import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { Field, Modal, PageHead, Spinner, useConfirm, useToast } from '../ui';

export default function RolesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get('/roles') });
  const perms = useQuery({ queryKey: ['perms'], queryFn: () => get('/roles/permissions') });
  const [draft, setDraft] = useState<Record<number, { permissions: string[]; portalAccess: boolean }>>({});
  const [newRole, setNewRole] = useState(false);

  useEffect(() => {
    if (roles.data) setDraft(Object.fromEntries(roles.data.map((r: any) => [r.id, { permissions: r.permissions, portalAccess: r.portalAccess }])));
  }, [roles.data]);

  const onErr = (e: any) => toast(e.message, 'err');
  const save = useMutation({ mutationFn: (r: any) => patch(`/roles/${r.id}`, { name: r.name, description: r.description ?? undefined, ...draft[r.id] }), onSuccess: () => { toast('Роль сохранена'); qc.invalidateQueries({ queryKey: ['roles'] }); }, onError: onErr });
  const remove = useMutation({ mutationFn: (id: number) => del(`/roles/${id}`), onSuccess: () => { toast('Роль удалена'); qc.invalidateQueries({ queryKey: ['roles'] }); }, onError: onErr });

  if (roles.isLoading || perms.isLoading) return <Spinner />;
  const locked = (r: any) => r.isSystem && (r.name === 'Администратор' || r.name === 'Житель');
  const changed = (r: any) => { const d = draft[r.id]; return d && (d.portalAccess !== r.portalAccess || d.permissions.length !== r.permissions.length || d.permissions.some((p) => !r.permissions.includes(p))); };

  return (
    <div className="rise">
      <PageHead title="Роли и права" sub="Какие разделы и действия доступны каждой роли. Изменения вступают в силу сразу" actions={<button className="btn primary" onClick={() => setNewRole(true)}><Plus />Новая роль</button>} />
      <div className="card flush"><div className="table-wrap"><table className="t matrix">
        <thead><tr><th>Право</th>{roles.data.map((r: any) => (
          <th key={r.id} style={{ minWidth: 120 }}>
            <div style={{ color: 'var(--text)', textTransform: 'none', fontSize: 13, fontWeight: 600 }}>{locked(r) && <Lock size={12} />} {r.name}</div>
            <div style={{ textTransform: 'none', fontWeight: 400 }}>{r._count.users} польз.</div>
          </th>))}</tr></thead>
        <tbody>
          <tr><td><b>Вход в веб-портал</b></td>{roles.data.map((r: any) => <td key={r.id}><input type="checkbox" className="check" style={{ accentColor: 'var(--teal)', width: 17, height: 17 }} disabled={locked(r)} checked={draft[r.id]?.portalAccess ?? false} onChange={(e) => setDraft({ ...draft, [r.id]: { ...draft[r.id], portalAccess: e.target.checked } })} aria-label={`${r.name}: вход в портал`} /></td>)}</tr>
          {perms.data.map((p: any) => (
            <tr key={p.key}><td>{p.title}<div className="mono muted" style={{ fontSize: 11 }}>{p.key}</div></td>
              {roles.data.map((r: any) => <td key={r.id}><input type="checkbox" style={{ accentColor: 'var(--teal)', width: 17, height: 17 }} disabled={locked(r)} checked={draft[r.id]?.permissions.includes(p.key) ?? false}
                onChange={(e) => { const cur = draft[r.id].permissions; setDraft({ ...draft, [r.id]: { ...draft[r.id], permissions: e.target.checked ? [...cur, p.key] : cur.filter((x) => x !== p.key) } }); }} aria-label={`${r.name}: ${p.title}`} /></td>)}</tr>))}
          <tr><td />{roles.data.map((r: any) => (
            <td key={r.id}><div className="stack" style={{ justifyItems: 'center', gap: 6 }}>
              <button className="btn primary sm" disabled={!changed(r) || save.isPending} onClick={() => save.mutate(r)}>Сохранить</button>
              {!r.isSystem && <button className="btn icon sm ghost" aria-label="Удалить роль" onClick={async () => { if (await confirm({ title: `Удалить роль «${r.name}»?`, ok: 'Удалить', danger: true })) remove.mutate(r.id); }}><Trash2 /></button>}
            </div></td>))}</tr>
        </tbody>
      </table></div></div>
      <p className="muted" style={{ marginTop: 12 }}>Роли «Администратор» и «Житель» защищены от изменений. После смены роли у пользователя его сессии завершаются, чтобы права обновились.</p>
      {newRole && <NewRoleModal onClose={() => setNewRole(false)} onDone={() => { setNewRole(false); qc.invalidateQueries({ queryKey: ['roles'] }); }} />}
    </div>
  );
}

function NewRoleModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const m = useMutation({ mutationFn: () => post('/roles', { name: name.trim(), description: description || undefined, portalAccess: true, permissions: ['garages.view'] }), onSuccess: () => { toast('Роль создана — отметьте её права в таблице'); onDone(); }, onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title="Новая роль" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={name.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>Создать</button></>}>
      <div className="stack"><Field label="Название"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></Field><Field label="Описание"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></Field></div>
    </Modal>
  );
}
