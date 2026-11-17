import { del, get, post } from './api';
import { isNative } from './native';

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /android/i.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const supportsWebPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export type PushState = 'unsupported' | 'need-install' | 'denied' | 'off' | 'on';

/* ───────────── Android (FCM через Capacitor) ───────────── */

const FCM_TOKEN_KEY = 'gsk-fcm-token';
let nativeListeners = false;

// Плагин нельзя возвращать из async напрямую (см. native.ts), поэтому оборачиваем в объект
async function nativePlugin() {
  return { P: (await import('@capacitor/push-notifications')).PushNotifications };
}

/** Слушатели ставятся один раз: токен FCM отправляется на сервер, нажатие на уведомление открывает нужный экран */
export async function initNativePush(onOpen: (url: string) => void) {
  if (!isNative() || nativeListeners) return;
  nativeListeners = true;
  const { P } = await nativePlugin();
  await P.addListener('registration', async (t) => {
    try {
      localStorage.setItem(FCM_TOKEN_KEY, t.value);
      await post('/push/devices', { platform: 'fcm', token: t.value });
    } catch { /* повторим при следующем запуске */ }
  });
  await P.addListener('registrationError', () => { /* нет Google-сервисов или сети: не критично */ });
  await P.addListener('pushNotificationActionPerformed', (a) => {
    const url = (a.notification.data as { url?: string } | undefined)?.url;
    // только путь внутри приложения: «//хост» и «/\хост» браузер/роутер может принять за внешний адрес
    if (url && /^\/(?![/\\])[^\s]*$/.test(url)) onOpen(url);
  });
  // Канал, который указывает сервер в FCM-сообщении
  try { await P.createChannel({ id: 'gsk', name: 'ГСК Родник', description: 'Новости, долг, объявления', importance: 4, visibility: 0 }); } catch { /* уже есть */ }
}

/** После входа: если разрешение уже выдано — обновить токен (он может смениться) */
export async function syncNativePush() {
  if (!isNative()) return;
  const { P } = await nativePlugin();
  const perm = await P.checkPermissions();
  if (perm.receive === 'granted') await P.register();
}

async function enableNativePush() {
  const { P } = await nativePlugin();
  let perm = await P.checkPermissions();
  if (perm.receive !== 'granted') perm = await P.requestPermissions();
  if (perm.receive !== 'granted') throw new Error('Разрешение на уведомления не выдано. Включите его в настройках телефона');
  await P.register();
}

/** При выходе из аккаунта устройство отвязывается: чужие push на общий телефон не придут */
export async function forgetDevice() {
  try {
    if (isNative()) {
      const token = localStorage.getItem(FCM_TOKEN_KEY);
      if (token) { await del('/push/devices', { token }); localStorage.removeItem(FCM_TOKEN_KEY); }
    } else if (supportsWebPush()) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await del('/push/devices', { token: JSON.stringify(sub.toJSON()) });
    }
  } catch { /* сессия может быть уже недействительна */ }
}

/* ───────────── Браузер / PWA (Web Push) ───────────── */

function key(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushState(): Promise<PushState> {
  if (isNative()) {
    try {
      const perm = (await (await nativePlugin()).P.checkPermissions()).receive;
      return perm === 'granted' ? 'on' : perm === 'denied' ? 'denied' : 'off';
    } catch { return 'unsupported'; }
  }
  if (!supportsWebPush()) return isIos() && !isStandalone() ? 'need-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch { return 'off'; }
}

/** Запрашивает разрешение (только по нажатию пользователя) и регистрирует устройство на сервере */
export async function enablePush(): Promise<void> {
  if (isNative()) return enableNativePush();
  if (!supportsWebPush()) throw new Error('Этот браузер не поддерживает уведомления');
  const cfg = await get<{ webPushPublicKey: string | null }>('/push/config');
  if (!cfg.webPushPublicKey) throw new Error('Уведомления на сервере пока не настроены');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Разрешение на уведомления не выдано');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(cfg.webPushPublicKey) }));
  await post('/push/devices', { platform: 'webpush', token: JSON.stringify(sub.toJSON()) });
}

export async function disablePush(): Promise<void> {
  if (isNative()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await del('/push/devices', { token: JSON.stringify(sub.toJSON()) }).catch(() => {});
    await sub.unsubscribe();
  }
}
