import ExpoModulesCore

// Same class names as the Android module, so both platforms reject with the
// same inferred error codes (ERR_BLUETOOTH_UNAVAILABLE, ...) and JavaScript
// can map them in one place.

final class BluetoothUnavailableException: Exception, @unchecked Sendable {
  override var reason: String {
    "Bluetooth is unavailable or turned off on this device"
  }
}

final class BluetoothPermissionException: Exception, @unchecked Sendable {
  override var reason: String {
    "Bluetooth permission was denied. Allow it in Settings to connect to the printer"
  }
}

final class PrinterNotConnectedException: Exception, @unchecked Sendable {
  override var reason: String {
    "No printer is connected"
  }
}

/// The param is the printer address, optionally followed by the underlying error.
final class PrinterConnectionException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "Could not connect to printer \(param)"
  }
}

final class PrinterWriteException: Exception, @unchecked Sendable {
  override var reason: String {
    "Could not send data to the printer"
  }
}
