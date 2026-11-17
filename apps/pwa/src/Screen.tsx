import { useQuery } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { get } from './lib/api';
import { UpdateBanner } from './update';
import { AppBar, TabBar } from './ui';

/** Экран: шапка + прокручиваемое тело + (для разделов) нижний таб-бар */
export function Screen({ title, tab, back, actions, children }: { title: string; tab?: number; back?: boolean | string; actions?: ReactNode; children: ReactNode }) {
  const unread = useQuery({ queryKey: ['news-unread'], queryFn: () => get('/news', { pageSize: 1 }).then((r) => r.unreadCount as number), enabled: tab !== undefined, refetchInterval: 60_000 });
  return (
    <>
      <AppBar title={title} back={back} actions={actions} />
      {tab !== undefined && <UpdateBanner />}
      <div className={`body ${tab === undefined ? 'notab' : ''}`}>{children}</div>
      {tab !== undefined && <TabBar active={tab} unread={unread.data} />}
    </>
  );
}
