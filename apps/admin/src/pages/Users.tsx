import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, LockOpen, MonitorOff, Pencil, Plus, Printer, ShieldCheck, ShieldOff, Trash2, UserX, Users as UsersIcon } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copyText, dateTime, phone, phoneDigits, phoneValid } from '../lib/format';
import { Empty, ExportButton, Field, Modal, PageHead, Pager, PhoneInput, SearchInput, Spinner, useConfirm, useDebounced, useToast } from '../ui';

export default function UsersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [roleId, setRoleId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any | 'new' | null>(sp.get('new') ? 'new' : null);
  const [pw, setPw] = useState<{ user: any; data: any } | null>(null);
  const dq = useDebounced(q);

  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get('/roles') });
  const list = useQuery({ queryKey: ['users', dq, roleId, status, page], queryFn: () => get('/users', { q: dq, roleId, status, page, pageSize: 25 }), placeholderData: (p) => p });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const onErr = (e: any) => toast(e.message, 'err');

  const issue = useMutation({ mutationFn: (u: any) => post(`/users/${u.id}/password`).then((data) => ({ user: u, data })), onSuccess: (r) => { setPw(r); refresh(); }, onError: onErr });
  const unblock = useMutation({ mutationFn: (id: number) => post(`/users/${id}/unblock`), onSuccess: () => { toast('Пользователь разблокирован'); refresh(); }, onError: onErr });
  const block = useMutation({ mutationFn: (id: number) => post(`/users/${id}/block`), onSuccess: () => { toast('Пользователь заблокирован'); refresh(); }, onError: onErr });
  const revoke = useMutation({ mutationFn: (id: number) => post(`/users/${id}/sessions/revoke`), onSuccess: (r) => toast(`Завершено сессий: ${r.revoked}`), onError: onErr });
  const reset2fa = useMutation({ mutationFn: (id: number) => post(`/auth/2fa/reset/${id}`), onSuccess: () => { toast('Двухфакторная защита сброшена: пользователь настроит её при следующем входе'); refresh(); }, onError: onErr });
  const remove = useMutation({ mutationFn: (id: number) => del(`/users/${id}`), onSuccess: () => { toast('Пользователь удалён'); refresh(); }, onError: onErr });

  useEffect(() => { if (sp.get('new')) { const n = new URLSearchParams(sp); n.delete('new'); setSp(n, { replace: true }); } }, []); // eslint-disable-line

  return (
    <div className="rise">
      <PageHead title="Пользователи" sub="Владельцы гаражей и сотрудники правления" actions={<>{can("data.export") && <ExportButton path="/export/users.xlsx" name="users.xlsx" />}{can("users.edit") && <button className="btn primary" onClick={() => setEdit("new")}><Plus />Добавить пользователя</button>}</>} />
      <div className="card flush">
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="ФИО, телефон или номер гаража" />
          <select className="input" style={{ width: 190 }} value={roleId} onChange={(e) => { setRoleId(e.target.value); setPage(1); }} aria-label="Роль">
            <option value="">Все роли</option>{roles.data?.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select className="input" style={{ width: 200 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Статус">
            <option value="">Любой статус</option><option value="blocked">Заблокированы</option><option value="noconsent">Не дали согласие</option>
          </select>
        </div>
        {list.isLoading ? <Spinner /> : !list.data?.items.length ? <Empty icon={<UsersIcon />} /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Гаражи</th><th>ФИО</th><th>Телефон</th><th>Роль</th><th>Последний вход</th><th /></tr></thead>
            <tbody>{list.data.items.map((u: any) => {
              const locked = u.isBlocked || u.lockedAt;
              return (
                <tr key={u.id}>
                  <td>{u.garages.length ? <div className="row" style={{ gap: 6 }}>{u.garages.map((g: any) => <button key={g.id} className="chip" style={{ height: 28, padding: '0 10px' }} onClick={() => nav(`/garages/${g.id}`)}>{g.number}{g.hasBenefit && <span title="Льгота" style={{ color: 'var(--sand)' }}>★</span>}</button>)}</div> : <span className="muted">—</span>}</td>
                  <td><b>{u.fullName ?? 'Без имени'}</b>{u.email && <div className="muted" style={{ fontSize: 12 }}>{u.email}</div>}</td>
                  <td className="mono">{phone(u.phone)}</td>
                  <td>{u.role.name}{locked && <> <span className="badge b-bad">Заблокирован</span></>}{!u.consentAt && <> <span className="badge b-off">нет согласия</span></>}{u.totpEnabled && <> <span className="badge b-good" title="Двухфакторная защита включена"><ShieldCheck size={11} />2FA</span></>}</td>
                  <td className="muted num">{dateTime(u.lastLoginAt)}</td>
                  <td className="r"><div className="row end" style={{ flexWrap: 'nowrap', gap: 4 }}>
                    {can('passwords.issue') && <button className="btn sm primary" onClick={() => issue.mutate(u)}><KeyRound />Выдать пароль</button>}
                    {can('passwords.issue') && u.totpEnabled && <button className="btn icon sm ghost" title="Сбросить 2FA (потерян телефон)" onClick={async () => { if (await confirm({ title: `Сбросить 2FA у ${u.fullName ?? phone(u.phone)}?`, text: 'Двухфакторная защита и резервные коды будут удалены, все сессии завершены. При следующем входе пользователь настроит защиту заново.', ok: 'Сбросить', danger: true })) reset2fa.mutate(u.id); }}><ShieldOff /></button>}
                    {can('passwords.issue') && locked && <button className="btn icon sm" title="Разблокировать" onClick={() => unblock.mutate(u.id)}><LockOpen /></button>}
                    {can('passwords.issue') && !locked && <button className="btn icon sm ghost" title="Завершить сессии" onClick={() => revoke.mutate(u.id)}><MonitorOff /></button>}
                    {can('users.edit') && <button className="btn icon sm ghost" title="Изменить" onClick={() => setEdit(u)}><Pencil /></button>}
                    {can('passwords.issue') && !locked && <button className="btn icon sm ghost" title="Заблокировать" onClick={async () => { if (await confirm({ title: 'Заблокировать пользователя?', text: 'Вход будет закрыт, все сессии завершены. Снять блокировку можно кнопкой с замком.', ok: 'Заблокировать', danger: true })) block.mutate(u.id); }}><UserX /></button>}
                    {can('users.delete') && <button className="btn icon sm ghost" title="Удалить" onClick={async () => { if (await confirm({ title: `Удалить ${u.fullName ?? phone(u.phone)}?`, text: 'Пользователь будет отвязан от гаражей, сессии завершены. История операций сохранится.', ok: 'Удалить', danger: true })) remove.mutate(u.id); }}><Trash2 /></button>}
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {list.data && <Pager page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      </div>
      {edit && <UserModal user={edit === 'new' ? null : edit} roles={roles.data ?? []} onClose={() => setEdit(null)} onDone={(created) => { setEdit(null); refresh(); if (created) issue.mutate(created); }} />}
      {pw && <PasswordModal {...pw} onClose={() => setPw(null)} />}
    </div>
  );
}

function UserModal({ user, roles, onClose, onDone }: { user: any | null; roles: any[]; onClose: () => void; onDone: (created?: any) => void }) {
  const toast = useToast();
  const resident = roles.find((r) => r.name === 'Житель');
  const [f, setF] = useState({ phone: user ? phone(user.phone) : '', fullName: user?.fullName ?? '', email: user?.email ?? '', roleId: String(user?.roleId ?? resident?.id ?? ''), note: user?.note ?? '', garages: '' });
  const m = useMutation({
    mutationFn: () => {
      const base = { phone: phoneDigits(f.phone), fullName: f.fullName.trim() || undefined, email: f.email.trim() || undefined, roleId: Number(f.roleId) || undefined, note: f.note || undefined };
      return user ? patch(`/users/${user.id}`, { ...base, email: f.email.trim() || null }) : post('/users', { ...base, garageNumbers: f.garages.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) });
    },
    onSuccess: (r) => { toast(user ? 'Сохранено' : 'Пользователь создан'); onDone(user ? undefined : r); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={user ? 'Редактирование пользователя' : 'Новый пользователь'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!phoneValid(f.phone) || m.isPending} onClick={() => m.mutate()}>{user ? 'Сохранить' : 'Создать и выдать пароль'}</button></>}>
      <div className="stack">
        <Field label="Телефон (логин)" hint="Только цифры, формат 909-111-22-77"><PhoneInput value={f.phone} onChange={(v) => setF({ ...f, phone: v })} autoFocus /></Field>
        <Field label="ФИО"><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} maxLength={150} /></Field>
        <div className="grid g2">
          <Field label="Email" hint="Для чеков и уведомлений"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={150} /></Field>
          <Field label="Роль"><select className="input" value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        </div>
        {!user && <Field label="Номера гаражей" hint="Через запятую: 5, 6, 17. Гараж должен уже существовать"><input className="input" value={f.garages} onChange={(e) => setF({ ...f, garages: e.target.value })} /></Field>}
        <Field label="Заметка"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function PasswordModal({ user, data, onClose }: { user: any; data: { phone: string; password: string; loginUrl: string }; onClose: () => void }) {
  const toast = useToast();
  const [qr, setQr] = useState('');
  useEffect(() => { QRCode.toDataURL(data.loginUrl, { margin: 1, width: 240, color: { dark: '#0f1722', light: '#ffffff' } }).then(setQr); }, [data.loginUrl]);
  return (
    <Modal title="Доступ для пользователя" onClose={onClose} footer={<>
      <button className="btn" onClick={() => window.print()}><Printer />Печать</button>
      <button className="btn" onClick={() => { copyText(data.password).then(() => toast('Пароль скопирован'), (e) => toast(e.message, 'err')); }}><Copy />Копировать</button>
      <button className="btn primary" onClick={onClose}>Готово</button>
    </>}>
      <div className="stack" style={{ textAlign: 'center' }}>
        <div><b>{user.fullName ?? 'Пользователь'}</b><div className="mono muted">{phone(data.phone)}{user.garages?.length ? ` · гараж ${user.garages.map((g: any) => g.number).join(', ')}` : ''}</div></div>
        {qr && <img src={qr} alt="QR-код для входа" width={200} height={200} style={{ margin: '0 auto', borderRadius: 14, background: '#fff', padding: 6 }} />}
        <div className="muted" style={{ fontSize: 13 }}>Отсканируйте QR: откроется вход в приложение, номер телефона подставится сам. Пароль введите вручную.</div>
        <div className="pw-box"><div className="muted">Пароль (показывается один раз)</div><div className="pw">{data.password}</div></div>
        <div className="muted" style={{ fontSize: 12 }}>Пароль не хранится в открытом виде. Если потеряется — выдайте новый, прежний перестанет действовать.</div>
      </div>
    </Modal>
  );
}

