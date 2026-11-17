import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { num, phoneTime } from '../lib/format';
import { Screen } from '../Screen';
import { Field, PhotoPicker, Sheet, useToast } from '../ui';

const MIN_PHOTOS = 2, MAX_PHOTOS = 6;
const SEEN_KEY = 'gsk-meter-photo-hint';

export default function MeterNew() {
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp] = useSearchParams();
  const garages = me?.garages ?? [];
  const [gid, setGid] = useState<number>(Number(sp.get('garage')) || garages[0]?.id);
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [now, setNow] = useState(new Date());
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(() => { try { return !localStorage.getItem(SEEN_KEY); } catch { return false; } });
  const last = useQuery({ queryKey: ['meters-my', gid, 1], queryFn: () => get('/meters/my', { garageId: gid, page: 1, pageSize: 10 }), enabled: !!gid });

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const v = Number(value.replace(',', '.'));
  const prev = last.data?.lastValue as number | null | undefined;
  const lower = value !== '' && prev != null && v < prev;
  const valid = value !== '' && Number.isFinite(v) && !lower && ids.length >= MIN_PHOTOS && !!gid;

  async function submit() {
    setBusy(true);
    try {
      // Дата и время берутся с телефона в момент отправки
      await post('/meters', { garageId: gid, value: v, takenAt: new Date().toISOString(), comment: comment.trim() || undefined, fileIds: ids });
      qc.invalidateQueries({ queryKey: ['meters-my'] });
      toast('Показания отправлены. Правление их проверит');
      nav('/meters', { replace: true });
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  }

  return (
    <Screen title="Передать показания" back="/meters">
      {garages.length > 1 && (
        <Field label="Гараж"><select className="input" value={gid} onChange={(e) => setGid(Number(e.target.value))}>{garages.map((g) => <option key={g.id} value={g.id}>Гараж {g.number}</option>)}</select></Field>
      )}

      <div className="card">
        <Field label="Показание счётчика, кВт·ч" hint={prev != null ? <>Предыдущее: <b className="num">{num(prev)}</b></> : undefined} error={lower ? `Меньше предыдущего (${num(prev)}). Проверьте цифры` : null}>
          <input className="input big num" inputMode="decimal" autoComplete="off" placeholder="0" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, '').replace(/([.,]\d).*/, '$1'))} maxLength={11} />
        </Field>
        <div className="row" style={{ gap: 10, color: 'var(--muted)', fontSize: 13 }}><CalendarClock size={18} /><span>Дата и время с телефона: <b className="num" style={{ color: 'var(--cream)' }}>{phoneTime(now)}</b></span></div>
      </div>

      <div className="sec">Фото счётчика</div>
      <div className="notice" role="note" style={{ marginBottom: 12 }}>
        <Eye />
        <div><b>Фото должно быть чётким.</b> На нём хорошо видны <b>цифры на табло</b> и <b>пломба</b>. Нечёткие фото правление не примет.</div>
      </div>
      <PhotoPicker kind="meter" ids={ids} onChange={setIds} max={MAX_PHOTOS} />
      <p className="muted" style={{ fontSize: 12.5, margin: '8px 4px 0' }}>Нужно минимум {MIN_PHOTOS} фото, максимум {MAX_PHOTOS}. Загружено: {ids.length}</p>

      <div className="sec">Комментарий</div>
      <textarea className="input" placeholder="Необязательно" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />

      <button className="btn p" style={{ marginTop: 22 }} disabled={!valid || busy} onClick={submit}>{busy ? 'Отправляем…' : 'Отправить'}</button>
      {!valid && value !== '' && ids.length < MIN_PHOTOS && <p className="muted" style={{ textAlign: 'center', fontSize: 12.5, marginTop: 8 }}>Добавьте ещё фото: {MIN_PHOTOS - ids.length}</p>}

      {hint && (
        <Sheet title="Сначала про фото" onClose={() => {}}>
          <div className="stack">
            <div className="notice"><Eye /><div>Сфотографируйте счётчик так, чтобы были <b>хорошо видны цифры показаний</b> и <b>пломба</b>. Снимайте при хорошем свете, без бликов и смаза.</div></div>
            <p className="muted">Понадобится минимум {MIN_PHOTOS} фото: общий план и крупно табло с пломбой.</p>
            <button className="btn p" onClick={() => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ok */ } setHint(false); }}>Понятно</button>
          </div>
        </Sheet>
      )}
    </Screen>
  );
}
