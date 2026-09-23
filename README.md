# expo-thermal-printer

Impresión en impresoras térmicas ESC/POS por Bluetooth Classic para apps Expo en **Android**.

Salió del proyecto de venta de boletos (app-vendedor), donde se probó con una impresora MP58C6 de 58 mm. Aquí solo está la parte reutilizable; los formatos de ticket de cada proyecto se quedan en ese proyecto.

## Qué incluye

- **Módulo nativo (Kotlin):** lista impresoras ya vinculadas, conecta por SPP/RFCOMM (con reintentos seguro → inseguro → canal 1), manda los datos en pedazos, detecta cuando la impresora se apaga (broadcast ACL + sondeo cada 4 s) y se reconecta sola cuando vuelve.
- **Transporte (`transport.ts`):** permisos de Bluetooth en Android 12+, conexión, desconexión, eventos y `printBytes` con ritmo de envío para no desbordar el buffer de la impresora.
- **`EscPosBuilder` (`escpos.ts`):** constructor de comandos ESC/POS en TypeScript puro, sin dependencias: alineación, negritas, tamaños, líneas de corte, imágenes raster, página de códigos CP850 con acentos y ñ, y respaldo ASCII.
- **`usePrinterDisconnected`:** hook para mostrar un aviso cuando la impresora se desconecta.

## Requisitos

- Expo con **development build** (no funciona en Expo Go, porque trae código nativo).
- Solo Android. En iOS y web, `isPrintingSupported()` regresa `false`.
- La impresora se vincula **una vez** desde los ajustes de Bluetooth de Android. El módulo no escanea, así que no pide permiso de ubicación.

## Uso en un proyecto

Por ahora es local. Desde el proyecto Expo:

```sh
npm install ../expo-thermal-printer
npx expo prebuild   # o un build con EAS, para que se enlace el módulo nativo
```

```ts
import {
  EscPosBuilder,
  CODEPAGE,
  listPairedPrinters,
  connectToPrinter,
  printBytes,
} from 'expo-thermal-printer';

const [printer] = await listPairedPrinters();
await connectToPrinter(printer.address);

const ticket = new EscPosBuilder()
  .init()
  .codepage(CODEPAGE.CP850)
  .align('center')
  .bold(true)
  .line('Mi negocio')
  .bold(false)
  .line('Gracias por su compra')
  .feed(3)
  .build();

await printBytes(ticket);
```

Los errores de `transport.ts` llegan como `{ code, message }` (`bluetooth_off`, `permission_denied`, `not_connected`, `write_failed`, `unsupported`) con mensajes en español listos para mostrar.

## Desarrollo

```sh
npm install
npm test          # pruebas de ESC/POS y base64, en Node, sin hardware
npm run typecheck
```
