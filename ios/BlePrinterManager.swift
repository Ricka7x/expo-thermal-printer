import CoreBluetooth
import ExpoModulesCore

/**
 * Services cheap ESC/POS printers commonly expose over BLE. They are tried
 * first when picking the characteristic to write to; any other writable
 * characteristic is the fallback, so an unlisted printer still works.
 */
private let knownPrinterServices: [CBUUID] = [
  CBUUID(string: "18F0"),
  CBUUID(string: "FF00"),
  CBUUID(string: "FFE0"),
  CBUUID(string: "49535343-FE7D-4AE5-8FA9-9FAFD205E455"),
  CBUUID(string: "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2"),
]

/** How long an explicit connect waits before giving up. */
private let connectTimeout: TimeInterval = 10

/**
 * Owns the CBCentralManager and the single printer connection.
 *
 * Every piece of state is only touched on `queue`, which is also the
 * delegate queue CoreBluetooth calls back on, so there is no locking beyond
 * hopping onto it. Public entry points are called from the JS thread and
 * either `queue.async` (work) or `queue.sync` (cheap reads).
 */
final class BlePrinterManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  /** Called on `eventQueue`, never on `queue`: see notifyConnectionChanged. */
  var onConnectionChanged: ((String, Bool) -> Void)?

  private let queue = DispatchQueue(label: "expo.modules.thermalprinter.ble")
  private let eventQueue = DispatchQueue(label: "expo.modules.thermalprinter.events")
  private var central: CBCentralManager?
  private var readyWaiters: [(Exception?) -> Void] = []

  private var discovered: [UUID: CBPeripheral] = [:]
  private var scanNames: [UUID: String] = [:]
  private var scanCompletions: [(Result<[[String: Any]], Exception>) -> Void] = []
  /** Identifies the running scan so a stale timer can't end a newer one. */
  private var scanGeneration = 0

  /** The printer being connected to, or connected. Retained: CoreBluetooth doesn't. */
  private var peripheral: CBPeripheral?
  private var writeCharacteristic: CBCharacteristic?
  private var connected = false

  /**
   * The printer we're trying to stay connected to. Set on a successful
   * connect, kept through an involuntary drop so the printer reconnects when
   * it comes back, and cleared only by an explicit disconnect().
   */
  private var lastKnownId: UUID?

  private var connectCompletion: ((Exception?) -> Void)?
  private var connectAttempt = 0
  private var pendingCharacteristicDiscoveries = 0

  private var writeChunks: [Data] = []
  private var writeType: CBCharacteristicWriteType = .withoutResponse
  private var awaitingWriteAck = false
  private var writeCompletion: ((Exception?) -> Void)?

  // MARK: - Public API

  func isPoweredOn() -> Bool {
    queue.sync {
      // Creating the manager is what shows the permission prompt, so don't do
      // it from a cheap status read before the app has asked for permission.
      if central == nil && CBCentralManager.authorization != .notDetermined {
        ensureCentral()
      }
      return central?.state == .poweredOn
    }
  }

  func isConnected() -> Bool {
    queue.sync { connected }
  }

  func connectedAddress() -> String? {
    queue.sync { connected ? peripheral?.identifier.uuidString : nil }
  }

  func requestPermission(_ completion: @escaping (Bool) -> Void) {
    queue.async {
      self.whenReady { _ in
        completion(CBCentralManager.authorization == .allowedAlways)
      }
    }
  }

  func scan(timeout: TimeInterval, _ completion: @escaping (Result<[[String: Any]], Exception>) -> Void) {
    queue.async {
      self.whenReady { error in
        if let error {
          completion(.failure(error))
          return
        }
        self.scanCompletions.append(completion)
        // A scan already running answers every caller when it ends.
        guard self.scanCompletions.count == 1, let central = self.central else { return }
        self.scanNames = [:]
        self.scanGeneration += 1
        let generation = self.scanGeneration
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        self.queue.asyncAfter(deadline: .now() + timeout) {
          guard self.scanGeneration == generation, !self.scanCompletions.isEmpty else { return }
          self.finishScan()
        }
      }
    }
  }

  func connect(address: String, _ completion: @escaping (Exception?) -> Void) {
    queue.async {
      self.whenReady { error in
        if let error {
          completion(error)
          return
        }
        guard let central = self.central, let id = UUID(uuidString: address) else {
          completion(PrinterConnectionException(address))
          return
        }
        // Reconnecting to the same printer is a no-op rather than a failure.
        if self.connected && self.peripheral?.identifier == id {
          completion(nil)
          return
        }

        let target: CBPeripheral
        if let pending = self.peripheral, pending.identifier == id {
          // Already connecting to it (an automatic reconnect after a drop).
          // Cancelling and reconnecting would deliver didDisconnect for this
          // same object and fail the new attempt, so join the pending connect.
          target = pending
          self.finishConnect(PrinterConnectionException("\(address) (superseded)"))
        } else {
          self.dropCurrent(notify: true)
          guard let found = self.discovered[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
            completion(PrinterConnectionException("\(address) (not found, scan for it first)"))
            return
          }
          target = found
          target.delegate = self
          self.peripheral = target
          central.connect(target)
        }
        self.connectCompletion = completion
        self.connectAttempt += 1
        let attempt = self.connectAttempt

        // CoreBluetooth never times out a connect on its own.
        self.queue.asyncAfter(deadline: .now() + connectTimeout) {
          guard self.connectAttempt == attempt, self.connectCompletion != nil, !self.connected else { return }
          central.cancelPeripheralConnection(target)
          self.peripheral = nil
          self.finishConnect(PrinterConnectionException("\(address) (timed out)"))
        }
      }
    }
  }

  func write(_ data: Data, _ completion: @escaping (Exception?) -> Void) {
    queue.async {
      guard self.connected, let peripheral = self.peripheral, let characteristic = self.writeCharacteristic else {
        completion(PrinterNotConnectedException())
        return
      }
      guard self.writeCompletion == nil else {
        completion(PrinterWriteException())
        return
      }
      // Without-response is faster and what most printers expect; with-response
      // is the fallback for the ones that only advertise that.
      self.writeType = characteristic.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
      let chunkSize = min(max(peripheral.maximumWriteValueLength(for: self.writeType), 20), 512)
      var chunks: [Data] = []
      var offset = 0
      while offset < data.count {
        let end = min(offset + chunkSize, data.count)
        chunks.append(data.subdata(in: offset..<end))
        offset = end
      }
      self.writeChunks = chunks
      self.writeCompletion = completion
      self.pumpWrites()
    }
  }

  func disconnect(_ completion: @escaping () -> Void) {
    queue.async {
      // The only voluntary path: stop trying to reconnect to this printer.
      self.lastKnownId = nil
      self.dropCurrent(notify: true)
      completion()
    }
  }

  func shutdown() {
    queue.async {
      self.lastKnownId = nil
      self.dropCurrent(notify: false)
      self.central?.stopScan()
    }
  }

  // MARK: - Internals (queue only)

  /**
   * Events leave through their own serial queue (order kept) instead of being
   * sent from `queue`. The status reads above block the JS thread on
   * `queue.sync`, so emitting from `queue` could deadlock if the emitter ever
   * waited on the JS thread.
   */
  private func notifyConnectionChanged(_ address: String, _ connected: Bool) {
    let callback = onConnectionChanged
    eventQueue.async {
      callback?(address, connected)
    }
  }

  private func ensureCentral() {
    if central == nil {
      central = CBCentralManager(
        delegate: self,
        queue: queue,
        options: [CBCentralManagerOptionShowPowerAlertKey: false]
      )
    }
  }

  /** Runs `completion` once the radio has a definitive state. */
  private func whenReady(_ completion: @escaping (Exception?) -> Void) {
    ensureCentral()
    if let readiness = readiness() {
      completion(readiness.failure)
    } else {
      readyWaiters.append(completion)
    }
  }

  private enum Readiness {
    case ready
    case failed(Exception)

    var failure: Exception? {
      if case .failed(let error) = self { return error }
      return nil
    }
  }

  /** nil while the state is still unknown or resetting. */
  private func readiness() -> Readiness? {
    switch central?.state {
    case .poweredOn:
      return .ready
    case .poweredOff, .unsupported:
      return .failed(BluetoothUnavailableException())
    case .unauthorized:
      return .failed(BluetoothPermissionException())
    default:
      return nil
    }
  }

  private func finishScan() {
    central?.stopScan()
    var devices = scanNames.map { id, name in
      ["name": name, "address": id.uuidString, "bonded": false] as [String: Any]
    }
    // A connected printer stops advertising, so the scan alone would miss it.
    if connected, let peripheral, scanNames[peripheral.identifier] == nil {
      devices.append(["name": peripheral.name ?? "Unnamed", "address": peripheral.identifier.uuidString, "bonded": false])
    }
    devices.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    let completions = scanCompletions
    scanCompletions = []
    completions.forEach { $0(.success(devices)) }
  }

  private func finishConnect(_ error: Exception?) {
    let completion = connectCompletion
    connectCompletion = nil
    completion?(error)
  }

  private func finishWrite(_ error: Exception?) {
    let completion = writeCompletion
    writeCompletion = nil
    writeChunks = []
    awaitingWriteAck = false
    completion?(error)
  }

  /** Closes the current connection, if any, without touching lastKnownId. */
  private func dropCurrent(notify: Bool) {
    let wasConnected = connected
    let address = peripheral?.identifier.uuidString
    if let peripheral {
      central?.cancelPeripheralConnection(peripheral)
    }
    peripheral = nil
    writeCharacteristic = nil
    connected = false
    finishWrite(PrinterNotConnectedException())
    finishConnect(PrinterConnectionException("\(address ?? "") (cancelled)"))
    if notify, wasConnected, let address {
      notifyConnectionChanged(address, false)
    }
  }

  private func pumpWrites() {
    guard writeCompletion != nil, let peripheral, let characteristic = writeCharacteristic else { return }
    if writeType == .withResponse {
      guard !awaitingWriteAck else { return }
      guard !writeChunks.isEmpty else {
        finishWrite(nil)
        return
      }
      awaitingWriteAck = true
      peripheral.writeValue(writeChunks.removeFirst(), for: characteristic, type: .withResponse)
      return
    }
    // Without response, CoreBluetooth has its own small queue: fill it while it
    // has room, then wait for peripheralIsReady(toSendWriteWithoutResponse:).
    while !writeChunks.isEmpty && peripheral.canSendWriteWithoutResponse {
      peripheral.writeValue(writeChunks.removeFirst(), for: characteristic, type: .withoutResponse)
    }
    if writeChunks.isEmpty {
      finishWrite(nil)
    }
  }

  private func pickWriteCharacteristic(_ peripheral: CBPeripheral) -> CBCharacteristic? {
    let services = (peripheral.services ?? []).sorted { a, b in
      knownPrinterServices.contains(a.uuid) && !knownPrinterServices.contains(b.uuid)
    }
    for service in services {
      for characteristic in service.characteristics ?? [] {
        let properties = characteristic.properties
        if properties.contains(.writeWithoutResponse) || properties.contains(.write) {
          return characteristic
        }
      }
    }
    return nil
  }

  private func failConnection(_ peripheral: CBPeripheral, _ error: Exception) {
    central?.cancelPeripheralConnection(peripheral)
    if connectCompletion != nil {
      self.peripheral = nil
      finishConnect(error)
    }
  }

  // MARK: - CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if let readiness = readiness() {
      let waiters = readyWaiters
      readyWaiters = []
      waiters.forEach { $0(readiness.failure) }
    }

    switch central.state {
    case .poweredOn:
      // Turning Bluetooth off drops every connection and pending connect; ask
      // again for the printer we were using so it comes back on its own.
      if !connected, peripheral == nil, let id = lastKnownId,
        let target = central.retrievePeripherals(withIdentifiers: [id]).first {
        target.delegate = self
        peripheral = target
        central.connect(target)
      }
    case .poweredOff, .unauthorized, .unsupported:
      if !scanCompletions.isEmpty {
        let completions = scanCompletions
        scanCompletions = []
        completions.forEach { $0(.failure(BluetoothUnavailableException())) }
      }
      dropCurrent(notify: true)
    default:
      break
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
    guard let name, !name.isEmpty else { return }
    discovered[peripheral.identifier] = peripheral
    scanNames[peripheral.identifier] = name
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard peripheral === self.peripheral else { return }
    peripheral.discoverServices(nil)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    guard peripheral === self.peripheral else { return }
    let detail = error.map { " (\($0.localizedDescription))" } ?? ""
    self.peripheral = nil
    finishConnect(PrinterConnectionException("\(peripheral.identifier.uuidString)\(detail)"))
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    guard peripheral === self.peripheral else { return }
    let wasConnected = connected
    connected = false
    writeCharacteristic = nil
    finishWrite(PrinterWriteException())
    finishConnect(PrinterConnectionException(peripheral.identifier.uuidString))
    if wasConnected {
      notifyConnectionChanged(peripheral.identifier.uuidString, false)
    }
    // An involuntary drop (printer off, out of range): a connect on iOS never
    // expires, so re-issuing it reconnects whenever the printer comes back.
    if peripheral.identifier == lastKnownId, central.state == .poweredOn {
      central.connect(peripheral)
    } else {
      self.peripheral = nil
    }
  }

  // MARK: - CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard peripheral === self.peripheral else { return }
    let services = peripheral.services ?? []
    if error != nil || services.isEmpty {
      failConnection(peripheral, PrinterConnectionException("\(peripheral.identifier.uuidString) (no services)"))
      return
    }
    pendingCharacteristicDiscoveries = services.count
    services.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard peripheral === self.peripheral else { return }
    pendingCharacteristicDiscoveries -= 1
    guard pendingCharacteristicDiscoveries == 0 else { return }

    guard let characteristic = pickWriteCharacteristic(peripheral) else {
      failConnection(
        peripheral,
        PrinterConnectionException("\(peripheral.identifier.uuidString) (no writable characteristic, not a BLE printer?)")
      )
      return
    }
    writeCharacteristic = characteristic
    connected = true
    lastKnownId = peripheral.identifier
    finishConnect(nil)
    notifyConnectionChanged(peripheral.identifier.uuidString, true)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard peripheral === self.peripheral, awaitingWriteAck else { return }
    awaitingWriteAck = false
    if error != nil {
      finishWrite(PrinterWriteException())
    } else {
      pumpWrites()
    }
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    guard peripheral === self.peripheral else { return }
    pumpWrites()
  }
}
