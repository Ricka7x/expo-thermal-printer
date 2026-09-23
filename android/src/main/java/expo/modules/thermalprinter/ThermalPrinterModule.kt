package expo.modules.thermalprinter

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Bluetooth Classic (SPP/RFCOMM) transport for ESC/POS thermal printers.
 *
 * Deliberately narrow: it lists already paired devices, opens a socket, and
 * writes raw bytes. All ESC/POS formatting lives in TypeScript (src/printer),
 * so this module never needs to know what a ticket looks like.
 *
 * Paired devices only, on purpose: the user pairs the printer once in Android
 * settings, which avoids the runtime location permission that BLE scanning
 * demands on Android 12+, and matches the real workflow (a fixed printer per
 * phone, not a printer hunt on every sale).
 */

/** Standard Serial Port Profile UUID, used by every ESC/POS SPP printer. */
private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

/**
 * Pause between write chunks. The printer has no flow control over RFCOMM, so
 * without a pause the socket can deliver data faster than the print head drains
 * its buffer, and the tail of a long ticket is lost.
 */
private const val CHUNK_PAUSE_MS = 12L

/**
 * How often a live connection is probed with a harmless status query. Turning
 * the printer off does not reliably raise Android's ACL-disconnect broadcast
 * on every device -- MIUI in particular is known to delay or drop it under
 * its background/battery restrictions -- so a dead socket can otherwise sit
 * unnoticed until the user tries to print and it fails. A cheap write is
 * the one thing a dead link cannot fake, and this is fast enough that "I
 * turned it back on" feels immediate without hammering the radio.
 */
private const val HEARTBEAT_INTERVAL_MS = 4000L

/**
 * Longest a single socket connect may block. BluetoothSocket.connect() has no
 * timeout of its own, and against a paired printer that is switched off it
 * can hang far longer than anyone waits at a counter. Closing the socket from
 * another thread is the only way to abort it.
 */
private const val CONNECT_ATTEMPT_TIMEOUT_MS = 8000L

/**
 * Budget for the whole fallback sequence: once spent, the remaining
 * transports aren't tried. A printer that is off fails every one of them the
 * same slow way, so trying all three only triples the wait.
 */
private const val CONNECT_TOTAL_TIMEOUT_MS = 15000L

/**
 * Waits between reconnect attempts after an involuntary drop, in order; the
 * last one repeats. Short at first, because the usual cause is the printer
 * being switched off and straight back on. Longer later, because each attempt
 * against a printer that stays off pages the radio for several seconds.
 */
private val RECONNECT_DELAYS_MS = longArrayOf(2000, 3000, 5000, 10000, 15000)

/** ESC/POS real-time status request (DLE EOT 1): no paper feed, no cut, no
 * print -- printers that don't support it simply ignore it. Only the success
 * or failure of the WRITE itself is used here, never the reply. */
private val HEARTBEAT_PROBE = byteArrayOf(0x10, 0x04, 0x01)

class BluetoothUnavailableException :
  CodedException("Bluetooth is unavailable or turned off on this device")

class BluetoothPermissionException :
  CodedException("Bluetooth permission was denied. Allow it to connect to the printer")

class PrinterNotConnectedException :
  CodedException("No printer is connected")

class PrinterConnectionException(address: String, cause: Throwable?) :
  CodedException(buildConnectionMessage(address, cause), cause)

/**
 * Surfaces the underlying Bluetooth error instead of swallowing it. Without this
 * the phone only shows "could not connect", which is impossible to act on.
 */
private fun buildConnectionMessage(address: String, cause: Throwable?): String {
  val detail = cause?.message?.takeIf { it.isNotBlank() }
  val type = cause?.javaClass?.simpleName
  return when {
    detail != null && type != null -> "Could not connect to printer $address ($type: $detail)"
    detail != null -> "Could not connect to printer $address ($detail)"
    type != null -> "Could not connect to printer $address ($type)"
    else -> "Could not connect to printer $address"
  }
}

class PrinterWriteException(cause: Throwable?) :
  CodedException("Could not send data to the printer", cause)

class ThermalPrinterModule : Module() {

  private var socket: BluetoothSocket? = null
  private var outputStream: OutputStream? = null
  private var connectedAddress: String? = null
  private var aclReceiver: BroadcastReceiver? = null

  /**
   * The address we're trying to stay connected to, independent of whether the
   * socket is open right now. Set on every successful connect, left alone by
   * an involuntary drop (ACL disconnect, a failed write) so a printer that
   * comes back on its own gets auto-reconnected -- only cleared by an
   * explicit disconnect(), so a deliberate "done with this printer" never
   * silently reconnects behind the user's back.
   */
  private var lastKnownAddress: String? = null

  /**
   * Identifies the current heartbeat loop so an old one recognizes it has
   * been superseded (a new connect, a disconnect) and stops on its own,
   * without needing to track or interrupt a Thread reference directly.
   */
  private val heartbeatGeneration = AtomicInteger(0)

  /**
   * Identifies the current reconnect loop. Bumped by an explicit connect or
   * disconnect, and by starting a new loop, so a superseded loop stops and a
   * socket it opens late is thrown away instead of installed.
   */
  private val reconnectGeneration = AtomicInteger(0)

  /**
   * Which socket type last connected (see createSocket), so reconnect
   * attempts go straight to the one this printer accepts instead of paging
   * the radio three times per attempt.
   */
  @Volatile private var lastWorkingTransport = 0

  private val adapter: BluetoothAdapter?
    get() {
      val context = appContext.reactContext ?: return null
      val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      return manager?.adapter
    }

  /**
   * There is no heartbeat on a Bluetooth Classic SPP socket: `socket.isConnected`
   * is a Java-side flag that only changes when *we* call connect()/close(), so a
   * printer powered off mid-session leaves it stuck reporting "connected" until
   * the next write() happens to fail. Android does notice the physical link drop
   * (a baseband/ACL disconnect) and broadcasts it; listening for that makes the
   * reported state follow reality. The heartbeat is the backstop for phones
   * that deliver the broadcast late or not at all.
   *
   * The receiver has to be EXPORTED. These broadcasts come from the Bluetooth
   * app (com.android.bluetooth), which is a different process, and Android 12+
   * refuses to deliver them to a NOT_EXPORTED receiver ("Permission Denial ...
   * requires DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" in logcat). That is
   * safe: ACL_CONNECTED/DISCONNECTED are protected broadcasts that only the
   * system can send, so no other app can spoof them.
   *
   * Only the disconnect is listened for. A printer never connects to the
   * phone on its own; an ACL_CONNECTED for it is the echo of our own connect
   * attempt, and reacting to it restarted the reconnect loop mid-attempt
   * (seen on a Poco M3: the retry failed with "RFCOMM already opened").
   * Getting the printer back is the reconnect loop's job alone.
   */
  private fun registerAclReceiver() {
    if (aclReceiver != null) return
    val context = appContext.reactContext ?: return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receivedContext: Context, intent: Intent) {
        val device = IntentCompat.getParcelableExtra(intent, BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java) ?: return
        if (intent.action != BluetoothDevice.ACTION_ACL_DISCONNECTED) return
        val address = connectedAddress ?: return
        if (device.address != address) return
        handleInvoluntaryDrop(address)
      }
    }
    val filter = IntentFilter().apply {
      addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
    }
    ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    aclReceiver = receiver
  }
  private fun unregisterAclReceiver() {
    val receiver = aclReceiver ?: return
    runCatching { appContext.reactContext?.unregisterReceiver(receiver) }
    aclReceiver = null
  }

  private fun hasConnectPermission(): Boolean {
    // BLUETOOTH_CONNECT only exists from Android 12 (API 31). Below that the
    // legacy BLUETOOTH permissions granted at install time are enough.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val context = appContext.reactContext ?: return false
    return ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
      PackageManager.PERMISSION_GRANTED
  }

  @SuppressLint("MissingPermission")
  private fun requireAdapter(): BluetoothAdapter {
    val adapter = adapter ?: throw BluetoothUnavailableException()
    if (!adapter.isEnabled) throw BluetoothUnavailableException()
    if (!hasConnectPermission()) throw BluetoothPermissionException()
    return adapter
  }

  @Synchronized
  private fun closeQuietly() {
    // Invalidates any heartbeat loop in flight -- it checks this generation
    // before every probe and lets itself die once it no longer matches.
    heartbeatGeneration.incrementAndGet()
    try {
      outputStream?.close()
    } catch (_: IOException) {
    }
    try {
      socket?.close()
    } catch (_: IOException) {
    }
    outputStream = null
    socket = null
    connectedAddress = null
  }

  /**
   * Starts probing the live connection every HEARTBEAT_INTERVAL_MS. Runs on
   * its own thread because the probe write blocks; synchronizes on `this`
   * (the same monitor as attemptConnect/closeQuietly/write) so a probe can
   * never interleave its bytes with a real print job or a reconnect.
   */
  private fun startHeartbeat() {
    val myGeneration = heartbeatGeneration.incrementAndGet()
    Thread {
      while (heartbeatGeneration.get() == myGeneration) {
        try {
          Thread.sleep(HEARTBEAT_INTERVAL_MS)
        } catch (_: InterruptedException) {
          return@Thread
        }
        val failedAddress = synchronized(this@ThermalPrinterModule) {
          if (heartbeatGeneration.get() != myGeneration) return@synchronized null
          val stream = outputStream ?: return@synchronized null
          try {
            stream.write(HEARTBEAT_PROBE)
            stream.flush()
            null
          } catch (_: Throwable) {
            connectedAddress
          }
        }
        if (failedAddress != null) {
          handleInvoluntaryDrop(failedAddress)
          return@Thread
        }
      }
    }.start()
  }

  /**
   * The printer went away without being asked to (switched off, out of
   * range, a failed write): report it and start trying to get it back.
   */
  private fun handleInvoluntaryDrop(address: String) {
    // The ACL broadcast, the heartbeat and a failed write can all notice the
    // same drop; only the first one to get here acts on it.
    val wasConnected = synchronized(this) {
      val current = connectedAddress == address
      if (current) closeQuietly()
      current
    }
    if (!wasConnected) return
    sendEvent("onConnectionChanged", mapOf("address" to address, "connected" to false))
    startReconnectLoop()
  }

  /**
   * Keeps trying the last printer until it answers, an explicit connect or
   * disconnect supersedes the loop, or the module is destroyed. A printer
   * doesn't announce that it's back, so polling is the only way to notice.
   * The blocking socket connect runs outside the module's lock, so writes,
   * status reads and a disconnect() are never held up by an attempt.
   */
  private fun startReconnectLoop() {
    val generation = reconnectGeneration.incrementAndGet()
    val target = lastKnownAddress ?: return
    Thread {
      var attempt = 0
      while (reconnectGeneration.get() == generation) {
        val delay = RECONNECT_DELAYS_MS[minOf(attempt, RECONNECT_DELAYS_MS.size - 1)]
        attempt++
        try {
          Thread.sleep(delay)
        } catch (_: InterruptedException) {
          return@Thread
        }
        if (reconnectGeneration.get() != generation) return@Thread
        if (tryReconnectOnce(target, generation)) return@Thread
      }
    }.apply { isDaemon = true; start() }
  }

  /** One reconnect attempt. True when connected (or no longer wanted), so the loop stops. */
  @SuppressLint("MissingPermission")
  private fun tryReconnectOnce(address: String, generation: Int): Boolean {
    val adapter = adapter ?: return false
    if (!adapter.isEnabled || !hasConnectPermission()) return false
    if (socket != null) return true
    val device = adapter.bondedDevices?.firstOrNull { it.address == address } ?: return false
    val candidate = createSocket(device, lastWorkingTransport) ?: return false
    if (connectWithTimeout(candidate) != null) return false

    synchronized(this) {
      val stillWanted = reconnectGeneration.get() == generation && lastKnownAddress == address && socket == null
      if (!stillWanted) {
        runCatching { candidate.close() }
        return true
      }
      install(candidate, address)
    }
    return true
  }

  /**
   * The socket types to try, most to least strict. Cheap 58mm printers
   * frequently do not publish an SDP record for SPP, in which case the
   * standard secure socket is refused with "Service discovery failed" or
   * "Connection refused": 0 is secure SPP, 1 insecure SPP (no authentication
   * or encryption on the link), 2 RFCOMM channel 1 directly, which is what
   * these printers actually listen on.
   */
  @SuppressLint("MissingPermission")
  private fun createSocket(device: BluetoothDevice, transport: Int): BluetoothSocket? = runCatching {
    when (transport) {
      0 -> device.createRfcommSocketToServiceRecord(SPP_UUID)
      1 -> device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
      else -> {
        val method = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
        method.invoke(device, 1) as? BluetoothSocket
      }
    }
  }.getOrNull()

  /**
   * candidate.connect(), aborted if it blocks past CONNECT_ATTEMPT_TIMEOUT_MS:
   * closing the socket from another thread makes a blocked connect() throw.
   * `settled` decides the race between the two: whichever side flips it first
   * wins, so a connect that succeeds just as the budget runs out is never
   * closed behind our back. Returns null on success; on failure the socket is
   * closed and the error returned.
   */
  @SuppressLint("MissingPermission")
  private fun connectWithTimeout(candidate: BluetoothSocket): Throwable? {
    val settled = AtomicBoolean(false)
    val watchdog = Thread {
      try {
        Thread.sleep(CONNECT_ATTEMPT_TIMEOUT_MS)
        if (settled.compareAndSet(false, true)) runCatching { candidate.close() }
      } catch (_: InterruptedException) {
      }
    }.apply { isDaemon = true; start() }
    return try {
      candidate.connect()
      if (!settled.compareAndSet(false, true)) throw IOException("Connect timed out")
      watchdog.interrupt()
      null
    } catch (error: Throwable) {
      settled.set(true)
      watchdog.interrupt()
      runCatching { candidate.close() }
      error
    }
  }

  /** Makes a connected socket the live one. Call with the module's lock held. */
  private fun install(candidate: BluetoothSocket, address: String) {
    socket = candidate
    outputStream = candidate.outputStream
    connectedAddress = address
    lastKnownAddress = address
    sendEvent("onConnectionChanged", mapOf("address" to address, "connected" to true))
    startHeartbeat()
  }

  /**
   * An explicit connect, from the "connect" AsyncFunction, which throws
   * whatever this returns so JS sees the detailed error. It supersedes any
   * reconnect loop. @Synchronized so two explicit connects can't race.
   */
  @Synchronized
  @SuppressLint("MissingPermission")
  private fun attemptConnect(address: String): Throwable? {
    reconnectGeneration.incrementAndGet()
    val adapter = adapter ?: return BluetoothUnavailableException()
    if (!adapter.isEnabled) return BluetoothUnavailableException()
    if (!hasConnectPermission()) return BluetoothPermissionException()

    // Reconnecting to the same device is a no-op rather than a failure.
    if (connectedAddress == address && socket?.isConnected == true) return null

    closeQuietly()

    val device = adapter.bondedDevices?.firstOrNull { it.address == address }
      ?: return PrinterConnectionException(address, null)

    // Deliberately NOT calling adapter.cancelDiscovery(): on Android 12+ it is
    // guarded by BLUETOOTH_SCAN, which this module does not request (we only
    // ever connect to already paired devices, never scan). Calling it threw
    // SecurityException and killed the connection before the socket was even
    // attempted. Nothing here starts discovery, so there is nothing to cancel.
    // If a future change adds scanning, this needs revisiting along with the
    // BLUETOOTH_SCAN permission.

    var lastError: Throwable? = null
    val deadline = System.currentTimeMillis() + CONNECT_TOTAL_TIMEOUT_MS
    for (transport in 0..2) {
      if (System.currentTimeMillis() >= deadline) break
      val candidate = createSocket(device, transport) ?: continue
      val error = connectWithTimeout(candidate)
      if (error == null) {
        lastWorkingTransport = transport
        install(candidate, address)
        return null
      }
      lastError = error
      // A short pause lets the printer settle before the next attempt: these
      // units frequently accept on the second try but not the first.
      Thread.sleep(300)
    }

    return PrinterConnectionException(address, lastError)
  }

  override fun definition() = ModuleDefinition {
    Name("ThermalPrinter")

    Events("onConnectionChanged")

    OnCreate {
      registerAclReceiver()
    }

    Function("isBluetoothEnabled") {
      adapter?.isEnabled == true
    }

    Function("hasPermission") {
      hasConnectPermission()
    }

    Function("isConnected") {
      // Cheap and idempotent (registerAclReceiver no-ops once attached), and
      // JS calls this on every render: a safety-net retry in case OnCreate
      // ran before appContext.reactContext existed, which would otherwise
      // leave the module silently never listening for ACL events at all.
      registerAclReceiver()
      socket?.isConnected == true
    }

    Function("connectedAddress") {
      connectedAddress
    }

    /** Bonded devices, so the user picks their printer from a short list. */
    AsyncFunction("pairedDevices") {
      val adapter = requireAdapter()
      adapter.bondedDevices.orEmpty().map { device ->
        mapOf(
          "name" to (device.name ?: "Unnamed"),
          "address" to device.address,
          "bonded" to true
        )
      }
    }

    AsyncFunction("connect") { address: String ->
      attemptConnect(address)?.let { throw it }
      true
    }

    /** Writes raw ESC/POS bytes, passed as base64 from JavaScript. */
    AsyncFunction("write") { base64: String ->
      val bytes = try {
        Base64.decode(base64, Base64.DEFAULT)
      } catch (error: Throwable) {
        throw PrinterWriteException(error)
      }

      // Synchronized against the same monitor as the heartbeat probe, so a
      // probe can never land mid-ticket and corrupt what the printer sees.
      var droppedAddress: String? = null
      val writeError = synchronized(this@ThermalPrinterModule) {
        val stream = outputStream ?: return@synchronized PrinterNotConnectedException()
        try {
          // Cheap printers have small buffers and no flow control: write in small
          // chunks and FLUSH AFTER EACH ONE, so the socket does not queue the whole
          // payload and outrun what the printer can consume. Flushing only once at
          // the end let a long ticket overrun the buffer and lose its tail.
          var offset = 0
          val chunkSize = 128
          while (offset < bytes.size) {
            val length = minOf(chunkSize, bytes.size - offset)
            stream.write(bytes, offset, length)
            stream.flush()
            offset += length
            if (offset < bytes.size) Thread.sleep(CHUNK_PAUSE_MS)
          }
          null
        } catch (error: Throwable) {
          droppedAddress = connectedAddress
          PrinterWriteException(error)
        }
      }
      droppedAddress?.let { handleInvoluntaryDrop(it) }
      if (writeError != null) throw writeError
      true
    }

    AsyncFunction("disconnect") {
      // The only voluntary path: stop trying to reconnect to this printer.
      reconnectGeneration.incrementAndGet()
      lastKnownAddress = null
      val address = connectedAddress
      closeQuietly()
      if (address != null) {
        sendEvent("onConnectionChanged", mapOf("address" to address, "connected" to false))
      }
      true
    }

    OnDestroy {
      reconnectGeneration.incrementAndGet()
      unregisterAclReceiver()
      closeQuietly()
    }
  }
}
