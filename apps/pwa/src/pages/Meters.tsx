import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, Gauge, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, num } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, Pager, Spinner } from '../ui';

export default function Meters() {
  const { me } = useAuth();
  const nav = useNavigate();
  const garages = me?.garages ?? [];
  const [gid, setGid] = useState<number | undefined>(garages[0]?.id);
  const [page, setPage] = useState(1);
  useEffect(() => { if (gid === undefined && garages[0]) setGid(garages[0].id); }, [garages, gid]);
  const { data, isLoading } = useQuery({ queryKey: ['meters-my', gid, page], queryFn: () => get('/meters/my', { garageId: gid, page, pageSize: 10 }), enabled: gid !== undefined, placeholderData: (p) => p });
  const last = data?.items?.[0];

  if (!garages.length) return <Screen title="Счётчик" tab={1}><Empty icon={<Gauge />} text="За вами не закреплён ни один гараж. Обратитесь в правление." /></Screen>;
  return (
    <Screen title="Счётчик" tab={1}>
      {garages.length > 1 && (
        <div className="chips">{garages.map((g) => <button key={g.id} className={`chip ${gid === g.id ? 'on' : ''}`} onClick={() => { setGid(g.id); setPage(1); }}>Гараж {g.number}</button>)}</div>
      )}
      <div className="card" style={{ padding: 20 }}>
        <div className="muted" style={{ fontSize: 12 }}>Последнее переданное показание</div>
        <div className="big-num num" style={{ margin: '6px 0 2px' }}>{data?.lastValue != null ? num(data.lastValue) : '—'}<u>кВт·ч</u></div>
        {last && <div className="muted" style={{ fontSize: 12.5 }}>{dateTime(last.takenAt)}</div>}
        <button className="btn p" style={{ marginTop: 18 }} onClick={() => nav(`/meters/new${gid ? `?garage=${gid}` : ''}`)}><Plus />Передать показания</button>
      </div>

      <div className="sec">История передачи</div>
      {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Gauge />} text="Показания ещё не передавались" /> : (
        <>
          {data.items.map((r: any) => (
            <Link key={r.id} to={`/meters/${r.id}`} className="card nitem">
              <div className="row between">
                <b className="num" style={{ font: '600 22px var(--display)' }}>{num(r.value)} <span className="muted" style={{ font: '400 12px var(--body)' }}>кВт·ч</span></b>
                {r.status === 'ACCEPTED' ? <span className="badge b-good"><CheckCircle2 size={12} />Принято</span> : <span className="badge b-warn"><Clock size={12} />Ждёт приёма</span>}
              </div>
              <div className="meta" style={{ marginBottom: 0 }}>{dateTime(r.takenAt)} · {r.photos.length} фото{data && garages.length > 1 ? ` · гараж ${r.garageNumber}` : ''}</div>
            </Link>
          ))}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </Screen>
  );
}
