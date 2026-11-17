import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { get } from '../lib/api';
import { dateTime, num, rub } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, Gallery, Spinner } from '../ui';

export default function MeterDetail() {
  const id = Number(useParams().id);
  const { data, isLoading, error } = useQuery({ queryKey: ['meter', id], queryFn: () => get(`/meters/${id}`) });
  return (
    <Screen title="Показание" back="/meters">
      {isLoading ? <Spinner /> : error || !data ? <Empty text="Показание не найдено" /> : (
        <>
          <div className="card" style={{ padding: 20 }}>
            <div className="row between"><span className="muted">Гараж {data.garageNumber}</span>
              {data.status === 'ACCEPTED' ? <span className="badge b-good"><CheckCircle2 size={12} />Принято</span> : <span className="badge b-warn"><Clock size={12} />Ждёт приёма</span>}
            </div>
            <div className="big-num num" style={{ margin: '8px 0' }}>{num(data.value)}<u>кВт·ч</u></div>
            <div className="kv"><span>Передано</span><span className="num">{dateTime(data.takenAt)}</span></div>
            {data.status === 'ACCEPTED' && (
              <>
                <div className="kv"><span>Принято</span><span className="num">{dateTime(data.acceptedAt)}</span></div>
                {data.acceptedBy?.fullName && <div className="kv"><span>Принял</span><span>{data.acceptedBy.fullName}</span></div>}
                {data.charge && !data.charge.voided && <div className="kv"><span>Начислено</span><b className="num">{rub(data.charge.amount)}</b></div>}
              </>
            )}
            {data.comment && <div className="kv"><span>Комментарий</span><span style={{ textAlign: 'right' }}>{data.comment}</span></div>}
          </div>
          <div className="sec">Фото ({data.photos.length})</div>
          <Gallery ids={data.photos} />
          {data.status === 'PENDING' && <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>Правление проверит фото и примет показание. Вы получите уведомление.</p>}
        </>
      )}
    </Screen>
  );
}
