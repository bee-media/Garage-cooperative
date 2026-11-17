import { useQuery } from '@tanstack/react-query';
import {
  Activity, BookOpen, CalendarClock, FileSpreadsheet, Gauge, Home, KeyRound, Map as MapIcon, LayoutDashboard, LogOut, Megaphone, Menu, Moon, Newspaper,
  Settings as SettingsIcon, ShieldCheck, Smartphone, Sun, Users, Wallet, Warehouse,
} from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { get, post } from './lib/api';
import { useAuth } from './lib/auth';
import { initials, maskPhone, phoneValid } from './lib/format';
import AdsPage from './pages/Ads';
import AuditPage from './pages/Audit';
import DashboardPage from './pages/Dashboard';
import DataPage from './pages/Data';
import DebtsPage from './pages/Debts';
import GarageCardPage from './pages/GarageCard';
import GaragesPage from './pages/Garages';
import MapPage from './pages/Map';
import MetersPage from './pages/Meters';
import NewsPage from './pages/News';
import { PrivacyPage } from './pages/Privacy';
import ReleasesPage from './pages/Releases';
import RolesPage from './pages/Roles';
import SchedulePage from './pages/Schedule';
import SettingsPage from './pages/Settings';
import SecurityPage, { digits6, TwoFactorWizard } from './pages/Security';
import UsersPage from './pages/Users';
import { Field, Modal, PhoneInput, Spinner, useToast } from './ui';

const Logo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#a8dadc" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 5v14h18" /><path d="M6 8l4 3 2-1 3 5 5 1" />
  </svg>
);

function Login() {
  const { login, verifyTwoFactor } = useAuth();
  const [ph, setPh] = useState(() => maskPhone(new URLSearchParams(window.location.search).get('phone') ?? ''));
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Второй шаг входа (код из приложения или резервный код)
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!phoneValid(ph)) return setErr('Телефон в формате 909-111-22-77');
    setBusy(true);
    try { setChallenge(await login(ph, pw)); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try { await verifyTwoFactor(challenge!, code); }
    catch (x: any) {
      setErr(x.message);
      // токен подтверждения живёт 5 минут; если истёк — вернуться к паролю
      if (/Войдите заново/.test(x.message)) { setChallenge(null); setCode(''); setPw(''); }
    } finally { setBusy(false); }
  }

  const header = (
    <div className="brand-big">
      <div className="logo"><Logo size={40} /></div>
      <h1>РОДНИК</h1>
      <p className="sub">Гаражный строительный кооператив · портал правления</p>
    </div>
  );

  if (challenge) {
    const ready = backup ? code.replace(/[\s-]/g, '').length === 10 : code.length === 6;
    return (
      <div className="login">
        <form className="card login-card rise" onSubmit={submitCode} style={{ display: 'grid', gap: 16 }}>
          {header}
          <div style={{ textAlign: 'center' }}>
            <ShieldCheck style={{ color: 'var(--seafoam)' }} />
            <h2 style={{ fontSize: 17, margin: '6px 0 2px' }}>Подтвердите вход</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{backup ? 'Введите один из резервных кодов' : 'Введите 6-значный код из приложения-аутентификатора'}</p>
          </div>
          <Field label={backup ? 'Резервный код' : 'Код'}>
            <input className="input mono" autoFocus autoComplete="one-time-code" inputMode={backup ? 'text' : 'numeric'} maxLength={backup ? 12 : 6}
              placeholder={backup ? 'xxxxx-xxxxx' : '000000'} value={code}
              style={{ fontSize: 22, letterSpacing: backup ? '0.1em' : '0.3em', textAlign: 'center' }}
              onChange={(e) => setCode(backup ? e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') : digits6(e.target.value))} />
          </Field>
          {err && <div className="bad" role="alert">{err}</div>}
          <button className="btn primary" style={{ height: 48 }} disabled={busy || !ready}>{busy ? 'Проверяем…' : 'Войти'}</button>
          <div className="row between">
            <button type="button" className="btn ghost sm" onClick={() => { setBackup(!backup); setCode(''); setErr(null); }}>{backup ? 'Код из приложения' : 'Нет телефона? Резервный код'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setChallenge(null); setCode(''); setPw(''); setErr(null); setBackup(false); }}>Назад</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="card login-card rise" onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        {header}
        <Field label="Телефон"><PhoneInput value={ph} onChange={setPh} autoFocus /></Field>
        <Field label="Пароль"><input className="input mono" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} maxLength={128} /></Field>
        {err && <div className="bad" role="alert">{err}</div>}
        <button className="btn primary" style={{ height: 48 }} disabled={busy || !pw}>{busy ? 'Вход…' : 'Войти'}</button>
        <p className="muted" style={{ textAlign: 'center', fontSize: 12, margin: 0 }}>Пароль выдаёт председатель правления</p>
      </form>
    </div>
  );
}

/** Сотрудник без настроенной 2FA при включённой политике видит только мастер настройки */
function TwoFactorGate({ children }: { children: ReactNode }) {
  const { me, reload, logout } = useAuth();
  if (!me?.twoFactor?.setupRequired) return <>{children}</>;
  return (
    <>
      <div className="login"><div className="contours" /></div>
      <Modal title="Включите двухфакторную защиту" size="wide" onClose={() => {}} footer={<button className="btn" onClick={logout}>Выйти</button>}>
        <p className="muted" style={{ marginTop: 0 }}>Для сотрудников правления вход по одному паролю закрыт. Настройка займёт пару минут.</p>
        <TwoFactorWizard onDone={() => reload()} />
      </Modal>
    </>
  );
}
function ConsentGate({ children }: { children: ReactNode }) {
  const { me, reload, logout } = useAuth();
  const toast = useToast();
  const [ok, setOk] = useState(false);
  if (!me?.consentRequired) return <>{children}</>;
  return (
    <>
      <div className="login"><div className="contours" /></div>
      <Modal title="Согласие на обработку персональных данных" onClose={() => {}} footer={
        <>
          <button className="btn" onClick={logout}>Выйти</button>
          <button className="btn primary" disabled={!ok} onClick={async () => { try { await post('/auth/consent'); await reload(); } catch (e: any) { toast(e.message, 'err'); } }}>Продолжить</button>
        </>
      }>
        <div className="stack">
          <p style={{ margin: 0 }}>Для работы в системе ГСК «Родник» необходимо согласие на обработку персональных данных: ФИО, телефон, адрес электронной почты, сведения о гараже, начислениях и платежах — в целях ведения учёта членов кооператива.</p>
          <p style={{ margin: 0 }} className="muted">Подробнее — в <a href="/privacy" target="_blank" rel="noreferrer">политике конфиденциальности</a>.</p>
          <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />Я даю согласие на обработку персональных данных</label>
        </div>
      </Modal>
    </>
  );
}

function CookieBanner() {
  const [shown, setShown] = useState(() => { try { return !localStorage.getItem('gsk-cookie'); } catch { return true; } });
  if (!shown) return null;
  return (
    <div className="cookie" role="dialog" aria-label="Использование cookie">
      <span style={{ flex: 1, minWidth: 220 }}>Портал использует только необходимые cookie для поддержания сессии. Аналитика и реклама не применяются. <a href="/privacy" target="_blank" rel="noreferrer">Подробнее</a></span>
      <button className="btn primary sm" onClick={() => { try { localStorage.setItem('gsk-cookie', '1'); } catch { /* ok */ } setShown(false); }}>Понятно</button>
    </div>
  );
}

function ThemeToggle() {
  const [t, setT] = useState(document.documentElement.dataset.theme ?? 'dark');
  return (
    <button className="btn ghost sm" onClick={() => {
      const n = t === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = n; setT(n);
      try { localStorage.setItem('gsk-theme', n); } catch { /* ok */ }
    }}>{t === 'dark' ? <Sun /> : <Moon />}{t === 'dark' ? 'Светлая тема' : 'Тёмная тема'}</button>
  );
}

function Shell() {
  const { me, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  const pending = useQuery({
    queryKey: ['nav-counts'], refetchInterval: 60_000, enabled: can('meters.view') || can('ads.moderate'),
    queryFn: async () => ({
      meters: can('meters.view') ? (await get('/meters', { status: 'PENDING', pageSize: 1 })).total : 0,
      ads: can('ads.moderate') ? (await get('/ads/moderation', { status: 'PENDING', pageSize: 1 })).pendingCount : 0,
    }),
  });

  const items: { to: string; label: string; icon: ReactNode; perm?: string; count?: number; section?: string }[] = [
    { to: '/', label: 'Обзор', icon: <LayoutDashboard />, perm: 'dashboard.view' },
    { to: '/debts', label: 'Задолженности', icon: <Wallet />, perm: 'debts.view', section: 'Учёт' },
    { to: '/garages', label: 'Гаражи', icon: <Warehouse />, perm: 'garages.view' },
    { to: '/users', label: 'Пользователи', icon: <Users />, perm: 'users.view' },
    { to: '/map', label: 'Карта ГСК', icon: <MapIcon />, perm: 'map.view' },
    { to: '/data', label: 'Данные (Excel)', icon: <FileSpreadsheet />, perm: 'data.export' },
    { to: '/meters', label: 'Показания', icon: <Gauge />, perm: 'meters.view', count: pending.data?.meters },
    { to: '/news', label: 'Новости', icon: <Newspaper />, perm: 'news.edit', section: 'Общение' },
    { to: '/ads', label: 'Объявления', icon: <Megaphone />, perm: 'ads.moderate', count: pending.data?.ads },
    { to: '/schedule', label: 'Расписание и контакты', icon: <CalendarClock />, perm: 'schedule.edit' },
    { to: '/releases', label: 'Приложение', icon: <Smartphone />, perm: 'releases.manage', section: 'Система' },
    { to: '/roles', label: 'Роли и права', icon: <KeyRound />, perm: 'roles.manage' },
    { to: '/audit', label: 'Журнал действий', icon: <Activity />, perm: 'audit.view' },
    { to: '/settings', label: 'Настройки', icon: <SettingsIcon />, perm: 'settings.finance' },
    { to: '/security', label: 'Безопасность', icon: <ShieldCheck /> },
  ].filter((i) => !i.perm || can(i.perm));

  const first = items[0]?.to ?? '/';
  return (
    <div className="shell">
      <div className="contours" />
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="brand">
          <div className="logo"><Logo /></div>
          <div><b>РОДНИК</b><small>ГСК · правление</small></div>
        </div>
        <nav className="nav">
          {items.map((i) => (
            <div key={i.to}>
              {i.section && <div className="nav-sec">{i.section}</div>}
              <NavLink to={i.to} end={i.to === '/'}>{i.icon}<span>{i.label}</span>{!!i.count && <span className="count">{i.count}</span>}</NavLink>
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="me">
            <div className="av">{initials(me?.fullName)}</div>
            <div><b>{me?.fullName ?? me?.phone}</b><small>{me?.role.name}</small></div>
          </div>
          <ThemeToggle />
          <button className="btn ghost sm" onClick={logout}><LogOut />Выйти</button>
        </div>
      </aside>
      <main className="main">
        <button className="btn icon menu-btn" style={{ marginBottom: 14 }} onClick={() => setOpen(true)} aria-label="Меню"><Menu /></button>
        <Routes>
          <Route path="/" element={can('dashboard.view') ? <DashboardPage /> : <Navigate to={first} replace />} />
          <Route path="/debts" element={<Guard perm="debts.view"><DebtsPage /></Guard>} />
          <Route path="/garages" element={<Guard perm="garages.view"><GaragesPage /></Guard>} />
          <Route path="/garages/:id" element={<Guard perm="garages.view"><GarageCardPage /></Guard>} />
          <Route path="/users" element={<Guard perm="users.view"><UsersPage /></Guard>} />
          <Route path="/map" element={<Guard perm="map.view"><MapPage /></Guard>} />
          <Route path="/data" element={<Guard perm="data.export"><DataPage /></Guard>} />
          <Route path="/meters" element={<Guard perm="meters.view"><MetersPage /></Guard>} />
          <Route path="/news" element={<Guard perm="news.edit"><NewsPage /></Guard>} />
          <Route path="/ads" element={<Guard perm="ads.moderate"><AdsPage /></Guard>} />
          <Route path="/schedule" element={<Guard perm="schedule.edit"><SchedulePage /></Guard>} />
          <Route path="/releases" element={<Guard perm="releases.manage"><ReleasesPage /></Guard>} />
          <Route path="/roles" element={<Guard perm="roles.manage"><RolesPage /></Guard>} />
          <Route path="/audit" element={<Guard perm="audit.view"><AuditPage /></Guard>} />
          <Route path="/settings" element={<Guard perm="settings.finance"><SettingsPage /></Guard>} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="*" element={<Navigate to={first} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Guard({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? <>{children}</> : <div className="card"><div className="empty"><ShieldCheck /><div>Недостаточно прав для этого раздела</div></div></div>;
}

export default function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loc.pathname === '/privacy') return <PrivacyPage />;
  if (loading) return <div className="login"><Spinner /></div>;
  return (
    <>
      {!me ? (
        <>
          <div className="contours" />
          <Login />
        </>
      ) : !me.portalAccess ? (
        <NoAccess />
      ) : (
        <ConsentGate><TwoFactorGate><Shell /></TwoFactorGate></ConsentGate>
      )}
      <CookieBanner />
    </>
  );
}

function NoAccess() {
  const { logout } = useAuth();
  return (
    <div className="login">
      <div className="card login-card" style={{ textAlign: 'center' }}>
        <BookOpen style={{ width: 40, height: 40, color: 'var(--seafoam)' }} />
        <h2 style={{ margin: '12px 0 8px' }}>Доступ только для правления</h2>
        <p className="muted">Жителям доступно мобильное приложение «ГСК Родник». Установите его или откройте версию для телефона.</p>
        <button className="btn" onClick={logout}><Home />Выйти</button>
      </div>
    </div>
  );
}

