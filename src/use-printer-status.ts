import { useEffect, useState } from 'react';

import { isConnected, isPrintingSupported, onConnectionChanged } from './transport';

/**
 * Whether a screen that prints should show its "printer disconnected" notice
 * right now. False on iOS (nothing there can print, so there is nothing to
 * warn about). On Android it starts from a fresh native read: the module is
 * a singleton, so this is accurate even on first mount, and then stays
 * current via onConnectionChanged, which fires on explicit connect/disconnect
 * and when the native module notices the printer physically went away.
 */
export function usePrinterDisconnected(): boolean {
  const [connected, setConnected] = useState(() => isConnected());

  useEffect(() => {
    if (!isPrintingSupported()) return;
    const subscription = onConnectionChanged((event) => setConnected(event.connected));
    return () => subscription.remove();
  }, []);

  return isPrintingSupported() && !connected;
}
