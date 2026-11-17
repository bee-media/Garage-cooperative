// Клиент API. Access-токен живёт только в памяти; refresh — httpOnly-cookie (недоступна из JS).
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onAuthLost: () => void = () => {};

export const setAuthLostHandler = (fn: () => void) => (onAuthLost = fn);
export const setAccessToken = (t: string | null) => (accessToken = t);

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch { /* не JSON */ }
  const m = body?.message;
  const message = Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : `Ошибка ${res.status}`;
  return new ApiError(res.status, message, body?.code);
}

export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'web-admin' }), credentials: 'same-origin' });
      if (!res.ok) return false;
      accessToken = (await res.json()).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function request(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
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

export const get = <T = any>(path: string, query?: Record<string, unknown>) => api<T>('GET', path + qs(query));
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T = any>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T = any>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = <T = any>(path: string, body?: unknown) => api<T>('DELETE', path, body);

export function qs(query?: Record<string, unknown>) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function uploadImage(kind: 'news' | 'ad' | 'meter' | 'map', file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await request('POST', `/files?kind=${kind}`, fd);
  if (!res.ok) throw await toError(res);
  return (await res.json()).id;
}

/** Загрузка изображения карты: возвращает ещё и размеры картинки */
export async function uploadMapImage(file: File): Promise<{ id: string; width: number; height: number }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await request('POST', '/files?kind=map', fd);
  if (!res.ok) throw await toError(res);
  return res.json();
}

/** Загрузка с прогрессом (APK) */
export function uploadWithProgress<T = any>(path: string, fd: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const send = (retry: boolean) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = async () => {
        if (xhr.status === 401 && retry && (await refreshSession())) return send(false);
        let body: any = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* пусто */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
        const m = body?.message;
        reject(new ApiError(xhr.status, Array.isArray(m) ? m.join('; ') : m ?? `Ошибка ${xhr.status}`));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Нет связи с сервером'));
      xhr.send(fd);
    };
    send(true);
  });
}

const blobCache = new Map<string, Promise<string>>();
/** Защищённые файлы: запрос с токеном → blob URL (фото нельзя открыть по прямой ссылке без входа) */
export function fileBlobUrl(id: string): Promise<string> {
  let p = blobCache.get(id);
  if (!p) {
    p = request('GET', `/files/${id}`).then(async (r) => {
      if (!r.ok) throw await toError(r);
      return URL.createObjectURL(await r.blob());
    });
    blobCache.set(id, p);
    p.catch(() => blobCache.delete(id));
  }
  return p;
}

export function clearBlobCache() {
  blobCache.forEach((p) => p.then((u) => URL.revokeObjectURL(u)).catch(() => {}));
  blobCache.clear();
}

/** Скачивание защищённого файла (xlsx/pdf) с токеном */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await request('GET', path);
  if (!res.ok) throw await toError(res);
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** PDF в новой вкладке (для печати). Вкладку открываем сразу по клику, иначе её блокирует браузер */
export async function openPdf(path: string): Promise<void> {
  const w = window.open('', '_blank');
  try {
    const res = await request('GET', path);
    if (!res.ok) throw await toError(res);
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (e) {
    w?.close();
    throw e;
  }
}

/** Загрузка файла (multipart, поле file) */
export async function uploadFile<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await request('POST', path, fd);
  if (!res.ok) throw await toError(res);
  return res.json();
}
