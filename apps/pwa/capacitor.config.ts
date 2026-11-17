import type { CapacitorConfig } from '@capacitor/cli';

// CAP_DEV=1 — только для проверки на эмуляторе с локальным HTTP-сервером; боевые сборки всегда HTTPS
const dev = process.env.CAP_DEV === '1';

const config: CapacitorConfig = {
  appId: 'ru.gskrodnik.app',
  appName: 'ГСК Родник',
  webDir: 'dist',
  backgroundColor: '#0f1722',
  // Страницы приложения лежат внутри APK и открываются по https://localhost; на сервер ходят запросами к API
  server: { androidScheme: dev ? 'http' : 'https' },
  android: {
    allowMixedContent: dev,
    webContentsDebuggingEnabled: dev, // chrome://inspect работает только в отладочной сборке (CAP_DEV=1)
    loggingBehavior: dev ? 'debug' : 'none',
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    SplashScreen: { launchShowDuration: 700, backgroundColor: '#0f1722', showSpinner: false, androidScaleType: 'CENTER_INSIDE' },
    StatusBar: { style: 'DARK', backgroundColor: '#0f1722', overlaysWebView: false },
  },
};

export default config;
