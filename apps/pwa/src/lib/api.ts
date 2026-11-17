// Клиент API. Access-токен только в памяти.
// Браузер/PWA: refresh в httpOnly-cookie. Нативное приложение (Capacitor): refresh хранится на устройстве.
const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

import { isNative, secureGet, secureRemove, secureSet } from './native';
export { isNative };
export const clientKind = () => (isNative() ? 'android' : 'pwa');
/** Код версии нативной сборки (задаётся при сборке APK: VITE_VERSION_CODE) */
export const APP_VERSION_CODE = Number(import.meta.env.VITE_VERSION_CODE ?? 0);
/** Версия нативной сборки для людей (VERSION_NAME из android/version.properties) */
export const APP_VERSION_NAME: string = (import.meta.env.VITE_VERSION_NAME as string | undefined) ?? '';

const RT_KEY = 'gsk-rt';
// Refresh-токен нативного приложения лежит в Android Keystore (шифрованное хранилище), не в localStorage
let rtCache: string | null | undefined;
const readRt = async (): Promise<string | null> => { if (rtCache === undefined) rtCache = await secureGet(RT_KEY); return rtCache; };
const writeRt = async (v: string | null): Promise<void> => { rtCache = v; if (v) await secureSet(RT_KEY, v); else await secureRemove(RT_KEY); };

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onAuthLost: () => void = () => {};

export const setAuthLostHandler = (fn: () => void) => (onAuthLost = fn);
export const setSession = (access: string | null, refresh?: string | null) => {
  accessToken = access;
  if (isNative() && refresh) void writeRt(refresh);
  if (!access && isNative()) void writeRt(null);
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** Запрос с ограничением по времени: без него при недоступном сервере приложение «висит» на кнопке. Ошибки сети — понятным текстом. */
async function fetchT(url: string, init: RequestInit, ms = 20_000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) throw new ApiError(0, 'Сервер не отвечает. Проверьте подключение к сети и попробуйте ещё раз');
    throw new ApiError(0, 'Нет связи с сервером. Проверьте интернет и адрес сервера');
  } finally {
    clearTimeout(timer);
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: any = null;
  try { body = await res.json(); } catch { /* не JSON */ }
  const m = body?.message;
  return new ApiError(res.status, Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : `Ошибка ${res.status}`, body?.code);
}

export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const body: { refreshToken?: string; client?: string } = isNative() ? { refreshToken: (await readRt()) ?? '' } : { client: 'pwa' };
      if (isNative() && !body.refreshToken) return false;
      const res = await fetchT(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: isNative() ? 'omit' : 'same-origin' }, 15_000);
      if (!res.ok) return false;
      const j = await res.json();
      accessToken = j.accessToken;
      if (isNative() && j.refreshToken) await writeRt(j.refreshToken);
      return true;
    } catch { return false; } finally { setTimeout(() => (refreshing = null), 0); }
  })();
  return refreshing;
}

async function request(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  // загрузка фото идёт дольше обычных запросов
  const res = await fetchT(`${BASE}/api${path}`, { method, headers, body: payload, credentials: isNative() ? 'omit' : 'same-origin' }, body instanceof FormData ? 120_000 : 20_000);
  if (res.status === 401 && retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) return request(method, path, body, false);
    onAuthLost();
  }
  return res;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function qs(query?: Record<string, unknown>) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
export const get = <T = any>(path: string, query?: Record<string, unknown>) => api<T>('GET', path + qs(query));
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T = any>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T = any>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export async function uploadImage(kind: 'meter' | 'ad', blob: Blob, name = 'photo.jpg'): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob, name);
  const res = await request('POST', `/files?kind=${kind}`, fd);
  if (!res.ok) throw await toError(res);
  return (await res.json()).id;
}

const blobCache = new Map<string, Promise<string>>();
/** Приватные фото: загрузка с токеном → blob URL */
export function fileBlobUrl(id: string): Promise<string> {
  let p = blobCache.get(id);
  if (!p) {
    p = request('GET', `/files/${id}`).then(async (r) => { if (!r.ok) throw await toError(r); return URL.createObjectURL(await r.blob()); });
    blobCache.set(id, p);
    p.catch(() => blobCache.delete(id));
  }
  return p;
}
export function clearBlobCache() { blobCache.forEach((p) => p.then((u) => URL.revokeObjectURL(u)).catch(() => {})); blobCache.clear(); }

export const absoluteUrl = (path: string) => `${BASE}${path}`;
