"use client";
// The Health tab's trend board: one small chart per metric over a 7 / 30 / 90
// day window, grouped Sleep · Recovery & vitals · Activity · Mind. Small
// multiples on purpose — one axis per chart (never two y-scales), each series
// its own hue, and null renders as a gap (a zero would be a fake dip).
//
// Palette pairs used in any multi-series chart were run through the dataviz
// validator on the Pulse dark surface (see the ISA for the run): the sleep-stage
// ramp is a single-hue ordinal ramp; stress/recovery and temperature use
// far-apart hues with sign as the secondary encoding.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Brain,
  Footprints,
  HeartPulse,
  Minus,
  Moon,
  Scale,
  Table2,
} from "lucide-react";
import { Panel } from "@/components/ui/chrome";
import { fmtClock, fmtDayKeyParts } from "@/lib/time";

// ── Data shapes (mirror observability.ts HealthDay / HealthJournalDay) ──

export interface HealthDay {
  day: string;
  sleepScore: number | null;
  sleepH: number | null;
  sleepEff: number | null;
  deepH: number | null;
  remH: number | null;
  lightH: number | null;
  awakeH: number | null;
  sleepHr: number | null;
  hrv: number | null;
  restingHr: number | null;
  bedtime: string | null;
  wake: string | null;
  readiness: number | null;
  tempDev: number | null;
  activity: number | null;
  steps: number | null;
  activeCal: number | null;
  activeMin: number | null;
  spo2: number | null;
  bdi: number | null;
  stressMin: number | null;
  recoveryMin: number | null;
  weightKg: number | null;
  vo2max: number | null;
  respRate: number | null;
  /** "oura", "apple", or "oura+apple" — which stores fed this day. */
  src: string;
}

export interface HealthJournalDay {
  day: string;
  H: number | null;
  M: number | null;
  E: number | null;
  S: number | null;
  C: number | null;
  CF: number | null;
  W: boolean;
  K: boolean;
}

// Windows are tabs above the board. Past ~4 months a bar per day is a hairline,
// so long windows average into weekly (or monthly) buckets — the bucket size is
// named in the header so a "day" never silently becomes a week.
type RangeKey = "week" | "month" | "6mo" | "year" | "all";
interface RangePreset {
  key: RangeKey;
  label: string;
  days: number; // Infinity = everything stored
  title: string;
}
const RANGES: RangePreset[] = [
  { key: "week", label: "Week", days: 7, title: "last 7 days" },
  { key: "month", label: "Month", days: 30, title: "last 30 days" },
  { key: "6mo", label: "6 months", days: 183, title: "last 6 months" },
  { key: "year", label: "Year", days: 365, title: "last year" },
  { key: "all", label: "Lifetime", days: Number.POSITIVE_INFINITY, title: "everything recorded" },
];
const DEFAULT_RANGE: RangeKey = "month";
// Back-compat for the first deep-link form (?range=7|30|90).
const LEGACY_RANGE: Record<string, RangeKey> = { "7": "week", "30": "month", "90": "6mo" };

type Bucket = "day" | "week" | "month";
export function bucketFor(rowCount: number): Bucket {
  if (rowCount > 730) return "month";
  if (rowCount > 120) return "week";
  return "day";
}

// ISO-ish bucket key: Monday of the week, or the 1st of the month.
export function bucketKey(day: string, bucket: Bucket): string {
  if (bucket === "day") return day;
  const d = new Date(day + "T00:00:00");
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const NUMERIC_KEYS = [
  "sleepScore", "sleepH", "sleepEff", "deepH", "remH", "lightH", "awakeH", "sleepHr", "hrv", "restingHr",
  "readiness", "tempDev", "activity", "steps", "activeCal", "activeMin", "spo2", "bdi", "stressMin", "recoveryMin",
  "weightKg", "vo2max", "respRate",
] as const;

// Average each numeric field over the bucket (null-aware: a week with three
// recorded nights averages those three, and a week with none stays null).
export function bucketDays(rows: HealthDay[], bucket: Bucket): HealthDay[] {
  if (bucket === "day") return rows;
  const groups = new Map<string, HealthDay[]>();
  for (const r of rows) {
    const k = bucketKey(r.day, bucket);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.entries()].map(([day, g]) => {
    const out = { ...g[0], day, bedtime: null, wake: null } as HealthDay & { label?: string };
    for (const k of NUMERIC_KEYS) {
      const m = mean(g.map((r) => r[k]));
      out[k] = m === null ? null : Math.round(m * 100) / 100;
    }
    out.label = `${bucket === "week" ? "Week of" : "Month of"} ${shortDay(day, true)} · ${g.length} day${g.length === 1 ? "" : "s"}`;
    return out;
  });
}

type JournalRow = { day: string; label?: string; H: number | null; M: number | null; E: number | null; S: number | null };

export function bucketJournal(rows: JournalRow[], bucket: Bucket): JournalRow[] {
  if (bucket === "day") return rows;
  const groups = new Map<string, JournalRow[]>();
  for (const r of rows) {
    const k = bucketKey(r.day, bucket);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const avg = (xs: (number | null)[]) => {
    const m = mean(xs);
    return m === null ? null : Math.round(m * 10) / 10;
  };
  return [...groups.entries()].map(([day, g]) => ({
    day,
    label: `${bucket === "week" ? "Week of" : "Month of"} ${shortDay(day, true)}`,
    H: avg(g.map((r) => r.H)),
    M: avg(g.map((r) => r.M)),
    E: avg(g.map((r) => r.E)),
    S: avg(g.map((r) => r.S)),
  }));
}

// ── Palette (Pulse tokens; hex because these feed SVG fills) ──

const C = {
  health: "#34D399",
  rhythms: "#2DD4BF",
  freedom: "#7DD3FC",
  creative: "#F87B7B",
  money: "#E0A458",
  relationships: "#B794F4",
  warn: "#FBBF24",
  ink3: "#6F7FA9",
  grid: "rgba(255,255,255,0.08)",
} as const;

// Single-hue ordinal ramp for sleep stages (validated --ordinal, light end 4.68:1).
const STAGE = { deep: "#1E8F6A", rem: "#34D399", light: "#5EEAB4" } as const;

// ── Helpers ──

function shortDay(day: string, withYear = false): string {
  // A day key has no zone: fmtDayKeyParts draws it in UTC so the principal's zone never shifts the day.
  // Composed as "Jan 5, 2026" (the bucket labels the trend tests pin) from the shared day-key parts.
  const md = `${fmtDayKeyParts(day, { month: "short" })} ${fmtDayKeyParts(day, { day: "numeric" })}`;
  return withYear ? `${md}, ${fmtDayKeyParts(day, { year: "numeric" })}` : md;
}

function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function latest<T extends object>(rows: T[], key: keyof T): { value: number; day: string; label?: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][key];
    if (typeof v === "number") {
      const r = rows[i] as { day: string; label?: string };
      return { value: v, day: r.day, label: r.label };
    }
  }
  return null;
}

// Headline date: the bucket label ("Week of Jun 15, 2026 · 7 days") when rows are
// buckets, else the day.
function dayLabel(x: { day: string; label?: string }): string {
  return x.label ?? shortDay(x.day);
}

function fmt(v: number | null | undefined, unit: string, digits = 0): string {
  if (v == null) return "–";
  const s = digits > 0 ? v.toFixed(digits) : Math.round(v).toLocaleString();
  return unit ? `${s}${unit}` : s;
}

function clockFromIso(iso: string | null): string {
  return fmtClock(iso, "–");
}

// Ticks: first day, last day, and roughly weekly in between. Never every day.
function tickDays(rows: { day: string }[]): string[] {
  if (rows.length <= 8) return rows.map((r) => r.day);
  // ~5–6 ticks whatever the row count: weekly for a month, fortnightly for 90
  // days, and an even split once rows are already weekly/monthly buckets.
  const step = rows.length <= 35 ? 7 : rows.length <= 100 ? 14 : Math.ceil(rows.length / 6);
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0; i -= step) out.unshift(rows[i].day);
  return out;
}

function tickLabel(day: string, bucket: Bucket): string {
  if (bucket === "month") return fmtDayKeyParts(day, { month: "short", year: "2-digit" });
  return shortDay(day);
}

// ── Tooltip ──

interface Series {
  key: string;
  label: string;
  color: string;
  unit?: string;
  digits?: number;
}

function DayTooltip({
  active,
  payload,
  label,
  series,
  extra,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: unknown; payload?: Record<string, unknown> }>;
  label?: string;
  series: Series[];
  extra?: (row: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const row = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  return (
    <div
      className="rounded-lg border px-2.5 py-2 text-xs shadow-xl min-w-[9rem]"
      style={{ borderColor: "var(--line-2)", backgroundColor: "var(--sheet-bg)", backdropFilter: "blur(8px)" }}
      data-sensitive
    >
      <div className="font-medium text-ink-1 mb-1">
        {typeof row.label === "string" ? row.label : typeof label === "string" ? shortDay(label) : ""}
      </div>
      <div className="space-y-1">
        {series.map((s) => {
          const v = row[s.key];
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="inline-block w-3 h-[2px] rounded" style={{ backgroundColor: s.color }} />
              <span className="text-ink-2 flex-1">{s.label}</span>
              <span className="font-mono tabular-nums text-ink-1">
                {typeof v === "number" ? fmt(v, s.unit ?? "", s.digits ?? 0) : "–"}
              </span>
            </div>
          );
        })}
        {extra ? extra(row) : null}
      </div>
    </div>
  );
}

// ── Metric card ──

type Good = "up" | "down" | "flat";

function Delta({ now, prev, good, unit, digits }: { now: number | null; prev: number | null; good: Good; unit: string; digits: number }) {
  if (now == null || prev == null) return <span className="text-[11px] text-ink-3">no prior window</span>;
  const diff = now - prev;
  const tiny = Math.abs(diff) < (digits > 0 ? 0.05 : 0.5);
  const positive = diff > 0;
  const isGood = tiny ? null : good === "flat" ? null : (good === "up") === positive;
  const color = isGood == null ? "var(--ink-3)" : isGood ? "var(--ok)" : "var(--err)";
  const Icon = tiny ? Minus : positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color }}>
      <Icon className="w-3 h-3" />
      <span className="font-mono tabular-nums">
        {tiny ? "±0" : `${positive ? "+" : "−"}${fmt(Math.abs(diff), unit, digits)}`}
      </span>
      <span className="text-ink-3">vs prior</span>
    </span>
  );
}

function MetricCard({
  title,
  headline,
  headlineSub,
  delta,
  children,
  legend,
  accent,
}: {
  title: string;
  headline: string;
  headlineSub?: string;
  delta?: ReactNode;
  children: ReactNode;
  legend?: Series[];
  accent: string;
}) {
  return (
    <Panel className="min-w-0" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-widest text-ink-3">{title}</div>
          <div className="flex items-baseline gap-2" data-sensitive>
            <span className="text-2xl font-semibold text-ink-1 leading-tight">{headline}</span>
            {headlineSub && <span className="text-[11px] text-ink-3">{headlineSub}</span>}
          </div>
        </div>
        {legend && legend.length > 1 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 justify-end text-[11px] text-ink-3 pt-1">
            {legend.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div data-sensitive className="mb-1.5">{delta}</div>
      <div className="h-[120px] w-full min-w-0" data-sensitive>
        {children}
      </div>
    </Panel>
  );
}

// ── Shared axis props ──

const axisTick = { fill: C.ink3, fontSize: 10 } as const;

// Recharts only recognises XAxis / YAxis as DIRECT children of a chart — a
// wrapper component around them is silently ignored (no axis, no domain, no
// reserved band). So these are prop builders, spread onto the real elements.
function xAxisProps(ticks: string[]) {
  return {
    dataKey: "day",
    ticks,
    // Monthly buckets key to the 1st of the month; label those "Aug 26" style.
    tickFormatter: (d: string) => tickLabel(d, ticks.length > 2 && ticks.every((t) => t.endsWith("-01")) ? "month" : "day"),
    tick: axisTick,
    axisLine: false,
    tickLine: false,
    interval: 0 as const,
    minTickGap: 16,
    height: 18,
  };
}

function yAxisProps({ domain, unit = "", width, tickCount = 3, abs = false }: { domain?: [number | string, number | string]; unit?: string; width?: number; tickCount?: number; abs?: boolean }) {
  // Width follows the longest plausible label ("100%", "-390m", "24ms") so the
  // first character never falls off the left edge.
  const w = width ?? (unit.length >= 2 ? 44 : unit ? 40 : 34);
  return {
    domain,
    tick: axisTick,
    axisLine: false,
    tickLine: false,
    width: w,
    tickCount,
    tickFormatter: (v: number) => {
      const raw = abs ? Math.abs(v) : v;
      // Bucketed means carry decimals; an axis tick never needs more than one.
      const n = Math.abs(raw) >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
      return unit ? `${n}${unit}` : Number(n).toLocaleString();
    },
  };
}

const grid = <CartesianGrid vertical={false} stroke={C.grid} strokeWidth={1} />;

// ── Charts ──

function LineCard({
  rows,
  prev,
  ticks,
  title,
  dataKey,
  color,
  unit = "",
  digits = 0,
  good,
  domain,
  area = false,
  label,
}: {
  rows: HealthDay[];
  prev: HealthDay[];
  ticks: string[];
  title: string;
  dataKey: keyof HealthDay;
  color: string;
  unit?: string;
  digits?: number;
  good: Good;
  domain?: [number | string, number | string];
  area?: boolean;
  label: string;
}) {
  const last = latest(rows, dataKey);
  const now = mean(rows.map((r) => r[dataKey] as number | null));
  const before = mean(prev.map((r) => r[dataKey] as number | null));
  const series: Series[] = [{ key: dataKey as string, label, color, unit, digits }];
  const common = { data: rows, margin: { top: 6, right: 22, left: 0, bottom: 0 } };
  return (
    <MetricCard
      title={title}
      headline={last ? fmt(last.value, unit, digits) : "–"}
      headlineSub={last ? dayLabel(last) : undefined}
      delta={<Delta now={now} prev={before} good={good} unit={unit} digits={digits} />}
      accent={color}
    >
      <ResponsiveContainer width="100%" height="100%">
        {area ? (
          <AreaChart {...common}>
            {grid}
            <XAxis {...xAxisProps(ticks)} />
            <YAxis {...yAxisProps({ domain, unit })} />
            <Tooltip content={<DayTooltip series={series} />} cursor={{ stroke: "var(--line-3)", strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey={dataKey as string}
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--sheet-bg)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <LineChart {...common}>
            {grid}
            <XAxis {...xAxisProps(ticks)} />
            <YAxis {...yAxisProps({ domain, unit })} />
            <Tooltip content={<DayTooltip series={series} />} cursor={{ stroke: "var(--line-3)", strokeWidth: 1 }} />
            <Line
              type="monotone"
              dataKey={dataKey as string}
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--sheet-bg)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </MetricCard>
  );
}

function SleepStagesCard({ rows, prev, ticks }: { rows: HealthDay[]; prev: HealthDay[]; ticks: string[] }) {
  const last = latest(rows, "sleepH");
  const now = mean(rows.map((r) => r.sleepH));
  const before = mean(prev.map((r) => r.sleepH));
  const series: Series[] = [
    { key: "deepH", label: "Deep", color: STAGE.deep, unit: "h", digits: 1 },
    { key: "remH", label: "REM", color: STAGE.rem, unit: "h", digits: 1 },
    { key: "lightH", label: "Light", color: STAGE.light, unit: "h", digits: 1 },
  ];
  return (
    <MetricCard
      title="Sleep hours · stages"
      headline={last ? fmt(last.value, "h", 1) : "–"}
      headlineSub={last ? dayLabel(last) : undefined}
      delta={<Delta now={now} prev={before} good="up" unit="h" digits={1} />}
      legend={series}
      accent={C.health}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 22, left: 0, bottom: 0 }} barCategoryGap="30%">
          {grid}
          <XAxis {...xAxisProps(ticks)} />
          <YAxis {...yAxisProps({ unit: "h", })} />
          <Tooltip
            content={
              <DayTooltip
                series={series}
                extra={(row) => (
                  <>
                    <div className="flex items-center gap-2 pt-1 border-t" style={{ borderColor: "var(--line-1)" }}>
                      <span className="inline-block w-3" />
                      <span className="text-ink-2 flex-1">Total</span>
                      <span className="font-mono tabular-nums text-ink-1">{fmt(row.sleepH as number | null, "h", 1)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-3" />
                      <span className="text-ink-2 flex-1">Bed → wake</span>
                      <span className="font-mono tabular-nums text-ink-1">
                        {clockFromIso(row.bedtime as string | null)} → {clockFromIso(row.wake as string | null)}
                      </span>
                    </div>
                  </>
                )}
              />
            }
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
          />
          <Bar dataKey="deepH" stackId="s" fill={STAGE.deep} stroke="var(--sheet-bg)" strokeWidth={1} maxBarSize={24} isAnimationActive={false} />
          <Bar dataKey="remH" stackId="s" fill={STAGE.rem} stroke="var(--sheet-bg)" strokeWidth={1} maxBarSize={24} isAnimationActive={false} />
          <Bar dataKey="lightH" stackId="s" fill={STAGE.light} stroke="var(--sheet-bg)" strokeWidth={1} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </MetricCard>
  );
}

// Diverging bars around zero: positive one hue, negative another, with a
// baseline reference line. Used for temperature deviation.
function DivergingCard({
  rows,
  prev,
  ticks,
  title,
  dataKey,
  unit,
  digits,
  label,
  up,
  down,
}: {
  rows: HealthDay[];
  prev: HealthDay[];
  ticks: string[];
  title: string;
  dataKey: keyof HealthDay;
  unit: string;
  digits: number;
  label: string;
  up: string;
  down: string;
}) {
  const last = latest(rows, dataKey);
  const now = mean(rows.map((r) => (r[dataKey] == null ? null : Math.abs(r[dataKey] as number))));
  const before = mean(prev.map((r) => (r[dataKey] == null ? null : Math.abs(r[dataKey] as number))));
  const maxAbs = Math.max(0.5, ...rows.map((r) => Math.abs((r[dataKey] as number | null) ?? 0)));
  const series: Series[] = [{ key: dataKey as string, label, color: up, unit, digits }];
  return (
    <MetricCard
      title={title}
      headline={last ? `${last.value > 0 ? "+" : ""}${fmt(last.value, unit, digits)}` : "–"}
      headlineSub={last ? dayLabel(last) : undefined}
      delta={<Delta now={now} prev={before} good="down" unit={unit} digits={digits} />}
      legend={[
        { key: "up", label: "above baseline", color: up },
        { key: "down", label: "below", color: down },
      ]}
      accent={up}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 22, left: 0, bottom: 0 }} barCategoryGap="30%">
          {grid}
          <XAxis {...xAxisProps(ticks)} />
          <YAxis {...yAxisProps({ domain: [-maxAbs, maxAbs], unit })} />
          <ReferenceLine y={0} stroke="var(--line-3)" />
          <Tooltip content={<DayTooltip series={series} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
          <Bar dataKey={dataKey as string} maxBarSize={24} isAnimationActive={false}>
            {rows.map((r) => {
              const v = r[dataKey] as number | null;
              return <Cell key={r.day} fill={v == null ? "transparent" : v >= 0 ? up : down} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </MetricCard>
  );
}

// Stress minutes up, recovery minutes down — one axis, sign carries the meaning.
function StressCard({ rows, prev, ticks }: { rows: HealthDay[]; prev: HealthDay[]; ticks: string[] }) {
  const data = rows.map((r) => ({ ...r, recoveryNeg: r.recoveryMin == null ? null : -r.recoveryMin }));
  const lastS = latest(rows, "stressMin");
  const lastR = latest(rows, "recoveryMin");
  const now = mean(rows.map((r) => r.stressMin));
  const before = mean(prev.map((r) => r.stressMin));
  const maxAbs = Math.ceil(Math.max(30, ...rows.map((r) => Math.max(r.stressMin ?? 0, r.recoveryMin ?? 0))) / 30) * 30;
  const series: Series[] = [
    { key: "stressMin", label: "Stress", color: C.warn, unit: "m" },
    { key: "recoveryMin", label: "Recovery", color: C.health, unit: "m" },
  ];
  return (
    <MetricCard
      title="Stress vs recovery"
      headline={fmt(lastS?.value ?? null, "m")}
      headlineSub={lastS ? `stress · ${dayLabel(lastS)} · recovery ${fmt(lastR?.value ?? null, "m")}` : undefined}
      delta={<Delta now={now} prev={before} good="down" unit="m" digits={0} />}
      legend={series}
      accent={C.warn}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 22, left: 0, bottom: 0 }} barCategoryGap="30%" stackOffset="sign">
          {grid}
          <XAxis {...xAxisProps(ticks)} />
          <YAxis {...yAxisProps({ domain: [-maxAbs, maxAbs], unit: "m", abs: true })} />
          <ReferenceLine y={0} stroke="var(--line-3)" />
          <Tooltip content={<DayTooltip series={series} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
          <Bar dataKey="stressMin" stackId="d" fill={C.warn} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="recoveryNeg" stackId="d" fill={C.health} maxBarSize={24} radius={[0, 0, 4, 4]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </MetricCard>
  );
}

function ColumnCard({
  rows,
  prev,
  ticks,
  title,
  dataKey,
  color,
  unit = "",
  label,
  good,
  marks,
}: {
  rows: HealthDay[];
  prev: HealthDay[];
  ticks: string[];
  title: string;
  dataKey: keyof HealthDay;
  color: string;
  unit?: string;
  label: string;
  good: Good;
  /** Days to mark under the axis (workout / walk logged). */
  marks?: Map<string, { W: boolean; K: boolean }>;
}) {
  const last = latest(rows, dataKey);
  const now = mean(rows.map((r) => r[dataKey] as number | null));
  const before = mean(prev.map((r) => r[dataKey] as number | null));
  const series: Series[] = [{ key: dataKey as string, label, color, unit }];
  // Unitless thousands ("10,000") need a wider axis band than scores do.
  const maxVal = Math.max(0, ...rows.map((r) => (r[dataKey] as number | null) ?? 0));
  const axisWidth = maxVal >= 1000 ? 50 : undefined;
  const legend: Series[] | undefined = marks
    ? [
        { key: dataKey as string, label, color },
        { key: "W", label: "workout", color: C.creative },
        { key: "K", label: "walk", color: C.freedom },
      ]
    : undefined;
  return (
    <MetricCard
      title={title}
      headline={last ? fmt(last.value, unit) : "–"}
      headlineSub={last ? dayLabel(last) : undefined}
      delta={<Delta now={now} prev={before} good={good} unit={unit} digits={0} />}
      legend={legend}
      accent={color}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 22, left: 0, bottom: 0 }} barCategoryGap="30%">
          {grid}
          <XAxis {...xAxisProps(ticks)} />
          <YAxis {...yAxisProps({ unit, width: axisWidth })} />
          <Tooltip
            content={
              <DayTooltip
                series={series}
                extra={
                  marks
                    ? (row) => {
                        const m = marks.get(String(row.day));
                        if (!m || (!m.W && !m.K)) return null;
                        return (
                          <div className="text-ink-2 pt-1">{[m.W ? "workout" : null, m.K ? "walk" : null].filter(Boolean).join(" · ")} logged</div>
                        );
                      }
                    : undefined
                }
              />
            }
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
          />
          <Bar dataKey={dataKey as string} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => {
              const m = marks?.get(r.day);
              // A logged workout or walk recolours that day's bar (legend names both hues).
              const fill = m?.W ? C.creative : m?.K ? C.freedom : color;
              return <Cell key={r.day} fill={fill} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </MetricCard>
  );
}

// Journal dims are 1–5 ratings logged on some days only; dots, no line across
// gaps, because a line would invent continuity that was never logged.
function JournalCard({
  rows,
  ticks,
  title,
  dataKey,
  color,
}: {
  rows: Array<{ day: string } & Partial<Record<"H" | "M" | "E" | "S", number | null>>>;
  ticks: string[];
  title: string;
  dataKey: "H" | "M" | "E" | "S";
  color: string;
}) {
  const logged = rows.filter((r) => typeof r[dataKey] === "number");
  const last = logged.length ? logged[logged.length - 1] : null;
  const avg = mean(logged.map((r) => r[dataKey] ?? null));
  const series: Series[] = [{ key: dataKey, label: title, color }];
  return (
    <MetricCard
      title={title}
      headline={last ? `${last[dataKey]}/5` : "–"}
      headlineSub={last ? dayLabel(last) : "not logged in window"}
      delta={
        <span className="text-[11px] text-ink-3" data-sensitive>
          {logged.length} logged · avg {avg == null ? "–" : avg.toFixed(1)}
        </span>
      }
      accent={color}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 22, left: 0, bottom: 0 }}>
          {grid}
          <XAxis {...xAxisProps(ticks)} />
          <YAxis {...yAxisProps({ domain: [1, 5], tickCount: 5, width: 22, })} />
          <Tooltip content={<DayTooltip series={series} />} cursor={{ stroke: "var(--line-3)", strokeWidth: 1 }} />
          <Line
            dataKey={dataKey}
            stroke="transparent"
            dot={{ r: 4, fill: color, stroke: "var(--sheet-bg)", strokeWidth: 2 }}
            activeDot={{ r: 5, fill: color, stroke: "var(--sheet-bg)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </MetricCard>
  );
}

// ── Table twin ──

const TABLE_COLS: Array<{ key: keyof HealthDay; label: string; unit?: string; digits?: number }> = [
  { key: "sleepScore", label: "Sleep" },
  { key: "sleepH", label: "Hours", unit: "h", digits: 1 },
  { key: "deepH", label: "Deep", unit: "h", digits: 1 },
  { key: "remH", label: "REM", unit: "h", digits: 1 },
  { key: "lightH", label: "Light", unit: "h", digits: 1 },
  { key: "sleepEff", label: "Eff", unit: "%" },
  { key: "readiness", label: "Ready" },
  { key: "hrv", label: "HRV", unit: "ms" },
  { key: "restingHr", label: "RHR", unit: "" },
  { key: "spo2", label: "SpO2", unit: "%", digits: 1 },
  { key: "bdi", label: "BDI" },
  { key: "tempDev", label: "Temp Δ", unit: "°", digits: 2 },
  { key: "stressMin", label: "Stress", unit: "m" },
  { key: "recoveryMin", label: "Recov", unit: "m" },
  { key: "activity", label: "Act" },
  { key: "steps", label: "Steps" },
  { key: "activeMin", label: "Active", unit: "m" },
  { key: "weightKg", label: "Weight", unit: "kg", digits: 1 },
  { key: "vo2max", label: "VO2", digits: 1 },
  { key: "respRate", label: "Resp", digits: 1 },
];

function TableTwin({ rows, journal }: { rows: HealthDay[]; journal: Map<string, HealthJournalDay> }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-[12px] text-ink-3 inline-flex items-center gap-1.5 select-none hover:text-ink-2">
        <Table2 className="w-3.5 h-3.5" /> Table view — every plotted value per day
      </summary>
      <div className="mt-3 overflow-x-auto rounded-lg border" style={{ borderColor: "var(--line-1)" }} data-sensitive>
        <table className="text-[11px] tabular-nums whitespace-nowrap min-w-full">
          <thead>
            <tr className="text-ink-3" style={{ backgroundColor: "var(--surface-1)" }}>
              <th className="text-left px-2 py-1.5 font-medium">Day</th>
              {TABLE_COLS.map((c) => (
                <th key={c.key} className="text-right px-2 py-1.5 font-medium">{c.label}</th>
              ))}
              <th className="text-right px-2 py-1.5 font-medium">OVR</th>
              <th className="text-right px-2 py-1.5 font-medium">Mood</th>
              <th className="text-right px-2 py-1.5 font-medium">Enrg</th>
              <th className="text-right px-2 py-1.5 font-medium">Slp★</th>
              <th className="text-right px-2 py-1.5 font-medium">W/K</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => {
              const j = journal.get(r.day);
              return (
                <tr key={r.day} className="text-ink-2 border-t" style={{ borderColor: "var(--line-1)" }}>
                  <td className="px-2 py-1 text-left text-ink-1">{shortDay(r.day)}</td>
                  {TABLE_COLS.map((c) => (
                    <td key={c.key} className="px-2 py-1 text-right">
                      {fmt(r[c.key] as number | null, c.unit ?? "", c.digits ?? 0)}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right">{j?.H ?? "–"}</td>
                  <td className="px-2 py-1 text-right">{j?.M ?? "–"}</td>
                  <td className="px-2 py-1 text-right">{j?.E ?? "–"}</td>
                  <td className="px-2 py-1 text-right">{j?.S ?? "–"}</td>
                  <td className="px-2 py-1 text-right">{j ? [j.W ? "W" : null, j.K ? "K" : null].filter(Boolean).join("/") || "–" : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── Board ──

function GroupHeader({ icon: Icon, title, note }: { icon: typeof Moon; title: string; note?: string }) {
  return (
    <h3 className="text-[12px] font-medium uppercase tracking-widest text-ink-3 mb-3 flex items-center gap-2">
      <Icon className="w-3.5 h-3.5" /> {title}
      {note && <span className="normal-case tracking-normal text-ink-3 font-normal" data-sensitive>· {note}</span>}
    </h3>
  );
}

export default function TrendBoard({ days, journal }: { days: HealthDay[]; journal: HealthJournalDay[] }) {
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);

  // Deep-linkable window: /health?range=week|month|6mo|year|all (query, never a
  // hash). Read after mount so the static export hydrates against the default.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("range") ?? "";
    const key = (RANGES.find((r) => r.key === q)?.key ?? LEGACY_RANGE[q]) as RangeKey | undefined;
    if (key) setRange(key);
  }, []);

  const preset = RANGES.find((r) => r.key === range) ?? RANGES[1];

  const { rows, prev, ticks, bucket, journalRows, journalMap, marks, dailyRows } = useMemo(() => {
    const n = Number.isFinite(preset.days) ? preset.days : days.length;
    const dailyRows = days.slice(-n);
    // The prior window only exists when there is a full one before this one.
    const prev = days.length >= 2 * n ? days.slice(-2 * n, -n) : [];
    const bucket = bucketFor(dailyRows.length);
    const rows = bucketDays(dailyRows, bucket);
    const ticks = tickDays(rows);
    const journalMap = new Map(journal.map((j) => [j.day, j]));
    const journalDaily: JournalRow[] = dailyRows.map((r) => {
      const j = journalMap.get(r.day);
      return { day: r.day, H: j?.H ?? null, M: j?.M ?? null, E: j?.E ?? null, S: j?.S ?? null };
    });
    const journalRows = bucketJournal(journalDaily, bucket);
    // Workout/walk marks only make sense per day; a weekly bar just counts them.
    const marks = new Map(
      bucket === "day"
        ? dailyRows.map((r) => [r.day, { W: journalMap.get(r.day)?.W ?? false, K: journalMap.get(r.day)?.K ?? false }] as const)
        : [],
    );
    return { rows, prev, ticks, bucket, journalRows, journalMap, marks, dailyRows };
  }, [days, journal, preset]);

  if (days.length < 2) return null;

  const loggedDays = dailyRows.filter((r) => {
    const j = journalMap.get(r.day);
    return j && (j.H != null || j.M != null || j.E != null || j.S != null);
  }).length;
  const first = dailyRows[0];
  // Body metrics only come from Apple Health; the group appears once any day has one.
  const hasBody = days.some((d) => d.weightKg != null || d.vo2max != null || d.respRate != null);
  const last = dailyRows[dailyRows.length - 1];
  const bucketNote = bucket === "day" ? "" : ` · ${bucket === "week" ? "weekly" : "monthly"} averages`;

  return (
    <div className="space-y-6">
      {/* One filter row, above everything it scopes. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[13px] font-medium uppercase tracking-widest text-ink-3 flex items-center gap-2">
          <Activity className="w-4 h-4" /> Trend · {preset.title}
          <span className="normal-case tracking-normal font-normal" data-sensitive>
            · {first ? shortDay(first.day, dailyRows.length > 300) : ""} → {last ? shortDay(last.day, dailyRows.length > 300) : ""} · {dailyRows.length} days{bucketNote}
          </span>
        </div>
        <div className="inline-flex rounded-lg border p-0.5" style={{ borderColor: "var(--line-2)", backgroundColor: "var(--surface-1)" }} role="tablist" aria-label="Trend window">
          {RANGES.map((r) => {
            const active = r.key === range;
            return (
              <button
                key={r.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setRange(r.key)}
                className="px-2.5 py-1 text-[12px] rounded-md transition-colors"
                style={{
                  backgroundColor: active ? "var(--surface-3)" : "transparent",
                  color: active ? "var(--ink-1)" : "var(--ink-3)",
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <section>
        <GroupHeader icon={Moon} title="Sleep" />
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          <LineCard rows={rows} prev={prev} ticks={ticks} title="Sleep score" dataKey="sleepScore" color={C.health} good="up" domain={[0, 100]} area label="Sleep score" />
          <SleepStagesCard rows={rows} prev={prev} ticks={ticks} />
          <LineCard rows={rows} prev={prev} ticks={ticks} title="Sleep efficiency" dataKey="sleepEff" color={C.health} unit="%" good="up" domain={[50, 100]} label="Efficiency" />
        </div>
      </section>

      <section>
        <GroupHeader icon={HeartPulse} title="Recovery & vitals" />
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          <LineCard rows={rows} prev={prev} ticks={ticks} title="Readiness" dataKey="readiness" color={C.rhythms} good="up" domain={[0, 100]} area label="Readiness" />
          <LineCard rows={rows} prev={prev} ticks={ticks} title="HRV (night avg)" dataKey="hrv" color={C.freedom} unit="ms" good="up" domain={["auto", "auto"]} label="HRV" />
          <LineCard rows={rows} prev={prev} ticks={ticks} title="Resting heart rate" dataKey="restingHr" color={C.creative} unit="" good="down" domain={["auto", "auto"]} label="Lowest HR (bpm)" />
          <LineCard rows={rows} prev={prev} ticks={ticks} title="Blood oxygen" dataKey="spo2" color={C.freedom} unit="%" digits={1} good="up" domain={[88, 100]} label="SpO2" />
          <DivergingCard rows={rows} prev={prev} ticks={ticks} title="Body temperature Δ" dataKey="tempDev" unit="°" digits={2} label="Temp deviation" up={C.creative} down={C.freedom} />
          <StressCard rows={rows} prev={prev} ticks={ticks} />
        </div>
      </section>

      <section>
        <GroupHeader icon={Footprints} title="Activity" />
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          <LineCard rows={rows} prev={prev} ticks={ticks} title="Activity score" dataKey="activity" color={C.money} good="up" domain={[0, 100]} area label="Activity score" />
          <ColumnCard rows={rows} prev={prev} ticks={ticks} title="Steps" dataKey="steps" color={C.money} label="Steps" good="up" marks={bucket === "day" ? marks : undefined} />
          <ColumnCard rows={rows} prev={prev} ticks={ticks} title="Active minutes" dataKey="activeMin" color={C.money} unit="m" label="Medium + high" good="up" />
        </div>
      </section>

      {hasBody && (
        <section>
          <GroupHeader icon={Scale} title="Body" note="Apple Health" />
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            <LineCard rows={rows} prev={prev} ticks={ticks} title="Weight" dataKey="weightKg" color={C.relationships} unit="kg" digits={1} good="flat" domain={["auto", "auto"]} label="Weight" />
            <LineCard rows={rows} prev={prev} ticks={ticks} title="VO2 max" dataKey="vo2max" color={C.rhythms} digits={1} good="up" domain={["auto", "auto"]} label="VO2 max (mL/kg/min)" />
            <LineCard rows={rows} prev={prev} ticks={ticks} title="Respiratory rate" dataKey="respRate" color={C.freedom} digits={1} good="flat" domain={["auto", "auto"]} label="Breaths/min (sleep)" />
          </div>
        </section>
      )}

      <section>
        <GroupHeader icon={Brain} title="Mind" note={loggedDays === 0 ? "nothing logged in this window — log with M4 / E3 / S5" : `${loggedDays} logged day${loggedDays === 1 ? "" : "s"}, self-rated 1–5`} />
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <JournalCard rows={journalRows} ticks={ticks} title="Overall" dataKey="H" color={C.relationships} />
          <JournalCard rows={journalRows} ticks={ticks} title="Mood" dataKey="M" color={C.relationships} />
          <JournalCard rows={journalRows} ticks={ticks} title="Energy" dataKey="E" color={C.relationships} />
          <JournalCard rows={journalRows} ticks={ticks} title="Sleep (self-rated)" dataKey="S" color={C.relationships} />
        </div>
      </section>

      <TableTwin rows={rows} journal={journalMap} />
    </div>
  );
}
