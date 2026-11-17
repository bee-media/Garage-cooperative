import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Download, LogOut, Mail, MonitorSmartphone, Share, Smartphone, Warehouse } from 'lucide-react';
import { useEffect, useState } from 'react';
import { APP_VERSION_CODE, APP_VERSION_NAME, del, get, isNative, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, initials, phone, rub } from '../lib/format';
import { disablePush, enablePush, isAndroid, isIos, isStandalone, pushState, PushState } from '../lib/push';
import { Screen } from '../Screen';
import { Field, Sheet, Spinner, Toggle, useConfirm, useToast } from '../ui';
import { openDownload, useApkUpdate, useAppUpdate } from '../update';

export default function Profile() {
  const { me, update, logout } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [mailSheet, setMailSheet] = useState(false);
  const [email, setEmail] = useState(me?.email ?? '');
  const [ps, setPs] = useState<PushState>('off');
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [iosHelp, setIosHelp] = useState(false);
  const upd = useAppUpdate();
  const apkUpd = useApkUpdate();

  const debt = useQuery({ queryKey: ['my-debt'], queryFn: () => get('/finance/my') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get('/auth/sessions') });
  const apk = useQuery({ queryKey: ['apk'], queryFn: () => get('/releases/latest'), enabled: !isNative() && isAndroid() });
  const [checking, setChecking] = useState(false);
  /** Ручная проверка обновления: показывает, что именно ответил сервер, чтобы было понятно, почему обновление не предлагается */
  async function checkUpdate() {
    setChecking(true);
    try {
      if (!APP_VERSION_CODE) return toast('Версия сборки не определена: приложение собрано без команды android:web', 'err');
      const r = await get('/releases/latest', { current: APP_VERSION_CODE });
      qc.invalidateQueries({ queryKey: ['app-latest'] });
      if (!r.available) toast('На сервере пока нет загруженных версий');
      else if (r.updateAvailable) toast(`Доступна версия ${r.versionName} (сборка ${r.versionCode})`);
      else toast(`Установлена последняя версия: на сервере ${r.versionName} (сборка ${r.versionCode}), у вас сборка ${APP_VERSION_CODE}`);
    } catch (e: any) { toast(e.message, 'err'); } finally { setChecking(false); }
  }
  const refreshPs = () => pushState().then(setPs);
  useEffect(() => { refreshPs(); }, []);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('beforeinstallprompt', h); return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  const revoke = useMutation({ mutationFn: (id: string) => del(`/auth/sessions/${id}`), onSuccess: () => { toast('Устройство отключено'); qc.invalidateQueries({ queryKey: ['sessions'] }); } });
  const revokeAll = useMutation({ mutationFn: () => post('/auth/sessions/revoke-others'), onSuccess: (r) => { toast(`Отключено устройств: ${r.revoked}`); qc.invalidateQueries({ queryKey: ['sessions'] }); } });

  async function togglePush(on: boolean) {
    try {
      if (on) {
        if (ps !== 'on' && ps !== 'unsupported') await enablePush();
        await update({ pushEnabled: true });
      } else {
        await update({ pushEnabled: false });
      }
    } catch (e: any) { toast(e.message, 'err'); }
    refreshPs();
  }

  async function saveEmail() {
    try { await update({ email: email.trim() || null }); toast('Email сохранён'); setMailSheet(false); } catch (e: any) { toast(e.message, 'err'); }
  }

  if (!me) return null;
  const total = debt.data?.total ?? 0;
  return (
    <Screen title="Профиль" tab={4}>
      <div className="card row" style={{ gap: 14 }}>
        <div className="av">{initials(me.fullName)}</div>
        <div style={{ minWidth: 0 }}><div style={{ font: '600 18px var(--display)' }}>{me.fullName ?? 'Без имени'}</div><div className="mono muted" style={{ marginTop: 2 }}>{phone(me.phone)}</div></div>
      </div>

      <div className="sec">Задолженность</div>
      <div className="card">
        {debt.isLoading ? <Spinner /> : (
          <>
            <div className="row between"><span className="muted">Всего к оплате</span></div>
            <div className={`big-num num ${total > 0 ? 'bad' : 'good'}`} style={{ margin: '4px 0 10px' }}>{rub(total)}</div>
            {debt.data?.garages.map((g: any) => (
              <div key={g.garageId} className="kv">
                <span className="row" style={{ gap: 8 }}><Warehouse size={16} />Гараж {g.number}</span>
                <span className="num">{g.total > 0 ? <b className="warn">{rub(g.total)}</b> : g.advance > 0 ? <span className="good">аванс {rub(g.advance)}</span> : <span className="good">нет долга</span>}</span>
              </div>
            ))}
            {debt.data?.garages.map((g: any) => g.total > 0 && (
              <div key={`d${g.garageId}`} className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>№{g.number}: электроэнергия {rub(Math.max(g.electricity, 0))}, взносы {rub(Math.max(g.membership, 0))}{g.penalty > 0 ? `, пеня ${rub(g.penalty)}` : ''}</div>
            ))}
            {total > 0 && <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Оплатить можно в правлении в часы приёма — см. раздел «Правление».</p>}
          </>
        )}
      </div>

      <div className="sec">Данные</div>
      <div className="card">
        <div className="kv"><span>Гаражи</span><b>{me.garages.length ? me.garages.map((g) => g.number).join(', ') : '—'}</b></div>
        <button className="kv" style={{ width: '100%', background: 'none', border: 0, borderTop: '1px solid rgba(168,218,220,.1)', cursor: 'pointer', textAlign: 'left' }} onClick={() => { setEmail(me.email ?? ''); setMailSheet(true); }}>
          <span className="row" style={{ gap: 8, color: 'var(--muted)' }}><Mail size={16} />Email</span><span>{me.email ?? <span style={{ color: 'var(--seafoam)' }}>Указать</span>}</span>
        </button>
      </div>

      <div className="sec">Уведомления</div>
      <div className="card">
        <div className="row between" style={{ gap: 12 }}>
          <div><div className="row" style={{ gap: 8 }}><Bell size={18} /><b>Push-уведомления</b></div><div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Новости правления, напоминание о долге, решения по объявлениям и показаниям</div></div>
          <Toggle on={me.pushEnabled && (ps === 'on' || ps === 'unsupported')} onChange={togglePush} label="Push-уведомления" />
        </div>
        {ps === 'need-install' && <div className="notice info" style={{ marginTop: 12 }}><Share /><div>На iPhone уведомления работают, когда приложение добавлено на экран «Домой» (см. ниже).</div></div>}
        {ps === 'denied' && <div className="notice" style={{ marginTop: 12 }}><Bell /><div>Уведомления запрещены в настройках браузера или телефона. Разрешите их для этого сайта.</div></div>}
      </div>

      <div className="sec">Приложение</div>
      <div className="stack">
        {upd && <div className="notice info"><Download /><div style={{ flex: 1 }}><b>Доступна версия {upd.versionName}</b><div style={{ marginTop: 8 }}><button className="btn p sm inline" disabled={apkUpd.disabled} onClick={() => apkUpd.start(upd)}>{apkUpd.label}</button></div></div></div>}
        {!isNative() && isIos() && !isStandalone() && <button className="btn s" onClick={() => setIosHelp(true)}><Share />Установить на iPhone</button>}
        {!isNative() && installEvt && <button className="btn s" onClick={async () => { installEvt.prompt(); await installEvt.userChoice; setInstallEvt(null); }}><Smartphone />Установить приложение</button>}
        {!isNative() && apk.data?.available && <button className="btn s" onClick={() => openDownload(apk.data.id).catch((e) => toast(e.message, 'err'))}><Download />Скачать для Android · {apk.data.versionName}</button>}
        {isNative() && <div className="muted" style={{ fontSize: 12.5 }}>Версия приложения: {APP_VERSION_NAME || '—'} (сборка {APP_VERSION_CODE})</div>}
        {isNative() && <button className="btn s" disabled={checking} onClick={checkUpdate}><Download />{checking ? 'Проверяем…' : 'Проверить обновления'}</button>}
      </div>

      <div className="sec">Устройства</div>
      <div className="card">
        {sessions.isLoading ? <Spinner /> : sessions.data?.map((s: any) => (
          <div key={s.id} className="kv" style={{ alignItems: 'center' }}>
            <span className="row" style={{ gap: 10, color: 'var(--cream)', minWidth: 0 }}><MonitorSmartphone size={18} style={{ flex: 'none' }} /><span style={{ minWidth: 0 }}>{s.client === 'android' ? 'Android-приложение' : 'Браузер / PWA'}{s.current && <span className="badge b-good" style={{ marginLeft: 8 }}>это устройство</span>}<br /><span className="muted" style={{ fontSize: 12 }}>{dateTime(s.lastUsedAt)}</span></span></span>
            {!s.current && <button className="btn s sm inline" style={{ height: 36 }} onClick={() => revoke.mutate(s.id)}>Выйти</button>}
          </div>
        ))}
        {(sessions.data?.length ?? 0) > 1 && <button className="btn d sm" style={{ marginTop: 12 }} onClick={async () => { if (await confirm({ title: 'Выйти на других устройствах?', text: 'Все остальные устройства будут отключены.', ok: 'Отключить', danger: true })) revokeAll.mutate(); }}>Выйти на всех остальных</button>}
      </div>

      <button className="btn d" style={{ marginTop: 18 }} onClick={async () => { if (await confirm({ title: 'Выйти из аккаунта?', ok: 'Выйти', danger: true })) logout(); }}><LogOut />Выйти</button>
      <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 14 }}>Пароль меняет председатель правления</p>

      {mailSheet && (
        <Sheet title="Email" onClose={() => setMailSheet(false)}>
          <Field label="Адрес электронной почты" hint="Нужен для чеков и восстановления доступа через правление"><input className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={150} autoFocus /></Field>
          <button className="btn p" onClick={saveEmail}>Сохранить</button>
        </Sheet>
      )}
      {iosHelp && (
        <Sheet title="Установка на iPhone" onClose={() => setIosHelp(false)}>
          <ol className="stack muted" style={{ paddingLeft: 20, lineHeight: 1.6 }}>
            <li>Откройте этот сайт в <b style={{ color: 'var(--cream)' }}>Safari</b>.</li>
            <li>Нажмите кнопку «Поделиться» <Share size={14} style={{ verticalAlign: -2 }} /> внизу экрана.</li>
            <li>Выберите «На экран Домой» и подтвердите.</li>
            <li>Откройте приложение с иконки — тогда заработают уведомления.</li>
          </ol>
          <button className="btn p" style={{ marginTop: 16 }} onClick={() => setIosHelp(false)}>Понятно</button>
        </Sheet>
      )}
    </Screen>
  );
}
