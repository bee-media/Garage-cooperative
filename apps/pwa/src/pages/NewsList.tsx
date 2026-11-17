import { useQuery } from '@tanstack/react-query';
import { BellRing, Newspaper } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { dateShort } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, Pager, SearchBar, Spinner, useDebounced } from '../ui';

export default function NewsList() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const { data, isLoading, error } = useQuery({ queryKey: ['news', dq, page], queryFn: () => get('/news', { q: dq, page, pageSize: 5 }), placeholderData: (p) => p });

  return (
    <Screen title="Новости" tab={0}>
      <SearchBar value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Поиск по новостям" />
      {isLoading ? <Spinner /> : error ? <Empty text={(error as Error).message} /> : !data?.items.length ? <Empty icon={<Newspaper />} text={dq ? 'Ничего не нашли' : 'Новостей пока нет'} /> : (
        <>
          {data.items.map((n: any) => (
            <Link key={n.id} to={`/news/${n.id}`} className="card nitem">
              <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
                <h3>{n.title}</h3>
                {!n.isRead && <span className="unread" aria-label="Не прочитано" />}
              </div>
              <div className="meta">{dateShort(n.publishedAt)}{n.pinned && <span className="badge b-sand"><BellRing size={11} />Важное</span>}{!!n.photos.length && <span>· {n.photos.length} фото</span>}</div>
              <p>{n.body}</p>
            </Link>
          ))}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </Screen>
  );
}
