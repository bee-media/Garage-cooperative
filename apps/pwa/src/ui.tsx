import { AlertTriangle, Camera, ChevronLeft, ChevronRight, Gauge, Images, Inbox, Megaphone, Newspaper, Plus, Search, UserRound, Users, X } from 'lucide-react';
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { fileBlobUrl, uploadImage } from './lib/api';
import { compressImage, maskPhone } from './lib/format';

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/* ───── уведомления ───── */
const ToastCtx = createContext<(t: string, k?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; k: string; t: string }[]>([]);
  const push = useCallback((t: string, k: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, k, t }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), k === 'err' ? 6000 : 3000);
  }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.k}`}>{i.t}</div>)}</div></ToastCtx.Provider>;
}

/* ───── шторка и подтверждение ───── */
export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="sheet-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grab" />
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

type ConfirmOpts = { title: string; text?: ReactNode; ok?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<(ConfirmOpts & { res: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((res) => setS({ ...o, res })), []);
  const close = (v: boolean) => { s?.res(v); setS(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {s && <Sheet title={s.title} onClose={() => close(false)}>
        {s.text && <p className="muted" style={{ marginBottom: 18 }}>{s.text}</p>}
        <div className="stack">
          <button className={`btn ${s.danger ? 'd' : 'p'}`} onClick={() => close(true)}>{s.ok ?? 'Подтвердить'}</button>
          <button className="btn s" onClick={() => close(false)}>Отмена</button>
        </div>
      </Sheet>}
    </ConfirmCtx.Provider>
  );
}

/* ───── каркас экрана ───── */
export function AppBar({ title, back, actions }: { title: string; back?: boolean | string; actions?: ReactNode }) {
  const nav = useNavigate();
  return (
    <div className={`appbar ${back ? 'back' : ''}`}>
      {back && <button className="ib" onClick={() => (typeof back === 'string' ? nav(back) : nav(-1))} aria-label="Назад"><ChevronLeft /></button>}
      <h2>{title}</h2>
      {actions}
    </div>
  );
}

const TABS = [
  { to: '/', label: 'Новости', icon: <Newspaper />, end: true },
  { to: '/meters', label: 'Счётчик', icon: <Gauge /> },
  { to: '/ads', label: 'Объявления', icon: <Megaphone /> },
  { to: '/board', label: 'Правление', icon: <Users /> },
  { to: '/profile', label: 'Профиль', icon: <UserRound /> },
];

export function TabBar({ active, unread }: { active: number; unread?: number }) {
  return (
    <nav className="tabs" aria-label="Разделы">
      <div className="pill" style={{ transform: `translateX(${active * 100}%)` }} />
      {TABS.map((t, i) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={`tab ${i === active ? 'on' : ''}`}>
          {t.icon}{t.label}
          {i === 0 && !!unread && <span className="badge-dot">{unread > 9 ? '9+' : unread}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/* ───── формы ───── */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && !error && <p className="hint">{hint}</p>}{error && <p className="err">{error}</p>}</label>;
}
export function PhoneInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input {...rest} className="input mono" inputMode="numeric" autoComplete="username" placeholder="909-111-22-77" maxLength={13} value={value} onChange={(e) => onChange(maskPhone(e.target.value))} />;
}
export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <div className="search"><Search /><input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />{value && <button className="ib" style={{ width: 28, height: 28 }} onClick={() => onChange('')} aria-label="Очистить"><X style={{ width: 16, height: 16 }} /></button>}</div>;
}
export const Toggle = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => <button role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;

export const Spinner = () => <div className="spinner" aria-label="Загрузка" />;
export const Empty = ({ text, icon }: { text: string; icon?: ReactNode }) => <div className="empty">{icon ?? <Inbox />}<div>{text}</div></div>;

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="ib" disabled={page <= 1} onClick={() => { onPage(page - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }} aria-label="Предыдущая страница"><ChevronLeft /></button>
      <span className="num">Страница {page} из {pages}</span>
      <button className="ib" disabled={page >= pages} onClick={() => { onPage(page + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }} aria-label="Следующая страница"><ChevronRight /></button>
    </div>
  );
}

/* ───── фото (только по токену) ───── */
export function SecureImage({ id, className, onClick }: { id: string; className?: string; onClick?: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; fileBlobUrl(id).then((u) => live && setSrc(u)).catch(() => live && setFailed(true)); return () => { live = false; }; }, [id]);
  if (failed) return <div className={className} style={{ display: 'grid', placeItems: 'center' }}><AlertTriangle className="bad" /></div>;
  if (!src) return <div className={className} />;
  return <img className={className} src={src} alt="Фото" onClick={onClick} loading="lazy" />;
}

/** Полноэкранный просмотр с переключением */
export function Lightbox({ ids, index, onClose }: { ids: string[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const startX = useRef<number | null>(null);
  const go = (d: number) => setI((v) => Math.min(ids.length - 1, Math.max(0, v + d)));
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Просмотр фото"
      onTouchStart={(e) => (startX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => { if (startX.current === null) return; const dx = e.changedTouches[0].clientX - startX.current; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); startX.current = null; }}>
      <div className="top"><span className="muted num">{i + 1} / {ids.length}</span><button className="ib" onClick={onClose} aria-label="Закрыть"><X /></button></div>
      <div className="stage">
        <FullImage id={ids[i]} />
        {i > 0 && <button className="ib nav l" onClick={() => go(-1)} aria-label="Назад"><ChevronLeft /></button>}
        {i < ids.length - 1 && <button className="ib nav r" onClick={() => go(1)} aria-label="Дальше"><ChevronRight /></button>}
      </div>
    </div>
  );
}
function FullImage({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let live = true; setSrc(null); fileBlobUrl(id).then((u) => live && setSrc(u)).catch(() => {}); return () => { live = false; }; }, [id]);
  return src ? <img src={src} alt="Фото" /> : <div className="spinner" />;
}

export function Gallery({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!ids.length) return null;
  return (
    <>
      <div className="photos">{ids.map((id, i) => <SecureImage key={id} id={id} className="photo" onClick={() => setOpen(i)} />)}</div>
      {open !== null && <Lightbox ids={ids} index={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Съёмка на камеру и выбор из галереи; фото сжимается на телефоне и загружается на сервер */
export function PhotoPicker({ kind, ids, onChange, max }: { kind: 'meter' | 'ad'; ids: string[]; onChange: (ids: string[]) => void; max: number }) {
  const toast = useToast();
  const cam = useRef<HTMLInputElement>(null);
  const gal = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const room = max - ids.length;
    const list = Array.from(files).slice(0, Math.max(room, 0));
    if (files.length > list.length) toast(`Можно добавить не более ${max} фото`, 'err');
    setBusy((b) => b + list.length);
    let next = [...ids];
    for (const f of list) {
      try { next = [...next, await uploadImage(kind, await compressImage(f))]; onChange(next); } catch (e: any) { toast(e.message || 'Не удалось загрузить фото', 'err'); } finally { setBusy((b) => b - 1); }
    }
    if (cam.current) cam.current.value = ''; if (gal.current) gal.current.value = '';
  }

  return (
    <>
      <div className="photos">
        {ids.map((id, i) => (
          <div key={id} className="photo-wrap">
            <SecureImage id={id} className="photo" onClick={() => setOpen(i)} />
            <button type="button" onClick={() => onChange(ids.filter((x) => x !== id))} aria-label="Убрать фото"><X /></button>
          </div>
        ))}
        {Array.from({ length: busy }).map((_, i) => <div key={`b${i}`} className="photo add"><div className="spinner" style={{ margin: 0 }} /></div>)}
        {ids.length + busy < max && <button type="button" className="photo add" onClick={() => setMenu(true)}><Plus />Добавить</button>}
      </div>
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => add(e.target.files)} />
      <input ref={gal} type="file" accept="image/jpeg,image/png,image/webp,image/*" multiple hidden onChange={(e) => add(e.target.files)} />
      {menu && (
        <Sheet title="Добавить фото" onClose={() => setMenu(false)}>
          <div className="stack">
            <button className="btn p" onClick={() => { setMenu(false); cam.current?.click(); }}><Camera />Снять на камеру</button>
            <button className="btn s" onClick={() => { setMenu(false); gal.current?.click(); }}><Images />Выбрать из галереи</button>
          </div>
        </Sheet>
      )}
      {open !== null && <Lightbox ids={ids} index={open} onClose={() => setOpen(null)} />}
    </>
  );
}
