import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Newspaper, Pencil, Pin, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { dateTime, phone } from '../lib/format';
import { Empty, Field, Gallery, ImagePicker, Modal, PageHead, Pager, SearchInput, Spinner, useConfirm, useDebounced, useToast } from '../ui';

export default function NewsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [readers, setReaders] = useState<any | null>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useQuery({ queryKey: ['news-admin', dq, status, page], queryFn: () => get('/news/admin', { q: dq, status, page, pageSize: 10 }), placeholderData: (p) => p });
  const refresh = () => qc.invalidateQueries({ queryKey: ['news-admin'] });
  const onErr = (e: any) => toast(e.message, 'err');
  const toggle = useMutation({ mutationFn: (n: any) => post(`/news/${n.id}/${n.status === 'HIDDEN' ? 'show' : 'hide'}`), onSuccess: refresh, onError: onErr });
  const remove = useMutation({ mutationFn: (id: number) => del(`/news/${id}`), onSuccess: () => { toast('Новость удалена'); refresh(); }, onError: onErr });

  return (
    <div className="rise">
      <PageHead title="Новости" sub="Публикация новостей для жителей. При публикации жителям уходит push" actions={<button className="btn primary" onClick={() => setEdit('new')}><Plus />Написать новость</button>} />
      <div className="card flush">
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Поиск по заголовку и тексту" />
          <div className="chips">
            {[['', 'Все'], ['PUBLISHED', 'Опубликованные'], ['HIDDEN', 'Снятые']].map(([v, l]) => <button key={v} className={`chip ${status === v ? 'on' : ''}`} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>)}
          </div>
        </div>
        {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Newspaper />} text="Новостей нет" /> : (
          <div>{data.items.map((n: any) => (
            <article key={n.id} style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', opacity: n.status === 'HIDDEN' ? 0.55 : 1 }}>
              <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>{n.pinned && <Pin size={15} color="var(--sand)" />}<h3 style={{ fontSize: 17 }}>{n.title}</h3>{n.status === 'HIDDEN' && <span className="badge b-off">Снята</span>}</div>
                  <div className="muted" style={{ fontSize: 12, margin: '3px 0 8px' }}>{dateTime(n.publishedAt)}</div>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap', maxWidth: 780, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{n.body}</p>
                  {!!n.photos.length && <div style={{ marginTop: 10 }}><Gallery ids={n.photos} /></div>}
                </div>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  <button className="btn sm" onClick={() => setReaders(n)}><Users />{n.readCount}</button>
                  <button className="btn icon sm ghost" title="Изменить" onClick={() => setEdit(n)}><Pencil /></button>
                  <button className="btn icon sm ghost" title={n.status === 'HIDDEN' ? 'Вернуть' : 'Снять с публикации'} onClick={() => toggle.mutate(n)}>{n.status === 'HIDDEN' ? <Eye /> : <EyeOff />}</button>
                  <button className="btn icon sm ghost" title="Удалить" onClick={async () => { if (await confirm({ title: 'Удалить новость?', text: 'Новость и её фото будут удалены безвозвратно. Чтобы лишь скрыть — используйте «Снять с публикации».', ok: 'Удалить', danger: true })) remove.mutate(n.id); }}><Trash2 /></button>
                </div>
              </div>
            </article>))}</div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
      {edit && <NewsModal n={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); refresh(); }} />}
      {readers && <ReadersModal n={readers} onClose={() => setReaders(null)} />}
    </div>
  );
}

function NewsModal({ n, onClose, onDone }: { n: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: n?.title ?? '', body: n?.body ?? '', pinned: n?.pinned ?? false });
  const [ids, setIds] = useState<string[]>(n?.photos ?? []);
  const m = useMutation({
    mutationFn: () => (n ? patch(`/news/${n.id}`, { ...f, fileIds: ids }) : post('/news', { ...f, fileIds: ids })),
    onSuccess: () => { toast(n ? 'Сохранено' : 'Новость опубликована'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={n ? 'Редактирование новости' : 'Новая новость'} size="wide" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={f.title.trim().length < 3 || !f.body.trim() || m.isPending} onClick={() => m.mutate()}>{n ? 'Сохранить' : 'Опубликовать'}</button></>}>
      <div className="stack">
        <Field label="Заголовок"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} autoFocus /></Field>
        <Field label="Текст" hint="Обычный текст, переносы строк сохраняются"><textarea className="input" style={{ minHeight: 180 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={10000} /></Field>
        <Field label="Фотографии (до 10)"><ImagePicker kind="news" ids={ids} onChange={setIds} max={10} /></Field>
        <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />Закрепить вверху списка</label>
      </div>
    </Modal>
  );
}

function ReadersModal({ n, onClose }: { n: any; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['readers', n.id], queryFn: () => get(`/news/${n.id}/readers`) });
  return (
    <Modal title="Кто прочитал" onClose={onClose}>
      {isLoading ? <Spinner /> : (
        <div className="stack">
          <div className="muted">Прочитали <b className="num">{data.readCount}</b> из <b className="num">{data.audience}</b></div>
          <div className="progress"><i style={{ width: `${(data.readCount / Math.max(data.audience, 1)) * 100}%` }} /></div>
          {!data.readers.length ? <Empty text="Пока никто" /> : data.readers.map((r: any) => (
            <div key={r.id} className="row between"><span>{r.fullName ?? 'Без имени'} <span className="mono muted">{phone(r.phone)}</span></span><span className="muted num">{dateTime(r.readAt)}</span></div>
          ))}
        </div>
      )}
    </Modal>
  );
}
