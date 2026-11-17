import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { phone } from '../lib/format';
import { BenefitBadge, DebtBuoy, Empty, ExportButton, Field, Modal, PageHead, Pager, SearchInput, Spinner, useDebounced, useToast } from '../ui';

export default function GaragesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [benefit, setBenefit] = useState(false);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<'one' | 'bulk' | null>(null);
  const dq = useDebounced(q);

  const list = useQuery({ queryKey: ['garages', dq, status, benefit, page], queryFn: () => get('/garages', { q: dq, status, benefit: benefit ? 1 : undefined, page, pageSize: 50 }), placeholderData: (p) => p });
  const debts = useQuery({ queryKey: ['debt-colors'], queryFn: () => get('/finance/debts', { pageSize: 1000 }), enabled: can('debts.view') });
  const colors = new Map<number, string>((debts.data?.items ?? []).map((d: any) => [d.garageId, d.color]));

  return (
    <div className="rise">
      <PageHead title="Гаражи" sub="Список боксов кооператива" actions={<>
        {can('data.export') && <ExportButton path={`/export/garages.xlsx?status=${status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE'}`} name="garages.xlsx" />}
        {can('garages.edit') && <button className="btn" onClick={() => setModal('bulk')}><Layers />Сгенерировать диапазон</button>}
        {can('garages.edit') && <button className="btn primary" onClick={() => setModal('one')}><Plus />Добавить гараж</button>}
      </>} />
      <div className="card flush">
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Номер, ФИО или телефон владельца" />
          <div className="chips">
            <button className={`chip ${status === 'ACTIVE' ? 'on' : ''}`} onClick={() => { setStatus('ACTIVE'); setPage(1); }}>Действующие</button>
            <button className={`chip ${status === 'ARCHIVED' ? 'on' : ''}`} onClick={() => { setStatus('ARCHIVED'); setPage(1); }}>Архив</button>
            <button className={`chip ${benefit ? 'on' : ''}`} onClick={() => { setBenefit(!benefit); setPage(1); }}>★ Льготные</button>
          </div>
        </div>
        {list.isLoading ? <Spinner /> : !list.data?.items.length ? <Empty icon={<Warehouse />} text="Гаражей нет. Нажмите «Сгенерировать диапазон»." /> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Гараж</th><th>Владельцы</th><th>Телефон</th><th>Площадь</th><th>Год</th><th>Отметки</th></tr></thead>
              <tbody>
                {list.data.items.map((g: any) => (
                  <tr key={g.id} className="click" onClick={() => nav(`/garages/${g.id}`)}>
                    <td><div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>{colors.has(g.id) && <DebtBuoy color={colors.get(g.id)!} />}<span className="garage-no">{g.number}</span>{g.hasBenefit && <BenefitBadge pct={g.benefitPercent} />}</div></td>
                    <td>{g.owners.length ? g.owners.map((o: any) => <div key={o.id}>{o.fullName ?? '—'}</div>) : <span className="muted">нет владельца</span>}</td>
                    <td className="mono">{g.owners.length ? g.owners.map((o: any) => <div key={o.id}>{phone(o.phone)}</div>) : '—'}</td>
                    <td className="num">{g.areaM2 ? `${g.areaM2} м²` : '—'}</td>
                    <td className="num">{g.buildYear ?? '—'}</td>
                    <td className="muted">{g.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && <Pager page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>

      {modal === 'one' && <OneModal onClose={() => setModal(null)} onDone={(id) => { qc.invalidateQueries({ queryKey: ['garages'] }); nav(`/garages/${id}`); }} />}
      {modal === 'bulk' && <BulkModal onClose={() => setModal(null)} onDone={(m) => { toast(m); qc.invalidateQueries({ queryKey: ['garages'] }); setModal(null); }} />}
    </div>
  );
}

function OneModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const m = useMutation({ mutationFn: () => post('/garages', { number: number.trim() }), onSuccess: (g) => onDone(g.id), onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title="Новый гараж" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!number.trim() || m.isPending} onClick={() => m.mutate()}>Создать</button></>}>
      <Field label="Номер гаража"><input className="input" value={number} onChange={(e) => setNumber(e.target.value)} autoFocus maxLength={12} /></Field>
    </Modal>
  );
}

function BulkModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const toast = useToast();
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('');
  const f = Number(from), t = Number(to);
  const valid = Number.isInteger(f) && Number.isInteger(t) && f >= 1 && t >= f && t - f <= 2000;
  const m = useMutation({ mutationFn: () => post('/garages/bulk', { from: f, to: t }), onSuccess: (r) => onDone(`Создано: ${r.created}, уже существовало: ${r.skipped}`), onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title="Сгенерировать гаражи" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!valid || m.isPending} onClick={() => m.mutate()}>Создать {valid ? t - f + 1 : ''}</button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Система создаст гаражи с номерами от «От» до «До». Уже существующие номера будут пропущены.</p>
        <div className="grid g2">
          <Field label="От"><input className="input num" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
          <Field label="До"><input className="input num" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        {t - f > 2000 && <div className="bad">Не более 2000 за один раз</div>}
      </div>
    </Modal>
  );
}
