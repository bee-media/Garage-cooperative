import { useQuery } from '@tanstack/react-query';
import { Banknote, Flag, Gauge, Megaphone, Receipt, TrendingDown, Warehouse } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateLong, num, rub } from '../lib/format';
import { PageHead, Spinner } from '../ui';

export default function DashboardPage() {
  const nav = useNavigate();
  const { can, me } = useAuth();
  const sum = useQuery({ queryKey: ['summary'], queryFn: () => get('/finance/summary'), enabled: can('debts.view') });
  const meters = useQuery({ queryKey: ['d-meters'], queryFn: () => get('/meters', { status: 'PENDING', pageSize: 1 }), enabled: can('meters.view') });
  const ads = useQuery({ queryKey: ['d-ads'], queryFn: () => get('/ads/moderation', { status: 'PENDING', pageSize: 1 }), enabled: can('ads.moderate') });
  const reported = useQuery({ queryKey: ['d-reported'], queryFn: () => get('/ads/moderation', { reported: '1', pageSize: 1 }), enabled: can('ads.moderate') });
  const s = sum.data;
  const total = s ? s.red + s.orange + s.green : 0;

  return (
    <div className="stack rise">
      <PageHead title={`Здравствуйте, ${me?.fullName?.split(' ')[1] ?? me?.fullName ?? 'коллега'}`} sub={`Сегодня ${dateLong(new Date())}`} />

      {can('debts.view') && (!s ? <Spinner /> : (
        <>
          <div className="grid g4">
            <div className="card metric"><small><Banknote />Общая задолженность</small><b className="num bad">{num(s.totalDebt)}<u>₽</u></b></div>
            <div className="card metric"><small><Receipt />Членские взносы</small><b className="num">{num(s.membership)}<u>₽</u></b></div>
            <div className="card metric"><small><TrendingDown />Электроэнергия</small><b className="num">{num(s.electricity)}<u>₽</u></b></div>
            <div className="card metric"><small><Banknote />Оплачено в этом месяце</small><b className="num good">{num(s.paidThisMonth)}<u>₽</u></b></div>
          </div>

          <div className="card">
            <h3><Warehouse />Состояние гаражей <span className="muted" style={{ fontWeight: 400 }}>· всего {s.garages}</span></h3>
            <div className="bar" aria-hidden>
              <i style={{ width: `${(s.green / Math.max(total, 1)) * 100}%`, background: 'var(--good)' }} />
              <i style={{ width: `${(s.orange / Math.max(total, 1)) * 100}%`, background: 'var(--warn)' }} />
              <i style={{ width: `${(s.red / Math.max(total, 1)) * 100}%`, background: 'var(--bad)' }} />
            </div>
            <div className="row" style={{ marginTop: 16, gap: 28 }}>
              <Legend color="GREEN" label="Всё оплачено" n={s.green} onClick={() => nav('/debts?color=GREEN')} />
              <Legend color="ORANGE" label="Есть задолженность" n={s.orange} onClick={() => nav('/debts?color=ORANGE')} />
              <Legend color="RED" label="Не оплачено ничего" n={s.red} onClick={() => nav('/debts?color=RED')} />
            </div>
          </div>
        </>
      ))}

      <div className="grid g3">
        {can('meters.view') && (
          <div className="card metric link" onClick={() => nav('/meters')}>
            <small><Gauge />Показания ждут приёма</small><b className="num">{meters.data?.total ?? '…'}</b>
          </div>
        )}
        {can('ads.moderate') && (
          <>
            <div className="card metric link" onClick={() => nav('/ads')}><small><Megaphone />Объявления на модерации</small><b className="num">{ads.data?.pendingCount ?? '…'}</b></div>
            <div className="card metric link" onClick={() => nav('/ads?reported=1')}><small><Flag />Объявления с жалобами</small><b className="num">{reported.data?.total ?? '…'}</b></div>
          </>
        )}
      </div>
    </div>
  );
}

function Legend({ color, label, n, onClick }: { color: string; label: string; n: number; onClick: () => void }) {
  return (
    <button className="row" style={{ background: 'none', border: 0, cursor: 'pointer', gap: 12 }} onClick={onClick}>
      <span className={`buoy ${color}`} />
      <span style={{ textAlign: 'left' }}><b className="num" style={{ fontFamily: 'var(--display)', fontSize: 22 }}>{n}</b><br /><span className="muted">{label}</span></span>
    </button>
  );
}

