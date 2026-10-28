"use client";

/**
 * Deeds weekly chart: three bars per week, one each for caps, fixes and tends, side by side.
 * Never stacked and never summed: the three kinds are not units of one thing, so no bar, label or
 * tooltip row adds them. A cap that regressed or was removed counts -1, so the axis can go below zero.
 */

import { useState, type MouseEvent } from "react";
import { PALETTE, n0 } from "./VelocityCharts";

export interface DeedWeek { week: string; cap: number; fix: number; tend: number }
export const KINDS = [["cap", "Caps"], ["fix", "Fixes"], ["tend", "Tends"]] as const;
export const KIND_COLOR: Record<string, string> = { cap: PALETTE[0], fix: PALETTE[1], tend: PALETTE[2] };

const GRID = "rgba(255,255,255,0.07)", INK3 = "var(--ink-3)";
const MONO = "'triplicate-a-code', ui-monospace, monospace";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const day = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
function niceStep(raw: number) { const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

export function DeedsBars({ weeks, width = 1104, height = 200 }: { weeks: DeedWeek[]; width?: number; height?: number }) {
  const padL = 44, padR = 12, padT = 12, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const hi = Math.max(1, ...weeks.flatMap((w) => [w.cap, w.fix, w.tend]));
  const lo = Math.min(0, ...weeks.flatMap((w) => [w.cap, w.fix, w.tend]));
  const step = niceStep((hi - lo) / 4);
  const top = Math.ceil(hi / step) * step, bottom = Math.floor(lo / step) * step;
  const y = (v: number) => padT + plotH - ((v - bottom) / (top - bottom)) * plotH;
  const grid: number[] = []; for (let v = bottom; v <= top; v += step) grid.push(v);
  const slot = plotW / Math.max(weeks.length, 1), gap = Math.max(3, slot * 0.2), groupW = slot - gap, barW = groupW / 3;
  const every = weeks.length > 40 ? 4 : weeks.length > 20 ? 2 : 1;
  const [hover, setHover] = useState<{ i: number; px: number; py: number; w: number } | null>(null);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const i = Math.floor(((px / r.width) * width - padL) / slot);
    if (i < 0 || i >= weeks.length) return setHover(null);
    setHover({ i, px, py, w: r.width });
  };
  const hw = hover ? weeks[hover.i] : null;
  const flip = hover ? hover.px > hover.w * 0.68 : false;
  return (
    <div className="relative" data-testid="deeds-weekly-chart">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height: "auto" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {grid.map((v) => (
          <g key={v}>
            <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke={v === 0 ? INK3 : GRID} />
            <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontFamily={MONO} fontSize={11} fill={INK3}>{n0(v)}</text>
          </g>
        ))}
        {hover && <rect x={padL + hover.i * slot} y={padT} width={slot} height={plotH} fill="rgba(255,255,255,0.05)" />}
        {weeks.map((w, i) => {
          const x0 = padL + i * slot + gap / 2;
          return (
            <g key={w.week} opacity={hover && hover.i !== i ? 0.55 : 1}>
              {KINDS.map(([k], ki) => {
                const v = w[k]; const y0 = y(0), y1 = y(v);
                return <rect key={k} x={x0 + ki * barW + 0.5} y={Math.min(y0, y1)} width={Math.max(1, barW - 1)} height={Math.max(v === 0 ? 0 : 1, Math.abs(y0 - y1))} fill={KIND_COLOR[k]} rx={2} />;
              })}
              {(i % every === 0 || hover?.i === i) && <text x={x0 + groupW / 2} y={height - padB + 17} textAnchor="middle" fontFamily={MONO} fontSize={11} fill={hover?.i === i ? "var(--ink-1)" : INK3}>{day(w.week)}</text>}
            </g>
          );
        })}
      </svg>
      {hover && hw && (
        <div className="rounded-md border border-line-2 px-3 py-2 shadow-xl min-w-[170px] whitespace-nowrap" data-testid="chart-tip"
          style={{ position: "absolute", top: Math.max(0, hover.py - 12), pointerEvents: "none", zIndex: 5, background: "#0E1428", boxShadow: "0 8px 24px rgba(0,0,0,0.55)", ...(flip ? { right: hover.w - hover.px + 14 } : { left: hover.px + 14 }) }}>
          <div className="mono text-[12px] text-ink-3 mb-1">Week of {day(hw.week)}</div>
          {KINDS.map(([k, label]) => (
            <div key={k} className="flex items-center gap-2 text-[13px] leading-5">
              <i className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: KIND_COLOR[k] }} />
              <span className="text-ink-2">{label}</span>
              <span className="ml-auto mono text-ink-1 pl-3">{n0(hw[k])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
