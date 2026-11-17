import { useQuery } from '@tanstack/react-query';
import { Lamp, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { PointerEvent as RPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { fileBlobUrl, get } from '../lib/api';
import { dateShort } from '../lib/format';
import { Screen } from '../Screen';
import { Empty, SecureImage, Sheet, Spinner } from '../ui';

const CATS: Record<string, { label: string; color: string }> = {
  NO_LIGHT: { label: 'Не работает свет', color: '#f2c261' },
  DAMAGE: { label: 'Повреждение', color: '#ff6b6b' },
  LEAK: { label: 'Протечка / вода', color: '#5aa9e6' },
  TRASH: { label: 'Мусор / свалка', color: '#b08968' },
  OTHER: { label: 'Другое', color: '#a8dadc' },
};

interface Pt { x: number; y: number }
type Picked = { t: 'box'; number: string; mine: boolean; known: boolean } | { t: 'mark'; m: any } | { t: 'pole'; p: any } | null;

/** Схема ГСК для жителей: только просмотр. Свои гаражи подсвечены, цвет долга и владельцы не показываются. */
export default function MapView() {
  const { data: scene, isLoading, error } = useQuery({ queryKey: ['map-view'], queryFn: () => get('/map') });
  return (
    <Screen title="Схема ГСК" back="/board">
      {isLoading ? <Spinner /> : error || !scene ? <Empty text="Схема сейчас недоступна" /> : <Viewer scene={scene} />}
    </Screen>
  );
}

function Viewer({ scene }: { scene: any }) {
  const W: number = scene.settings.width, H: number = scene.settings.height;
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 360, h: 420 });
  const [vb, setVb] = useState<{ x: number; y: number; w: number } | null>(null);
  const [bg, setBg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>(null);
  const pointers = useRef(new Map<number, Pt>());
  // Нажатие определяем по элементу под пальцем: контейнер захватывает указатель, и события дочерних элементов до них не доходят
  const picks = useRef<Record<string, Picked>>({});
  const reg = (p: NonNullable<Picked>) => { const key = p.t === 'box' ? `box:${p.number}` : p.t === 'pole' ? `pole:${p.p.id}` : `mark:${p.m.id}`; picks.current[key] = p; return key; };
  const gesture = useRef<{ vb: { x: number; y: number; w: number }; dist: number; mid: Pt; moved: boolean; startPt: Pt } | null>(null);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(() => { const r = wrap.current!.getBoundingClientRect(); setSize({ w: Math.max(260, r.width), h: Math.max(260, r.height) }); });
    ro.observe(wrap.current); return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!scene.settings.backgroundFileId) return;
    let live = true; fileBlobUrl(scene.settings.backgroundFileId).then((u) => live && setBg(u)).catch(() => {}); return () => { live = false; };
  }, [scene.settings.backgroundFileId]);

  const fit = useCallback(() => {
    const scale = Math.min(size.w / W, size.h / H); const w = size.w / scale, h = size.h / scale;
    setVb({ x: (W - w) / 2, y: (H - h) / 2, w });
  }, [size, W, H]);
  useEffect(() => { fit(); }, [fit]);

  const vh = vb ? (vb.w * size.h) / size.w : 0;
  const k = vb ? vb.w / size.w : 1;
  const clampW = (w: number) => Math.min(W * 2, Math.max(W / 25, w));

  const zoomAt = (cx: number, cy: number, f: number, base = vb!) => {
    // cx, cy — координаты точки в единицах карты; она остаётся на месте
    const nw = clampW(base.w * f), r = nw / base.w;
    setVb({ x: cx - (cx - base.x) * r, y: cy - (cy - base.y) * r, w: nw });
  };
  const toMap = (px: number, py: number): Pt => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: vb!.x + ((px - rect.left) / rect.width) * vb!.w, y: vb!.y + ((py - rect.top) / rect.height) * vh };
  };

  function down(e: RPointerEvent) {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    gesture.current = {
      vb: vb!, moved: false, startPt: { x: e.clientX, y: e.clientY },
      dist: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
      mid: pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : { x: e.clientX, y: e.clientY },
    };
  }
  function move(e: RPointerEvent) {
    const g = gesture.current; if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length >= 2 && g.dist > 0) {
      g.moved = true;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const base = g.vb; const f = g.dist / d;
      const rect = svg.current!.getBoundingClientRect(); const bh = (base.w * size.h) / size.w;
      const cx = base.x + ((g.mid.x - rect.left) / rect.width) * base.w, cy = base.y + ((g.mid.y - rect.top) / rect.height) * bh;
      const nw = clampW(base.w * f), r = nw / base.w;
      // масштаб вокруг начальной середины + сдвиг вслед за пальцами
      const sx = ((mid.x - g.mid.x) / rect.width) * nw, sy = ((mid.y - g.mid.y) / rect.height) * ((nw * size.h) / size.w);
      setVb({ x: cx - (cx - base.x) * r - sx, y: cy - (cy - base.y) * r - sy, w: nw });
    } else if (pts.length === 1) {
      const dx = e.clientX - g.startPt.x, dy = e.clientY - g.startPt.y;
      if (Math.hypot(dx, dy) > 5) g.moved = true;
      if (g.moved) setVb({ x: g.vb.x - dx * (g.vb.w / size.w), y: g.vb.y - dy * (g.vb.w / size.w), w: g.vb.w });
    }
  }
  function up(e: RPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      const g = gesture.current; gesture.current = null;
      if (g && !g.moved) {
        const key = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-pick]')?.getAttribute('data-pick');
        setPicked(key ? picks.current[key] ?? null : null);
      }
    }
  }

  const showNumbers = (bw: number) => bw / k >= 10;
  const mine: string[] = scene.rows.flatMap((r: any) => r.boxes.filter((b: any) => b.mine).map((b: any) => b.number));

  return (
    <>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div ref={wrap} style={{ position: 'relative', height: 'min(68vh, 560px)', background: 'rgba(8,13,20,.6)', touchAction: 'none' }}>
          <div style={{ position: 'absolute', right: 10, top: 10, zIndex: 3, display: 'grid', gap: 8 }}>
            <button className="ib" style={{ background: 'rgba(26,35,50,.85)', border: '1px solid var(--line)' }} onClick={() => vb && zoomAt(vb.x + vb.w / 2, vb.y + vh / 2, 1 / 1.4)} aria-label="Приблизить"><ZoomIn /></button>
            <button className="ib" style={{ background: 'rgba(26,35,50,.85)', border: '1px solid var(--line)' }} onClick={() => vb && zoomAt(vb.x + vb.w / 2, vb.y + vh / 2, 1.4)} aria-label="Отдалить"><ZoomOut /></button>
            <button className="ib" style={{ background: 'rgba(26,35,50,.85)', border: '1px solid var(--line)' }} onClick={fit} aria-label="Вся схема"><Maximize /></button>
          </div>
          {vb && (
            <svg ref={svg} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vh}`} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', userSelect: 'none' }}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              onWheel={(e) => { const p = toMap(e.clientX, e.clientY); zoomAt(p.x, p.y, e.deltaY > 0 ? 1.15 : 1 / 1.15); }}>
              <rect x={0} y={0} width={W} height={H} fill="rgba(255,255,255,.04)" />
              {bg && <image href={bg} x={0} y={0} width={W} height={H} opacity={0.9} preserveAspectRatio="none" style={{ pointerEvents: 'none' }} />}
              {scene.rows.map((r: any) => {
                const dx = r.x2 - r.x1, dy = r.y2 - r.y1, len = Math.hypot(dx, dy), ang = (Math.atan2(dy, dx) * 180) / Math.PI, n = r.boxes.length, bw = len / n, gap = Math.min(bw * 0.12, 3 * k);
                return (
                  <g key={r.id} transform={`translate(${r.x1} ${r.y1}) rotate(${ang})`}>
                    {r.boxes.map((b: any, i: number) => (
                      <g key={i} transform={`translate(${i * bw} 0)`} data-pick={b.number ? reg({ t: 'box', number: b.number, mine: b.mine, known: !!b.garageId }) : undefined}>
                        <rect x={gap / 2} y={-r.depth / 2} width={Math.max(bw - gap, 0.5)} height={r.depth} rx={2}
                          fill={b.mine ? '#2d8b8b' : b.garageId ? '#6b8190' : 'transparent'} fillOpacity={b.archived ? 0.3 : 0.85}
                          stroke={b.mine ? '#ffffff' : 'rgba(15,23,34,.7)'} strokeWidth={(b.mine ? 2.4 : 1) * k} />
                        {b.number && showNumbers(bw) && <text transform={`translate(${bw / 2} 0) rotate(${-ang})`} textAnchor="middle" dominantBaseline="central" fontSize={Math.min(bw * 0.52, r.depth * 0.62, 18 * k)} fontWeight={700} fill={b.mine ? '#fff' : '#0f1722'} style={{ pointerEvents: 'none' }}>{b.number}</text>}
                      </g>
                    ))}
                  </g>
                );
              })}
              {scene.poles.map((p: any) => (
                <g key={p.id} transform={`translate(${p.x} ${p.y})`} data-pick={reg({ t: 'pole', p })}>
                  <circle r={10 * k} fill="#0f1722" stroke="#f2c261" strokeWidth={2 * k} />
                  <circle r={4 * k} fill="#f2c261" />
                </g>
              ))}
              {scene.marks.map((m: any) => (
                <g key={m.id} transform={`translate(${m.x} ${m.y})`} data-pick={reg({ t: 'mark', m })}>
                  <path d={`M 0 0 C ${-12 * k} ${-14 * k} ${-12 * k} ${-30 * k} 0 ${-30 * k} C ${12 * k} ${-30 * k} ${12 * k} ${-14 * k} 0 0 z`} fill={CATS[m.category]?.color ?? '#a8dadc'} stroke="#0f1722" strokeWidth={2 * k} />
                  <circle cy={-21 * k} r={4 * k} fill="#0f1722" />
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <div className="row wrap" style={{ gap: 14, fontSize: 13 }}>
          <span className="row" style={{ gap: 6 }}><i style={{ width: 14, height: 14, borderRadius: 4, background: '#2d8b8b', border: '2px solid #fff', display: 'inline-block' }} />Ваш гараж{mine.length ? `: ${mine.join(', ')}` : ''}</span>
          <span className="row" style={{ gap: 6 }}><i style={{ width: 14, height: 14, borderRadius: 4, background: '#6b8190', display: 'inline-block' }} />Другие гаражи</span>
          <span className="row" style={{ gap: 6 }}><Lamp size={15} color="#f2c261" />Опоры: {scene.poles.length}</span>
          {scene.settings.residentsSeeMarks && <span className="row" style={{ gap: 6 }}><i style={{ width: 12, height: 12, borderRadius: '50%', background: '#f2c261', display: 'inline-block' }} />Пометки: {scene.marks.length}</span>}
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: '8px 0 0' }}>Двигайте схему пальцем, масштаб — щипком двумя пальцами. Нажмите на гараж, опору или пометку.</p>
      </div>

      {picked && (
        <Sheet onClose={() => setPicked(null)} title={picked.t === 'box' ? `Гараж №${picked.number}` : picked.t === 'pole' ? `Опора №${picked.p.number}` : CATS[picked.m.category]?.label ?? 'Пометка'}>
          {picked.t === 'box' && <p>{picked.mine ? <b className="good">Это ваш гараж</b> : picked.known ? 'Гараж кооператива' : 'Бокс на схеме'}</p>}
          {picked.t === 'pole' && <div className="stack">{picked.p.comment && <p style={{ whiteSpace: 'pre-wrap' }}>{picked.p.comment}</p>}{picked.p.fileId && <SecureImage id={picked.p.fileId} className="photo" />}{!picked.p.comment && !picked.p.fileId && <p className="muted">Опора освещения</p>}</div>}
          {picked.t === 'mark' && <div className="stack">{picked.m.garageNumber && <div className="muted">Гараж №{picked.m.garageNumber}</div>}{picked.m.comment && <p style={{ whiteSpace: 'pre-wrap' }}>{picked.m.comment}</p>}{picked.m.fileId && <SecureImage id={picked.m.fileId} className="photo" />}<div className="muted" style={{ fontSize: 12.5 }}>Отмечено {dateShort(picked.m.createdAt)}</div></div>}
          <button className="btn s" style={{ marginTop: 14 }} onClick={() => setPicked(null)}>Закрыть</button>
        </Sheet>
      )}
    </>
  );
}
