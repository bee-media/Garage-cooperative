import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Map as MapIcon, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { dateShort, phone, WEEKDAYS } from '../lib/format';
import { Screen } from '../Screen';
import { Spinner } from '../ui';

export default function Board() {
  const sched = useQuery({ queryKey: ['schedule'], queryFn: () => get('/schedule') });
  const contacts = useQuery({ queryKey: ['contacts'], queryFn: () => get('/contacts') });
  const s = sched.data;
  // Схема показывается, только если правление включило её для жителей (иначе API отвечает 403)
  const map = useQuery({ queryKey: ['map-view'], queryFn: () => get('/map'), retry: false });

  return (
    <Screen title="Правление" tab={3}>
      {map.data && (
        <Link to="/map" className="card tel" style={{ marginBottom: 6 }}>
          <span className="call"><MapIcon /></span>
          <span style={{ flex: 1 }}><b>Схема ГСК</b><br /><span className="muted" style={{ fontSize: 12.5 }}>Расположение гаражей и опор освещения</span></span>
        </Link>
      )}

      <div className="sec" style={{ marginTop: 6 }}>Часы приёма</div>
      {sched.isLoading ? <Spinner /> : !s?.days.length ? <div className="card muted">Расписание пока не заполнено</div> : (
        <div className="stack" style={{ gap: 8 }}>
          {s.exceptions.map((e: any) => <div key={e.id} className="notice"><CalendarClock /><div><b>{dateShort(e.date)}</b> — {e.note}</div></div>)}
          {s.days.map((d: any) => {
            const today = d.weekday === s.todayWeekday;
            return (
              <div key={d.weekday} className={`card ${today ? 'today' : ''}`} style={{ padding: '12px 16px' }}>
                <div className="row between">
                  <span><b>{WEEKDAYS[d.weekday - 1]}</b>{today && <span className="badge b-good" style={{ marginLeft: 8 }}>сегодня</span>}</span>
                  {d.isClosed ? <span className="muted">выходной</span> : <b className="num">{d.opensAt} — {d.closesAt}</b>}
                </div>
                {d.note && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{d.note}</div>}
              </div>
            );
          })}
          {s.note && <p className="muted" style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', padding: '4px 4px 0' }}>{s.note}</p>}
        </div>
      )}

      <div className="sec">Контакты</div>
      {contacts.isLoading ? <Spinner /> : !contacts.data?.length ? <div className="card muted">Контакты пока не добавлены</div> : contacts.data.map((c: any) => (
        <a key={c.id} href={`tel:+7${c.phone}`} className="card tel" style={{ marginBottom: 10 }} aria-label={`Позвонить: ${c.position} ${c.fullName}`}>
          <span className="call"><Phone /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="muted" style={{ fontSize: 12 }}>{c.position}</span><br />
            <b>{c.fullName}</b><br />
            <span className="mono" style={{ color: 'var(--seafoam)' }}>{phone(c.phone)}</span>
          </span>
        </a>
      ))}
      <p className="muted" style={{ fontSize: 12.5, textAlign: 'center', marginTop: 6 }}>Нажмите на контакт — начнётся вызов</p>
    </Screen>
  );
}
