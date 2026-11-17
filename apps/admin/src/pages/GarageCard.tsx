import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Ban, Banknote, Mail, ChevronRight, History, Pencil, Plus, Receipt, RotateCcw, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { COLOR_LABEL, date, dateTime, METHOD_LABEL, phone, rub, TYPE_LABEL } from '../lib/format';
import { BenefitBadge, DebtBuoy, Empty, Field, Gallery, Modal, PageHead, PdfButton, SearchInput, Spinner, useConfirm, useDebounced, useToast } from '../ui';

type Tab = 'fin' | 'meters' | 'ads' | 'log';

export default function GarageCardPage() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('fin');
  const [modal, setModal] = useState<null | 'edit' | 'pay' | 'charge' | 'owner'>(null);

  const g = useQuery({ queryKey: ['garage', id], queryFn: () => get(`/garages/${id}`) });
  const ledger = useQuery({ queryKey: ['ledger', id], queryFn: () => get(`/finance/garages/${id}`), enabled: can('debts.view') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['garage', id] }); qc.invalidateQueries({ queryKey: ['ledger', id] }); qc.invalidateQueries({ queryKey: ['debts'] }); qc.invalidateQueries({ queryKey: ['summary'] }); };
  const onErr = (e: any) => toast(e.message, 'err');
  async function sendReceipt(path: string) {
    try {
      const r = await post(path);
      if (!r.sent && !r.failed) return toast('У владельцев не указана почта — укажите её в карточке пользователя', 'err');
      toast(r.failed ? `Не удалось отправить: ${r.failed}` : `Отправлено писем: ${r.sent}`, r.failed ? 'err' : 'ok');
    } catch (e: any) { onErr(e); }
  }

  const removeOwner = useMutation({ mutationFn: (uid: number) => del(`/garages/${id}/owners/${uid}`), onSuccess: () => { toast('Владелец убран'); refresh(); }, onError: onErr });
  const archive = useMutation({ mutationFn: () => del(`/garages/${id}`), onSuccess: () => { toast('Гараж отправлен в архив'); refresh(); }, onError: onErr });
  const restore = useMutation({ mutationFn: () => post(`/garages/${id}/restore`), onSuccess: () => { toast('Гараж восстановлен'); refresh(); }, onError: onErr });
  const voidItem = useMutation({ mutationFn: (p: string) => post(p), onSuccess: () => { toast('Аннулировано'); refresh(); }, onError: onErr });

  if (g.isLoading) return <Spinner />;
  if (g.error || !g.data) return <Empty text="Гараж не найден" />;
  const gar = g.data;
  const bal = ledger.data?.balance;
  const archived = gar.status === 'ARCHIVED';
  const current = gar.owners.filter((o: any) => !o.toDate);
  const past = gar.owners.filter((o: any) => o.toDate);

  const entries = [
    ...(ledger.data?.charges ?? []).map((c: any) => ({ kind: 'charge', at: c.createdAt, ...c })),
    ...(ledger.data?.payments ?? []).map((p: any) => ({ kind: 'payment', at: p.paidAt, ...p })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <div className="stack rise">
      <PageHead
        crumbs={<><Link to="/garages">Гаражи</Link><ChevronRight size={14} />№{gar.number}</>}
        title={<span className="row" style={{ gap: 14 }}>{bal && <DebtBuoy color={bal.color} />}Гараж №{gar.number}{gar.hasBenefit && <BenefitBadge pct={gar.benefitPercent} />}{archived && <span className="badge b-off">В архиве</span>}</span>}
        sub={bal ? COLOR_LABEL[bal.color] : undefined}
        actions={<>
          {can('payments.edit') && !archived && <button className="btn primary" onClick={() => setModal('pay')}><Banknote />Принять оплату</button>}
          {can('payments.edit') && !archived && <PdfButton label="Квитанция" path={`/receipts/garage/${id}.pdf`} />}
          {can('payments.edit') && !archived && <button className="btn" onClick={() => sendReceipt(`/receipts/garage/${id}/send`)}><Mail />На почту</button>}
          {can('charges.edit') && !archived && <button className="btn" onClick={() => setModal('charge')}><Receipt />Начислить</button>}
          {can('garages.edit') && <button className="btn" onClick={() => setModal('edit')}><Pencil />Изменить</button>}
          {can('garages.delete') && (archived
            ? <button className="btn" onClick={() => restore.mutate()}><RotateCcw />Восстановить</button>
            : <button className="btn danger" onClick={async () => { if (await confirm({ title: `Архивировать гараж №${gar.number}?`, text: 'Владельцы будут отвязаны, вся история сохранится. Действие можно отменить восстановлением.', ok: 'В архив', danger: true })) archive.mutate(); }}><Archive />В архив</button>)}
        </>}
      />

      <div className="grid g-main">
        <div className="stack">
          {bal && (
            <div className="grid g4">
              <div className="card metric"><small>Электроэнергия</small><b className={`num ${bal.electricity > 0 ? 'warn' : ''}`}>{rub(bal.electricity)}</b></div>
              <div className="card metric"><small>Членские взносы</small><b className={`num ${bal.membership > 0 ? 'warn' : ''}`}>{rub(bal.membership)}</b></div>
              <div className="card metric"><small>Пеня</small><b className={`num ${bal.penalty > 0 ? 'warn' : ''}`}>{rub(bal.penalty)}</b></div>
              <div className="card metric"><small>{bal.total > 0 ? 'К оплате' : 'Аванс'}</small><b className={`num ${bal.total > 0 ? 'bad' : 'good'}`}>{rub(bal.total > 0 ? bal.total : bal.advance)}</b></div>
            </div>
          )}

          <div className="tabs" role="tablist">
            {([['fin', 'Начисления и оплаты'], ['meters', 'Показания'], ['ads', 'Объявления'], ['log', 'История изменений']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          <div className="card flush">
            {tab === 'fin' && (!can('debts.view') ? <Empty text="Нет доступа к финансам" /> : !entries.length ? <Empty icon={<Receipt />} text="Начислений и оплат пока нет" /> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Дата</th><th>Операция</th><th>Вид</th><th>Комментарий</th><th className="r">Сумма</th><th /></tr></thead>
                <tbody>{entries.map((e: any) => (
                  <tr key={`${e.kind}${e.id}`} style={e.voidedAt ? { opacity: 0.45, textDecoration: 'line-through' } : undefined}>
                    <td className="num">{date(e.at)}</td>
                    <td>{e.kind === 'charge' ? <span className="badge b-warn">Начисление</span> : <span className="badge b-good">Оплата · {METHOD_LABEL[e.method] ?? e.method}</span>}</td>
                    <td>{TYPE_LABEL[e.type]}{e.period ? <span className="muted"> · {e.period}</span> : null}</td>
                    <td className="muted wrap">{e.description ?? e.comment ?? ''}</td>
                    <td className={`r num ${e.kind === 'charge' ? 'warn' : 'good'}`}>{e.kind === 'charge' ? '+' : '−'}{rub(Math.abs(e.amount))}</td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>{e.kind === 'payment' && !e.voidedAt && can('payments.edit') && (<>
                      <PdfButton className="btn icon sm ghost" path={`/receipts/payment/${e.id}.pdf`} />
                      <button className="btn icon sm ghost" title="Отправить чек на почту" aria-label="Отправить чек на почту" onClick={() => sendReceipt(`/receipts/payment/${e.id}/send`)}><Mail /></button>
                    </>)}{!e.voidedAt && can(e.kind === 'charge' ? 'charges.edit' : 'payments.edit') && (
                      <button className="btn icon sm ghost" title="Аннулировать" aria-label="Аннулировать" onClick={async () => { if (await confirm({ title: 'Аннулировать запись?', text: 'Запись останется в истории как аннулированная.', ok: 'Аннулировать', danger: true })) voidItem.mutate(`/finance/${e.kind === 'charge' ? 'charges' : 'payments'}/${e.id}/void`); }}><Ban /></button>
                    )}</td>
                  </tr>))}</tbody>
              </table></div>
            ))}
            {tab === 'meters' && <MetersTab garageId={id} />}
            {tab === 'ads' && <AdsTab number={gar.number} />}
            {tab === 'log' && <LogTab garageId={id} />}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h3>Владельцы {current.length > 1 && <span className="badge b-off">{current.length}</span>}</h3>
            {!current.length && <p className="muted" style={{ margin: 0 }}>Владелец не назначен</p>}
            <div className="stack">
              {current.map((o: any) => (
                <div key={o.id} className="row between" style={{ flexWrap: 'nowrap' }}>
                  <div><Link to={`/users?q=${o.user.phone}`}><b>{o.user.fullName ?? 'Без имени'}</b></Link><div className="mono muted">{phone(o.user.phone)}</div>{o.user.email && <div className="muted" style={{ fontSize: 12 }}>{o.user.email}</div>}<div className="muted" style={{ fontSize: 12 }}>с {date(o.fromDate)}</div></div>
                  {can('garages.edit') && <button className="btn icon sm ghost" title="Убрать владельца" onClick={async () => { if (await confirm({ title: 'Убрать владельца?', text: `${o.user.fullName ?? o.user.phone} перестанет видеть этот гараж. В истории запись останется.`, ok: 'Убрать', danger: true })) removeOwner.mutate(o.user.id); }}><UserMinus /></button>}
                </div>
              ))}
              {can('garages.edit') && !archived && <button className="btn sm" onClick={() => setModal('owner')}><UserPlus />Добавить владельца</button>}
            </div>
          </div>

          <div className="card">
            <h3>Сведения</h3>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Площадь</dt><dd>{gar.areaM2 ? `${gar.areaM2} м²` : '—'}</dd>
              <dt>Год постройки</dt><dd>{gar.buildYear ?? '—'}</dd>
              <dt>Льгота</dt><dd>{gar.hasBenefit ? `${gar.benefitPercent}% на взносы` : 'нет'}</dd>
              <dt>Отметки</dt><dd>{gar.notes || '—'}</dd>
            </dl>
          </div>

          {!!past.length && (
            <div className="card">
              <h3><History />Прежние владельцы</h3>
              <div className="stack">{past.map((o: any) => (
                <div key={o.id}><b>{o.user.fullName ?? o.user.phone}</b><div className="muted" style={{ fontSize: 12 }}>{date(o.fromDate)} — {date(o.toDate)}</div></div>
              ))}</div>
            </div>
          )}
        </div>
      </div>

      {modal === 'edit' && <EditModal g={gar} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); qc.invalidateQueries({ queryKey: ['garages'] }); }} />}
      {modal === 'pay' && <PaymentModal garageId={id} bal={bal} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'charge' && <ChargeModal garageId={id} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'owner' && <OwnerModal garageId={id} current={current.map((o: any) => o.user.id)} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} onNew={() => nav('/users?new=1')} />}
    </div>
  );
}

function MetersTab({ garageId }: { garageId: number }) {
  const { data, isLoading } = useQuery({ queryKey: ['g-meters', garageId], queryFn: () => get('/meters', { garageId, pageSize: 20 }) });
  if (isLoading) return <Spinner />;
  if (!data?.items.length) return <Empty text="Показания не передавались" />;
  return (
    <div className="table-wrap"><table className="t">
      <thead><tr><th>Передано</th><th className="r">Показание</th><th>Статус</th><th>Фото</th></tr></thead>
      <tbody>{data.items.map((r: any) => (
        <tr key={r.id}>
          <td className="num">{dateTime(r.takenAt)}<div className="muted" style={{ fontSize: 12 }}>{r.submittedBy?.fullName}</div></td>
          <td className="r num" style={{ fontWeight: 600 }}>{r.value}</td>
          <td>{r.status === 'ACCEPTED' ? <span className="badge b-good">Принято · {r.acceptedBy?.fullName ?? '—'}</span> : <span className="badge b-warn">Ждёт приёма</span>}</td>
          <td><Gallery ids={r.photos} /></td>
        </tr>))}</tbody>
    </table></div>
  );
}

function AdsTab({ number }: { number: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['g-ads', number], queryFn: () => get('/ads/moderation', { q: number, pageSize: 50 }) });
  if (isLoading) return <Spinner />;
  const items = (data?.items ?? []).filter((a: any) => a.garageNumber === number);
  if (!items.length) return <Empty text="Объявлений по этому гаражу нет" />;
  const L: Record<string, string> = { PENDING: 'На модерации', APPROVED: 'Опубликовано', REJECTED: 'Отклонено', ARCHIVED: 'В архиве' };
  return (
    <div className="table-wrap"><table className="t">
      <thead><tr><th>Дата</th><th>Тип</th><th className="r">Цена</th><th>Статус</th><th>Автор</th></tr></thead>
      <tbody>{items.map((a: any) => (
        <tr key={a.id}><td className="num">{date(a.createdAt)}</td><td>{a.type === 'SALE' ? 'Продажа' : 'Аренда'}</td><td className="r num">{rub(a.price)}</td><td>{L[a.status]}</td><td>{a.author?.fullName ?? '—'}</td></tr>))}</tbody>
    </table></div>
  );
}

function LogTab({ garageId }: { garageId: number }) {
  const { data, isLoading } = useQuery({ queryKey: ['g-log', garageId], queryFn: () => get('/audit', { entity: 'Garage', entityId: garageId, pageSize: 30 }) });
  if (isLoading) return <Spinner />;
  if (!data?.items.length) return <Empty text="Записей нет (журнал доступен при праве «Просмотр журнала»)" />;
  return <div className="timeline" style={{ padding: '4px 20px' }}>{data.items.map((a: any) => (
    <div className="tl" key={a.id}><span className="muted num">{dateTime(a.at)}</span><span><b>{a.action}</b> · {a.actorPhone ? phone(a.actorPhone) : 'система'}</span></div>))}</div>;
}

function EditModal({ g, onClose, onDone }: { g: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ number: g.number, areaM2: g.areaM2 ?? '', buildYear: g.buildYear ?? '', notes: g.notes ?? '', hasBenefit: g.hasBenefit, benefitPercent: g.benefitPercent });
  const m = useMutation({
    mutationFn: () => patch(`/garages/${g.id}`, {
      number: f.number.trim(), areaM2: f.areaM2 === '' ? null : Number(f.areaM2), buildYear: f.buildYear === '' ? null : Number(f.buildYear),
      notes: f.notes, hasBenefit: f.hasBenefit, benefitPercent: f.hasBenefit ? Number(f.benefitPercent) : 0,
    }),
    onSuccess: () => { toast('Сохранено'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title="Данные гаража" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>Сохранить</button></>}>
      <div className="stack">
        <div className="grid g3">
          <Field label="Номер"><input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} maxLength={12} /></Field>
          <Field label="Площадь, м²"><input className="input num" inputMode="decimal" value={f.areaM2} onChange={(e) => setF({ ...f, areaM2: e.target.value.replace(',', '.') })} /></Field>
          <Field label="Год постройки"><input className="input num" inputMode="numeric" value={f.buildYear} onChange={(e) => setF({ ...f, buildYear: e.target.value.replace(/\D/g, '') })} maxLength={4} /></Field>
        </div>
        <Field label="Особые отметки"><textarea className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={1000} /></Field>
        <div className="row">
          <label className="check"><input type="checkbox" checked={f.hasBenefit} onChange={(e) => setF({ ...f, hasBenefit: e.target.checked })} />Льготный гараж</label>
          {f.hasBenefit && <Field label="Скидка на взносы, %"><input className="input num" style={{ width: 120 }} inputMode="numeric" value={f.benefitPercent} onChange={(e) => setF({ ...f, benefitPercent: Math.min(100, Number(e.target.value.replace(/\D/g, '')) || 0) })} /></Field>}
        </div>
      </div>
    </Modal>
  );
}

const TYPES = [['MEMBERSHIP', 'Членские взносы'], ['ELECTRICITY', 'Электроэнергия'], ['PENALTY', 'Пеня']];

function PaymentModal({ garageId, bal, onClose, onDone }: { garageId: number; bal: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const first = bal?.electricity > 0 && !(bal?.membership > 0) ? 'ELECTRICITY' : 'MEMBERSHIP';
  const [type, setType] = useState(first);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [paidAt, setPaidAt] = useState('');
  const [comment, setComment] = useState('');
  const debt = bal ? ({ ELECTRICITY: bal.electricity, MEMBERSHIP: bal.membership, PENALTY: bal.penalty } as any)[type] : 0;
  const m = useMutation({
    mutationFn: () => post('/finance/payments', { garageId, type, amount: Number(amount.replace(',', '.')), method, comment: comment || undefined, paidAt: paidAt ? `${paidAt}T12:00:00+03:00` : undefined }),
    onSuccess: () => { toast('Оплата внесена'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  const n = Number(amount.replace(',', '.'));
  return (
    <Modal title="Принять оплату" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!(n > 0) || m.isPending} onClick={() => m.mutate()}>Внести {n > 0 ? rub(n) : ''}</button></>}>
      <div className="stack">
        <Field label="За что"><select className="input" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Сумма, ₽" hint={debt > 0 ? `Долг по этому виду: ${rub(debt)}` : debt < 0 ? `Аванс: ${rub(-debt)}` : 'Долга нет — сумма станет авансом'}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} autoFocus />
            {debt > 0 && <button type="button" className="btn" onClick={() => setAmount(String(debt))}>Весь долг</button>}
          </div>
        </Field>
        <div className="grid g2">
          <Field label="Способ"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(METHOD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Дата оплаты" hint="Пусто — сейчас"><input className="input" type="date" value={paidAt} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        </div>
        <Field label="Комментарий"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={300} /></Field>
      </div>
    </Modal>
  );
}

function ChargeModal({ garageId, onClose, onDone }: { garageId: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState('MEMBERSHIP');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('');
  const [description, setDescription] = useState('');
  const n = Number(amount.replace(',', '.'));
  const m = useMutation({
    mutationFn: () => post('/finance/charges', { garageId, type, amount: n, period: period || undefined, description: description || undefined }),
    onSuccess: () => { toast('Начисление добавлено'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title="Ручное начисление" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!n || m.isPending} onClick={() => m.mutate()}>Начислить</button></>}>
      <div className="stack">
        <Field label="Вид"><select className="input" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Сумма, ₽" hint="Отрицательная сумма — корректировка (уменьшение долга)"><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,-]/g, ''))} autoFocus /></Field>
        <div className="grid g2">
          <Field label="Период" hint="Например 2026-Q4"><input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} maxLength={20} /></Field>
          <Field label="Описание"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function OwnerModal({ garageId, current, onClose, onDone, onNew }: { garageId: number; current: number[]; onClose: () => void; onDone: () => void; onNew: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data } = useQuery({ queryKey: ['owner-search', dq], queryFn: () => get('/users', { q: dq, pageSize: 8 }), enabled: dq.length >= 2 });
  const add = useMutation({ mutationFn: (userId: number) => post(`/garages/${garageId}/owners`, { userId }), onSuccess: () => { toast('Владелец добавлен'); onDone(); }, onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title="Добавить владельца" onClose={onClose} footer={<button className="btn" onClick={onNew}><Plus />Создать нового пользователя</button>}>
      <div className="stack">
        <SearchInput value={q} onChange={setQ} placeholder="ФИО или телефон (от 2 символов)" />
        {data?.items.filter((u: any) => !current.includes(u.id)).map((u: any) => (
          <div key={u.id} className="row between card" style={{ padding: 12 }}>
            <div><b>{u.fullName ?? 'Без имени'}</b><div className="mono muted">{phone(u.phone)}</div></div>
            <button className="btn primary sm" onClick={() => add.mutate(u.id)}>Выбрать</button>
          </div>
        ))}
        {data && !data.items.length && <Empty text="Никого не нашли" />}
      </div>
    </Modal>
  );
}
