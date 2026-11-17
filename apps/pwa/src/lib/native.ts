// Нативная оболочка Android (Capacitor): хранилище токена, кнопка «Назад», открытие ссылок.
// Всё вызывается только при isNative(); в браузере модули плагинов даже не загружаются.
export const isNative = () => !!(window as any).Capacitor?.isNativePlatform?.();

type Secure = typeof import('@aparajita/capacitor-secure-storage').SecureStorage;
// ВАЖНО: плагин Capacitor нельзя возвращать из Promise/async напрямую — у его прокси «есть» любой метод,
// включая then(), и ожидание зависает навсегда. Поэтому плагин всегда заворачивается в объект.
let secure: Promise<{ plugin: Secure }> | null = null;

/** Android Keystore: значения шифруются ключом, который нельзя извлечь с устройства */
export function secureStore(): Promise<{ plugin: Secure }> {
  secure ??= import('@aparajita/capacitor-secure-storage').then(async (m) => {
    await m.SecureStorage.setKeyPrefix('gsk_');
    return { plugin: m.SecureStorage };
  });
  return secure;
}

export async function secureGet(key: string): Promise<string | null> {
  try { return ((await (await secureStore()).plugin.get(key, false)) as string | null) ?? null; } catch { return null; }
}
export async function secureSet(key: string, value: string): Promise<void> {
  try { await (await secureStore()).plugin.set(key, value, false); } catch { /* хранилище недоступно */ }
}
export async function secureRemove(key: string): Promise<void> {
  try { await (await secureStore()).plugin.remove(key); } catch { /* уже нет */ }
}

/** Скачивание файла (APK): системный браузер сам скачает и предложит установить */
export async function openExternal(url: string) {
  if (!isNative()) { window.location.href = url; return; }
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url });
}

/** Тёмная системная панель в цвет приложения */
export async function setupNativeChrome() {
  if (!isNative()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
  } catch { /* не критично */ }
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch { /* не критично */ }
}

/** Нативный плагин обновления (android/…/ApkInstallerPlugin.java). Как и у других плагинов — только в объекте-обёртке. */
interface ApkInstallerApi {
  download(o: { url: string; sha256: string }): Promise<{ size: number }>;
  install(): Promise<{ needsPermission: boolean }>;
  cleanup(): Promise<void>;
  addListener(ev: 'progress', cb: (p: { loaded: number; total: number }) => void): Promise<{ remove: () => Promise<void> }>;
}
let apkInstaller: Promise<{ plugin: ApkInstallerApi }> | null = null;
export function apkInstallerPlugin(): Promise<{ plugin: ApkInstallerApi }> {
  apkInstaller ??= import('@capacitor/core').then((m) => ({ plugin: m.registerPlugin<ApkInstallerApi>('ApkInstaller') }));
  return apkInstaller;
}
