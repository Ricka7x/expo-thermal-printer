import CoreBluetooth
import ExpoModulesCore

/**
 * iOS transport for ESC/POS thermal printers, over Bluetooth Low Energy.
 *
 * iOS gives apps no access to Bluetooth Classic SPP (the Android transport)
 * unless the accessory is MFi certified, which cheap printers never are. So
 * on iOS the printer must expose a BLE GATT service with a writable
 * characteristic, which most dual-mode 58mm printers do. All ESC/POS
 * formatting still lives in TypeScript; this only moves bytes.
 *
 * The JS surface mirrors the Android module, with two iOS-only additions:
 * `scanDevices` (BLE has no "paired devices" list to read, so printers are
 * found by scanning) and `requestPermission` (the system prompt only appears
 * when a CBCentralManager is created).
 */
public class ThermalPrinterModule: Module {
  private lazy var printer: BlePrinterManager = {
    let manager = BlePrinterManager()
    manager.onConnectionChanged = { [weak self] address, connected in
      self?.sendEvent("onConnectionChanged", ["address": address, "connected": connected])
    }
    return manager
  }()

  public func definition() -> ModuleDefinition {
    Name("ThermalPrinter")

    Events("onConnectionChanged")

    Function("isBluetoothEnabled") { () -> Bool in
      self.printer.isPoweredOn()
    }

    Function("hasPermission") { () -> Bool in
      CBCentralManager.authorization == .allowedAlways
    }

    Function("isConnected") { () -> Bool in
      self.printer.isConnected()
    }

    Function("connectedAddress") { () -> String? in
      self.printer.connectedAddress()
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      self.printer.requestPermission { granted in
        promise.resolve(granted)
      }
    }

    /** Named BLE peripherals seen within the timeout, plus the connected printer. */
    AsyncFunction("scanDevices") { (timeoutMs: Double, promise: Promise) in
      self.printer.scan(timeout: max(timeoutMs, 500) / 1000) { result in
        switch result {
        case .success(let devices):
          promise.resolve(devices)
        case .failure(let error):
          promise.reject(error)
        }
      }
    }

    AsyncFunction("connect") { (address: String, promise: Promise) in
      self.printer.connect(address: address) { error in
        if let error {
          promise.reject(error)
        } else {
          promise.resolve(true)
        }
      }
    }

    /** Writes raw ESC/POS bytes, passed as base64 from JavaScript. */
    AsyncFunction("write") { (base64: String, promise: Promise) in
      guard let data = Data(base64Encoded: base64) else {
        promise.reject(PrinterWriteException())
        return
      }
      self.printer.write(data) { error in
        if let error {
          promise.reject(error)
        } else {
          promise.resolve(true)
        }
      }
    }

    AsyncFunction("disconnect") { (promise: Promise) in
      self.printer.disconnect {
        promise.resolve(true)
      }
    }

    OnDestroy {
      self.printer.shutdown()
    }
  }
}
