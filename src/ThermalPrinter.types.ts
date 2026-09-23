export type PrinterDevice = {
  /** Device name as the phone reports it. */
  name: string;
  /**
   * The value passed back to `connect`: the MAC address on Android, the
   * CoreBluetooth peripheral identifier (a UUID, stable per phone) on iOS.
   */
  address: string;
  /** True for Android's bonded (paired) devices; always false on iOS, where BLE printers are found by scanning. */
  bonded: boolean;
};

export type ConnectionChangedEvent = {
  address: string;
  connected: boolean;
};

export type ThermalPrinterModuleEvents = {
  onConnectionChanged: (event: ConnectionChangedEvent) => void;
};
