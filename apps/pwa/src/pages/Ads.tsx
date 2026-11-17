import { useQuery } from '@tanstack/react-query';
import { Megaphone, Phone, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { phone, rub } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, Pager, SearchBar, SecureImage, Spinner, useDebounced } from '../ui';

type Mode = 'board' | 'my' | 'archive';
export const AD_STATUS: Record<string, [string, string]> = { PENDING: ['На модерации', 'b-warn'], APPROVED: ['Опубликовано', 'b-good'], REJECTED: ['Отклонено', 'b-bad'], ARCHIVED: ['В архиве', 'b-off'] };

export function AdCard({ a, showStatus }: { a: any; showStatus?: boolean }) {
  return (
    <div className="card nitem" style={{ cursor: 'default' }}>
      <Link to={`/ads/${a.id}`} style={{ color: 'inherit', display: 'block' }}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          {a.photos[0] ? <SecureImage id={a.photos[0]} className="photo thumb" /> : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row between" style={{ gap: 8 }}>
              <b style={{ font: '600 17px var(--display)' }}>Гараж №{a.garageNumber}</b>
              <span className={`badge ${a.type === 'SALE' ? 'b-sand' : 'b-off'}`}>{a.type === 'SALE' ? 'Продаётся' : 'Сдаётся'}</span>
            </div>
            <div className="num" style={{ font: '600 21px var(--display)', margin: '4px 0' }}>{rub(a.price)}{a.type === 'RENT' && <span className="muted" style={{ font: '400 12px var(--body)' }}> / мес.</span>}</div>
            {a.description && <p style={{ WebkitLineClamp: 2 }}>{a.description}</p>}
            {showStatus && <div style={{ marginTop: 6 }}><span className={`badge ${AD_STATUS[a.status][1]}`}>{AD_STATUS[a.status][0]}</span></div>}
          </div>
        </div>
      </Link>
      {!showStatus && a.phone && (
        <a href={`tel:+7${a.phone}`} className="tel" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(168,218,220,.1)' }} aria-label={`Позвонить ${phone(a.phone)}`}>
          <span className="call"><Phone /></span><span><b className="mono">{phone(a.phone)}</b><br /><span className="muted" style={{ fontSize: 12 }}>Нажмите, чтобы позвонить</span></span>
        </a>
      )}
    </div>
  );
}

export default function Ads() {
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>('board');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const path = mode === 'board' ? '/ads' : mode === 'archive' ? '/ads/archive' : '/ads/my';
  const { data, isLoading } = useQuery({ queryKey: ['ads', mode, type, dq, page], queryFn: () => get(path, { type: mode === 'my' ? undefined : type, q: mode === 'my' ? undefined : dq, page, pageSize: 10 }), placeholderData: (p) => p });
  const sw = (m: Mode) => { setMode(m); setPage(1); };

  return (
    <Screen title="Объявления" tab={2} actions={<button className="ib" onClick={() => nav('/ads/new')} aria-label="Подать объявление"><Plus /></button>}>
      <div className="chips">
        {([['board', 'Доска'], ['my', 'Мои'], ['archive', 'Архив']] as [Mode, string][]).map(([m, l]) => <button key={m} className={`chip ${mode === m ? 'on' : ''}`} onClick={() => sw(m)}>{l}</button>)}
      </div>
      {mode !== 'my' && (
        <>
          <SearchBar value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Номер гаража" />
          <div className="chips">{[['', 'Все'], ['SALE', 'Продажа'], ['RENT', 'Аренда']].map(([v, l]) => <button key={v} className={`chip ${type === v ? 'on' : ''}`} onClick={() => { setType(v); setPage(1); }}>{l}</button>)}</div>
        </>
      )}
      {isLoading ? <Spinner /> : !data?.items.length ? <Empty icon={<Megaphone />} text={mode === 'my' ? 'Вы ещё не подавали объявлений. Нажмите «+» вверху.' : mode === 'archive' ? 'Архив пуст' : 'Объявлений пока нет'} /> : (
        <>
          {data.items.map((a: any) => <AdCard key={a.id} a={a} showStatus={mode === 'my'} />)}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </Screen>
  );
}
