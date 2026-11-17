import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // В разработке API проксируется, поэтому cookie обновления сессии работает как на боевом сервере (один origin)
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { sourcemap: false, target: 'es2022' },
});
