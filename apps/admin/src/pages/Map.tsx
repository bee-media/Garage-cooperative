import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, ImageUp, Lamp, MapPin, MousePointer2, Printer, Rows3, Settings2, Trash2, ZoomIn, ZoomOut, Maximize, Square, Cable, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react';
import { PointerEvent as RPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, fileBlobUrl, get, patch, post, put, uploadMapImage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { COLOR_LABEL, dateTime } from '../lib/format';
import { Empty, Field, ImagePicker, Modal, PageHead, SecureImage, Spinner, useConfirm, useToast } from '../ui';

/* ───── типы и константы ───── */
type Tool = 'select' | 'row' | 'box' | 'line' | 'mark' | 'pole';
type Sel = { t: 'box'; number: string } | { t: 'row'; id: number } | { t: 'mark'; id: number } | { t: 'pole'; id: number } | { t: 'line'; id: number } | null;
interface Pt { x: number; y: number }
/** Вершина линии; poleId — «приклеена» к опоре и следует за ней */
interface LPt extends Pt { poleId?: number }

const CATS: Record<string, { label: string; color: string }> = {
  NO_LIGHT: { label: 'Не работает свет', color: '#f2c261' },
  DAMAGE: { label: 'Повреждение', color: '#ff6b6b' },
  LEAK: { label: 'Протечка / вода', color: '#5aa9e6' },
  TRASH: { label: 'Мусор / свалка', color: '#b08968' },
  OTHER: { label: 'Другое', color: '#a8dadc' },
};
const LINE_STATUS: Record<string, { label: string; color: string }> = {
  OK: { label: 'Исправна', color: '#4fd1a5' },
  CHECK: { label: 'Требует осмотра', color: '#f2c261' },
  EMERGENCY: { label: 'Авария', color: '#ff4d4d' },
  OFF: { label: 'Отключена', color: '#9aa7b2' },
};
const LINE_COLORS = ['#f2c261', '#ff9f43', '#5aa9e6', '#4fd1a5', '#c77dff', '#e9ecef'];
const DEBT_COLOR: Record<string, string> = { GREEN: '#4fd1a5', ORANGE: '#f2c261', RED: '#ff6b6b' };
const NEUTRAL = '#6b8190';

const num = (v: string) => parseInt(v, 10);
/** Номера боксов для ряда: от первого с шагом (шаг может быть отрицательным) */
const genNumbers = (first: number, step: number, count: number) => Array.from({ length: count }, (_, i) => String(first + i * step));
/** «1, 2, -, 4» → ['1','2','','4']; «-» и «_» означают бокс без номера */
const parseNumbers = (s: string) => s.split(/[\s,;]+/).filter((t) => t !== '').map((t) => (t === '-' || t === '_' ? '' : t));

const rowGeom = (r: any) => {
  const dx = r.x2 - r.x1, dy = r.y2 - r.y1;
  return { len: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI };
};
const boxCenter = (r: any, i: number) => {
  const n = r.boxes.length, t = (i + 0.5) / n;
  return { x: r.x1 + (r.x2 - r.x1) * t, y: r.y1 + (r.y2 - r.y1) * t };
};

/* ───── страница ───── */
export default function MapPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const scene = useQuery({ queryKey: ['map'], queryFn: () => get('/map') });
  const s = scene.data;
  const canEdit = !!s?.access.edit, canMark = !!s?.access.mark;

  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<Sel>(null);
  const [layers, setLayers] = useState({ rows: true, colors: true, marks: true, poles: true, lines: true });
  const [dialog, setDialog] = useState<null | { kind: 'row'; row?: any; p1?: Pt; p2?: Pt; single?: boolean } | { kind: 'mark'; at: Pt; garageNumber?: string; mark?: any } | { kind: 'pole'; at: Pt; pole?: any } | { kind: 'line'; pts?: LPt[]; line?: any } | { kind: 'line-status'; line: any } | { kind: 'line-log'; line: any } | { kind: 'settings' } | { kind: 'closed' } | { kind: 'close-mark'; mark: any }>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['map'] });
  const onErr = (e: any) => toast(e.message, 'err');

  const delRow = useMutation({ mutationFn: (id: number) => del(`/map/rows/${id}`), onSuccess: () => { setSel(null); refresh(); toast('Ряд удалён'); }, onError: onErr });
  const delMark = useMutation({ mutationFn: (id: number) => del(`/map/marks/${id}`), onSuccess: () => { setSel(null); refresh(); toast('Пометка удалена'); }, onError: onErr });
  const delLine = useMutation({ mutationFn: (id: number) => del(`/map/lines/${id}`), onSuccess: () => { setSel(null); refresh(); toast('Линия удалена'); }, onError: onErr });
  const delPole = useMutation({ mutationFn: (id: number) => del(`/map/poles/${id}`), onSuccess: () => { setSel(null); refresh(); toast('Опора удалена'); }, onError: onErr });
  const move = useMutation({ mutationFn: (v: { path: string; body: any }) => patch(v.path, v.body), onSuccess: refresh, onError: (e: any) => { onErr(e); refresh(); } });

  const nudge = (r: any, dx: number, dy: number) => move.mutate({ path: `/map/rows/${r.id}`, body: { x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy } });
  const askDelRow = async (r: any) => { if (await confirm({ title: 'Удалить ряд?', text: 'Сами гаражи и их данные не удаляются, пропадёт только рисунок на карте.', ok: 'Удалить', danger: true })) delRow.mutate(r.id); };
  const nudgePad = (r: any) => (
    <div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Сдвиг ряда (или перетащите мышью)</div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn icon sm" aria-label="Влево" onClick={() => nudge(r, -10, 0)}><ArrowLeft /></button>
        <button className="btn icon sm" aria-label="Вверх" onClick={() => nudge(r, 0, -10)}><ArrowUp /></button>
        <button className="btn icon sm" aria-label="Вниз" onClick={() => nudge(r, 0, 10)}><ArrowDown /></button>
        <button className="btn icon sm" aria-label="Вправо" onClick={() => nudge(r, 10, 0)}><ArrowRight /></button>
      </div>
    </div>
  );

  if (scene.isLoading) return <Spinner />;
  if (scene.error || !s) return <div className="card"><Empty text={(scene.error as any)?.message ?? 'Карта недоступна'} /></div>;

  const rows: any[] = s.rows, marks: any[] = s.marks, poles: any[] = s.poles, lines: any[] = s.lines ?? [];
  const selectedRow = sel?.t === 'row' ? rows.find((r) => r.id === sel.id) : null;
  const selectedBox = sel?.t === 'box' ? rows.flatMap((r, ri) => r.boxes.map((b: any, i: number) => ({ ...b, row: r, i }))).find((b: any) => b.number === sel.number) : null;
  const selectedMark = sel?.t === 'mark' ? marks.find((m) => m.id === sel.id) : null;
  const selectedLine = sel?.t === 'line' ? lines.find((l) => l.id === sel.id) : null;
  const selectedPole = sel?.t === 'pole' ? poles.find((p) => p.id === sel.id) : null;

  const tools: { id: Tool; icon: JSX.Element; label: string; show: boolean }[] = [
    { id: 'select', icon: <MousePointer2 />, label: 'Выбрать', show: true },
    { id: 'row', icon: <Rows3 />, label: 'Нарисовать ряд', show: canEdit },
    { id: 'box', icon: <Square />, label: 'Один бокс', show: canEdit },
    { id: 'line', icon: <Cable />, label: 'Линия', show: canMark && s.access.staff },
    { id: 'mark', icon: <MapPin />, label: 'Пометка', show: canMark },
    { id: 'pole', icon: <Lamp />, label: 'Опора', show: canMark },
  ];

  return (
    <div className="rise">
      <PageHead title="Карта ГСК" sub="Цвет бокса — состояние задолженности. Нажмите на бокс, пометку или опору, чтобы открыть подробности" actions={
        <>
          <button className="btn" onClick={() => setDialog({ kind: 'closed' })}><History />Снятые пометки</button>
          <button className="btn" onClick={() => window.print()}><Printer />Печать / PDF</button>
          {canEdit && <button className="btn" onClick={() => setDialog({ kind: 'settings' })}><Settings2 />Настройки карты</button>}
        </>
      } />

      <div className="map-layout">
        <div className="card flush map-card">
          <div className="map-toolbar">
            <div className="chips">
              {tools.filter((t) => t.show).map((t) => <button key={t.id} className={`chip ${tool === t.id ? 'on' : ''}`} onClick={() => { setTool(t.id); setSel(null); }}>{t.icon}{t.label}</button>)}
            </div>
            <div className="chips">
              <button className={`chip ${layers.rows ? 'on' : ''}`} onClick={() => setLayers({ ...layers, rows: !layers.rows })}>Боксы</button>
              {s.access.debts && <button className={`chip ${layers.colors ? 'on' : ''}`} onClick={() => setLayers({ ...layers, colors: !layers.colors })}>Цвет долга</button>}
              <button className={`chip ${layers.marks ? 'on' : ''}`} onClick={() => setLayers({ ...layers, marks: !layers.marks })}>Пометки · {s.stats.openMarks}</button>
              {s.access.staff && <button className={`chip ${layers.lines ? 'on' : ''}`} onClick={() => setLayers({ ...layers, lines: !layers.lines })}>Линии · {s.stats.lines}</button>}
              <button className={`chip ${layers.poles ? 'on' : ''}`} onClick={() => setLayers({ ...layers, poles: !layers.poles })}>Опоры · {s.stats.poles}</button>
            </div>
          </div>
          <MapCanvas
            scene={s} tool={tool} sel={sel} layers={layers} canEdit={canEdit} canMark={canMark}
            onSelect={setSel}
            onRowDrawn={(p1, p2) => { setDialog({ kind: 'row', p1, p2 }); setTool('select'); }}
            onPlaceBox={(a, b) => { setDialog({ kind: 'row', p1: a, p2: b, single: true }); setTool('select'); }}
            onLineDrawn={(pts) => { setDialog({ kind: 'line', pts }); setTool('select'); }}
            onPlaceMark={(at) => { setDialog({ kind: 'mark', at }); setTool('select'); }}
            onPlacePole={(at) => { setDialog({ kind: 'pole', at }); setTool('select'); }}
            onMove={(path, body) => move.mutate({ path, body })}
          />
        </div>

        <div className="stack map-side">
          {selectedBox ? (
            <div className="card">
              <h3>Гараж №{selectedBox.number}</h3>
              {!selectedBox.garageId ? <p className="muted" style={{ margin: 0 }}>{selectedBox.number ? 'Гаража с таким номером нет в списке. Добавьте его в разделе «Гаражи» или поправьте номер бокса.' : 'Бокс без номера'}</p> : (
                <div className="stack">
                  <div className="row">
                    {selectedBox.color && <span className="badge" style={{ background: DEBT_COLOR[selectedBox.color] + '30', color: DEBT_COLOR[selectedBox.color] }}>{COLOR_LABEL[selectedBox.color]}</span>}
                    {selectedBox.hasBenefit && <span className="badge b-benefit">★ Льгота</span>}
                    {selectedBox.archived && <span className="badge b-off">В архиве</span>}
                  </div>
                  <div>{selectedBox.owners?.length ? selectedBox.owners.join(', ') : <span className="muted">нет владельца</span>}</div>
                  {can('garages.view') && <Link to={`/garages/${selectedBox.garageId}`} className="btn primary">Открыть карточку гаража</Link>}
                </div>
              )}
              {canMark && <button className="btn" style={{ marginTop: 10 }} onClick={() => setDialog({ kind: 'mark', at: boxCenter(selectedBox.row, selectedBox.i), garageNumber: selectedBox.number })}><MapPin />Поставить пометку на этом гараже</button>}
              {canEdit && (
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="muted" style={{ fontSize: 12.5 }}>Ряд «{selectedBox.row.label || `№${selectedBox.row.id}`}» можно перетащить по карте</div>
                  {nudgePad(selectedBox.row)}
                  <button className="btn" onClick={() => setSel({ t: 'row', id: selectedBox.row.id })}>Изменить ряд</button>
                  <button className="btn danger" onClick={() => askDelRow(selectedBox.row)}><Trash2 />Удалить ряд</button>
                </div>
              )}
            </div>
          ) : selectedRow ? (
            <div className="card">
              <h3>Ряд «{selectedRow.label || `№${selectedRow.id}`}»</h3>
              <p className="muted" style={{ margin: '0 0 10px' }}>Боксов: {selectedRow.boxes.length}. Перетащите ряд или его концы по карте.</p>
              <div className="stack">
                <div className="mono" style={{ fontSize: 13, wordBreak: 'break-word' }}>{selectedRow.boxes.map((b: any) => b.number || '·').join(' ')}</div>
                {canEdit && <button className="btn" onClick={() => setDialog({ kind: 'row', row: selectedRow })}>Изменить номера и размеры</button>}
                {canEdit && nudgePad(selectedRow)}
                {canEdit && <button className="btn danger" onClick={() => askDelRow(selectedRow)}><Trash2 />Удалить ряд</button>}
              </div>
            </div>
          ) : selectedMark ? (
            <div className="card">
              <h3><MapPin style={{ color: CATS[selectedMark.category]?.color }} />{CATS[selectedMark.category]?.label ?? selectedMark.category}</h3>
              <div className="stack">
                {selectedMark.garageNumber && <div className="muted">Гараж №{selectedMark.garageNumber}</div>}
                {selectedMark.comment && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{selectedMark.comment}</p>}
                {selectedMark.fileId && <SecureImage id={selectedMark.fileId} className="photo" />}
                <div className="muted" style={{ fontSize: 12.5 }}>{selectedMark.createdBy ? `${selectedMark.createdBy} · ` : ''}{dateTime(selectedMark.createdAt)}</div>
                {canMark && <button className="btn primary" onClick={() => setDialog({ kind: 'close-mark', mark: selectedMark })}>Снять пометку (проблема устранена)</button>}
                {canMark && <button className="btn" onClick={() => setDialog({ kind: 'mark', at: { x: selectedMark.x, y: selectedMark.y }, mark: selectedMark })}>Изменить</button>}
                {canEdit && <button className="btn danger" onClick={async () => { if (await confirm({ title: 'Удалить пометку?', text: 'Пометка и фото будут удалены безвозвратно (в отличие от «Снять», которая сохраняет историю).', ok: 'Удалить', danger: true })) delMark.mutate(selectedMark.id); }}><Trash2 />Удалить</button>}
              </div>
            </div>
          ) : selectedLine ? (
            <div className="card">
              <h3><Cable style={{ color: selectedLine.color }} />{selectedLine.name || `Линия №${selectedLine.id}`}</h3>
              <div className="stack">
                <div className="row"><span className="badge" style={{ background: LINE_STATUS[selectedLine.status]?.color + '30', color: LINE_STATUS[selectedLine.status]?.color }}>{LINE_STATUS[selectedLine.status]?.label ?? selectedLine.status}</span><span className="muted" style={{ fontSize: 12.5 }}>Точек: {selectedLine.points.length}</span></div>
                {selectedLine.comment && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{selectedLine.comment}</p>}
                {selectedLine.fileId && <SecureImage id={selectedLine.fileId} className="photo" />}
                <div className="muted" style={{ fontSize: 12.5 }}>Изменена {dateTime(selectedLine.updatedAt)}</div>
                {canMark && <button className="btn primary" onClick={() => setDialog({ kind: 'line-status', line: selectedLine })}>Сменить состояние</button>}
                <button className="btn" onClick={() => setDialog({ kind: 'line-log', line: selectedLine })}><History />Журнал</button>
                {canMark && <button className="btn" onClick={() => setDialog({ kind: 'line', line: selectedLine })}>Изменить</button>}
                {canMark && <div className="muted" style={{ fontSize: 12.5 }}>Точки можно тянуть мышью, «+» между точками добавляет новую, Shift + клик по точке удаляет её. Точка у опоры приклеивается к ней.</div>}
                {canEdit && <button className="btn danger" onClick={async () => { if (await confirm({ title: 'Удалить линию?', text: 'Линия и её журнал будут удалены безвозвратно.', ok: 'Удалить', danger: true })) delLine.mutate(selectedLine.id); }}><Trash2 />Удалить</button>}
              </div>
            </div>
          ) : selectedPole ? (
            <div className="card">
              <h3><Lamp />Опора №{selectedPole.number}</h3>
              <div className="stack">
                {selectedPole.comment && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{selectedPole.comment}</p>}
                {selectedPole.fileId && <SecureImage id={selectedPole.fileId} className="photo" />}
                {canMark && <button className="btn" onClick={() => setDialog({ kind: 'pole', at: { x: selectedPole.x, y: selectedPole.y }, pole: selectedPole })}>Изменить</button>}
                {canEdit && <button className="btn danger" onClick={async () => { if (await confirm({ title: `Удалить опору №${selectedPole.number}?`, ok: 'Удалить', danger: true })) delPole.mutate(selectedPole.id); }}><Trash2 />Удалить</button>}
              </div>
            </div>
          ) : (
            <div className="card">
              <h3>Сводка</h3>
              <dl className="kv" style={{ margin: 0 }}>
                <dt>Боксов на карте</dt><dd className="num">{s.stats.boxes}</dd>
                <dt>Привязано к гаражам</dt><dd className="num">{s.stats.linked}</dd>
                <dt>Без гаража в списке</dt><dd className={`num ${s.stats.unlinked ? 'warn' : ''}`}>{s.stats.unlinked}</dd>
                <dt>Опор освещения</dt><dd className="num">{s.stats.poles}</dd>
                {s.access.staff && <><dt>Линий электропередачи</dt><dd className="num">{s.stats.lines}</dd>
                <dt>Линий в аварии</dt><dd className={`num ${s.stats.emergencyLines ? 'warn' : ''}`}>{s.stats.emergencyLines}</dd></>}
                <dt>Открытых пометок</dt><dd className={`num ${s.stats.openMarks ? 'warn' : ''}`}>{s.stats.openMarks}</dd>
              </dl>
              {s.stats.duplicates.length > 0 && <div className="notice-box" style={{ marginTop: 10, background: 'rgba(242,194,97,.14)', color: 'var(--warn)' }}>Повторяются номера: {s.stats.duplicates.join(', ')}</div>}
              {!s.settings.backgroundFileId && canEdit && <div className="muted" style={{ marginTop: 10 }}>Загрузите схему кооператива в «Настройках карты» и нарисуйте ряды боксов инструментом «Нарисовать ряд».</div>}
            </div>
          )}

          <div className="card">
            <h3>Легенда</h3>
            <div className="stack" style={{ gap: 8 }}>
              {s.access.debts && Object.entries(DEBT_COLOR).map(([k, c]) => <div key={k} className="row" style={{ gap: 10 }}><i style={{ width: 16, height: 16, borderRadius: 4, background: c, display: 'inline-block' }} />{COLOR_LABEL[k]}</div>)}
              <div className="row" style={{ gap: 10 }}><i style={{ width: 16, height: 16, borderRadius: 4, background: NEUTRAL, display: 'inline-block' }} />{s.access.debts ? 'Нет данных / гараж не найден' : 'Гараж'}</div>
              {Object.entries(CATS).map(([k, c]) => <div key={k} className="row" style={{ gap: 10 }}><i style={{ width: 14, height: 14, borderRadius: '50%', background: c.color, display: 'inline-block' }} />{c.label}</div>)}
              <div className="row" style={{ gap: 10 }}><Lamp size={16} />Опора освещения</div>
              {s.access.staff && Object.entries(LINE_STATUS).map(([k, c]) => <div key={k} className="row" style={{ gap: 10 }}><i style={{ width: 18, height: 0, borderTop: `3px ${k === 'OFF' ? 'dashed' : 'solid'} ${c.color}`, display: 'inline-block' }} />Линия: {c.label.toLowerCase()}</div>)}
            </div>
          </div>
        </div>
      </div>

      {dialog?.kind === 'row' && <RowDialog row={dialog.row} p1={dialog.p1} p2={dialog.p2} single={dialog.single} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); refresh(); if (id) setSel({ t: 'row', id }); }} />}
      {dialog?.kind === 'mark' && <MarkDialog at={dialog.at} garageNumber={dialog.garageNumber} mark={dialog.mark} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === 'pole' && <PoleDialog at={dialog.at} pole={dialog.pole} nextNumber={String(Math.max(0, ...poles.map((p) => num(p.number) || 0)) + 1)} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === 'line' && <LineDialog pts={dialog.pts} line={dialog.line} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); refresh(); if (id) setSel({ t: 'line', id }); }} />}
      {dialog?.kind === 'line-status' && <LineStatusDialog line={dialog.line} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === 'line-log' && <LineLogDialog line={dialog.line} canWrite={canMark} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'close-mark' && <CloseMarkDialog mark={dialog.mark} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setSel(null); refresh(); }} />}
      {dialog?.kind === 'settings' && <SettingsDialog s={s.settings} onClose={() => setDialog(null)} onDone={() => { refresh(); }} />}
      {dialog?.kind === 'closed' && <ClosedMarksDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

/* ───── холст ───── */
function MapCanvas({ scene, tool, sel, layers, canEdit, canMark, onSelect, onRowDrawn, onLineDrawn, onPlaceBox, onPlaceMark, onPlacePole, onMove }: {
  scene: any; tool: Tool; sel: Sel; layers: { rows: boolean; colors: boolean; marks: boolean; poles: boolean; lines: boolean };
  canEdit: boolean; canMark: boolean; onSelect: (s: Sel) => void;
  onRowDrawn: (p1: Pt, p2: Pt) => void; onLineDrawn: (pts: LPt[]) => void; onPlaceBox: (p1: Pt, p2: Pt) => void; onPlaceMark: (p: Pt) => void; onPlacePole: (p: Pt) => void;
  onMove: (path: string, body: any) => void;
}) {
  const W: number = scene.settings.width, H: number = scene.settings.height;
  const wrap = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [vb, setVbRaw] = useState<{ x: number; y: number; w: number } | null>(null);
  const touched = useRef(false); // пользователь сам двигал или масштабировал карту — автоподгонку не трогаем
  const setVb: typeof setVbRaw = (v) => { touched.current = true; setVbRaw(v); };
  const [bg, setBg] = useState<string | null>(null);
  const [first, setFirst] = useState<Pt | null>(null);      // первая точка рисуемого ряда
  const [hover, setHover] = useState<Pt | null>(null);
  const [linePts, setLinePts] = useState<LPt[]>([]);        // вершины рисуемой линии
  useEffect(() => { if (tool !== 'line') setLinePts([]); }, [tool]);
  // перетаскивание: временные координаты, пока не отпущена кнопка
  const [drag, setDrag] = useState<null | { kind: 'row' | 'p1' | 'p2' | 'mark' | 'pole' | 'vtx' | 'pan'; id?: number; start: Pt; startPx: Pt; orig: any; moved: boolean }>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(() => { const r = wrap.current!.getBoundingClientRect(); setSize({ w: Math.max(300, r.width), h: Math.max(300, r.height) }); });
    ro.observe(wrap.current); return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!scene.settings.backgroundFileId) { setBg(null); return; }
    let live = true; fileBlobUrl(scene.settings.backgroundFileId).then((u) => live && setBg(u)).catch(() => {}); return () => { live = false; };
  }, [scene.settings.backgroundFileId]);

  // вся схема по центру с небольшим полем; сама область карты не ограничена — можно отдалять и двигать куда угодно
  const fit = useCallback((auto = false) => {
    const scale = Math.min(size.w / W, size.h / H) * 0.96;
    const w = size.w / scale, h = size.h / scale;
    if (!auto) touched.current = false;
    setVbRaw({ x: (W - w) / 2, y: (H - h) / 2, w });
  }, [size, W, H]);
  useEffect(() => { if (!touched.current) fit(true); }, [fit]);
  useEffect(() => { touched.current = false; }, [W, H, scene.settings.backgroundFileId]);

  const vh = vb ? (vb.w * size.h) / size.w : 0;
  const k = vb ? vb.w / size.w : 1; // единиц карты на пиксель экрана

  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!; const m = svg.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m); return { x: p.x, y: p.y };
  };

  // зум колесом вокруг курсора
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      setVb((v) => {
        if (!v) return v;
        const m = el.getScreenCTM()!.inverse(); const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
        const f = e.deltaY > 0 ? 1.15 : 1 / 1.15; const nw = Math.min(W * 20, Math.max(W / 150, v.w * f)); const r = nw / v.w;
        return { x: p.x - (p.x - v.x) * r, y: p.y - (p.y - v.y) * r, w: nw };
      });
    };
    el.addEventListener('wheel', h, { passive: false }); return () => el.removeEventListener('wheel', h);
  }, [W, vb === null]); // eslint-disable-line

  const zoomBy = (f: number) => setVb((v) => { if (!v) return v; const nw = Math.min(W * 20, Math.max(W / 150, v.w * f)); const h0 = (v.w * size.h) / size.w, h1 = (nw * size.h) / size.w; return { x: v.x + (v.w - nw) / 2, y: v.y + (h0 - h1) / 2, w: nw }; });

  function startDrag(e: RPointerEvent, kind: 'row' | 'p1' | 'p2' | 'mark' | 'pole' | 'vtx', id: number, orig: any) {
    e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ kind, id, start: toPt(e), startPx: { x: e.clientX, y: e.clientY }, orig, moved: false });
  }

  function onPointerDown(e: RPointerEvent<SVGSVGElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, startPx: { x: e.clientX, y: e.clientY }, orig: vb, moved: false });
  }

  function onPointerMove(e: RPointerEvent<SVGSVGElement>) {
    const p = toPt(e); setHover(p);
    if (!drag) return;
    const dxp = e.clientX - drag.startPx.x, dyp = e.clientY - drag.startPx.y;
    const moved = drag.moved || Math.hypot(dxp, dyp) > 4;
    if (moved !== drag.moved) setDrag({ ...drag, moved });
    if (!moved) return;
    if (drag.kind === 'pan') {
      const o = drag.orig; setVb({ x: o.x - dxp * k, y: o.y - dyp * k, w: o.w });
    } else {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y, o = drag.orig;
      if (drag.kind === 'row') setDraft({ [`r${drag.id}`]: { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy } });
      if (drag.kind === 'p1') setDraft({ [`r${drag.id}`]: { x1: o.x1 + dx, y1: o.y1 + dy } });
      if (drag.kind === 'p2') setDraft({ [`r${drag.id}`]: { x2: o.x2 + dx, y2: o.y2 + dy } });
      if (drag.kind === 'mark') setDraft({ [`m${drag.id}`]: { x: o.x + dx, y: o.y + dy } });
      if (drag.kind === 'pole') setDraft({ [`p${drag.id}`]: { x: o.x + dx, y: o.y + dy } });
      if (drag.kind === 'vtx') { const sn = snapPole(p); setDraft({ [`l${drag.id}`]: { points: o.points.map((q: any, i: number) => (i === o.idx ? sn : q)) } }); }
    }
  }

  function onPointerUp(e: RPointerEvent<SVGSVGElement>) {
    const d = drag; setDrag(null);
    if (!d) return;
    const p = toPt(e);
    if (!d.moved) {
      // обычный клик по пустому месту карты
      if (d.kind === 'pan') {
        if (tool === 'row' && canEdit) {
          if (!first) setFirst(p); else { onRowDrawn(first, p); setFirst(null); }
        } else if (tool === 'line' && canMark) setLinePts((a) => [...a, snapPole(p)]);
        else if (tool === 'box' && canEdit) { const h = 20 * k; onPlaceBox({ x: p.x - h, y: p.y }, { x: p.x + h, y: p.y }); }
        else if (tool === 'mark' && canMark) onPlaceMark(p);
        else if (tool === 'pole' && canMark) onPlacePole(p);
        else onSelect(null);
      }
      setDraft({}); return;
    }
    if (d.kind === 'row' || d.kind === 'p1' || d.kind === 'p2') { const v = draft[`r${d.id}`]; if (v) onMove(`/map/rows/${d.id}`, v); }
    if (d.kind === 'mark') { const v = draft[`m${d.id}`]; if (v) onMove(`/map/marks/${d.id}`, v); }
    if (d.kind === 'pole') { const v = draft[`p${d.id}`]; if (v) onMove(`/map/poles/${d.id}`, v); }
    if (d.kind === 'vtx') { const v = draft[`l${d.id}`]; if (v) onMove(`/map/lines/${d.id}`, { points: v.points }); }
    // draft сбрасывается после обновления данных
    setTimeout(() => setDraft({}), 600);
  }

  const cursor = tool === 'select' ? (drag?.kind === 'pan' && drag.moved ? 'grabbing' : 'grab') : 'crosshair';
  const showNumbers = (bw: number) => bw / k >= 11;
  const rows: any[] = scene.rows;
  // ряд, который сейчас можно двигать: выбранный ряд или ряд выбранного бокса
  const activeRowId = sel?.t === 'row' ? sel.id : sel?.t === 'box' ? rows.find((r) => r.boxes.some((b: any) => b.number === sel.number))?.id : undefined;

  // вершины с poleId берут текущие координаты опоры (в том числе пока опору тащат)
  const poleById = new Map<number, any>(scene.poles.map((p: any) => [p.id, p]));
  const resolvePts = (pts: LPt[]): LPt[] => pts.map((q) => {
    const pl = q.poleId ? poleById.get(q.poleId) : null; if (!pl) return q;
    const d = draft[`p${pl.id}`]; return { ...q, x: d ? d.x : pl.x, y: d ? d.y : pl.y };
  });
  /** Если точка рядом с опорой — «прилипаем» к ней */
  function snapPole(p: Pt): LPt {
    let best: any = null, bd = 14 * k;
    for (const pl of scene.poles) { const dd = Math.hypot(pl.x - p.x, pl.y - p.y); if (dd < bd) { bd = dd; best = pl; } }
    return best ? { x: best.x, y: best.y, poleId: best.id } : { x: p.x, y: p.y };
  }
  function finishLine() {
    const out: LPt[] = [];
    for (const q of linePts) { const l = out[out.length - 1]; if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 4 * k) out.push(q); }
    setLinePts([]);
    if (out.length >= 2) onLineDrawn(out);
  }
  const lineD = (pts: Pt[]) => pts.map((q, i) => `${i ? 'L' : 'M'} ${q.x} ${q.y}`).join(' ');
  const hoverSnap = tool === 'line' && hover ? snapPole(hover) : null;

  // сетка размеров для рисуемого ряда
  const preview = first && hover ? { x1: first.x, y1: first.y, x2: hover.x, y2: hover.y } : null;

  return (
    <div ref={wrap} className="map-wrap">
      <div className="map-zoom">
        <button className="btn icon sm" onClick={() => zoomBy(1 / 1.3)} aria-label="Приблизить"><ZoomIn /></button>
        <button className="btn icon sm" onClick={() => zoomBy(1.3)} aria-label="Отдалить"><ZoomOut /></button>
        <button className="btn icon sm" onClick={() => fit()} aria-label="Вся карта"><Maximize /></button>
      </div>
      {tool !== 'select' && <div className="map-hint">{tool === 'line' ? (<>{linePts.length ? `Точек: ${linePts.length}. Продолжайте кликать; у опоры линия приклеится к ней` : 'Нажмите, где линия начинается; у опоры линия приклеится к ней'}{linePts.length >= 2 && <button className="btn primary sm" style={{ marginLeft: 10 }} onClick={finishLine}>Готово</button>}{linePts.length > 0 && <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setLinePts([])}>Отмена</button>}</>) : tool === 'box' ? 'Нажмите на место бокса' : tool === 'row' ? (first ? 'Нажмите, где ряд заканчивается (Esc — отмена)' : 'Нажмите, где ряд начинается') : tool === 'mark' ? 'Нажмите на место пометки' : 'Нажмите на место опоры'}</div>}
      {vb && (
        <svg ref={svgRef} className="map-svg" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vh}`} style={{ cursor }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onDoubleClick={() => tool === 'line' && finishLine()}
          onKeyDown={(e) => { if (e.key === 'Escape') { setFirst(null); setLinePts([]); } else if (e.key === 'Enter' && tool === 'line') finishLine(); }} tabIndex={0} role="img" aria-label="Схема гаражного кооператива">
          {bg && <image href={bg} x={0} y={0} width={W} height={H} opacity={0.9} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />}

          {layers.rows && rows.map((r) => {
            const d = draft[`r${r.id}`]; const rr = d ? { ...r, ...d } : r;
            const { len, angle } = rowGeom(rr); const n = rr.boxes.length; const bw = len / n; const gap = Math.min(bw * 0.12, 3 * k);
            const selected = activeRowId === r.id;
            return (
              <g key={r.id} transform={`translate(${rr.x1} ${rr.y1}) rotate(${angle})`}>
                {rr.boxes.map((b: any, i: number) => {
                  const isSel = sel?.t === 'box' && sel.number === b.number && b.number !== '';
                  const fill = !b.garageId ? 'transparent' : layers.colors && b.color ? DEBT_COLOR[b.color] : NEUTRAL;
                  return (
                    <g key={i} transform={`translate(${i * bw} 0)`} onPointerDown={(e) => { if (tool !== 'select') return; if (canEdit && selected) startDrag(e, 'row', r.id, { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }); else e.stopPropagation(); }}
                      onPointerUp={(e) => { if (tool === 'select' && !(drag?.moved)) { e.stopPropagation(); setDrag(null); setDraft({}); onSelect(b.number ? { t: 'box', number: b.number } : { t: 'row', id: r.id }); } }} style={{ cursor: tool === 'select' ? 'pointer' : undefined }}>
                      <rect x={gap / 2} y={-rr.depth / 2} width={Math.max(bw - gap, 0.5)} height={rr.depth} rx={Math.min(3 * k, 3)}
                        fill={fill} fillOpacity={b.archived ? 0.35 : 0.82}
                        stroke={isSel ? '#ffffff' : selected ? '#a8dadc' : b.number && !b.garageId ? '#ff9f43' : 'rgba(15,23,34,.7)'}
                        strokeWidth={(isSel ? 2.4 : 1) * k} strokeDasharray={b.number && !b.garageId ? `${3 * k} ${2 * k}` : undefined} />
                      {b.mine && <rect x={gap / 2} y={-rr.depth / 2} width={Math.max(bw - gap, 0.5)} height={rr.depth} fill="none" stroke="#fff" strokeWidth={2 * k} />}
                      {b.number && showNumbers(bw) && (
                        <text transform={`translate(${bw / 2} 0) rotate(${-angle})`} textAnchor="middle" dominantBaseline="central"
                          fontSize={Math.min(bw * 0.52, rr.depth * 0.62, 18 * k)} fontWeight={700} fill="#0f1722" style={{ pointerEvents: 'none', fontFamily: 'var(--display)' }}>{b.number}</text>
                      )}
                    </g>
                  );
                })}
                {selected && canEdit && (
                  <>
                    <circle cx={0} cy={0} r={7 * k} fill="#a8dadc" stroke="#0f1722" strokeWidth={2 * k} style={{ cursor: 'move' }} onPointerDown={(e) => startDrag(e, 'p1', r.id, { x1: r.x1, y1: r.y1 })} />
                    <circle cx={len} cy={0} r={7 * k} fill="#a8dadc" stroke="#0f1722" strokeWidth={2 * k} style={{ cursor: 'move' }} onPointerDown={(e) => startDrag(e, 'p2', r.id, { x2: r.x2, y2: r.y2 })} />
                  </>
                )}
                {rr.label && size.w > 0 && <text x={len / 2} y={-rr.depth / 2 - 6 * k} textAnchor="middle" fontSize={12 * k} fill="#a8dadc" style={{ pointerEvents: 'none' }} transform={`rotate(${-angle === 0 ? 0 : 0})`}>{rr.label}</text>}
              </g>
            );
          })}

          {preview && (
            <g style={{ pointerEvents: 'none' }}>
              <line x1={preview.x1} y1={preview.y1} x2={preview.x2} y2={preview.y2} stroke="#a8dadc" strokeWidth={3 * k} strokeDasharray={`${8 * k} ${5 * k}`} />
              <circle cx={preview.x1} cy={preview.y1} r={5 * k} fill="#a8dadc" />
            </g>
          )}

          {layers.lines && (scene.lines ?? []).map((l: any) => {
            const dl = draft[`l${l.id}`]; const pts = resolvePts(dl ? dl.points : l.points);
            const d = lineD(pts); const isSel = sel?.t === 'line' && sel.id === l.id; const st: string = l.status;
            let mi = 1, ml = -1, total = 0;
            for (let i = 1; i < pts.length; i++) { const sl = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); total += sl; if (sl > ml) { ml = sl; mi = i; } }
            const mid = { x: (pts[mi].x + pts[mi - 1].x) / 2, y: (pts[mi].y + pts[mi - 1].y) / 2 };
            const none = { pointerEvents: 'none' as const };
            return (
              <g key={l.id}>
                {st === 'EMERGENCY' && <path d={d} className="line-alarm" fill="none" stroke={LINE_STATUS.EMERGENCY.color} strokeWidth={9 * k} strokeLinecap="round" strokeLinejoin="round" style={none} />}
                {st === 'CHECK' && <path d={d} fill="none" stroke={LINE_STATUS.CHECK.color} strokeOpacity={0.32} strokeWidth={8 * k} strokeLinecap="round" strokeLinejoin="round" style={none} />}
                <path d={d} fill="none" stroke={l.color} strokeWidth={(isSel ? 3.2 : 2.2) * k} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={st === 'OFF' ? `${7 * k} ${5 * k}` : undefined} opacity={st === 'OFF' ? 0.6 : 1} style={none} />
                <path d={d} fill="none" stroke="transparent" strokeWidth={14 * k} strokeLinecap="round" strokeLinejoin="round"
                  style={{ pointerEvents: tool === 'select' ? 'stroke' : 'none', cursor: tool === 'select' ? 'pointer' : undefined }}
                  onPointerDown={(e) => { if (tool === 'select') e.stopPropagation(); }}
                  onPointerUp={(e) => { if (tool === 'select' && !drag?.moved) { e.stopPropagation(); setDrag(null); onSelect({ t: 'line', id: l.id }); } }} />
                {st === 'EMERGENCY' && (
                  <g transform={`translate(${mid.x} ${mid.y})`} style={none}>
                    <circle r={9 * k} fill={LINE_STATUS.EMERGENCY.color} stroke="#0f1722" strokeWidth={2 * k} />
                    <text textAnchor="middle" dominantBaseline="central" fontSize={12 * k} fontWeight={800} fill="#fff">!</text>
                  </g>
                )}
                {l.name && total / k > 150 && st !== 'EMERGENCY' && <text x={mid.x} y={mid.y - 9 * k} textAnchor="middle" fontSize={11 * k} fontWeight={600} fill={l.color} stroke="#0f1722" strokeWidth={3 * k} paintOrder="stroke" style={none}>{l.name}</text>}
                {isSel && canMark && tool === 'select' && (
                  <>
                    {pts.slice(1).map((q, j) => {
                      const a = pts[j], mx = (a.x + q.x) / 2, my = (a.y + q.y) / 2;
                      return (
                        <g key={`m${j}`} transform={`translate(${mx} ${my})`} style={{ cursor: 'copy' }} onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => { e.stopPropagation(); setDrag(null); onMove(`/map/lines/${l.id}`, { points: [...l.points.slice(0, j + 1), { x: mx, y: my }, ...l.points.slice(j + 1)] }); }}>
                          <circle r={5 * k} fill="#0f1722" stroke={l.color} strokeWidth={1.5 * k} />
                          <path d={`M ${-2.5 * k} 0 H ${2.5 * k} M 0 ${-2.5 * k} V ${2.5 * k}`} stroke={l.color} strokeWidth={1.4 * k} />
                        </g>
                      );
                    })}
                    {pts.map((q, i) => (
                      <circle key={i} cx={q.x} cy={q.y} r={6 * k} fill={q.poleId ? '#f2c261' : '#a8dadc'} stroke="#0f1722" strokeWidth={2 * k} style={{ cursor: 'move' }}
                        onPointerDown={(e) => {
                          if (e.shiftKey) { e.stopPropagation(); if (l.points.length > 2) onMove(`/map/lines/${l.id}`, { points: l.points.filter((_: any, j: number) => j !== i) }); return; }
                          startDrag(e, 'vtx', l.id, { idx: i, points: l.points });
                        }} />
                    ))}
                  </>
                )}
              </g>
            );
          })}

          {tool === 'line' && (
            <g style={{ pointerEvents: 'none' }}>
              {hoverSnap?.poleId && <circle cx={hoverSnap.x} cy={hoverSnap.y} r={14 * k} fill="none" stroke="#ffffff" strokeWidth={2 * k} />}
              {linePts.length > 0 && <path d={lineD(hover ? [...linePts, hoverSnap ?? hover] : linePts)} fill="none" stroke="#a8dadc" strokeWidth={2.4 * k} strokeDasharray={`${7 * k} ${4 * k}`} strokeLinecap="round" strokeLinejoin="round" />}
              {linePts.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={4 * k} fill={q.poleId ? '#f2c261' : '#a8dadc'} stroke="#0f1722" strokeWidth={1.5 * k} />)}
            </g>
          )}

          {layers.poles && scene.poles.map((p: any) => {
            const d = draft[`p${p.id}`]; const pp = d ? { ...p, ...d } : p; const isSel = sel?.t === 'pole' && sel.id === p.id;
            return (
              <g key={p.id} transform={`translate(${pp.x} ${pp.y})`} style={{ cursor: tool === 'select' ? 'pointer' : undefined }}
                onPointerDown={(e) => { if (tool !== 'select') return; if (canMark) startDrag(e, 'pole', p.id, { x: p.x, y: p.y }); else e.stopPropagation(); }}
                onPointerUp={(e) => { if (tool === 'select' && !drag?.moved) { e.stopPropagation(); setDrag(null); onSelect({ t: 'pole', id: p.id }); } }}>
                <circle r={9 * k} fill="#0f1722" stroke={isSel ? '#ffffff' : '#f2c261'} strokeWidth={2 * k} />
                <path d={`M ${-3.5 * k} ${-1 * k} a ${3.5 * k} ${3.5 * k} 0 1 1 ${7 * k} 0 c 0 ${2 * k} -${1.5 * k} ${2.5 * k} -${1.5 * k} ${4.5 * k} h ${-4 * k} c 0 ${-2 * k} -${1.5 * k} ${-2.5 * k} -${1.5 * k} ${-4.5 * k} z`} fill="#f2c261" />
                <text y={19 * k} textAnchor="middle" fontSize={11 * k} fontWeight={700} fill="#f2c261" stroke="#0f1722" strokeWidth={3 * k} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{p.number}</text>
              </g>
            );
          })}

          {layers.marks && scene.marks.map((m: any) => {
            const d = draft[`m${m.id}`]; const mm = d ? { ...m, ...d } : m; const c = CATS[m.category]?.color ?? '#a8dadc'; const isSel = sel?.t === 'mark' && sel.id === m.id;
            return (
              <g key={m.id} transform={`translate(${mm.x} ${mm.y})`} style={{ cursor: tool === 'select' ? 'pointer' : undefined }}
                onPointerDown={(e) => { if (tool !== 'select') return; if (canMark) startDrag(e, 'mark', m.id, { x: m.x, y: m.y }); else e.stopPropagation(); }}
                onPointerUp={(e) => { if (tool === 'select' && !drag?.moved) { e.stopPropagation(); setDrag(null); onSelect({ t: 'mark', id: m.id }); } }}>
                <path d={`M 0 0 C ${-12 * k} ${-14 * k} ${-12 * k} ${-30 * k} 0 ${-30 * k} C ${12 * k} ${-30 * k} ${12 * k} ${-14 * k} 0 0 z`} fill={c} stroke={isSel ? '#ffffff' : '#0f1722'} strokeWidth={(isSel ? 3 : 2) * k} />
                <circle cy={-21 * k} r={4 * k} fill="#0f1722" />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* ───── диалоги ───── */
function RowDialog({ row, p1, p2, single, onClose, onDone }: { row?: any; p1?: Pt; p2?: Pt; single?: boolean; onClose: () => void; onDone: (id?: number) => void }) {
  const toast = useToast();
  const initial = row ? row.boxes.map((b: any) => b.number) : single ? [''] : genNumbers(1, 1, 10);
  const [label, setLabel] = useState(row?.label ?? '');
  const [count, setCount] = useState(String(initial.length));
  const [first, setFirst] = useState(initial.find((n: string) => n) ?? '1');
  const [step, setStep] = useState('1');
  const [depth, setDepth] = useState(String(row?.depth ?? (single && p1 && p2 ? Math.max(4, Math.min(200, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y)))) : 34)));
  const [list, setList] = useState(single && !row ? '' : initial.map((n: string) => n || '-').join(', '));
  const numbers = useMemo(() => parseNumbers(list), [list]);
  const regen = () => { const c = Math.min(300, Math.max(1, num(count) || 1)); setList(genNumbers(num(first) || 1, num(step) || 1, c).join(', ')); };
  const bad = numbers.find((n) => n && !/^[0-9A-Za-zА-Яа-я\-/]{1,12}$/.test(n));
  const m = useMutation({
    mutationFn: () => {
      const body = { label: label || undefined, depth: Number(depth), numbers };
      return row ? patch(`/map/rows/${row.id}`, body) : post('/map/rows', { ...body, x1: p1!.x, y1: p1!.y, x2: p2!.x, y2: p2!.y });
    },
    onSuccess: (r) => { toast(row ? 'Ряд обновлён' : single ? 'Бокс добавлен' : 'Ряд создан'); onDone(r.id); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={row ? 'Изменить ряд' : single ? 'Новый бокс' : 'Новый ряд боксов'} size="wide" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!numbers.length || numbers.length > 300 || !!bad || (single && !row && numbers.length !== 1) || m.isPending} onClick={() => m.mutate()}>{row ? 'Сохранить' : single ? 'Поставить бокс' : `Создать ряд из ${numbers.length}`}</button></>}>
      {single && !row ? (
        <div className="stack">
          <Field label="Номер бокса" hint="Должен совпадать с номером гаража. «-» — бокс без номера" error={bad ? `Некорректный номер: ${bad}` : numbers.length > 1 ? 'Нужен один номер' : null}>
            <input className="input" value={list} onChange={(e) => setList(e.target.value)} maxLength={12} autoFocus />
          </Field>
          <Field label="Размер бокса" hint="Можно поменять потом: выберите бокс и потяните за концы"><input className="input num" inputMode="numeric" value={depth} onChange={(e) => setDepth(e.target.value.replace(/D/g, ''))} /></Field>
        </div>
      ) : (
      <div className="stack">
        <div className="grid g2">
          <Field label="Название (необязательно)"><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Например: Линия 3" /></Field>
          <Field label="Ширина ряда" hint="Толщина боксов на карте"><input className="input num" inputMode="numeric" value={depth} onChange={(e) => setDepth(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <div className="card" style={{ background: 'var(--input-bg)' }}>
          <b>Нумерация по порядку от начала к концу</b>
          <div className="grid g4" style={{ marginTop: 10 }}>
            <Field label="Количество боксов"><input className="input num" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Первый номер"><input className="input num" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
            <Field label="Шаг" hint="−1 — номера убывают"><select className="input" value={step} onChange={(e) => setStep(e.target.value)}><option value="1">+1</option><option value="-1">−1</option><option value="2">+2</option><option value="-2">−2</option></select></Field>
            <div style={{ alignSelf: 'end' }}><button className="btn" onClick={regen}>Сгенерировать</button></div>
          </div>
        </div>
        <Field label={`Номера боксов (${numbers.length})`} hint="Можно править вручную: через запятую. «-» — бокс без номера, например: 1, 2, -, 4. Номер должен совпадать с номером гаража" error={bad ? `Некорректный номер: ${bad}` : numbers.length > 300 ? 'Не более 300 боксов в ряду' : null}>
          <textarea className="input mono" rows={4} value={list} onChange={(e) => setList(e.target.value)} />
        </Field>
      </div>
      )}
    </Modal>
  );
}

const lineName = (l: any) => l.name || `Линия №${l.id}`;

function LineDialog({ pts, line, onClose, onDone }: { pts?: LPt[]; line?: any; onClose: () => void; onDone: (id?: number) => void }) {
  const toast = useToast();
  const [name, setName] = useState(line?.name ?? '');
  const [color, setColor] = useState<string>(line?.color ?? LINE_COLORS[0]);
  const [status, setStatus] = useState('OK');
  const [comment, setComment] = useState(line?.comment ?? '');
  const [ids, setIds] = useState<string[]>(line?.fileId ? [line.fileId] : []);
  const m = useMutation({
    mutationFn: () => line
      ? patch(`/map/lines/${line.id}`, { name: name || undefined, color, comment: comment || undefined, fileId: ids[0] })
      : post('/map/lines', { name: name || undefined, color, status, comment: comment || undefined, fileId: ids[0], points: pts }),
    onSuccess: (r) => { toast(line ? 'Линия обновлена' : 'Линия добавлена'); onDone(r.id); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={line ? 'Изменить линию' : 'Новая линия электропередачи'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>Сохранить</button></>}>
      <div className="stack">
        <Field label="Название (необязательно)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Например: Кабель от ТП к линии 3" autoFocus /></Field>
        <Field label="Цвет линии">
          <div className="row" style={{ gap: 8 }}>
            {LINE_COLORS.map((c) => <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 8, background: c, border: color === c ? '3px solid #fff' : '2px solid rgba(255,255,255,.2)', cursor: 'pointer' }} />)}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Свой цвет" style={{ width: 34, height: 28, padding: 0, border: 0, background: 'none' }} />
          </div>
        </Field>
        {!line && <Field label="Состояние"><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(LINE_STATUS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select></Field>}
        <Field label="Комментарий"><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder="Сечение, откуда и куда идёт, особенности" /></Field>
        <Field label="Фото"><ImagePicker kind="map" ids={ids} onChange={setIds} max={1} /></Field>
        {!line && pts && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Точек: {pts.length}{pts.some((p) => p.poleId) ? ', часть приклеена к опорам — при переносе опоры линия пойдёт за ней' : ''}.</p>}
      </div>
    </Modal>
  );
}

function LineStatusDialog({ line, onClose, onDone }: { line: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<string>(line.status);
  const [comment, setComment] = useState('');
  const m = useMutation({ mutationFn: () => post(`/map/lines/${line.id}/status`, { status, comment: comment || undefined }), onSuccess: () => { toast('Состояние записано в журнал'); onDone(); }, onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title={`Состояние: ${lineName(line)}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={m.isPending || (status === line.status && !comment)} onClick={() => m.mutate()}>Сохранить</button></>}>
      <div className="stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(LINE_STATUS).map(([k, c]) => (
            <button key={k} type="button" className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}><i style={{ width: 10, height: 10, borderRadius: '50%', background: c.color, display: 'inline-block' }} />{c.label}</button>
          ))}
        </div>
        <Field label="Что произошло / что сделано" hint="Попадёт в журнал линии"><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder="Например: обрыв у опоры 5, вызвана бригада" autoFocus /></Field>
      </div>
    </Modal>
  );
}

function LineLogDialog({ line, canWrite, onClose }: { line: any; canWrite: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['map-line-log', line.id], queryFn: () => get(`/map/lines/${line.id}/events`) });
  const add = useMutation({ mutationFn: () => post(`/map/lines/${line.id}/notes`, { comment: note.trim() }), onSuccess: () => { setNote(''); qc.invalidateQueries({ queryKey: ['map-line-log', line.id] }); }, onError: (e: any) => toast(e.message, 'err') });
  const title = (e: any) => e.action === 'CREATE' ? 'Линия создана' : e.action === 'STATUS' ? `Состояние: ${LINE_STATUS[e.status]?.label ?? e.status}` : 'Заметка';
  return (
    <Modal title={`Журнал: ${lineName(line)}`} size="wide" onClose={onClose}>
      <div className="stack">
        {canWrite && (
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}><Field label="Добавить запись"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Например: осмотр, замена изолятора" /></Field></div>
            <button className="btn primary" disabled={!note.trim() || add.isPending} onClick={() => add.mutate()}>Добавить</button>
          </div>
        )}
        {isLoading ? <Spinner /> : !data?.length ? <Empty text="Записей пока нет" /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Когда</th><th>Событие</th><th>Кто</th></tr></thead>
            <tbody>{data.map((e: any) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(e.at)}</td>
                <td className="wrap"><b style={{ color: e.action === 'STATUS' ? LINE_STATUS[e.status]?.color : undefined }}>{title(e)}</b>{e.comment && <div>{e.comment}</div>}</td>
                <td>{e.user ?? '—'}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </Modal>
  );
}

function MarkDialog({ at, garageNumber, mark, onClose, onDone }: { at: Pt; garageNumber?: string; mark?: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState(mark?.category ?? 'NO_LIGHT');
  const [comment, setComment] = useState(mark?.comment ?? '');
  const [ids, setIds] = useState<string[]>(mark?.fileId ? [mark.fileId] : []);
  const m = useMutation({
    mutationFn: () => {
      const body: any = { category, comment: comment || undefined, fileId: ids[0] };
      return mark ? patch(`/map/marks/${mark.id}`, body) : post('/map/marks', { ...body, x: at.x, y: at.y, garageNumber });
    },
    onSuccess: () => { toast(mark ? 'Пометка обновлена' : 'Пометка поставлена'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={mark ? 'Изменить пометку' : 'Новая пометка'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>Сохранить</button></>}>
      <div className="stack">
        {garageNumber && <div className="muted">Привязка к гаражу №{garageNumber}</div>}
        <Field label="Что случилось"><select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATS).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}</select></Field>
        <Field label="Комментарий"><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder="Например: не горит фонарь, нужна лампа" /></Field>
        <Field label="Фото"><ImagePicker kind="map" ids={ids} onChange={setIds} max={1} /></Field>
      </div>
    </Modal>
  );
}

function CloseMarkDialog({ mark, onClose, onDone }: { mark: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const m = useMutation({ mutationFn: () => post(`/map/marks/${mark.id}/close`, { comment: comment || undefined }), onSuccess: () => { toast('Пометка снята'); onDone(); }, onError: (e: any) => toast(e.message, 'err') });
  return (
    <Modal title="Снять пометку" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={m.isPending} onClick={() => m.mutate()}>Проблема устранена</button></>}>
      <div className="stack"><div className="muted">{CATS[mark.category]?.label}{mark.comment ? ` — ${mark.comment}` : ''}</div>
        <Field label="Что сделано (необязательно)"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} placeholder="Например: заменили лампу" autoFocus /></Field>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Пометка уйдёт с карты, но сохранится в истории («Снятые пометки»).</p></div>
    </Modal>
  );
}

function PoleDialog({ at, pole, nextNumber, onClose, onDone }: { at: Pt; pole?: any; nextNumber: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [number, setNumber] = useState(pole?.number ?? nextNumber);
  const [comment, setComment] = useState(pole?.comment ?? '');
  const [ids, setIds] = useState<string[]>(pole?.fileId ? [pole.fileId] : []);
  const m = useMutation({
    mutationFn: () => { const body: any = { number: number.trim(), comment: comment || undefined, fileId: ids[0] }; return pole ? patch(`/map/poles/${pole.id}`, body) : post('/map/poles', { ...body, x: at.x, y: at.y }); },
    onSuccess: () => { toast(pole ? 'Опора обновлена' : 'Опора добавлена'); onDone(); }, onError: (e: any) => toast(e.message, 'err'),
  });
  return (
    <Modal title={pole ? `Опора №${pole.number}` : 'Новая опора освещения'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!number.trim() || m.isPending} onClick={() => m.mutate()}>Сохранить</button></>}>
      <div className="stack">
        <Field label="Номер опоры"><input className="input" value={number} onChange={(e) => setNumber(e.target.value)} maxLength={20} autoFocus /></Field>
        <Field label="Комментарий"><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder="Состояние, тип светильника, что требуется" /></Field>
        <Field label="Фото"><ImagePicker kind="map" ids={ids} onChange={setIds} max={1} /></Field>
      </div>
    </Modal>
  );
}

function SettingsDialog({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [canView, setCanView] = useState<boolean>(s.residentsCanView);
  const [seeMarks, setSeeMarks] = useState<boolean>(s.residentsSeeMarks);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function upload(f: File) {
    setBusy(true);
    try {
      const r = await uploadMapImage(f);
      await put('/map/background', { fileId: r.id, width: r.width, height: r.height });
      toast(`Схема загружена (${r.width}×${r.height})`); qc.invalidateQueries({ queryKey: ['map'] }); onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  }
  const save = useMutation({ mutationFn: () => put('/map/settings', { residentsCanView: canView, residentsSeeMarks: canView && seeMarks }), onSuccess: () => { toast('Настройки сохранены'); onDone(); onClose(); }, onError: (e: any) => toast(e.message, 'err') });

  return (
    <Modal title="Настройки карты" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Закрыть</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Сохранить доступ</button></>}>
      <div className="stack">
        <div className="card" style={{ background: 'var(--input-bg)' }}>
          <b>Схема (подложка)</b>
          <p className="muted" style={{ margin: '4px 0 10px', fontSize: 13 }}>Загрузите картинку-схему кооператива (JPEG, PNG, WebP). Ряды боксов рисуются поверх неё. {s.backgroundFileId ? `Сейчас загружена, ${s.width}×${s.height}.` : 'Сейчас не загружена.'}</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => file.current?.click()}><ImageUp />{s.backgroundFileId ? 'Заменить схему' : 'Загрузить схему'}</button>
            {s.backgroundFileId && <button className="btn danger" onClick={async () => { if (await confirm({ title: 'Убрать схему?', text: 'Ряды останутся, пропадёт только картинка под ними.', ok: 'Убрать', danger: true })) { await del('/map/background'); qc.invalidateQueries({ queryKey: ['map'] }); onDone(); } }}>Убрать</button>}
          </div>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {busy && <div className="spinner" />}
        </div>
        <div className="card" style={{ background: 'var(--input-bg)' }}>
          <b>Доступ жителей</b>
          <div className="stack" style={{ marginTop: 10 }}>
            <label className="check"><input type="checkbox" checked={canView} onChange={(e) => setCanView(e.target.checked)} />Жители могут смотреть карту в приложении</label>
            <label className="check" style={{ opacity: canView ? 1 : 0.5 }}><input type="checkbox" checked={seeMarks && canView} disabled={!canView} onChange={(e) => setSeeMarks(e.target.checked)} />Показывать им пометки (например, «не работает свет»)</label>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Жители не видят цвет задолженности и имена владельцев — только схему, свои гаражи, опоры и (по желанию) пометки. Права сотрудников настраиваются в разделе «Роли и права».</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ClosedMarksDialog({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['map-closed'], queryFn: () => get('/map/marks/closed') });
  return (
    <Modal title="Снятые пометки" size="wide" onClose={onClose}>
      {isLoading ? <Spinner /> : !data?.length ? <Empty text="Снятых пометок пока нет" /> : (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Что</th><th>Где</th><th>Поставил</th><th>Снял</th></tr></thead>
          <tbody>{data.map((m: any) => (
            <tr key={m.id}>
              <td className="wrap"><b>{CATS[m.category]?.label}</b><div className="muted">{m.comment}</div></td>
              <td>{m.garageNumber ? `гараж №${m.garageNumber}` : '—'}</td>
              <td>{m.createdBy ?? '—'}<div className="muted" style={{ fontSize: 12 }}>{dateTime(m.createdAt)}</div></td>
              <td>{m.closedBy ?? '—'}<div className="muted" style={{ fontSize: 12 }}>{dateTime(m.closedAt)}</div>{m.closeComment && <div style={{ fontSize: 12.5 }}>{m.closeComment}</div>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Modal>
  );
}
