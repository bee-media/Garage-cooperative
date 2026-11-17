import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearBlobCache, clientKind, get, patch, post, refreshSession, setAuthLostHandler, setSession } from './api';
import { forgetDevice } from './push';

export interface Me {
  id: number; phone: string; fullName: string | null; email: string | null; pushEnabled: boolean;
  consentRequired: boolean; consentVersion: string; role: { id: number; name: string };
  portalAccess: boolean; permissions: string[];
  garages: { id: number; number: string; hasBenefit: boolean }[];
  twoFactor?: { enabled: boolean; required: boolean; setupRequired: boolean; backupCodesLeft: number };
}

interface AuthState {
  me: Me | null; loading: boolean;
  /** Первый шаг входа: если нужен код — вернёт challengeToken, иначе null (вход выполнен) */
  login: (phone: string, password: string) => Promise<string | null>;
  verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  update: (d: { email?: string | null; pushEnabled?: boolean }) => Promise<void>;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const reset = useCallback(() => { setSession(null); clearBlobCache(); qc.clear(); setMe(null); }, [qc]);
  const reload = useCallback(async () => { setMe(await get<Me>('/auth/me')); }, []);

  useEffect(() => {
    setAuthLostHandler(reset);
    (async () => {
      try { if (await refreshSession()) await reload(); } catch { reset(); } finally { setLoading(false); }
    })();
  }, [reload, reset]);

  const login = useCallback(async (phone: string, password: string) => {
    const r = await post<{ accessToken?: string; refreshToken?: string; twoFactorRequired?: boolean; challengeToken?: string }>('/auth/login', {
      phone, password, client: clientKind(), deviceName: navigator.userAgent.slice(0, 80),
    });
    if (r.twoFactorRequired && r.challengeToken) return r.challengeToken;
    setSession(r.accessToken!, r.refreshToken ?? null);
    await reload();
    return null;
  }, [reload]);

  const verifyTwoFactor = useCallback(async (challengeToken: string, code: string) => {
    const r = await post<{ accessToken: string; refreshToken?: string }>('/auth/2fa/verify', { challengeToken, code });
    setSession(r.accessToken, r.refreshToken ?? null);
    await reload();
  }, [reload]);

  const logout = useCallback(async () => {
    await forgetDevice(); // отвязать устройство от push, пока сессия ещё действует
    try { await post('/auth/logout'); } catch { /* сессия уже недействительна */ }
    reset();
  }, [reset]);

  const update = useCallback(async (d: { email?: string | null; pushEnabled?: boolean }) => { setMe(await patch<Me>('/auth/me', d)); }, []);

  const value = useMemo(() => ({ me, loading, login, verifyTwoFactor, logout, reload, update }), [me, loading, login, verifyTwoFactor, logout, reload, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
