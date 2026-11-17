import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, FileUp, History, TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { downloadFile, get, qs, uploadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Empty, Field, Modal, PageHead, Spinner, useToast } from '../ui';

const EXPORTS = [
  { kind: 'users', title: 'Пользователи', text: 'ФИО, телефон, email, гаражи, роль, статус', perm: 'users.view' },
  { kind: 'garages', title: 'Гаражи и владельцы', text: 'Номера, владельцы, телефоны, площадь, льготы', perm: 'garages.view', status: true },
  { kind: 'debts', title: 'Задолженности', text: 'Долги по видам и итог, цвет статуса как на портале', perm: 'debts.view' },
  { kind: 'charges', title: 'Начисления', text: 'Журнал начислений за период', perm: 'debts.view', period: true },
  { kind: 'payments', title: 'Оплаты', text: 'Журнал оплат за период', perm: 'debts.view', period: true },
];

const IMPORTS = [
  { kind: 'garages', title: 'Гаражи и владельцы', text: 'Список гаражей, владельцев и их телефонов. Создаёт пользователей-жителей (пароли выдаются отдельно).', perms: ['garages.edit', 'users.edit'] },
  { kind: 'charges', title: 'Начисления и входящие долги', text: 'Остатки долга на начало учёта и разовые начисления.', perms: ['charges.edit'] },
  { kind: 'payments', title: 'Оплаты', text: 'История оплат по гаражам.', perms: ['payments.edit'] },
];

const KIND_LABEL: Record<string, string> = { garages: 'Гаражи и владельцы', charges: 'Начисления', payments: 'Оплаты' };

export default function DataPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [wizard, setWizard] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const history = useQuery({ queryKey: ['import-history'], queryFn: () => get('/import/history'), enabled: can('data.import') });

  async function dl(path: string, name: string, key: string) {
    setBusy(key);
    try { await downloadFile(path, name); } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
  }

  return (
    <div className="stack rise">
      <PageHead title="Данные" sub="Выгрузка в Excel и загрузка из Excel" />

      {can('data.export') && (
        <div className="card">
          <h3><Download />Выгрузка в Excel</h3>
          <div className="row" style={{ marginBottom: 14, gap: 12 }}>
            <Field label="Период с (для начислений и оплат)"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="по"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Гаражи"><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Действующие</option><option value="ARCHIVED">Архив</option><option value="ALL">Все</option></select></Field>
          </div>
          <div className="grid g3">
            {EXPORTS.filter((x) => can(x.perm)).map((x) => (
              <div key={x.kind} className="card inner" style={{ display: 'grid', gap: 8 }}>
                <b><FileSpreadsheet size={16} style={{ verticalAlign: -3, marginRight: 6 }} />{x.title}</b>
                <span className="muted" style={{ fontSize: 12.5 }}>{x.text}</span>
                <div>
                  <button className="btn" disabled={busy === x.kind}
                    onClick={() => dl(`/export/${x.kind}.xlsx${qs(x.period ? { from, to } : x.status ? { status } : undefined)}`, `${x.kind}.xlsx`, x.kind)}>
                    <Download />{busy === x.kind ? 'Готовим…' : 'Скачать .xlsx'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {can('data.import') && (
        <div className="card">
          <h3><Upload />Загрузка из Excel</h3>
          <p className="muted" style={{ marginTop: 0 }}>Порядок: сначала «Гаражи и владельцы», затем начисления (входящие долги) и оплаты. Перед записью файл проверяется — вы увидите отчёт и ошибки по строкам.</p>
          <div className="grid g3">
            {IMPORTS.map((x) => {
              const allowed = x.perms.every((p) => can(p));
              return (
                <div key={x.kind} className="card inner" style={{ display: 'grid', gap: 8 }}>
                  <b><FileUp size={16} style={{ verticalAlign: -3, marginRight: 6 }} />{x.title}</b>
                  <span className="muted" style={{ fontSize: 12.5 }}>{x.text}</span>
                  <div className="row">
                    <button className="btn ghost sm" onClick={() => dl(`/import/template/${x.kind}.xlsx`, `shablon-${x.kind}.xlsx`, `t-${x.kind}`)}><Download />Шаблон</button>
                    <button className="btn primary sm" disabled={!allowed} title={allowed ? '' : 'Недостаточно прав'} onClick={() => setWizard(x.kind)}><Upload />Загрузить</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {can('data.import') && (
        <div className="card flush">
          <div style={{ padding: '16px 18px 0' }}><h3><History />История загрузок</h3></div>
          {history.isLoading ? <Spinner /> : !history.data?.length ? <Empty text="Загрузок ещё не было" /> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Когда</th><th>Что</th><th>Файл</th><th>Кто</th><th>Итог</th></tr></thead>
                <tbody>
                  {history.data.map((h: any) => (
                    <tr key={h.id}>
                      <td>{dateTime(h.at)}</td><td>{KIND_LABEL[h.kind] ?? h.kind}</td><td className="mono">{h.fileName}</td><td>{h.by ?? '—'}</td>
                      <td className="muted" style={{ fontSize: 12.5 }}>{Object.entries(h.summary ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {wizard && <ImportWizard kind={wizard} onClose={() => setWizard(null)} />}
    </div>
  );
}

function ImportWizard({ kind, onClose }: { kind: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<any>(null);
  const [update, setUpdate] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const q = (dry: boolean) => `/import/${kind}${qs({ dryRun: dry ? 1 : undefined, updateExisting: update ? 1 : undefined, force: force ? 1 : undefined })}`;

  async function check(f: File, upd = update) {
    setBusy(true); setReport(null);
    try {
      const path = `/import/${kind}${qs({ dryRun: 1, updateExisting: upd ? 1 : undefined })}`;
      setReport(await uploadFile(path, f));
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  }

  async function apply() {
    if (!file) return;
    setBusy(true);
    try {
      const r = await uploadFile(q(false), file);
      setReport(r); setDone(true);
      toast('Данные загружены');
      qc.invalidateQueries();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  }

  const errors = report?.errorCount ?? 0;
  return (
    <Modal title={`Загрузка: ${KIND_LABEL[kind]}`} size="wide" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>{done ? 'Закрыть' : 'Отмена'}</button>
        {!done && <button className="btn primary" disabled={busy || !report || errors > 0 || (report.alreadyImported && !force && kind !== 'garages')} onClick={apply}>
          {busy ? 'Загружаем…' : 'Записать данные'}
        </button>}
      </>
    }>
      <div className="stack">
        {!done && (
          <>
            <input ref={ref} type="file" hidden accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; setFile(f); setDone(false); if (f) check(f); }} />
            <div className="row">
              <button className="btn" onClick={() => ref.current?.click()}><FileUp />{file ? 'Выбрать другой файл' : 'Выбрать файл .xlsx'}</button>
              {file && <span className="mono">{file.name}</span>}
            </div>
            {kind === 'garages' && (
              <label className="check"><input type="checkbox" checked={update} onChange={(e) => { setUpdate(e.target.checked); if (file) check(file, e.target.checked); }} />
                Обновлять существующие гаражи и пользователей (иначе только дополняются пустые поля)</label>
            )}
          </>
        )}
        {busy && !report && <Spinner />}
        {report && (
          <>
            {report.alreadyImported && kind !== 'garages' && !done && (
              <div className="callout warn">
                <TriangleAlert /><div>Этот файл уже загружался {dateTime(report.alreadyImported.at)}. Повторная запись создаст дубликаты.
                  <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />Всё равно загрузить повторно</label></div>
              </div>
            )}
            <div className={`callout ${errors ? 'bad' : 'good'}`}>
              {errors ? <TriangleAlert /> : <CheckCircle2 />}
              <div>
                <b>{done ? 'Загружено' : errors ? `Найдено ошибок: ${errors} — исправьте файл и выберите его снова` : 'Файл проверен, ошибок нет'}</b>
                <div className="muted" style={{ fontSize: 13 }}>Строк в файле: {report.rows}</div>
              </div>
            </div>
            <div className="grid g3">
              {Object.entries(report.summary ?? {}).map(([k, v]) => (
                <div key={k} className="card inner"><div className="muted" style={{ fontSize: 12 }}>{k}</div><div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{String(v)}</div></div>
              ))}
            </div>
            {!!report.warnings?.length && <div className="stack" style={{ gap: 4 }}>{report.warnings.map((w: string, i: number) => <div key={i} className="warn" style={{ fontSize: 13 }}>⚠ {w}</div>)}</div>}
            {!!errors && (
              <div className="table-wrap" style={{ maxHeight: 260 }}>
                <table className="t"><thead><tr><th style={{ width: 80 }}>Строка</th><th>Ошибка</th></tr></thead>
                  <tbody>{report.errors.map((e: any, i: number) => <tr key={i}><td className="num">{e.row || '—'}</td><td>{e.message}</td></tr>)}</tbody></table>
                {errors > report.errors.length && <div className="muted" style={{ padding: 8 }}>Показаны первые {report.errors.length} из {errors}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
