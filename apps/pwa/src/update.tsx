import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { absoluteUrl, APP_VERSION_CODE, get, isNative, post } from './lib/api';
import { apkInstallerPlugin, openExternal } from './lib/native';
import { useToast } from './ui';

/** Есть ли новая версия нативного приложения (для баннера и отметки в профиле) */
export function useAppUpdate() {
  const { data } = useQuery({
    queryKey: ['app-latest'], queryFn: () => get('/releases/latest', { current: APP_VERSION_CODE }),
    enabled: isNative() && APP_VERSION_CODE > 0, refetchInterval: 6 * 3600_000,
  });
  return data?.updateAvailable ? data : null;
}

/** Скачивание APK: подписанная ссылка на 10 минут, только для авторизованного */
export async function openDownload(id: number) {
  const r = await post(`/releases/${id}/link`);
  await openExternal(absoluteUrl(r.url));
}

type Phase = 'idle' | 'downloading' | 'ready' | 'installing';

/**
 * Скачивание и установка обновления прямо из приложения: файл качается внутрь приложения по подписанной ссылке
 * (только авторизованному), проверяется контрольная сумма, затем открывается системный установщик.
 * В браузере (не нативное приложение) — прежнее поведение: ссылка открывается во внешнем браузере.
 */
export function useApkUpdate() {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [pct, setPct] = useState<number | null>(null);
  const busy = useRef(false);

  const start = useCallback(async (rel: { id: number; sha256: string }) => {
    if (!isNative()) { await openDownload(rel.id); return; }
    if (busy.current) return;
    busy.current = true;
    try {
      const { plugin } = await apkInstallerPlugin();
      if (phase !== 'ready') {
        setPhase('downloading'); setPct(0);
        const sub = await plugin.addListener('progress', (p) => setPct(p.total > 0 ? Math.min(99, Math.round((p.loaded / p.total) * 100)) : null));
        try {
          const link = await post(`/releases/${rel.id}/link`);
          await plugin.download({ url: absoluteUrl(link.url), sha256: rel.sha256 });
        } finally { await sub.remove(); }
        setPhase('ready'); setPct(100);
      }
      setPhase('installing');
      const r = await plugin.install();
      if (r.needsPermission) {
        toast('Разрешите установку из этого приложения в открывшихся настройках, вернитесь и нажмите «Установить» ещё раз');
        setPhase('ready');
      } else {
        // установщик открыт; если пользователь отменит, файл остаётся и установку можно повторить
        setPhase('ready');
      }
    } catch (e: any) {
      setPhase('idle'); setPct(null);
      toast(e?.message ?? 'Не удалось установить обновление', 'err');
    } finally { busy.current = false; }
  }, [phase, toast]);

  const label = phase === 'downloading' ? `Скачиваем… ${pct ?? 0}%` : phase === 'ready' ? 'Установить' : phase === 'installing' ? 'Открываем установщик…' : 'Скачать и установить';
  return { phase, pct, start, label, disabled: phase === 'downloading' || phase === 'installing' };
}

export function UpdateBanner() {
  const upd = useAppUpdate();
  const apk = useApkUpdate();
  const [hidden, setHidden] = useState(() => { try { return Number(localStorage.getItem('gsk-upd-snooze') ?? 0) > Date.now(); } catch { return false; } });
  if (!upd || hidden) return null;
  return (
    <div className="banner">
      <div className="notice info" style={{ alignItems: 'flex-start' }}>
        <Download />
        <div style={{ flex: 1 }}>
          <b>Доступна новая версия {upd.versionName}</b>
          {upd.notes && <div className="muted" style={{ fontSize: 12.5, margin: '3px 0 8px' }}>{upd.notes}</div>}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn p sm inline" disabled={apk.disabled} onClick={() => apk.start(upd)}>{apk.label}</button>
            <button className="btn s sm inline" onClick={() => { try { localStorage.setItem('gsk-upd-snooze', String(Date.now() + 24 * 3600_000)); } catch { /* ok */ } setHidden(true); }}>Позже</button>
          </div>
        </div>
      </div>
    </div>
  );
}
