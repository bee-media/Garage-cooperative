import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Mail, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { dateTime } from '../lib/format';
import { Field, PdfButton, Spinner, useToast } from '../ui';

type S = Record<string, any>;
const digits = (n: number) => (v: string) => v.replace(/\D/g, '').slice(0, n);

/** Шаблон квитанции, почта и журнал писем (раздел «Настройки») */
export default function ReceiptSettings() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['receipt-settings'], queryFn: () => get('/receipts/settings') });
  const mail = useQuery({ queryKey: ['mail-status'], queryFn: () => get('/mail/status') });
  const log = useQuery({ queryKey: ['mail-log'], queryFn: () => get('/mail/log', { pageSize: 8 }) });
  const [s, setS] = useState<S | null>(null);
  const [to, setTo] = useState('');
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: () => put('/receipts/settings', s),
    onSuccess: () => { toast('Шаблон квитанции сохранён'); qc.invalidateQueries({ queryKey: ['receipt-settings'] }); },
    onError: (e: any) => toast(e.message, 'err'),
  });
  const test = useMutation({
    mutationFn: () => post('/mail/test', { to }),
    onSuccess: (r: any) => {
      toast(r.ok ? (r.status === 'dry-run' ? 'Тестовый режим: письмо сохранено в файл, не отправлено' : 'Письмо отправлено') : `Ошибка: ${r.error}`, r.ok ? 'ok' : 'err');
      qc.invalidateQueries({ queryKey: ['mail-log'] });
    },
    onError: (e: any) => toast(e.message, 'err'),
  });

  if (!s) return <div className="card"><Spinner /></div>;
  const set = (k: string, v: any) => setS({ ...s, [k]: v });
  const text = (k: string, label: string, hint?: string, max?: number) => (
    <Field label={label} hint={hint}><input className="input" value={s[k] ?? ''} maxLength={max} onChange={(e) => set(k, e.target.value)} /></Field>
  );
  const num = (k: string, label: string, n: number, hint?: string) => (
    <Field label={label} hint={hint}><input className="input mono" inputMode="numeric" value={s[k] ?? ''} onChange={(e) => set(k, digits(n)(e.target.value))} /></Field>
  );

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <h3><FileText />Квитанции и почта</h3>
      <div className="stack">
        <div className="grid g2">
          {text('orgName', 'Получатель платежа', 'Как в банковских реквизитах', 150)}
          {text('orgAddress', 'Адрес кооператива', undefined, 250)}
          {text('phone', 'Телефон для вопросов', undefined, 60)}
          {text('bankName', 'Банк получателя', undefined, 150)}
        </div>
        <div className="grid g3">
          {num('inn', 'ИНН', 12)}{num('kpp', 'КПП', 9)}{num('bik', 'БИК', 9)}
          {num('account', 'Расчётный счёт', 20)}{num('corrAccount', 'Корр. счёт', 20)}
        </div>
        <Field label="Назначение платежа" hint="Подставляются: {garage} — номер гаража, {fio} — владелец. Попадает в QR-код для оплаты">
          <input className="input" value={s.purposeTemplate ?? ''} maxLength={250} onChange={(e) => set('purposeTemplate', e.target.value)} />
        </Field>
        <div className="grid g2">
          <Field label="Текст сверху квитанции"><textarea className="input area" value={s.headerNote ?? ''} maxLength={600} onChange={(e) => set('headerNote', e.target.value)} /></Field>
          <Field label="Текст внизу (также в письме)" hint="Например, сроки оплаты и график работы кассы"><textarea className="input area" value={s.footerNote ?? ''} maxLength={600} onChange={(e) => set('footerNote', e.target.value)} /></Field>
        </div>
        <div className="grid g2">
          {text('signerPosition', 'Должность подписанта', undefined, 80)}
          {text('signerName', 'ФИО подписанта', undefined, 80)}
        </div>
        <label className="check"><input type="checkbox" checked={!!s.showQr} onChange={(e) => set('showQr', e.target.checked)} />QR-код для оплаты в банковском приложении (по реквизитам и сумме долга)</label>
        <label className="check"><input type="checkbox" checked={!!s.autoEmailPayments} onChange={(e) => set('autoEmailPayments', e.target.checked)} />Автоматически отправлять чек владельцу на почту при каждой принятой оплате</label>
        <div className="row">
          <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Сохранить шаблон</button>
          <PdfButton label="Образец квитанции" path="/receipts/preview.pdf?kind=billing" />
          <PdfButton label="Образец чека" path="/receipts/preview.pdf?kind=payment" />
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Образец строится по сохранённому шаблону — сначала сохраните изменения.</p>

        <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
        <h3 style={{ margin: 0 }}><Mail />Отправка почты</h3>
        {mail.data && (
          <div className="row" style={{ gap: 8 }}>
            <span className={`badge ${mail.data.configured ? 'b-good' : 'b-warn'}`}>{mail.data.configured ? `SMTP: ${mail.data.host}` : 'SMTP не настроен'}</span>
            {mail.data.dryRun && <span className="badge b-off">тестовый режим — письма не уходят, сохраняются в файлы</span>}
            <span className="muted" style={{ fontSize: 12.5 }}>Отправитель: {mail.data.from}</span>
          </div>
        )}
        {mail.data?.dryRun && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Почтовый сервер задаётся переменными SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM в настройках сервера (см. docs/RECEIPTS.md).</p>}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Проверка: отправить тестовое письмо на"><input className="input" type="email" style={{ width: 280 }} value={to} placeholder="you@example.ru" onChange={(e) => setTo(e.target.value)} /></Field>
          <button className="btn" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to) || test.isPending} onClick={() => test.mutate()}><Send />Отправить</button>
        </div>
        {!!log.data?.items?.length && (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Когда</th><th>Кому</th><th>Тема</th><th>Статус</th></tr></thead>
              <tbody>{log.data.items.map((m: any) => (
                <tr key={m.id}>
                  <td>{dateTime(m.createdAt ?? m.at)}</td><td className="mono">{m.toAddr}</td><td>{m.subject}</td>
                  <td><span className={`badge ${m.status === 'sent' ? 'b-good' : m.status === 'failed' ? 'b-warn' : 'b-off'}`} title={m.error ?? ''}>{m.status === 'sent' ? 'отправлено' : m.status === 'failed' ? 'ошибка' : 'тест'}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
