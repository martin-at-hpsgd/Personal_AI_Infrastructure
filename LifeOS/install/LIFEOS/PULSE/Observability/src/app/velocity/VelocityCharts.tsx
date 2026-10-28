"use client";

/**
 * Velocity charts — inline SVG, no chart library. Three forms: stacked bars
 * (weekly and daily), and a cumulative line against a dashed counterfactual.
 * Categorical colors are a fixed, validated 5-slot dark palette (dataviz skill,
 * 2026-09-06); series never cycle past five.
 *
 * Every chart is hoverable: the pointer picks the nearest bucket, the chart
 * draws a guide and highlights it, and an HTML tooltip (positioned over the
 * wrapper, so it never clips inside the SVG) lists the breakdown. State is
 * local to each chart; nothing is shared across charts.
 */

import { useRef, useState, type MouseEvent, type ReactNode } from "react";

export interface Row { key: string; label: string; total: number; parts: Record<string, number>; partial: boolean; tick?: boolean }
export interface Marker { atIndex: number; label: string }

export const PALETTE = ["#3B82F6", "#D95926", "#199E70", "#C98500", "#9085E9"];
const DEFAULT_PALETTE = PALETTE;
const INK2 = "var(--ink-2)", INK3 = "var(--ink-3)", GRID = "rgba(255,255,255,0.07)", BLUE = "var(--accent-blue)";
const MONO = "'triplicate-a-code', ui-monospace, monospace";
const TEXT = "'concourse-t3', system-ui, sans-serif";
const CAPS = "'concourse-c3', 'concourse-t3', system-ui, sans-serif";
const HALO: React.CSSProperties = { paintOrder: "stroke", stroke: "var(--bg-0, #0A0F1E)", strokeWidth: 4, strokeLinejoin: "round" };

export const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
function niceStep(raw: number) { const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

// ---------- hover plumbing ----------

/** Pointer position in SVG user units plus in wrapper pixels, from one mouse event. */
function svgPoint(e: MouseEvent<SVGSVGElement>, viewW: number, viewH: number) {
  const r = e.currentTarget.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  return { sx: (px / r.width) * viewW, sy: (py / r.height) * viewH, px, py, w: r.width, h: r.height };
}

type Hover = { i: number; px: number; py: number; w: number } | null;

/** Floating tooltip over the chart wrapper. Flips left of the pointer near the right edge, never leaves the wrapper. */
function Tip({ hover, title, rows, foot }: { hover: { px: number; py: number; w: number }; title: string; rows: { color?: string; name: string; value: string }[]; foot?: ReactNode }) {
  const flip = hover.px > hover.w * 0.68;
  const style: React.CSSProperties = { position: "absolute", top: Math.max(0, hover.py - 12), pointerEvents: "none", zIndex: 5, ...(flip ? { right: hover.w - hover.px + 14 } : { left: hover.px + 14 }) };
  return (
    <div className="rounded-md border border-line-2 px-3 py-2 shadow-xl min-w-[200px] max-w-[340px] whitespace-nowrap" style={{ ...style, background: "#0E1428", boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }} data-testid="chart-tip">
      <div className="mono text-[12px] text-ink-3 mb-1">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-[13px] leading-5">
          {r.color && <i className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: r.color }} />}
          <span className="text-ink-2">{r.name}</span>
          <span className="ml-auto mono text-ink-1 pl-3">{r.value}</span>
        </div>
      ))}
      {foot && <div className="mt-1 text-[12px] text-ink-3">{foot}</div>}
    </div>
  );
}

// ---------- charts ----------

export function StackedBars({ rows, categories, width = 1104, height = 300, markers, refLine, directLabels, yTicks = 4, format = n0, palette }: {
  rows: Row[]; categories: string[]; width?: number; height?: number; markers: Marker[];
  refLine?: { value: number; label: string }; directLabels: boolean; yTicks?: number;
  /** How a value reads in the tooltip and axis; share charts pass a percent formatter. */
  format?: (v: number) => string;
  /** One color per category, in category order; defaults to the 5-slot palette by position. */
  palette?: string[];
}) {
  const PALETTE = palette ?? DEFAULT_PALETTE;
  const padL = 52, padR = 12, padT = 30, padB = 30;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = Math.max(1, ...rows.map((r) => r.total), refLine?.value ?? 0) * 1.12;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const slot = plotW / Math.max(rows.length, 1), gap = Math.max(2, slot * 0.22), barW = slot - gap;
  const step = niceStep(max / yTicks);
  const grid: number[] = []; for (let v = 0; v <= max; v += step) grid.push(v);
  const [hover, setHover] = useState<Hover>(null);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const p = svgPoint(e, width, height);
    const i = Math.floor((p.sx - padL) / slot);
    if (i < 0 || i >= rows.length || p.sy < padT - 6 || p.sy > height - padB + 20) return setHover(null);
    setHover({ i, px: p.px, py: p.py, w: p.w });
  };
  const hr = hover ? rows[hover.i] : null;
  const tipRows = hr ? categories.filter((k) => (hr.parts[k] ?? 0) > 0).map((k) => ({ color: PALETTE[Math.min(categories.indexOf(k), PALETTE.length - 1)], name: k, value: format(hr.parts[k]) })) : [];
  return (
    <div className="relative" data-testid="stacked-bars">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto", cursor: hover ? "crosshair" : "default" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {grid.map((v) => (
          <g key={v}>
            <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke={GRID} />
            <text x={padL - 10} y={y(v) + 4} textAnchor="end" fontFamily={MONO} fontSize={11} fill={INK3}>{format(v)}</text>
          </g>
        ))}
        {hover && <rect x={padL + hover.i * slot} y={padT - 6} width={slot} height={plotH + 6} fill="rgba(255,255,255,0.05)" />}
        {rows.map((r, i) => {
          const x = padL + i * slot + gap / 2;
          let acc = 0;
          const segs = categories.filter((k) => (r.parts[k] ?? 0) > 0);
          const op = (r.partial ? 0.45 : 1) * (hover && hover.i !== i ? 0.55 : 1);
          return (
            <g key={r.key}>
              {segs.map((k, si) => {
                const v = r.parts[k]; const y1 = y(acc + v), y0 = y(acc);
                const h = Math.max(0, y0 - y1 - (si < segs.length - 1 ? 2 : 0));
                const color = PALETTE[Math.min(categories.indexOf(k), PALETTE.length - 1)];
                acc += v;
                return si === segs.length - 1 && h >= 4
                  ? <path key={k} d={roundedTop(x, y1, barW, h, 4)} fill={color} opacity={op} />
                  : <rect key={k} x={x} y={y1} width={barW} height={h} fill={color} opacity={op} />;
              })}
              {directLabels && r.total > 0 && (
                <text x={x + barW / 2} y={y(r.total) - 7} textAnchor="middle" fontFamily={MONO} fontSize={12} fontWeight="bold" fill="var(--ink-1)" style={HALO}>{format(r.total)}{r.partial ? "*" : ""}</text>
              )}
              {(r.tick !== false || hover?.i === i) && <text x={x + barW / 2} y={height - padB + 18} textAnchor="middle" fontFamily={MONO} fontSize={11} fill={hover?.i === i ? "var(--ink-1)" : INK3} style={hover?.i === i ? HALO : undefined}>{r.label}</text>}
            </g>
          );
        })}
        <line x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} stroke={INK3} />
        {refLine && (
          <g>
            <line x1={padL} x2={width - padR} y1={y(refLine.value)} y2={y(refLine.value)} stroke={INK2} strokeDasharray="4 4" />
            <text x={padL + 6} y={y(refLine.value) - 6} fontFamily={TEXT} fontSize={12} fill={INK2} style={HALO}>{refLine.label}</text>
          </g>
        )}
        {markers.map((m, mi) => {
          const x = padL + m.atIndex * slot; const flip = x > padL + plotW * 0.8;
          return (
            <g key={m.label}>
              <line x1={x} x2={x} y1={padT - 6} y2={y(0)} stroke={BLUE} strokeWidth={1.5} strokeDasharray="3 3" />
              <text x={flip ? x - 6 : x + 6} y={padT + 4 + (mi % 2) * 16} textAnchor={flip ? "end" : "start"} fontFamily={CAPS} fontSize={13} fill={BLUE} style={HALO}>{m.label}</text>
            </g>
          );
        })}
      </svg>
      {hover && hr && (
        <Tip hover={hover} title={`${hr.label}${hr.partial ? " · partial" : ""}`}
          rows={[...tipRows, ...(tipRows.length > 1 ? [{ name: "Total", value: format(hr.total) }] : [])]}
          foot={markers.filter((m) => m.atIndex === hover.i).map((m) => `→ ${m.label}`).join(" · ") || undefined} />
      )}
    </div>
  );
}

export function CumulativeLine({ series, events, counterfactual, counterfactualLabel, width = 1104, height = 300 }: {
  series: { day: string; total: number; label?: string; tick?: boolean }[]; events: { date: string; label: string }[]; counterfactual: number; counterfactualLabel: string; width?: number; height?: number;
}) {
  const padL = 52, padR = 12, padT = 30, padB = 30;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const n = Math.max(series.length, 2);
  const total = series.length ? series[series.length - 1].total : 0;
  const max = Math.max(1, total, counterfactual) * 1.1;
  const x = (i: number) => padL + (i / (n - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const step = niceStep(max / 4);
  const grid: number[] = []; for (let v = 0; v <= max; v += step) grid.push(v);
  const d = series.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c.total).toFixed(1)}`).join(" ");
  const lastEventIdx = events.length ? series.findIndex((c) => c.day === events[events.length - 1].date) : -1;
  const cfAnchor = lastEventIdx > 0 ? lastEventIdx : n - 1;
  const fmt = (day: string) => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+day.slice(5, 7) - 1];
  const [hover, setHover] = useState<Hover>(null);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!series.length) return;
    const p = svgPoint(e, width, height);
    if (p.sx < padL - 8 || p.sx > width - padR + 8 || p.sy < padT - 6 || p.sy > height - padB + 20) return setHover(null);
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((p.sx - padL) / plotW) * (n - 1))));
    setHover({ i, px: p.px, py: p.py, w: p.w });
  };
  const hc = hover ? series[hover.i] : null;
  const delta = hover && hover.i > 0 ? series[hover.i].total - series[hover.i - 1].total : hc?.total ?? 0;
  const pace = hover ? (counterfactual / (n - 1)) * hover.i : 0;
  return (
    <div className="relative" data-testid="cumulative-line">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto", cursor: hover ? "crosshair" : "default" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {grid.map((v) => (
          <g key={v}>
            <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke={GRID} />
            <text x={padL - 10} y={y(v) + 4} textAnchor="end" fontFamily={MONO} fontSize={11} fill={INK3}>{n0(v)}</text>
          </g>
        ))}
        {series.map((c, i) => (c.tick ?? c.day.endsWith("-01")) && (
          <g key={c.day}>
            <line x1={x(i)} x2={x(i)} y1={y(0)} y2={y(0) + 5} stroke={INK3} />
            <text x={x(i)} y={height - padB + 18} textAnchor="middle" fontFamily={MONO} fontSize={11} fill={INK3}>{c.label ?? fmt(c.day)}</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(n - 1)} y2={y(counterfactual)} stroke={INK2} strokeWidth={1.5} strokeDasharray="5 5" />
        <text x={x(cfAnchor) - 10} y={y(counterfactual) - 8} textAnchor="end" fontFamily={TEXT} fontSize={12} fill={INK2} style={HALO}>{counterfactualLabel}</text>
        {events.map((e, mi) => {
          const i = series.findIndex((c) => c.day === e.date); if (i < 0) return null;
          const flip = x(i) > padL + plotW * 0.8;
          return (
            <g key={e.date}>
              <line x1={x(i)} x2={x(i)} y1={padT - 6} y2={y(0)} stroke={BLUE} strokeWidth={1.5} strokeDasharray="3 3" />
              <text x={flip ? x(i) - 6 : x(i) + 6} y={padT + 4 + (mi % 2) * 16} textAnchor={flip ? "end" : "start"} fontFamily={CAPS} fontSize={13} fill={BLUE} style={HALO}>{e.label}</text>
            </g>
          );
        })}
        <path d={d} fill="none" stroke={BLUE} strokeWidth={2.5} strokeLinejoin="round" />
        {series.length > 0 && (
          <g>
            <circle cx={x(n - 1)} cy={y(total)} r={5} fill={BLUE} stroke="var(--bg-0, #0A0F1E)" strokeWidth={2} />
            <text x={x(n - 1) - 12} y={y(total) + 24} textAnchor="end" fontFamily={MONO} fontSize={15} fontWeight="bold" fill="var(--ink-1)" style={HALO}>{n0(total)}</text>
          </g>
        )}
        <line x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} stroke={INK3} />
        {hover && hc && (
          <g>
            <line x1={x(hover.i)} x2={x(hover.i)} y1={padT - 6} y2={y(0)} stroke="var(--ink-2)" strokeWidth={1} />
            <circle cx={x(hover.i)} cy={y(hc.total)} r={6} fill={BLUE} stroke="var(--bg-0, #0A0F1E)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover && hc && (
        <Tip hover={hover} title={hc.label ?? hc.day}
          rows={[{ color: PALETTE[0], name: "Cumulative", value: n0(hc.total) }, { name: "This bucket", value: `+${n0(delta)}` }, ...(counterfactual > 0 ? [{ name: "Previous pace", value: n0(pace) }] : [])]} />
      )}
    </div>
  );
}

/** Hour × weekday heatmap. One hue (blue), light→dark by magnitude, value on hover. */
export function Heatmap({ matrix, rowLabels }: { matrix: number[][]; rowLabels: string[] }) {
  const max = Math.max(1, ...matrix.flat());
  const sum = Math.max(1, matrix.flat().reduce((a, b) => a + b, 0));
  const cell = 34, gap = 3, padL = 40, padT = 22;
  const width = padL + 24 * (cell + gap), height = padT + matrix.length * (cell + gap);
  const [hover, setHover] = useState<{ r: number; h: number; px: number; py: number; w: number } | null>(null);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const p = svgPoint(e, width, height);
    const h = Math.floor((p.sx - padL) / (cell + gap)), r = Math.floor((p.sy - padT) / (cell + gap));
    if (h < 0 || h >= 24 || r < 0 || r >= matrix.length) return setHover(null);
    setHover({ r, h, px: p.px, py: p.py, w: p.w });
  };
  const hv = hover ? matrix[hover.r][hover.h] : 0;
  return (
    <div className="relative" style={{ maxWidth: width }} data-testid="heatmap">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: 24 }, (_, h) => (h % 3 === 0 || hover?.h === h) && <text key={h} x={padL + h * (cell + gap) + cell / 2} y={14} textAnchor="middle" fontFamily={MONO} fontSize={11} fill={hover?.h === h ? "var(--ink-1)" : INK3}>{String(h).padStart(2, "0")}</text>)}
        {matrix.map((row, r) => (
          <g key={r}>
            <text x={padL - 8} y={padT + r * (cell + gap) + cell / 2 + 4} textAnchor="end" fontFamily={MONO} fontSize={11} fill={hover?.r === r ? "var(--ink-1)" : INK3}>{rowLabels[r]}</text>
            {row.map((v, h) => (
              <rect key={h} x={padL + h * (cell + gap)} y={padT + r * (cell + gap)} width={cell} height={cell} rx={4}
                fill={v === 0 ? "rgba(255,255,255,0.04)" : `rgba(59,130,246,${0.18 + 0.82 * Math.sqrt(v / max)})`}
                stroke={hover && hover.r === r && hover.h === h ? "var(--ink-1)" : "none"} strokeWidth={1.5} />
            ))}
          </g>
        ))}
      </svg>
      {hover && (
        <Tip hover={hover} title={`${rowLabels[hover.r]} ${String(hover.h).padStart(2, "0")}:00–${String(hover.h + 1).padStart(2, "0")}:00`}
          rows={[{ color: PALETTE[0], name: "Commits", value: n0(hv) }, { name: "Share", value: `${(hv / sum * 100).toFixed(1)}%` }]} />
      )}
    </div>
  );
}

/** Horizontal share bar with an optional trailing label. value 0..1 */
export function BarList({ value, label, color = PALETTE[0] }: { value: number; label: string; color?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-sm" style={{ background: "rgba(255,255,255,0.06)" }}><div className="h-2 rounded-sm" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} /></div>
      {label && <span className="mono text-[12px] w-12 text-right" style={{ color: INK2 }}>{label}</span>}
    </div>
  );
}

/** Tiny line, no axes. Hover names the point when labels are given. */
export function Sparkline({ values, labels, height = 48, color = PALETTE[0] }: { values: number[]; labels?: string[]; height?: number; color?: string }) {
  const w = 400, n = Math.max(values.length, 2), max = Math.max(1, ...values);
  const x = (i: number) => (i / (n - 1)) * w, y = (v: number) => height - 4 - (v / max) * (height - 8);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const [hover, setHover] = useState<Hover>(null);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!values.length) return;
    const p = svgPoint(e, w, height);
    setHover({ i: Math.max(0, Math.min(values.length - 1, Math.round((p.sx / w) * (n - 1)))), px: p.px, py: p.py, w: p.w });
  };
  return (
    <div className="relative" data-testid="sparkline">
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <path d={`${d} L${w},${height} L0,${height} Z`} fill={color} opacity={0.12} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {hover && <g><line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={height} stroke="var(--ink-3)" /><circle cx={x(hover.i)} cy={y(values[hover.i])} r={4} fill={color} /></g>}
      </svg>
      {hover && <Tip hover={hover} title={labels?.[hover.i] ?? `#${hover.i + 1}`} rows={[{ color, name: "Value", value: n0(values[hover.i]) }]} />}
    </div>
  );
}

/** Which model was pinned when: one colored band per window across the range. */
export function ModelStrip({ timeline, from, to, labels, compact = false }: { timeline: { at: number; label: string }[]; from: string; to: string; labels: string[]; /** Strip only, no legend row: for stacked per-lane rows. */ compact?: boolean }) {
  const fromMs = Date.parse(from + "T00:00:00"), toMs = Date.parse(to + "T23:59:59");
  const span = Math.max(1, toMs - fromMs);
  const sorted = [...timeline].sort((a, b) => a.at - b.at);
  const bands: { label: string; a: number; b: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = Math.max(sorted[i].at, fromMs), b = Math.min(i + 1 < sorted.length ? sorted[i + 1].at : Date.now(), toMs);
    if (b > a) bands.push({ label: sorted[i].label, a, b });
  }
  const color = (l: string) => PALETTE[Math.min(Math.max(labels.indexOf(l), 0), 4)];
  const [hover, setHover] = useState<{ i: number; px: number; py: number; w: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: MouseEvent<HTMLDivElement>, i: number) => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    setHover({ i, px: e.clientX - r.left, py: e.clientY - r.top, w: r.width });
  };
  const hb = hover ? bands[hover.i] : null;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return (
    <div className={compact ? "relative" : "mt-3 relative"} ref={ref} data-testid="model-strip">
      <div className={`relative rounded-md overflow-hidden ${compact ? "h-5" : "h-8"}`} style={{ background: "rgba(255,255,255,0.04)" }} onMouseLeave={() => setHover(null)}>
        {bands.map((b, i) => <div key={i} onMouseMove={(e) => onMove(e, i)} className={`absolute top-0 ${compact ? "h-5" : "h-8"}`} style={{ left: `${((b.a - fromMs) / span) * 100}%`, width: `${((b.b - b.a) / span) * 100}%`, background: color(b.label), opacity: hover && hover.i !== i ? 0.5 : 0.85 }} />)}
      </div>
      {!compact && <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]" style={{ color: INK2 }}>
        {labels.map((l) => <span key={l}><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]" style={{ background: color(l) }} />{l}</span>)}
        <span className="ml-auto mono text-[12px]" style={{ color: INK3 }}>{from} → {to}</span>
      </div>}
      {hover && hb && <Tip hover={hover} title={hb.label} rows={[{ color: color(hb.label), name: "Pinned", value: `${day(hb.a)} → ${day(hb.b)}` }, { name: "Days", value: n0((hb.b - hb.a) / 86_400_000) }]} />}
    </div>
  );
}
