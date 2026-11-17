import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, ImagePlus, Inbox, Printer, Search, X } from 'lucide-react';
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { downloadFile, fileBlobUrl, openPdf, uploadImage } from './lib/api';
import { COLOR_LABEL, maskPhone } from './lib/format';

/* ───── хуки ───── */
export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/* ───── уведомления ───── */
type Toast = { id: number; kind: 'ok' | 'err'; text: string };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, kind, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok' ? <CheckCircle2 className="good" /> : <AlertTriangle className="bad" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ───── модальные окна ───── */
export function Modal({ title, onClose, children, footer, size }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'wide' | 'xl';
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <h2>{title}</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Закрыть"><X /></button>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

type ConfirmOpts = { title: string; text?: ReactNode; ok?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} footer={<>
          <button className="btn" onClick={() => close(false)}>Отмена</button>
          <button className={`btn ${state.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>{state.ok ?? 'Подтвердить'}</button>
        </>}>
          <div className="muted">{state.text}</div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ───── формы ───── */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

/** Телефон: вводятся только цифры, формат 909-111-22-77 */
export function PhoneInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input {...rest} className="input mono" inputMode="numeric" autoComplete="off" placeholder="909-111-22-77" maxLength={13}
      value={value} onChange={(e) => onChange(maskPhone(e.target.value))} />
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="input-wrap grow">
      <Search />
      <input className="input" value={value} placeholder={placeholder ?? 'Поиск'} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ───── отображение ───── */
export function Spinner() { return <div className="spinner" aria-label="Загрузка" />; }

export function Empty({ text = 'Ничего не найдено', icon }: { text?: string; icon?: ReactNode }) {
  return <div className="empty">{icon ?? <Inbox />}<div>{text}</div></div>;
}

export function PageHead({ title, sub, actions, crumbs }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="pager">
      <span className="num">{from}–{Math.min(page * pageSize, total)} из {total}</span>
      <div className="row">
        <button className="btn icon sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Назад"><ChevronLeft /></button>
        <span className="num">{page} / {pages}</span>
        <button className="btn icon sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Вперёд"><ChevronRight /></button>
      </div>
    </div>
  );
}

export const DebtBuoy = ({ color }: { color: string }) => <span className={`buoy ${color}`} title={COLOR_LABEL[color]} />;
export const BenefitBadge = ({ pct }: { pct?: number }) => <span className="badge b-benefit" title="Льготный гараж">★ Льгота{pct ? ` ${pct}%` : ''}</span>;

/* ───── изображения (только по токену) ───── */
export function SecureImage({ id, className, alt, onClick }: { id: string; className?: string; alt?: string; onClick?: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fileBlobUrl(id).then((u) => live && setSrc(u)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [id]);
  if (failed) return <div className={className} style={{ display: 'grid', placeItems: 'center' }} title="Не удалось загрузить"><AlertTriangle className="bad" /></div>;
  if (!src) return <div className={className} />;
  return <img className={className} src={src} alt={alt ?? 'Фото'} onClick={onClick} loading="lazy" />;
}

export function Gallery({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!ids.length) return <span className="muted">Нет фото</span>;
  return (
    <>
      <div className="photos">
        {ids.map((id, i) => <SecureImage key={id} id={id} className="photo" onClick={() => setOpen(i)} />)}
      </div>
      {open !== null && (
        <Modal title={`Фото ${open + 1} из ${ids.length}`} onClose={() => setOpen(null)} size="xl" footer={
          <>
            <button className="btn" disabled={open <= 0} onClick={() => setOpen(open - 1)}><ChevronLeft /> Назад</button>
            <button className="btn" disabled={open >= ids.length - 1} onClick={() => setOpen(open + 1)}>Дальше <ChevronRight /></button>
          </>
        }>
          <SecureImage id={ids[open]} className="photo lg" />
        </Modal>
      )}
    </>
  );
}

/** Выбор и загрузка нескольких изображений */
export function ImagePicker({ kind, ids, onChange, max }: { kind: 'news' | 'ad' | 'map'; ids: string[]; onChange: (ids: string[]) => void; max: number }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      let next = [...ids];
      for (const f of Array.from(files)) {
        if (next.length >= max) { toast(`Не более ${max} фото`, 'err'); break; }
        next.push(await uploadImage(kind, f));
      }
      onChange(next);
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  }
  return (
    <div className="photos">
      {ids.map((id) => (
        <div key={id} style={{ position: 'relative' }}>
          <SecureImage id={id} className="photo" />
          <button type="button" className="btn icon sm danger" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => onChange(ids.filter((x) => x !== id))} aria-label="Убрать"><X /></button>
        </div>
      ))}
      {ids.length < max && (
        <button type="button" className="photo" style={{ display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => ref.current?.click()} disabled={busy}>
          {busy ? <div className="spinner" style={{ margin: 0 }} /> : <div style={{ textAlign: 'center' }}><ImagePlus /><div style={{ fontSize: 12 }}>Добавить</div></div>}
        </button>
      )}
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => pick(e.target.files)} />
    </div>
  );
}

/* ───── выгрузка / печать ───── */
export function ExportButton({ path, name, label = 'Excel' }: { path: string; name: string; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await downloadFile(path, name); } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
    }}><Download />{busy ? 'Готовим…' : label}</button>
  );
}

export function PdfButton({ path, label, icon, className = 'btn' }: { path: string; label?: string; icon?: ReactNode; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button className={className} disabled={busy} title={label ? undefined : 'Печать'} aria-label={label ?? 'Печать'} onClick={async (e) => {
      e.stopPropagation();
      setBusy(true);
      try { await openPdf(path); } catch (x: any) { toast(x.message, 'err'); } finally { setBusy(false); }
    }}>{icon ?? <Printer />}{label}</button>
  );
}
