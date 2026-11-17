import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, KeyRound, MonitorSmartphone, Printer, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { ReactNode, useEffect, useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copyText, dateTime } from '../lib/format';
import { Field, Modal, PageHead, Spinner, useConfirm, useToast } from '../ui';

/** 6 цифр: только цифры, без пробелов */
export const digits6 = (s: string) => s.replace(/\D/g, '').slice(0, 6);

export function BackupCodes({ codes }: { codes: string[] }) {
  const toast = useToast();
  const text = `ГСК «Родник» — резервные коды входа\nКаждый код действует один раз.\n\n${codes.join('\n')}\n`;
  return (
    <div className="stack">
      <div className="card" style={{ background: 'var(--input-bg)' }}>
        <div className="grid g2" style={{ gap: 8 }}>
          {codes.map((c) => <div key={c} className="mono" style={{ fontSize: 17, letterSpacing: '0.06em', textAlign: 'center', padding: '4px 0' }}>{c}</div>)}
        </div>
      </div>
      <div className="row">
        <button className="btn sm" onClick={() => copyText(codes.join('\n')).then(() => toast('Коды скопированы'), (e) => toast(e.message, 'err'))}><Copy />Копировать</button>
        <button className="btn sm" onClick={() => window.print()}><Printer />Печать</button>
        <button className="btn sm" onClick={() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
          a.download = 'gsk-rodnik-backup-codes.txt'; a.click(); URL.revokeObjectURL(a.href);
        }}><Download />Скачать</button>
      </div>
    </div>
  );
}

/** Мастер включения 2FA: QR → первый код → резервные коды */
export function TwoFactorWizard({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'qr' | 'codes'>('qr');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    post('/auth/2fa/setup').then(setSetup).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 220, color: { dark: '#0f1722', light: '#ffffff' } }).then(setQr);
  }, [setup]);

  async function enable() {
    setBusy(true); setErr(null);
    try { const r = await post<{ backupCodes: string[] }>('/auth/2fa/enable', { code }); setCodes(r.backupCodes); setStep('codes'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (step === 'codes') {
    return (
      <div className="stack">
        <div className="notice-box good"><ShieldCheck />Двухфакторная защита включена</div>
        <p style={{ margin: 0 }}><b>Сохраните резервные коды.</b> Если потеряете телефон, войти можно будет только по такому коду. Каждый код работает один раз. Больше они показаны не будут.</p>
        <BackupCodes codes={codes} />
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />Я сохранил(а) резервные коды в надёжном месте</label>
        <div className="row end"><button className="btn primary" disabled={!saved} onClick={() => { toast('Защита включена'); onDone(); }}>Готово</button></div>
      </div>
    );
  }
  if (!setup) return err ? <div className="bad">{err}</div> : <Spinner />;
  const grouped = setup.secret.replace(/(.{4})/g, '$1 ').trim();
  return (
    <div className="stack">
      <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
        <li>Установите на телефон приложение для кодов: <b>Яндекс Ключ</b>, <b>Google Authenticator</b>, <b>Microsoft Authenticator</b>, Aegis или 2FAS.</li>
        <li>Добавьте аккаунт: отсканируйте QR-код (или введите ключ вручную).</li>
        <li>Введите 6-значный код из приложения.</li>
      </ol>
      <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
        {qr ? <img src={qr} alt="QR-код для приложения-аутентификатора" width={200} height={200} style={{ borderRadius: 14, background: '#fff', padding: 6 }} /> : <Spinner />}
        <div className="stack" style={{ minWidth: 220, flex: 1 }}>
          <div><div className="muted" style={{ fontSize: 12 }}>Ключ для ручного ввода</div><div className="mono" style={{ fontSize: 15, wordBreak: 'break-all', userSelect: 'all' }}>{grouped}</div></div>
          <Field label="Код из приложения" error={err}>
            <input className="input mono" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} value={code} autoFocus
              style={{ fontSize: 22, letterSpacing: '0.3em', textAlign: 'center' }}
              onChange={(e) => setCode(digits6(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && enable()} />
          </Field>
          <button className="btn primary" disabled={code.length !== 6 || busy} onClick={enable}>{busy ? 'Проверяем…' : 'Подтвердить и включить'}</button>
        </div>
      </div>
    </div>
  );
}

function CodePrompt({ title, text, action, onClose, onDone }: { title: string; text: ReactNode; action: string; onClose: () => void; onDone: (code: string) => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() { setBusy(true); setErr(null); try { await onDone(code); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={code.length !== 6 || busy} onClick={go}>{action}</button></>}>
      <div className="stack">
        <div className="muted">{text}</div>
        <Field label="Код из приложения" error={err}>
          <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus placeholder="000000"
            style={{ fontSize: 22, letterSpacing: '0.3em', textAlign: 'center' }} onChange={(e) => setCode(digits6(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && go()} />
        </Field>
      </div>
    </Modal>
  );
}

export default function SecurityPage() {
  const { me, reload, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [wizard, setWizard] = useState(false);
  const [prompt, setPrompt] = useState<null | 'regen' | 'disable'>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => get('/auth/sessions') });
  const policy = useQuery({ queryKey: ['sec-policy'], queryFn: () => get('/auth/security-policy') });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/auth/sessions/${id}`), onSuccess: () => { toast('Устройство отключено'); qc.invalidateQueries({ queryKey: ['my-sessions'] }); } });
  const revokeOthers = useMutation({ mutationFn: () => post('/auth/sessions/revoke-others'), onSuccess: (r) => { toast(`Отключено сессий: ${r.revoked}`); qc.invalidateQueries({ queryKey: ['my-sessions'] }); } });
  const setPolicy = useMutation({
    mutationFn: (v: boolean) => put('/auth/security-policy', { require2fa: v }),
    onSuccess: () => { toast('Политика сохранена'); qc.invalidateQueries({ queryKey: ['sec-policy'] }); reload(); }, onError: (e: any) => toast(e.message, 'err'),
  });

  if (!me) return null;
  const tf = me.twoFactor;

  return (
    <div className="stack rise">
      <PageHead title="Безопасность" sub="Двухфакторная защита и устройства вашей учётной записи" />
      <div className="grid g2">
        <div className="card">
          <h3><ShieldCheck />Двухфакторная защита</h3>
          {tf.enabled ? (
            <div className="stack">
              <div className="row"><span className="badge b-good">Включена</span><span className="muted">Резервных кодов осталось: <b className={tf.backupCodesLeft <= 2 ? 'warn' : ''}>{tf.backupCodesLeft}</b></span></div>
              <p className="muted" style={{ margin: 0 }}>При входе после пароля нужен код из приложения на телефоне.</p>
              <div className="row">
                <button className="btn" onClick={() => setPrompt('regen')}><KeyRound />Новые резервные коды</button>
                {!tf.required && <button className="btn danger" onClick={() => setPrompt('disable')}>Отключить</button>}
              </div>
              {tf.required && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Отключить нельзя: двухфакторная защита обязательна для сотрудников правления.</p>}
            </div>
          ) : (
            <div className="stack">
              <div className="row"><span className="badge b-warn"><ShieldAlert size={12} />Не настроена</span></div>
              <p style={{ margin: 0 }}>Пароль могут подсмотреть или подобрать. Код из приложения на вашем телефоне закрывает эту дыру: без телефона войти не получится.</p>
              <div><button className="btn primary" onClick={() => setWizard(true)}><Smartphone />Включить</button></div>
            </div>
          )}
        </div>

        {can('roles.manage') && (
          <div className="card">
            <h3><ShieldAlert />Политика для правления</h3>
            <div className="stack">
              <label className="check"><input type="checkbox" checked={policy.data?.require2fa ?? true} disabled={setPolicy.isPending} onChange={(e) => setPolicy.mutate(e.target.checked)} />Требовать двухфакторную защиту от всех сотрудников</label>
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Сотрудник без настроенной защиты сможет только настроить её (или выйти). Потерявшему телефон сбросьте защиту в разделе «Пользователи».</p>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3><MonitorSmartphone />Активные входы</h3>
        {sessions.isLoading ? <Spinner /> : (
          <div className="stack">
            {sessions.data?.map((s: any) => (
              <div key={s.id} className="row between">
                <div><b>{s.client === 'web-admin' ? 'Портал' : s.client === 'android' ? 'Android-приложение' : 'Браузер (PWA)'}</b>{s.current && <span className="badge b-good" style={{ marginLeft: 8 }}>это устройство</span>}
                  <div className="muted" style={{ fontSize: 12.5 }}>{s.deviceName ?? s.userAgent?.slice(0, 70) ?? '—'} · IP {s.ip ?? '—'} · {dateTime(s.lastUsedAt)}</div></div>
                {!s.current && <button className="btn sm" onClick={() => revoke.mutate(s.id)}>Отключить</button>}
              </div>
            ))}
            {(sessions.data?.length ?? 0) > 1 && <div><button className="btn danger sm" onClick={async () => { if (await confirm({ title: 'Выйти на других устройствах?', text: 'Все остальные входы будут завершены.', ok: 'Отключить', danger: true })) revokeOthers.mutate(); }}>Выйти на всех остальных</button></div>}
          </div>
        )}
      </div>

      {wizard && <Modal title="Включение двухфакторной защиты" size="wide" onClose={() => setWizard(false)}><TwoFactorWizard onDone={() => { setWizard(false); reload(); }} /></Modal>}
      {prompt === 'regen' && (
        <CodePrompt title="Новые резервные коды" text="Старые коды перестанут работать. Введите код из приложения для подтверждения." action="Выпустить"
          onClose={() => setPrompt(null)} onDone={async (code) => { const r = await post<{ backupCodes: string[] }>('/auth/2fa/backup-codes', { code }); setPrompt(null); setNewCodes(r.backupCodes); reload(); }} />
      )}
      {prompt === 'disable' && (
        <CodePrompt title="Отключить защиту" text="Вход снова будет по одному паролю. Введите код из приложения." action="Отключить"
          onClose={() => setPrompt(null)} onDone={async (code) => { await post('/auth/2fa/disable', { code }); setPrompt(null); toast('Защита отключена'); reload(); }} />
      )}
      {newCodes && (
        <Modal title="Ваши новые резервные коды" onClose={() => setNewCodes(null)} footer={<button className="btn primary" onClick={() => setNewCodes(null)}>Я сохранил(а)</button>}>
          <BackupCodes codes={newCodes} />
        </Modal>
      )}
    </div>
  );
}
