import { useQuery } from '@tanstack/react-query';
import { Mail, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { COLOR_LABEL, phone, rub } from '../lib/format';
import { BenefitBadge, DebtBuoy, Empty, ExportButton, PageHead, Pager, PdfButton, SearchInput, Spinner, useConfirm, useDebounced, useToast } from '../ui';

const COLORS = ['', 'RED', 'ORANGE', 'GREEN'];

export default function DebtsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const color = sp.get('color') ?? '';
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'number' | 'debt'>('number');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const { data, isLoading } = useQuery({
    queryKey: ['debts', dq, color, sort, page],
    queryFn: () => get('/finance/debts', { q: dq, color, sort, page, pageSize: 50 }),
    placeholderData: (p) => p,
  });

  async function sendAll() {
    const body = { color: color === 'RED' || color === 'ORANGE' ? color : undefined };
    try {
      const d = await post('/receipts/debts/send', { ...body, dryRun: true });
      if (!d.emails) return toast(d.debtors ? 'У должников не указана почта' : 'Должников нет', 'err');
      const ok = await confirm({
        title: 'Разослать квитанции?',
        text: `Должников: ${d.debtors}. Письма уйдут на ${d.emails} адр., без почты: ${d.garagesWithoutEmail} гар. Каждому — квитанция в PDF.`, ok: 'Отправить',
      });
      if (!ok) return;
      const r = await post('/receipts/debts/send', body);
      toast(`Отправлено писем: ${r.sent}${r.failed ? `, ошибок: ${r.failed}` : ''}`, r.failed ? 'err' : 'ok');
    } catch (e: any) { toast(e.message, 'err'); }
  }

  return (
    <div className="rise">
      <PageHead title="Задолженности" sub="Электроэнергия и членские взносы по всем гаражам" actions={<>
        {can('data.export') && <ExportButton path="/export/debts.xlsx" name="debts.xlsx" />}
        {can('payments.edit') && <PdfButton label="Квитанции должникам" path={`/receipts/debts.pdf${color === 'RED' || color === 'ORANGE' ? '?color=' + color : ''}`} />}
        {can('payments.edit') && <button className="btn" onClick={sendAll}><Mail />Разослать на почту</button>}
      </>} />
      <div className="card flush">
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Гараж, ФИО или телефон" />
          <div className="chips">
            {COLORS.map((c) => (
              <button key={c} className={`chip ${color === c ? 'on' : ''}`} onClick={() => { setSp(c ? { color: c } : {}); setPage(1); }}>
                {c && <DebtBuoy color={c} />}{c ? COLOR_LABEL[c] : 'Все'}
              </button>
            ))}
          </div>
          <select className="input" style={{ width: 190 }} value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Сортировка">
            <option value="number">По номеру гаража</option><option value="debt">По сумме долга</option>
          </select>
        </div>
        {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Wallet />} /> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Гараж</th><th>Владелец</th><th>Телефон</th><th className="r">Электро&shy;энергия</th><th className="r">Взносы</th><th className="r">Пеня</th><th className="r">К оплате</th></tr></thead>
              <tbody>
                {data.items.map((r: any) => (
                  <tr key={r.garageId} className={`click row-${r.color}`} onClick={() => nav(`/garages/${r.garageId}`)}>
                    <td><div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}><DebtBuoy color={r.color} /><span className="garage-no">{r.number}</span>{r.hasBenefit && <BenefitBadge pct={r.benefitPercent} />}</div></td>
                    <td>{r.owners.length ? r.owners.map((o: any) => <div key={o.id}>{o.fullName ?? '—'}</div>) : <span className="muted">нет владельца</span>}</td>
                    <td className="mono">{r.owners.length ? r.owners.map((o: any) => <div key={o.id}>{phone(o.phone)}</div>) : '—'}</td>
                    <Money v={r.electricity} /><Money v={r.membership} /><Money v={r.penalty} />
                    <td className={`r num ${r.total > 0 ? 'bad' : 'good'}`} style={{ fontWeight: 600 }}>{r.total > 0 ? rub(r.total) : r.advance > 0 ? `аванс ${rub(r.advance)}` : '0 ₽'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}

function Money({ v }: { v: number }) {
  return <td className={`r num ${v > 0 ? 'warn' : v < 0 ? 'good' : 'muted'}`}>{v === 0 ? '—' : rub(v)}</td>;
}
