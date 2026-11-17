import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Phone, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { del, get, patch, post, put } from '../lib/api';
import { date, phone, phoneDigits, phoneValid, WEEKDAYS } from '../lib/format';
import { Field, Modal, PageHead, PhoneInput, Spinner, useConfirm, useToast } from '../ui';

type Day = { weekday: number; isClosed: boolean; opensAt: string; closesAt: string; note: string };
const blank = (): Day[] => WEEKDAYS.map((_, i) => ({ weekday: i + 1, isClosed: i >= 5, opensAt: '10:00', closesAt: '18:00', note: '' }));

export default function SchedulePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const sched = useQuery({ queryKey: ['schedule'], queryFn: () => get('/schedule') });
  const contacts = useQuery({ queryKey: ['contacts'], queryFn: () => get('/contacts') });
  const [days, setDays] = useState<Day[]>(blank());
  const [note, setNote] = useState('');
  const [exDate, setExDate] = useState('');
  const [exNote, setExNote] = useState('');
  const [contact, setContact] = useState<any | 'new' | null>(null);

  useEffect(() => {
    if (!sched.data) return;
    if (sched.data.days.length) {
      setDays(blank().map((b) => { const d = sched.data.days.find((x: any) => x.weekday === b.weekday); return d ? { weekday: d.weekday, isClosed: d.isClosed, opensAt: d.opensAt ?? '10:00', closesAt: d.closesAt ?? '18:00', note: d.note ?? '' } : b; }));
    }
    setNote(sched.data.note ?? '');
  }, [sched.data]);

  const onErr = (e: any) => toast(e.message, 'err');
  const save = useMutation({ mutationFn: () => put('/schedule', { days: days.map((d) => ({ weekday: d.weekday, isClosed: d.isClosed, opensAt: d.isClosed ? undefined : d.opensAt, closesAt: d.isClosed ? undefined : d.closesAt, note: d.note || undefined })), note }), onSuccess: () => { toast('Расписание сохранено'); qc.invalidateQueries({ queryKey: ['schedule'] }); }, onError: onErr });
  const addEx = useMutation({ mutationFn: () => post('/schedule/exceptions', { date: exDate, note: exNote }), onSuccess: () => { setExDate(''); setExNote(''); qc.invalidateQueries({ queryKey: ['schedule'] }); }, onError: onErr });
  const delEx = useMutation({ mutationFn: (id: number) => del(`/schedule/exceptions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule'] }), onError: onErr });
  const delContact = useMutation({ mutationFn: (id: number) => del(`/contacts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }), onError: onErr });
  const upd = (i: number, p: Partial<Day>) => setDays(days.map((d, k) => (k === i ? { ...d, ...p } : d)));

  if (sched.isLoading) return <Spinner />;
  return (
    <div className="rise">
      <PageHead title="Расписание и контакты" sub="Жители видят это в приложении; по номеру телефона можно сразу позвонить" />
      <div className="grid g-main">
        <div className="stack">
          <div className="card">
            <h3><CalendarClock />Приём правления</h3>
            <div className="stack">
              {days.map((d, i) => (
                <div key={d.weekday} className="row" style={{ gap: 12, flexWrap: 'nowrap', opacity: d.isClosed ? 0.7 : 1 }}>
                  <b style={{ width: 118 }}>{WEEKDAYS[i]}</b>
                  <label className="check" style={{ width: 100 }}><input type="checkbox" checked={d.isClosed} onChange={(e) => upd(i, { isClosed: e.target.checked })} />Выходной</label>
                  <input className="input num" type="time" style={{ width: 120 }} value={d.opensAt} disabled={d.isClosed} onChange={(e) => upd(i, { opensAt: e.target.value })} aria-label="Начало" />
                  <span>—</span>
                  <input className="input num" type="time" style={{ width: 120 }} value={d.closesAt} disabled={d.isClosed} onChange={(e) => upd(i, { closesAt: e.target.value })} aria-label="Конец" />
                  <input className="input" placeholder="Примечание" value={d.note} onChange={(e) => upd(i, { note: e.target.value })} maxLength={200} />
                </div>
              ))}
              <Field label="Общее примечание"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Где находится правление, как пройти, особые условия" /></Field>
              <div className="row end"><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Сохранить расписание</button></div>
            </div>
          </div>

          <div className="card">
            <h3>Исключения (праздники, отпуск)</h3>
            <div className="stack">
              {!sched.data?.exceptions.length && <span className="muted">Предстоящих исключений нет</span>}
              {sched.data?.exceptions.map((e: any) => <div key={e.id} className="row between"><span><b className="num">{date(e.date)}</b> · {e.note}</span><button className="btn icon sm ghost" onClick={() => delEx.mutate(e.id)} aria-label="Удалить"><Trash2 /></button></div>)}
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input className="input" type="date" style={{ width: 170 }} value={exDate} onChange={(e) => setExDate(e.target.value)} />
                <input className="input" placeholder="Например: правление не принимает" value={exNote} onChange={(e) => setExNote(e.target.value)} maxLength={300} />
                <button className="btn" disabled={!exDate || exNote.trim().length < 2} onClick={() => addEx.mutate()}><Plus />Добавить</button>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ alignSelf: 'start' }}>
          <h3><Phone />Контакты</h3>
          <div className="stack">
            {contacts.data?.map((c: any) => (
              <div key={c.id} className="row between" style={{ flexWrap: 'nowrap' }}>
                <div><b>{c.position}</b><div>{c.fullName}</div><div className="mono muted">{phone(c.phone)}</div></div>
                <div className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
                  <button className="btn sm ghost" onClick={() => setContact(c)}>Изменить</button>
                  <button className="btn icon sm ghost" aria-label="Удалить" onClick={async () => { if (await confirm({ title: 'Удалить контакт?', ok: 'Удалить', danger: true })) delContact.mutate(c.id); }}><Trash2 /></button>
                </div>
              </div>))}
            {!contacts.data?.length && <span className="muted">Контактов пока нет</span>}
            <button className="btn" onClick={() => setContact('new')}><Plus />Добавить контакт</button>
          </div>
        </div>
      </div>
      {contact && <ContactModal c={contact === 'new' ? null : contact} onClose={() => setContact(null)} onDone={() => { setContact(null); qc.invalidateQueries({ queryKey: ['contacts'] }); }} />}
    </div>
  );
}

function ContactModal({ c, onClose, onDone }: { c: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ position: c?.position ?? '', fullName: c?.fullName ?? '', phone: c ? phone(c.phone) : '', sort: c?.sort ?? 0 });
  const m = useMutation({
    mutationFn: () => { const body = { position: f.position.trim(), fullName: f.fullName.trim(), phone: phoneDigits(f.phone), sort: Number(f.sort) || 0 }; return c ? patch(`/contacts/${c.id}`, body) : post('/contacts', body); },
    onSuccess: () => { toast('Сохранено'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={c ? 'Контакт' : 'Новый контакт'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={f.position.trim().length < 2 || f.fullName.trim().length < 2 || !phoneValid(f.phone) || m.isPending} onClick={() => m.mutate()}>Сохранить</button></>}>
      <div className="stack">
        <Field label="Должность"><input className="input" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} placeholder="Председатель, Бухгалтер, Электрик" maxLength={100} autoFocus /></Field>
        <Field label="ФИО"><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} maxLength={150} /></Field>
        <Field label="Телефон"><PhoneInput value={f.phone} onChange={(v) => setF({ ...f, phone: v })} /></Field>
        <Field label="Порядок в списке" hint="Меньше — выше"><input className="input num" style={{ width: 100 }} inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value.replace(/\D/g, '') as any })} /></Field>
      </div>
    </Modal>
  );
}
