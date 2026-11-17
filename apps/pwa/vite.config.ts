import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** Версия нативной сборки берётся из android/version.properties — единственного источника правды */
function androidVersion(): { code: string; name: string } {
  try {
    const text = readFileSync(new URL('./android/version.properties', import.meta.url), 'utf8');
    return {
      code: /^VERSION_CODE\s*=\s*(\d+)/m.exec(text)?.[1] ?? '0',
      name: /^VERSION_NAME\s*=\s*(\S+)/m.exec(text)?.[1] ?? '',
    };
  } catch {
    return { code: '0', name: '' };
  }
}

/**
 * Для Android-сборки у страницы нет заголовков nginx (в приложении страницы лежат внутри APK), поэтому политика
 * безопасности контента задаётся метатегом: скрипты только свои, запросы только к своему серверу API.
 * Даже если в страницу удастся внедрить чужой код, он не сможет подгрузить внешний скрипт или отправить данные на чужой адрес.
 */
function androidCsp(apiBase: string): Plugin {
  let origin = '';
  try { origin = apiBase ? new URL(apiBase).origin : ''; } catch { /* неверный адрес — только свой источник */ }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${origin ? ' ' + origin : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
  ].join('; ');
  return {
    name: 'gsk-android-csp',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const android = mode === 'android';
  return {
    plugins: [react(), ...(android ? [androidCsp(env.VITE_API_BASE ?? '')] : [])],
    define: android
      ? { 'import.meta.env.VITE_VERSION_CODE': JSON.stringify(androidVersion().code), 'import.meta.env.VITE_VERSION_NAME': JSON.stringify(androidVersion().name) }
      : {},
    server: {
      port: 5174,
      proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
    },
    build: { sourcemap: false, target: 'es2022' },
  };
});
