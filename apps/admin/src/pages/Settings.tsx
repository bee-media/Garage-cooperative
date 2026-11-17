import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Calculator, Percent, Settings as Cog, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { rub } from '../lib/format';
import ReceiptSettings from './ReceiptSettings';
import { Field, PageHead, Spinner, useConfirm, useToast } from '../ui';

const dec = (s: string) => Number(s.replace(',', '.'));

export default function SettingsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fin = useQuery({ queryKey: ['fin-settings'], queryFn: () => get('/finance/settings') });
  const push = useQuery({ queryKey: ['push-settings'], queryFn: () => get('/push/settings') });
  const pushCfg = useQuery({ queryKey: ['push-config'], queryFn: () => get('/push/config') });
  const ads = useQuery({ queryKey: ['ads-settings'], queryFn: () => get('/ads/settings'), enabled: can('ads.moderate') });

  const [f, setF] = useState<any>(null);
  const [p, setP] = useState<any>(null);
  const [ttl, setTtl] = useState('30');
  useEffect(() => { if (fin.data) setF({ kwhPrice: String(fin.data.kwhPrice), membershipFee: String(fin.data.membershipFee), membershipPeriod: fin.data.membershipPeriod, pen: { ...fin.data.penalty, ratePerDayPercent: String(fin.data.penalty.ratePerDayPercent), graceDays: String(fin.data.penalty.graceDays), capPercent: String(fin.data.penalty.capPercent) } }); }, [fin.data]);
  useEffect(() => { if (push.data) setP(push.data); }, [push.data]);
  useEffect(() => { if (ads.data) setTtl(String(ads.data.ttlDays)); }, [ads.data]);

  const onErr = (e: any) => toast(e.message, 'err');
  const saveFin = useMutation({
    mutationFn: () => put('/finance/settings', { kwhPrice: dec(f.kwhPrice), membershipFee: dec(f.membershipFee), membershipPeriod: f.membershipPeriod, penalty: { enabled: f.pen.enabled, ratePerDayPercent: dec(f.pen.ratePerDayPercent), graceDays: dec(f.pen.graceDays), capPercent: dec(f.pen.capPercent) } }),
    onSuccess: () => { toast('Настройки финансов сохранены'); qc.invalidateQueries({ queryKey: ['fin-settings'] }); }, onError: onErr,
  });
  const savePush = useMutation({ mutationFn: () => put('/push/settings', { debtReminderDay: Number(p.debtReminderDay), windowFromHour: Number(p.windowFromHour), windowToHour: Number(p.windowToHour) }), onSuccess: () => toast('Настройки уведомлений сохранены'), onError: onErr });
  const saveAds = useMutation({ mutationFn: () => put('/ads/settings', { ttlDays: Number(ttl) }), onSuccess: () => toast('Срок объявлений сохранён'), onError: onErr });

  async function membership() {
    try {
      const d = await post('/finance/charges/membership', { dryRun: true });
      if (!d.willCreate) return toast(`За период ${d.period} взнос уже начислен всем гаражам`);
      if (await confirm({ title: `Начислить взнос за ${d.period}?`, text: `Будет создано начислений: ${d.willCreate}, на сумму ${rub(d.total)} (льготы учтены). Уже начисленным гаражам повторно не начисляется.`, ok: 'Начислить' })) {
        const r = await post('/finance/charges/membership', {});
        toast(`Начислено: ${r.willCreate} шт. на ${rub(r.total)}`);
        qc.invalidateQueries({ queryKey: ['debts'] }); qc.invalidateQueries({ queryKey: ['summary'] });
      }
    } catch (e: any) { onErr(e); }
  }
  async function penalties() {
    try {
      const d = await post('/finance/charges/penalties', { dryRun: true });
      if (!d.garages) return toast('Пеню начислять не на что');
      if (await confirm({ title: 'Начислить пеню?', text: `Гаражей: ${d.garages}, общая сумма пени ${rub(d.total)}.`, ok: 'Начислить' })) {
        const r = await post('/finance/charges/penalties', {});
        toast(`Пеня начислена: ${r.garages} гаражей на ${rub(r.total)}`);
        qc.invalidateQueries({ queryKey: ['debts'] }); qc.invalidateQueries({ queryKey: ['summary'] });
      }
    } catch (e: any) { onErr(e); }
  }
  async function reminders() {
    try {
      const d = await post('/push/debt-reminders', { dryRun: true });
      if (!d.candidates) return toast('Некому отправлять: в этом месяце напоминания уже ушли или нет должников с включёнными уведомлениями');
      if (await confirm({ title: 'Отправить напоминания о долге?', text: `Получат: ${d.candidates} чел. Каждому не более одного напоминания в месяц.`, ok: 'Отправить' })) {
        const r = await post('/push/debt-reminders', {});
        toast(`Отправлено: ${r.sent} из ${r.candidates}`);
      }
    } catch (e: any) { onErr(e); }
  }

  if (!f || !p) return <Spinner />;
  return (
    <div className="stack rise">
      <PageHead title="Настройки" sub="Тарифы, пеня, уведомления" />
      <div className="grid g2">
        <div className="card">
          <h3><Zap />Тарифы</h3>
          <div className="stack">
            <Field label="Электроэнергия, ₽ за кВт·ч"><input className="input num" inputMode="decimal" value={f.kwhPrice} disabled={!can('settings.finance')} onChange={(e) => setF({ ...f, kwhPrice: e.target.value.replace(/[^\d.,]/g, '') })} /></Field>
            <div className="grid g2">
              <Field label="Членский взнос, ₽ за гараж"><input className="input num" inputMode="decimal" value={f.membershipFee} onChange={(e) => setF({ ...f, membershipFee: e.target.value.replace(/[^\d.,]/g, '') })} /></Field>
              <Field label="Период взноса"><select className="input" value={f.membershipPeriod} onChange={(e) => setF({ ...f, membershipPeriod: e.target.value })}><option value="quarter">Квартал</option><option value="year">Год</option></select></Field>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Льготным гаражам скидка в процентах применяется к взносу автоматически (процент задаётся в карточке гаража).</p>
            <div className="row">
              <button className="btn primary" disabled={saveFin.isPending} onClick={() => saveFin.mutate()}>Сохранить</button>
              {can('charges.edit') && <button className="btn" onClick={membership}><Calculator />Начислить взнос всем гаражам</button>}
            </div>
          </div>
        </div>

        <div className="card">
          <h3><Percent />Пеня</h3>
          <div className="stack">
            <label className="check"><input type="checkbox" checked={f.pen.enabled} onChange={(e) => setF({ ...f, pen: { ...f.pen, enabled: e.target.checked } })} />Начислять пеню</label>
            <div className="grid g3">
              <Field label="% в день"><input className="input num" inputMode="decimal" value={f.pen.ratePerDayPercent} onChange={(e) => setF({ ...f, pen: { ...f.pen, ratePerDayPercent: e.target.value.replace(/[^\d.,]/g, '') } })} /></Field>
              <Field label="Льготных дней"><input className="input num" inputMode="numeric" value={f.pen.graceDays} onChange={(e) => setF({ ...f, pen: { ...f.pen, graceDays: e.target.value.replace(/\D/g, '') } })} /></Field>
              <Field label="Потолок, % долга"><input className="input num" inputMode="numeric" value={f.pen.capPercent} onChange={(e) => setF({ ...f, pen: { ...f.pen, capPercent: e.target.value.replace(/\D/g, '') } })} /></Field>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Пеня считается от неоплаченной суммы за каждый полный день после льготного срока. Оплаты гасят самые старые начисления. Запускайте начисление раз в месяц или чаще.</p>
            <div className="row"><button className="btn primary" disabled={saveFin.isPending} onClick={() => saveFin.mutate()}>Сохранить</button>{can('charges.edit') && <button className="btn" onClick={penalties} disabled={!fin.data?.penalty.enabled}><Calculator />Начислить пеню сейчас</button>}</div>
          </div>
        </div>

        <div className="card">
          <h3><BellRing />Напоминания должникам</h3>
          <div className="stack">
            <div className="grid g3">
              <Field label="День месяца"><input className="input num" inputMode="numeric" value={p.debtReminderDay} onChange={(e) => setP({ ...p, debtReminderDay: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="С (час МСК)"><input className="input num" inputMode="numeric" value={p.windowFromHour} onChange={(e) => setP({ ...p, windowFromHour: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="До (час МСК)"><input className="input num" inputMode="numeric" value={p.windowToHour} onChange={(e) => setP({ ...p, windowToHour: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Раз в месяц, начиная с указанного дня, в рабочее окно (без выходных). Получают только должники с включёнными уведомлениями.</p>
            <div className="row"><button className="btn primary" onClick={() => savePush.mutate()}>Сохранить</button>{can('charges.edit') && <button className="btn" onClick={reminders}><BellRing />Отправить сейчас</button>}</div>
            {pushCfg.data && <div className="row" style={{ gap: 8 }}>
              <span className={`badge ${pushCfg.data.fcmEnabled ? 'b-good' : 'b-warn'}`}>Android (FCM): {pushCfg.data.fcmEnabled ? 'подключён' : 'не настроен'}</span>
              <span className={`badge ${pushCfg.data.webPushPublicKey ? 'b-good' : 'b-warn'}`}>Web Push: {pushCfg.data.webPushPublicKey ? 'подключён' : 'не настроен'}</span>
              {pushCfg.data.dryRun && <span className="badge b-off">тестовый режим — не отправляется</span>}
            </div>}
          </div>
        </div>

        {can('ads.moderate') && (
          <div className="card">
            <h3><Cog />Доска объявлений</h3>
            <div className="stack">
              <Field label="Автоархив через, дней" hint="Объявление уходит в архив через столько дней после публикации"><input className="input num" style={{ width: 140 }} inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ''))} /></Field>
              <div><button className="btn primary" disabled={!Number(ttl) || saveAds.isPending} onClick={() => saveAds.mutate()}>Сохранить</button></div>
            </div>
          </div>
        )}
        {can('settings.finance') && <ReceiptSettings />}
      </div>
    </div>
  );
}
