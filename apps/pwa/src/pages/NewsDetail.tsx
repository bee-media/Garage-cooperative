import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { dateLong } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, Gallery, Spinner } from '../ui';

export default function NewsDetail() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['news-one', id], queryFn: () => get(`/news/${id}`) });

  // Открытие новости = отметка «прочитано»
  useEffect(() => {
    if (data && !data.isRead) post(`/news/${id}/read`).then(() => { qc.invalidateQueries({ queryKey: ['news'] }); qc.invalidateQueries({ queryKey: ['news-unread'] }); }).catch(() => {});
  }, [data, id, qc]);

  return (
    <Screen title="Новость" back="/">
      {isLoading ? <Spinner /> : error || !data ? <Empty text="Новость не найдена или снята с публикации" /> : (
        <article className="card">
          <h1 style={{ fontSize: 21, lineHeight: 1.25 }}>{data.title}</h1>
          <div className="muted" style={{ fontSize: 12.5, margin: '6px 0 14px' }}>{dateLong(data.publishedAt)}</div>
          <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: data.photos.length ? 16 : 0 }}>{data.body}</p>
          <Gallery ids={data.photos} />
        </article>
      )}
    </Screen>
  );
}
