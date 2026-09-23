export type PairedPrinter = {
  /** Device name as shown in Android's Bluetooth settings. */
  name: string;
  /** MAC address, the value passed back to `connect`. */
  address: string;
  bonded: boolean;
};

export type ConnectionChangedEvent = {
  address: string;
  connected: boolean;
};

export type ThermalPrinterModuleEvents = {
  onConnectionChanged: (event: ConnectionChangedEvent) => void;
};
