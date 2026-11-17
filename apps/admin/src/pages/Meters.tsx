import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Gauge, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, num, phone, rub } from '../lib/format';
import { Empty, Field, Gallery, Modal, PageHead, Pager, Spinner, useToast } from '../ui';

export default function MetersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'PENDING' | 'ACCEPTED'>('PENDING');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['meters', status, page], queryFn: () => get('/meters', { status, page, pageSize: 20 }), placeholderData: (p) => p });

  return (
    <div className="rise">
      <PageHead title="Показания счётчиков" sub="Проверьте фото, затем примите показание. Начисление рассчитается автоматически" />
      <div className="card flush">
        <div className="toolbar"><div className="chips">
          <button className={`chip ${status === 'PENDING' ? 'on' : ''}`} onClick={() => { setStatus('PENDING'); setPage(1); }}>Ждут приёма</button>
          <button className={`chip ${status === 'ACCEPTED' ? 'on' : ''}`} onClick={() => { setStatus('ACCEPTED'); setPage(1); }}>Приняты</button>
        </div></div>
        {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Gauge />} text={status === 'PENDING' ? 'Все показания приняты' : 'Принятых показаний нет'} /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Гараж</th><th>Передал</th><th>Дата с телефона</th><th className="r">Показание</th><th>Фото</th><th>Статус</th><th /></tr></thead>
            <tbody>{data.items.map((r: any) => (
              <tr key={r.id}>
                <td><button className="chip" onClick={() => nav(`/garages/${r.garageId}`)}><span className="garage-no" style={{ minWidth: 0, fontSize: 15 }}>{r.garageNumber}</span></button></td>
                <td>{r.submittedBy?.fullName ?? '—'}<div className="mono muted" style={{ fontSize: 12 }}>{phone(r.submittedBy?.phone)}</div></td>
                <td className="num">{dateTime(r.takenAt)}{r.comment && <div className="muted" style={{ fontSize: 12, maxWidth: 220, whiteSpace: 'normal' }}>{r.comment}</div>}</td>
                <td className="r num" style={{ fontWeight: 600, fontSize: 16 }}>{num(r.value)}</td>
                <td><button className="btn sm" onClick={() => setOpen(r)}>{r.photos.length} фото</button></td>
                <td>{r.status === 'ACCEPTED'
                  ? <div><span className="badge b-good">Принято</span><div className="muted" style={{ fontSize: 12 }}>{r.acceptedBy?.fullName ?? '—'} · {dateTime(r.acceptedAt)}</div>{r.charge && <div className="num" style={{ fontSize: 12 }}>Начислено {rub(r.charge.amount)}</div>}</div>
                  : <span className="badge b-warn">Ждёт приёма</span>}</td>
                <td className="r">{r.status === 'PENDING' && can('meters.accept') && <button className="btn primary sm" onClick={() => setOpen(r)}><Check />Проверить</button>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
      {open && <ReviewModal r={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); qc.invalidateQueries({ queryKey: ['meters'] }); qc.invalidateQueries({ queryKey: ['nav-counts'] }); qc.invalidateQueries({ queryKey: ['d-meters'] }); }} />}
    </div>
  );
}

function ReviewModal({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [value, setValue] = useState(String(r.value));
  const [editing, setEditing] = useState(false);
  const [override, setOverride] = useState('');
  const pending = r.status === 'PENDING';
  const v = Number(value.replace(',', '.'));
  const calc = useQuery({ queryKey: ['calc', r.garageId, v], queryFn: () => get('/finance/electricity/preview', { garageId: r.garageId, value: v }), enabled: pending && can('charges.edit') && v >= 0, retry: false });

  const save = useMutation({ mutationFn: () => patch(`/meters/${r.id}`, { value: v }), onSuccess: () => { toast('Значение исправлено'); setEditing(false); r.value = v; }, onError: (e: any) => toast(e.message, 'err') });
  const accept = useMutation({
    mutationFn: () => post(`/meters/${r.id}/accept`, override !== '' ? { amount: Number(override.replace(',', '.')) } : {}),
    onSuccess: () => { toast('Показание принято'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={`Гараж №${r.garageNumber} · показание`} size="wide" onClose={onClose} footer={pending && can('meters.accept') ? <><button className="btn" onClick={onClose}>Закрыть</button><button className="btn primary" disabled={editing || accept.isPending} onClick={() => accept.mutate()}><Check />Принять показание</button></> : <button className="btn" onClick={onClose}>Закрыть</button>}>
      <div className="stack">
        <Gallery ids={r.photos} />
        <div className="grid g2">
          <div className="card">
            <div className="muted">Показание</div>
            {editing ? (
              <div className="row" style={{ flexWrap: 'nowrap' }}><input className="input num" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, ''))} /><button className="btn primary sm" onClick={() => save.mutate()}>Сохранить</button></div>
            ) : (
              <div className="row between"><b className="num" style={{ font: '600 30px var(--display)' }}>{num(r.value)}</b>{pending && can('meters.accept') && <button className="btn ghost sm" onClick={() => setEditing(true)}><Pencil />Исправить</button>}</div>
            )}
            <div className="muted" style={{ marginTop: 6 }}>Передано {dateTime(r.takenAt)}<br />{r.submittedBy?.fullName} · {phone(r.submittedBy?.phone)}</div>
            {r.comment && <div style={{ marginTop: 8 }}>«{r.comment}»</div>}
          </div>
          {pending && can('charges.edit') && (
            <div className="card">
              <div className="muted">Расчёт начисления</div>
              {calc.isLoading ? <Spinner /> : calc.error ? <div className="bad">{(calc.error as any).message}</div> : calc.data && (
                calc.data.baseline ? <div style={{ marginTop: 6 }}>Первое принятое показание — точка отсчёта, начисления не будет.</div> : (
                  <div style={{ marginTop: 6 }}>
                    <div className="num">{num(calc.data.previous)} → {num(v)} = <b>{num(calc.data.consumption)} кВт·ч</b></div>
                    <div className="num muted">× {num(calc.data.price)} ₽ за кВт·ч</div>
                    <b className="num" style={{ font: '600 26px var(--display)' }}>{rub(calc.data.amount)}</b>
                  </div>
                )
              )}
              <div style={{ marginTop: 12 }}><Field label="Своя сумма вместо расчётной (необязательно)"><input className="input num" inputMode="decimal" value={override} onChange={(e) => setOverride(e.target.value.replace(/[^\d.,]/g, ''))} /></Field></div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
