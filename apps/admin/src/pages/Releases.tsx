import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Download, Smartphone, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { del, get, post, uploadWithProgress } from '../lib/api';
import { dateTime } from '../lib/format';
import { Empty, Field, PageHead, Spinner, useConfirm, useToast } from '../ui';

const mb = (n: number) => `${(n / 1048576).toFixed(1)} МБ`;

export default function ReleasesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const file = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useQuery({ queryKey: ['releases'], queryFn: () => get('/releases') });
  const [f, setF] = useState({ versionName: '', versionCode: '', notes: '' });
  const [pick, setPick] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const last = data?.[0];

  async function upload() {
    if (!pick) return;
    const fd = new FormData();
    fd.append('file', pick); fd.append('versionName', f.versionName.trim()); fd.append('versionCode', f.versionCode); if (f.notes.trim()) fd.append('notes', f.notes.trim());
    setPct(0);
    try {
      await uploadWithProgress('/releases', fd, setPct);
      toast('Версия загружена'); setPick(null); setF({ versionName: '', versionCode: '', notes: '' }); if (file.current) file.current.value = '';
      qc.invalidateQueries({ queryKey: ['releases'] });
    } catch (e: any) { toast(e.message, 'err'); } finally { setPct(null); }
  }
  const announce = useMutation({ mutationFn: (id: number) => post(`/releases/${id}/announce`), onSuccess: (r) => toast(`Уведомление отправлено на устройств: ${r.sent}`), onError: (e: any) => toast(e.message, 'err') });
  const remove = useMutation({ mutationFn: (id: number) => del(`/releases/${id}`), onSuccess: () => { toast('Версия удалена'); qc.invalidateQueries({ queryKey: ['releases'] }); }, onError: (e: any) => toast(e.message, 'err') });

  async function download(id: number) {
    try { const r = await post(`/releases/${id}/link`); window.location.href = r.url; } catch (e: any) { toast(e.message, 'err'); }
  }

  return (
    <div className="rise">
      <PageHead title="Приложение для Android" sub="Загрузите новую сборку: у жителей появится предложение обновиться" />
      <div className="grid g-main">
        <div className="card">
          <h3><Upload />Новая версия</h3>
          <div className="stack">
            <div className="grid g2">
              <Field label="Версия" hint={last ? `Сейчас: ${last.versionName}` : 'Например 1.0.0'}><input className="input num" value={f.versionName} onChange={(e) => setF({ ...f, versionName: e.target.value })} placeholder="1.0.0" /></Field>
              <Field label="Код версии (versionCode)" hint={last ? `Должен быть больше ${last.versionCode}` : 'Целое число, растёт с каждой сборкой'}><input className="input num" inputMode="numeric" value={f.versionCode} onChange={(e) => setF({ ...f, versionCode: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            <Field label="Что нового"><textarea className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={3000} placeholder="Этот текст увидят жители в окне обновления" /></Field>
            <div className="row">
              <button className="btn" onClick={() => file.current?.click()}><Smartphone />{pick ? pick.name : 'Выбрать APK'}</button>
              {pick && <span className="muted">{mb(pick.size)}</span>}
              <input ref={file} type="file" accept=".apk,application/vnd.android.package-archive" hidden onChange={(e) => setPick(e.target.files?.[0] ?? null)} />
              <button className="btn primary" disabled={!pick || !f.versionName.trim() || !f.versionCode || pct !== null} onClick={upload}><Upload />Загрузить</button>
            </div>
            {pct !== null && <div className="progress"><i style={{ width: `${pct}%` }} /></div>}
          </div>
        </div>
        <div className="card">
          <h3>Как это работает</h3>
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Соберите APK, подпишите своим ключом.</li>
            <li>Загрузите здесь с большим кодом версии.</li>
            <li>Приложение при запуске узнает о новой версии и предложит «Скачать» или «Позже».</li>
            <li>Файл доступен только авторизованным.</li>
          </ol>
        </div>
      </div>

      <div className="card flush" style={{ marginTop: 16 }}>
        {isLoading ? <Spinner /> : !data?.length ? <Empty icon={<Smartphone />} text="Версий пока нет" /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Версия</th><th>Код</th><th>Размер</th><th>Загружена</th><th>Описание</th><th /></tr></thead>
            <tbody>{data.map((r: any, i: number) => (
              <tr key={r.id}>
                <td><b>{r.versionName}</b> {i === 0 && <span className="badge b-good">актуальная</span>}<div className="mono muted" style={{ fontSize: 11 }} title={r.sha256}>sha256 {r.sha256.slice(0, 12)}…</div></td>
                <td className="num">{r.versionCode}</td><td className="num">{mb(r.size)}</td><td className="num">{dateTime(r.createdAt)}</td>
                <td className="muted" style={{ whiteSpace: 'normal', maxWidth: 320 }}>{r.notes ?? '—'}</td>
                <td className="r"><div className="row end" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  <button className="btn sm" onClick={() => download(r.id)}><Download />Скачать</button>
                  {i === 0 && <button className="btn sm" onClick={async () => { if (await confirm({ title: 'Оповестить жителей?', text: 'Всем с включёнными уведомлениями придёт push о новой версии.', ok: 'Отправить' })) announce.mutate(r.id); }}><BellRing />Оповестить</button>}
                  <button className="btn icon sm ghost" aria-label="Удалить" onClick={async () => { if (await confirm({ title: `Удалить версию ${r.versionName}?`, ok: 'Удалить', danger: true })) remove.mutate(r.id); }}><Trash2 /></button>
                </div></td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
