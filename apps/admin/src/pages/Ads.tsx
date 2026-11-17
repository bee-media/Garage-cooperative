import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, Flag, Megaphone, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, get, post } from '../lib/api';
import { dateTime, phone, rub } from '../lib/format';
import { Empty, Field, Gallery, Modal, PageHead, Pager, SearchInput, Spinner, useConfirm, useDebounced, useToast } from '../ui';

const STATUS: Record<string, [string, string]> = { PENDING: ['На модерации', 'b-warn'], APPROVED: ['Опубликовано', 'b-good'], REJECTED: ['Отклонено', 'b-bad'], ARCHIVED: ['В архиве', 'b-off'] };

export default function AdsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const reported = sp.get('reported') === '1';
  const [status, setStatus] = useState(reported ? '' : 'PENDING');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [reject, setReject] = useState<any | null>(null);
  const [reports, setReports] = useState<any | null>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useQuery({ queryKey: ['ads-mod', dq, status, reported, page], queryFn: () => get('/ads/moderation', { q: dq, status, reported: reported ? '1' : undefined, page, pageSize: 15 }), placeholderData: (p) => p });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ads-mod'] }); qc.invalidateQueries({ queryKey: ['nav-counts'] }); qc.invalidateQueries({ queryKey: ['d-ads'] }); };
  const onErr = (e: any) => toast(e.message, 'err');
  const approve = useMutation({ mutationFn: (id: number) => post(`/ads/${id}/approve`), onSuccess: () => { toast('Опубликовано'); refresh(); }, onError: onErr });
  const archive = useMutation({ mutationFn: (id: number) => post(`/ads/${id}/archive`), onSuccess: () => { toast('Отправлено в архив'); refresh(); }, onError: onErr });
  const remove = useMutation({ mutationFn: (id: number) => del(`/ads/${id}`), onSuccess: () => { toast('Объявление удалено'); refresh(); }, onError: onErr });

  const tabs: [string, string][] = [['PENDING', 'На модерации'], ['APPROVED', 'Опубликованные'], ['REJECTED', 'Отклонённые'], ['ARCHIVED', 'Архив'], ['', 'Все']];
  return (
    <div className="rise">
      <PageHead title="Объявления" sub="Объявления видны жителям только после проверки" />
      <div className="card flush">
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Номер гаража" />
          <div className="chips">
            {tabs.map(([v, l]) => <button key={v} className={`chip ${!reported && status === v ? 'on' : ''}`} onClick={() => { setSp({}); setStatus(v); setPage(1); }}>{l}{v === 'PENDING' && data?.pendingCount ? <span className="badge b-bad">{data.pendingCount}</span> : null}</button>)}
            <button className={`chip ${reported ? 'on' : ''}`} onClick={() => { setSp({ reported: '1' }); setStatus(''); setPage(1); }}><Flag size={14} />С жалобами</button>
          </div>
        </div>
        {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Megaphone />} text="Объявлений нет" /> : (
          <div>{data.items.map((a: any) => (
            <div key={a.id} style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)' }}>
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="garage-no">№{a.garageNumber}</span>
                    <span className="badge b-off">{a.type === 'SALE' ? 'Продажа' : 'Аренда'}</span>
                    <b className="num" style={{ font: '600 18px var(--display)' }}>{rub(a.price)}{a.type === 'RENT' ? ' / мес.' : ''}</b>
                    <span className={`badge ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span>
                    {a.reportCount > 0 && <button className="badge b-bad" style={{ border: 0, cursor: 'pointer' }} onClick={() => setReports(a)}><Flag size={12} />Жалоб: {a.reportCount}</button>}
                  </div>
                  <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>{a.author?.fullName ?? '—'} · <span className="mono">{phone(a.phone)}</span> · {dateTime(a.createdAt)}</div>
                  {a.description && <p style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{a.description}</p>}
                  {a.rejectReason && <p className="bad" style={{ margin: '0 0 10px' }}>Причина отклонения: {a.rejectReason}</p>}
                  <Gallery ids={a.photos} />
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {a.status === 'PENDING' && <><button className="btn primary sm" onClick={() => approve.mutate(a.id)}><Check />Одобрить</button><button className="btn danger sm" onClick={() => setReject(a)}><X />Отклонить</button></>}
                  {a.status === 'APPROVED' && <button className="btn sm" onClick={() => archive.mutate(a.id)}><Archive />В архив</button>}
                  <button className="btn icon sm ghost" title="Удалить" onClick={async () => { if (await confirm({ title: 'Удалить объявление?', text: 'Объявление и его фото будут удалены безвозвратно.', ok: 'Удалить', danger: true })) remove.mutate(a.id); }}><Trash2 /></button>
                </div>
              </div>
            </div>))}</div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
      {reject && <RejectModal ad={reject} onClose={() => setReject(null)} onDone={() => { setReject(null); refresh(); }} />}
      {reports && <ReportsModal ad={reports} onClose={() => setReports(null)} onChanged={refresh} />}
    </div>
  );
}

function RejectModal({ ad, onClose, onDone }: { ad: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => post(`/ads/${ad.id}/reject`, { reason }), onSuccess: () => { toast('Объявление отклонено'); onDone(); }, onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title={`Отклонить объявление (гараж №${ad.garageNumber})`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn danger" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Отклонить</button></>}>
      <Field label="Причина (её увидит автор)"><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus /></Field>
    </Modal>
  );
}

function ReportsModal({ ad, onClose, onChanged }: { ad: any; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['ad-reports', ad.id], queryFn: () => get(`/ads/${ad.id}/reports`) });
  const dismiss = useMutation({ mutationFn: () => del(`/ads/${ad.id}/reports`), onSuccess: () => { toast('Жалобы сброшены'); qc.invalidateQueries({ queryKey: ['ad-reports'] }); onChanged(); onClose(); } });
  return (
    <Modal title={`Жалобы на объявление, гараж №${ad.garageNumber}`} onClose={onClose} footer={<><button className="btn" onClick={() => dismiss.mutate()}>Сбросить жалобы</button><button className="btn primary" onClick={onClose}>Закрыть</button></>}>
      {isLoading ? <Spinner /> : <div className="stack">{data.map((r: any) => (
        <div key={r.id} className="card" style={{ padding: 14 }}><div>{r.reason}</div><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{r.user?.fullName ?? '—'} · {phone(r.user?.phone)} · {dateTime(r.createdAt)}</div></div>))}</div>}
    </Modal>
  );
}
