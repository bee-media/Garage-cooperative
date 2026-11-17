import '@fontsource-variable/geologica';
import '@fontsource-variable/golos-text';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import './styles.css';
import { ConfirmProvider, ToastProvider } from './ui';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 15_000 } } });

if (import.meta.env.PROD && 'serviceWorker' in navigator && !(window as any).Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
