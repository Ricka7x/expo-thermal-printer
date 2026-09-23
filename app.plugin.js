const { withInfoPlist } = require('expo/config-plugins');

const DEFAULT_BLUETOOTH_PERMISSION = 'Allow $(PRODUCT_NAME) to use Bluetooth to connect to your receipt printer.';

/**
 * iOS refuses to create a CBCentralManager (and crashes the app) without
 * NSBluetoothAlwaysUsageDescription. Android permissions ship in the library
 * manifest, so this plugin only touches Info.plist.
 *
 *   plugins: [["@ricka7x/expo-thermal-printer", { "bluetoothPermission": "..." }]]
 */
module.exports = function withThermalPrinter(config, { bluetoothPermission } = {}) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSBluetoothAlwaysUsageDescription =
      bluetoothPermission || config.modResults.NSBluetoothAlwaysUsageDescription || DEFAULT_BLUETOOTH_PERMISSION;
    return config;
  });
};
