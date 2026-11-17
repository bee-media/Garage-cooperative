import { useQuery } from '@tanstack/react-query';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { get } from '../lib/api';
import { dateTime, phone } from '../lib/format';
import { Empty, PageHead, Pager, SearchInput, Spinner, useDebounced } from '../ui';

const GROUPS: [string, string][] = [
  ['', 'Все события'], ['auth', 'Вход и сессии'], ['user', 'Пользователи'], ['garage', 'Гаражи'], ['charge', 'Начисления'], ['payment', 'Оплаты'],
  ['meter', 'Показания'], ['news', 'Новости'], ['ad', 'Объявления'], ['role', 'Роли'], ['schedule', 'Расписание'], ['release', 'Релизы'], ['push', 'Push'], ['file', 'Файлы'],
];

// Границы дня по Москве (UTC+3)
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00+03:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999+03:00`).toISOString() : undefined);

export default function AuditPage() {
  const [group, setGroup] = useState('');
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const dAction = useDebounced(action), dEntity = useDebounced(entityId);
  const { data, isLoading } = useQuery({
    queryKey: ['audit', group, dAction, dEntity, from, to, page],
    queryFn: () => get('/audit', { action: dAction || group || undefined, entityId: dEntity, from: dayStart(from), to: dayEnd(to), page, pageSize: 50 }),
    placeholderData: (p) => p,
  });
  const reset = () => setPage(1);

  return (
    <div className="rise">
      <PageHead title="Журнал действий" sub="Кто, что и когда делал в системе. Записи хранятся 3 года и не редактируются" />
      <div className="card flush">
        <div className="toolbar">
          <select className="input" style={{ width: 190 }} value={group} onChange={(e) => { setGroup(e.target.value); setAction(''); reset(); }} aria-label="Тип событий">{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <SearchInput value={action} onChange={(v) => { setAction(v); reset(); }} placeholder="Действие, например payment.create" />
          <input className="input mono" style={{ width: 130 }} placeholder="ID объекта" value={entityId} onChange={(e) => { setEntityId(e.target.value); reset(); }} />
          <input className="input" type="date" style={{ width: 150 }} value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} aria-label="С даты" />
          <input className="input" type="date" style={{ width: 150 }} value={to} onChange={(e) => { setTo(e.target.value); reset(); }} aria-label="По дату" />
        </div>
        {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Activity />} /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th /><th>Время (МСК)</th><th>Кто</th><th>Действие</th><th>Объект</th><th>IP</th></tr></thead>
            <tbody>{data.items.map((a: any) => {
              const has = a.before || a.after;
              return (
                <Fragment key={a.id}>
                  <tr key={a.id} className={has ? 'click' : ''} onClick={() => has && setOpen(open === a.id ? null : a.id)}>
                    <td style={{ width: 28 }}>{has ? (open === a.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : null}</td>
                    <td className="num">{dateTime(a.at)}</td>
                    <td className="mono">{a.actorPhone ? phone(a.actorPhone) : <span className="muted">система</span>}</td>
                    <td><span className={`badge ${a.action.includes('fail') || a.action.includes('lock') || a.action.includes('delete') ? 'b-bad' : 'b-off'}`}>{a.action}</span></td>
                    <td className="muted">{a.entity ? `${a.entity}${a.entityId ? ` #${a.entityId}` : ''}` : '—'}</td>
                    <td className="mono muted">{a.ip ?? '—'}</td>
                  </tr>
                  {open === a.id && (
                    <tr key={`${a.id}-d`}><td /><td colSpan={5}><div className="grid g2" style={{ padding: '4px 0 10px' }}>
                      {a.before && <div><div className="muted" style={{ marginBottom: 4 }}>Было</div><pre className="json">{JSON.stringify(a.before, null, 2)}</pre></div>}
                      {a.after && <div><div className="muted" style={{ marginBottom: 4 }}>Стало</div><pre className="json">{JSON.stringify(a.after, null, 2)}</pre></div>}
                    </div>{a.userAgent && <div className="muted" style={{ fontSize: 11 }}>{a.userAgent}</div>}</td></tr>
                  )}
                </Fragment>
              );
            })}</tbody>
          </table></div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
