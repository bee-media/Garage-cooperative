import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Flag, Pencil, Phone } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { dateShort, phone, rub } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, Field, Gallery, Sheet, Spinner, useConfirm, useToast } from '../ui';
import { AD_STATUS } from './Ads';

export default function AdDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState('');
  const { data: a, isLoading, error } = useQuery({ queryKey: ['ad', id], queryFn: () => get(`/ads/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ads'] }); qc.invalidateQueries({ queryKey: ['ad', id] }); };

  const archive = useMutation({ mutationFn: () => post(`/ads/${id}/archive`), onSuccess: () => { toast('Объявление отправлено в архив'); refresh(); nav('/ads', { replace: true }); }, onError: (e: any) => toast(e.message, 'err') });
  const send = useMutation({ mutationFn: () => post(`/ads/${id}/report`, { reason: reason.trim() }), onSuccess: () => { toast('Жалоба отправлена. Спасибо!'); setReport(false); setReason(''); }, onError: (e: any) => toast(e.message, 'err') });

  return (
    <Screen title="Объявление" back="/ads">
      {isLoading ? <Spinner /> : error || !a ? <Empty text="Объявление не найдено" /> : (
        <>
          <div className="card" style={{ padding: 20 }}>
            <div className="row between"><b style={{ font: '600 22px var(--display)' }}>Гараж №{a.garageNumber}</b><span className={`badge ${a.type === 'SALE' ? 'b-sand' : 'b-off'}`}>{a.type === 'SALE' ? 'Продаётся' : 'Сдаётся'}</span></div>
            <div className="big-num num" style={{ fontSize: 36, margin: '10px 0' }}>{rub(a.price)}{a.type === 'RENT' && <u>в месяц</u>}</div>
            {a.description && <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 10 }}>{a.description}</p>}
            <div className="muted" style={{ fontSize: 12.5 }}>Размещено {dateShort(a.createdAt)}</div>
            {a.isMine && <div style={{ marginTop: 10 }}><span className={`badge ${AD_STATUS[a.status][1]}`}>{AD_STATUS[a.status][0]}</span></div>}
            {a.isMine && a.status === 'REJECTED' && a.rejectReason && <div className="notice" style={{ marginTop: 12 }}><div><b>Правление отклонило объявление:</b><br />{a.rejectReason}</div></div>}
            {a.isMine && a.status === 'PENDING' && <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>Объявление проверяется правлением и пока не видно другим.</p>}
          </div>

          {!!a.photos.length && <><div className="sec">Фото ({a.photos.length})</div><Gallery ids={a.photos} /></>}

          <div style={{ marginTop: 18 }} className="stack">
            {a.phone && <a href={`tel:+7${a.phone}`} className="btn p"><Phone />Позвонить · {phone(a.phone)}</a>}
            {a.isMine && a.status !== 'ARCHIVED' && (
              <div className="row" style={{ gap: 10 }}>
                <button className="btn s" onClick={() => nav(`/ads/${id}/edit`)}><Pencil />Изменить</button>
                <button className="btn s" onClick={async () => { if (await confirm({ title: 'Отправить в архив?', text: 'Объявление исчезнет с доски и попадёт в архив.', ok: 'В архив' })) archive.mutate(); }}><Archive />В архив</button>
              </div>
            )}
            {a.isMine && <p className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>После изменения объявление снова пройдёт проверку правлением</p>}
            {!a.isMine && a.status === 'APPROVED' && <button className="btn s sm" onClick={() => setReport(true)}><Flag />Пожаловаться</button>}
          </div>
        </>
      )}
      {report && (
        <Sheet title="Пожаловаться на объявление" onClose={() => setReport(false)}>
          <Field label="Что не так?"><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Например: неверная цена, чужой гараж, мошенничество" /></Field>
          <button className="btn p" disabled={reason.trim().length < 3 || send.isPending} onClick={() => send.mutate()}>Отправить</button>
        </Sheet>
      )}
    </Screen>
  );
}
