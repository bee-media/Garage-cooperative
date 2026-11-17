import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearBlobCache, get, post, refreshSession, setAccessToken, setAuthLostHandler } from './api';

export interface TwoFactorState {
  enabled: boolean;
  /** политика требует 2FA от сотрудников */
  required: boolean;
  /** 2FA обязательна, но ещё не настроена: доступен только мастер настройки */
  setupRequired: boolean;
  backupCodesLeft: number;
}

export interface Me {
  id: number; phone: string; fullName: string | null; email: string | null; pushEnabled: boolean;
  consentRequired: boolean; consentVersion: string; role: { id: number; name: string };
  portalAccess: boolean; permissions: string[];
  twoFactor: TwoFactorState;
}

interface AuthState {
  me: Me | null; loading: boolean;
  /** Первый шаг входа. Если нужен код — возвращает challengeToken, иначе null (вход выполнен) */
  login: (phone: string, password: string) => Promise<string | null>;
  /** Второй шаг: код из приложения или резервный код */
  verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const reset = useCallback(() => {
    setAccessToken(null); clearBlobCache(); qc.clear(); setMe(null);
  }, [qc]);

  const reload = useCallback(async () => { setMe(await get<Me>('/auth/me')); }, []);

  useEffect(() => {
    setAuthLostHandler(reset);
    (async () => {
      try {
        if (await refreshSession()) await reload();
      } catch { reset(); } finally { setLoading(false); }
    })();
  }, [reload, reset]);

  const login = useCallback(async (phone: string, password: string) => {
    const r = await post<{ accessToken?: string; twoFactorRequired?: boolean; challengeToken?: string }>(
      '/auth/login', { phone, password, client: 'web-admin', deviceName: navigator.userAgent.slice(0, 80) },
    );
    if (r.twoFactorRequired && r.challengeToken) return r.challengeToken;
    setAccessToken(r.accessToken!);
    await reload();
    return null;
  }, [reload]);

  const verifyTwoFactor = useCallback(async (challengeToken: string, code: string) => {
    const r = await post<{ accessToken: string }>('/auth/2fa/verify', { challengeToken, code });
    setAccessToken(r.accessToken);
    await reload();
  }, [reload]);

  const logout = useCallback(async () => {
    try { await post('/auth/logout'); } catch { /* сессия уже недействительна */ }
    reset();
  }, [reset]);

  const value = useMemo<AuthState>(() => ({
    me, loading, login, verifyTwoFactor, logout, reload,
    can: (...perms) => !!me && me.portalAccess && perms.every((p) => me.permissions.includes(p)),
  }), [me, loading, login, verifyTwoFactor, logout, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
