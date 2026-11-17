/**
 * Адреса push-сервисов браузеров: Chrome/Opera/Samsung (FCM), Firefox, Safari, Edge (WNS). Только хосты самих
 * push-сервисов: под *.googleapis.com живут и другие API Google (например, хранилище), куда сервер ходить не должен.
 */
const PUSH_HOSTS = [/^(fcm|android)\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/**
 * Web Push: сервер отправляет запрос по адресу из подписки, который прислал клиент. Чтобы это нельзя было
 * использовать для обращений во внутреннюю сеть (SSRF), допускаются только HTTPS-адреса известных push-сервисов.
 */
export function isPushServiceUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 1000) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}
