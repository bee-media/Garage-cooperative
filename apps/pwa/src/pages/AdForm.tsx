import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Screen } from '../Screen';
import { Field, PhotoPicker, Spinner, useToast } from '../ui';

export default function AdForm() {
  const id = Number(useParams().id) || null;
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['ad', id], queryFn: () => get(`/ads/${id}`), enabled: !!id });
  const [f, setF] = useState({ garageNumber: me?.garages[0]?.number ?? '', type: 'SALE', price: '', description: '' });
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const a = existing.data;
    if (a) { setF({ garageNumber: a.garageNumber, type: a.type, price: String(a.price), description: a.description ?? '' }); setIds(a.photos); }
  }, [existing.data]);

  const price = Number(f.price.replace(',', '.'));
  const valid = f.garageNumber.trim() && f.price !== '' && price >= 0 && Number.isFinite(price);

  async function save() {
    setBusy(true);
    try {
      const body = { garageNumber: f.garageNumber.trim(), type: f.type, price, description: f.description.trim() || undefined, fileIds: ids };
      if (id) await patch(`/ads/${id}`, body); else await post('/ads', body);
      qc.invalidateQueries({ queryKey: ['ads'] }); qc.invalidateQueries({ queryKey: ['ad'] });
      toast(id ? 'Сохранено. Объявление отправлено на проверку' : 'Объявление отправлено на проверку');
      nav('/ads', { replace: true });
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  }

  if (id && existing.isLoading) return <Screen title="Изменить объявление" back><Spinner /></Screen>;
  return (
    <Screen title={id ? 'Изменить объявление' : 'Новое объявление'} back>
      <div className="notice info" style={{ marginBottom: 14 }}><Info /><div>Объявление появится на доске после проверки правлением. Ваш номер телефона будет виден жителям.</div></div>
      <div className="chips">{[['SALE', 'Продажа'], ['RENT', 'Аренда']].map(([v, l]) => <button key={v} className={`chip ${f.type === v ? 'on' : ''}`} onClick={() => setF({ ...f, type: v })}>{l}</button>)}</div>
      <div className="card">
        <Field label="Номер гаража"><input className="input" value={f.garageNumber} onChange={(e) => setF({ ...f, garageNumber: e.target.value })} maxLength={12} inputMode="numeric" /></Field>
        <Field label={f.type === 'RENT' ? 'Цена, ₽ в месяц' : 'Цена, ₽'}><input className="input num" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^\d.,]/g, '') })} maxLength={12} /></Field>
        <Field label="Описание"><textarea className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} placeholder="Размер, состояние, свет, яма, условия" /></Field>
      </div>
      <div className="sec">Фото (до 5)</div>
      <PhotoPicker kind="ad" ids={ids} onChange={setIds} max={5} />
      <button className="btn p" style={{ marginTop: 22 }} disabled={!valid || busy} onClick={save}>{busy ? 'Сохраняем…' : id ? 'Сохранить' : 'Отправить на проверку'}</button>
    </Screen>
  );
}
