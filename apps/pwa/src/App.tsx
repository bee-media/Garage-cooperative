import { Info } from 'lucide-react';
import { useState } from 'react';
import { useEffect, useRef } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { post } from './lib/api';
import { useAuth } from './lib/auth';
import { maskPhone, phoneDigits, phoneValid } from './lib/format';
import { isNative, setupNativeChrome } from './lib/native';
import { initNativePush, syncNativePush } from './lib/push';
import AdDetail from './pages/AdDetail';
import AdForm from './pages/AdForm';
import Ads from './pages/Ads';
import Board from './pages/Board';
import MapView from './pages/MapView';
import MeterDetail from './pages/MeterDetail';
import MeterNew from './pages/MeterNew';
import Meters from './pages/Meters';
import NewsDetail from './pages/NewsDetail';
import NewsList from './pages/NewsList';
import Profile from './pages/Profile';
import { Field, PhoneInput, Sheet, Spinner, useToast } from './ui';

const Logo = ({ size = 40 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#a8dadc" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5v14h18" /><path d="M6 8l4 3 2-1 3 5 5 1" /></svg>
);

function Login() {
  const { login, verifyTwoFactor } = useAuth();
  const [ph, setPh] = useState(() => maskPhone(new URLSearchParams(window.location.search).get('phone') ?? ''));
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Сотрудникам правления после пароля нужен код из приложения-аутентификатора
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!phoneValid(ph)) return setErr('Введите телефон в формате 909-111-22-77');
    setBusy(true);
    try { setChallenge(await login(phoneDigits(ph), pw)); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try { await verifyTwoFactor(challenge!, code); }
    catch (x: any) {
      setErr(x.message);
      if (/Войдите заново/.test(x.message)) { setChallenge(null); setCode(''); setPw(''); }
    } finally { setBusy(false); }
  }

  const brand = (
    <div className="brand">
      <div className="logo"><Logo /></div>
      <h1>РОДНИК</h1>
      <p>Гаражный кооператив — всё под рукой</p>
    </div>
  );

  if (challenge) {
    const ready = backup ? code.replace(/[\s-]/g, '').length === 10 : code.length === 6;
    return (
      <div className="body notab" style={{ paddingTop: 0 }}>
        {brand}
        <form className="card" style={{ padding: 20 }} onSubmit={submitCode}>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>Подтвердите вход</h2>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>{backup ? 'Введите один из резервных кодов' : 'Введите 6-значный код из приложения-аутентификатора'}</p>
          <input className="input big mono" autoFocus autoComplete="one-time-code" inputMode={backup ? 'text' : 'numeric'} maxLength={backup ? 12 : 6}
            placeholder={backup ? 'xxxxx-xxxxx' : '000000'} value={code} style={{ fontSize: backup ? 22 : 30 }}
            onChange={(e) => setCode(backup ? e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') : e.target.value.replace(/\D/g, '').slice(0, 6))} />
          {err && <p className="err" role="alert" style={{ marginTop: 10 }}>{err}</p>}
          <button className="btn p" style={{ marginTop: 14 }} disabled={busy || !ready}>{busy ? 'Проверяем…' : 'Войти'}</button>
          <div className="row between" style={{ marginTop: 10 }}>
            <button type="button" className="btn s sm inline" onClick={() => { setBackup(!backup); setCode(''); setErr(null); }}>{backup ? 'Код из приложения' : 'Резервный код'}</button>
            <button type="button" className="btn s sm inline" onClick={() => { setChallenge(null); setCode(''); setPw(''); setErr(null); setBackup(false); }}>Назад</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="body notab" style={{ paddingTop: 0 }}>
      {brand}
      <form className="card" style={{ padding: 20 }} onSubmit={submit}>
        <Field label="Телефон"><PhoneInput value={ph} onChange={setPh} autoFocus={!ph} /></Field>
        <Field label="Пароль"><input className="input mono" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} maxLength={128} autoFocus={!!ph} /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn p" style={{ marginTop: 10 }} disabled={busy || !pw}>{busy ? 'Входим…' : 'Войти'}</button>
      </form>
      <p className="muted" style={{ textAlign: 'center', fontSize: 13, marginTop: 18, display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}><Info size={16} />Пароль выдаёт председатель правления</p>
    </div>
  );
}

/** Сотруднику правления без 2FA приложение жителя недоступно: настройка — в портале */
function TwoFactorSetupNotice() {
  const { logout } = useAuth();
  return (
    <div className="body notab" style={{ paddingTop: 0 }}>
      <div className="brand"><div className="logo"><Logo /></div><h1>РОДНИК</h1></div>
      <div className="card" style={{ padding: 20, marginTop: 8 }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Нужна двухфакторная защита</h2>
        <p className="muted" style={{ marginBottom: 16 }}>Для сотрудников правления вход по одному паролю закрыт. Откройте портал правления, войдите и включите защиту в разделе «Безопасность», затем войдите здесь снова.</p>
        <button className="btn s" onClick={logout}>Выйти</button>
      </div>
    </div>
  );
}
function ConsentGate() {
  const { logout, reload } = useAuth();
  const toast = useToast();
  const [ok, setOk] = useState(false);
  return (
    <Sheet title="Согласие на обработку данных" onClose={() => {}}>
      <div className="stack">
        <p>Чтобы пользоваться приложением, нужно согласие на обработку персональных данных: ФИО, телефон, email, сведения о гараже, начислениях и платежах — для ведения учёта членов кооператива.</p>
        <p className="muted">Подробнее — в <Link to="/privacy">политике конфиденциальности</Link>.</p>
        <label className="row" style={{ gap: 12, cursor: 'pointer' }}><input type="checkbox" style={{ width: 22, height: 22, accentColor: 'var(--teal)' }} checked={ok} onChange={(e) => setOk(e.target.checked)} />Я даю согласие на обработку персональных данных</label>
        <button className="btn p" disabled={!ok} onClick={async () => { try { await post('/auth/consent'); await reload(); } catch (e: any) { toast(e.message, 'err'); } }}>Продолжить</button>
        <button className="btn s" onClick={logout}>Выйти</button>
      </div>
    </Sheet>
  );
}

function Privacy() {
  return (
    <div className="body notab" style={{ paddingTop: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Политика конфиденциальности</h1>
      <p className="muted" style={{ marginBottom: 16 }}>ГСК «Родник». Черновик — текст подлежит утверждению правлением.</p>
      <div className="stack" style={{ lineHeight: 1.6 }}>
        <h3>Какие данные мы обрабатываем</h3><p>ФИО, телефон, email (по желанию), номер гаража, начисления, платежи, показания счётчика, фотографии показаний и объявлений, технические данные входа.</p>
        <h3>Зачем</h3><p>Учёт членов кооператива, расчёт взносов и электроэнергии, уведомления о новостях и задолженности, доска объявлений, безопасность системы.</p>
        <h3>Хранение</h3><p>Данные хранятся на сервере кооператива в РФ, доступны только уполномоченным членам правления, действия фиксируются в журнале.</p>
        <h3>Ваши права</h3><p>Вы можете запросить сведения о своих данных, их исправление или удаление, обратившись к председателю правления.</p>
      </div>
      <Link to="/" className="btn s" style={{ marginTop: 24 }}>Назад</Link>
    </div>
  );
}

/** Нативная оболочка: кнопка «Назад», системные панели, push-уведомления */
function useNativeShell(signedIn: boolean) {
  const nav = useNavigate();
  const loc = useLocation();
  const path = useRef(loc.pathname);
  path.current = loc.pathname;

  useEffect(() => {
    if (!isNative()) return;
    setupNativeChrome();
    let remove: (() => void) | undefined;
    import('@capacitor/app').then(async ({ App: CapApp }) => {
      const h = await CapApp.addListener('backButton', () => {
        if (path.current !== '/' && window.history.length > 1) nav(-1);
        else CapApp.exitApp();
      });
      remove = () => h.remove();
    });
    return () => remove?.();
  }, [nav]);

  useEffect(() => {
    if (!isNative() || !signedIn) return;
    initNativePush((url) => nav(url)).then(syncNativePush).catch(() => {});
  }, [signedIn, nav]);
}

export default function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  useNativeShell(!!me && !me.consentRequired);
  let content;
  if (loc.pathname === '/privacy') content = <Privacy />;
  else if (loading) content = <div className="center-screen"><Spinner /></div>;
  else if (!me) content = <Login />;
  else if (me.twoFactor?.setupRequired) content = <TwoFactorSetupNotice />;
  else
    content = (
      me.consentRequired ? <ConsentGate /> : (
      <>
        <Routes>
          <Route path="/" element={<NewsList />} />
          <Route path="/news/:id" element={<NewsDetail />} />
          <Route path="/meters" element={<Meters />} />
          <Route path="/meters/new" element={<MeterNew />} />
          <Route path="/meters/:id" element={<MeterDetail />} />
          <Route path="/ads" element={<Ads />} />
          <Route path="/ads/new" element={<AdForm />} />
          <Route path="/ads/:id" element={<AdDetail />} />
          <Route path="/ads/:id/edit" element={<AdForm />} />
          <Route path="/board" element={<Board />} />
          <Route path="/map" element={<MapView />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </>
      ));
  return <div className="app">{content}</div>;
}
