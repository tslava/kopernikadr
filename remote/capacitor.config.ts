import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'pl.slava.kopernikadr.remote',
  appName: 'Kopernikadr',
  webDir: 'out',
  // http://localhost: a secure context (localhost) that may still open ws:// and http:// to the
  // camera on the LAN; the camera's CORS allows exactly this origin.
  server: {
    androidScheme: 'http',
    hostname: 'localhost',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
