"use client";

import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { Gauge, Coins, MessagesSquare } from "lucide-react";
import {
  PageShell,
  PageHeader,
  Panel,
  PanelHeader,
  StatTile,
  TabBar,
  EmptyState,
  type Dim,
} from "@/components/ui/chrome";
import { accountCardMarks, type CardMarks } from "@/lib/usage-cards";
import { fmtDateTime, fmtWeekdayClock } from "@/lib/time";

/**
 * Usage tab — Claude Code and Codex account headroom, subscription utilization, durable token/cost/model usage.
 * Zero data here; fetches /api/usage/{summary,trend,models}. The durable per-day
 * store behind trend/models is written nightly by LIFEOS/TOOLS/UsageAggregator.ts.
 */

interface Totals { totalTokens: number; costUsd: number; messages: number }
interface Summary {
  ts: string | null;
  subscription: { fiveHourPct: number | null; sevenDayPct: number | null };
  monthUsedUsd: number | null;
  monthUsedSource: string | null;
  today: Totals; week: Totals; month: Totals;
  hasDaily: boolean; daysTracked: number;
}
interface AcctWindow { pct: number | null; resets_at: string | null; active: boolean }
interface Account {
  slug: string; email: string; status: "ok" | "expired" | "needs-login" | "error" | "wrong-org";
  /** Pulse-computed: active is slug === active_slug (at most one card); org_label is "Personal" or the org name. */
  active?: boolean; org_label?: string | null; kind?: "personal" | "team";
  five_hour?: AcctWindow; seven_day?: AcctWindow;
  windows?: { name: string; pct: number; resets_at: string | null; active: boolean }[];
  extra?: { enabled: boolean; used_cents: number; limit_cents: number; reached: boolean };
  headroom: number | null; binding?: string; fetched_at?: string; error?: string; login?: string;
  resets?: { available: number; total: number; usable_now: boolean; grants: { id: string; label: string; left: number; total: number; usable_now: boolean; ends_at: string | null }[]; weekly: { available: boolean; next_available_at: string | null; per_week: number } | null };
}
interface Accounts {
  fetched_at: string | null; active_email: string | null; active_slug?: string | null; stale: boolean; accounts: Account[];
  recommendation: { current: string | null; best: string | null; best_headroom: number | null; switch: boolean; reason: string } | null;
}
interface CodexAccount {
  slug?: string; status?: "ok" | "needs-login"; login?: string;
  email: string; plan: string; source: string; fetched_at: string | null; limit_reached: boolean; stale: boolean;
  resets?: { available: number; applicable: number } | null;
  windows: { label: string; pct: number; resets_at: string | null }[];
}
interface TrendPoint { label: string; totalTokens: number; costUsd: number; messages: number }
interface ModelRow { model: string; messages: number; totalTokens: number; costUsd: number; pct: number }
interface OverageRow { vendor: "openai" | "anthropic"; lane: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
interface OverageCall { ts: string; vendor: string; lane: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; sessionId?: string; reason?: string }
interface Overage {
  month: string; ceilingUsd: number; spentUsd: number; remainingUsd: number; byVendor: OverageRow[];
  armed: { armed: boolean; sessionId?: string; reason?: string; expiresAt?: number }; recent: OverageCall[]; updated: string;
}

type Range = "daily" | "weekly" | "monthly";

const fmtTokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
// A billed call under a cent keeps four decimals — "$0.00" reads as nothing billed.
const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—"
    : n > 0 && n < 0.01 ? `$${n.toFixed(4)}`
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`;

// Model → dimension token for the mix bars.
const MODEL_COLOR = (m: string) =>
  /fable/i.test(m) ? "var(--relationships)" : /opus/i.test(m) ? "var(--accent-blue)" : /sonnet/i.test(m) ? "var(--ok)" : /haiku/i.test(m) ? "var(--warn)" : "var(--ink-3)";

const RANGE_TABS: { id: Range; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

export default function UsagePage() {
  const [range, setRange] = useState<Range>("daily");
  const { data: accounts = null } = useApi<Accounts>("/api/usage/accounts", { refetchInterval: 60_000 });
  const { data: codex = null } = useApi<{ accounts?: CodexAccount[] }, CodexAccount[]>("/api/usage/codex", { refetchInterval: 60_000, select: (d) => d.accounts ?? [] });
  const { data: summary = null, error: summaryError } = useApi<Summary>("/api/usage/summary");
  const error = summaryError ? String(summaryError) : null;
  const { data: models = [] } = useApi<{ models?: ModelRow[] }, ModelRow[]>("/api/usage/models?window=all", { select: (d) => d.models ?? [] });
  const { data: overage = null } = useApi<Overage>("/api/usage/overage");
  const { data: trend = [] } = useApi<{ points?: TrendPoint[] }, TrendPoint[]>(`/api/usage/trend?range=${range}`, { select: (d) => d.points ?? [], placeholderData: keepPreviousData });

  const maxCost = useMemo(() => Math.max(1e-6, ...trend.map((p) => p.costUsd)), [trend]);

  return (
    <PageShell className="max-w-[1400px]">
      <PageHeader
        icon={Gauge}
        title="Usage"
        subtitle={
          <>
            Anthropic subscription utilization and Claude usage over time — models, tokens, and cost.
            {summary?.daysTracked ? ` ${summary.daysTracked} days tracked.` : ""}
            <span className="block text-[12px] text-ink-3 mt-1">
              <strong className="text-ink-2">Cost = what this usage would cost at list API prices if it were NOT on the subscription</strong> — the number that starts to matter as Fable moves off-plan. Per-model breakdown below. The &ldquo;API spend&rdquo; card is what&apos;s already billed outside the subscription (admin cost report).
            </span>
          </>
        }
      />

      {error && <div className="text-warn text-sm">Couldn&apos;t reach Usage API: {error}</div>}
      {!summary && !error && <div className="text-ink-3 text-sm">Loading…</div>}

      {/* Per-account Claude Code usage, drawn only when this install polls per account (the API returns rows).
          The API sends a recommendation only on an install with the private skill that owns it; otherwise it is null and no "switch" text draws. */}
      {accounts && accounts.accounts.length > 0 && (
        <Panel>
          <PanelHeader
            title="Claude Code accounts"
            actions={
              accounts.recommendation ? (
                <span className="text-[12px]" style={{ color: accounts.recommendation.switch ? "var(--warn)" : "var(--ink-3)" }}>
                  {accounts.recommendation.switch ? `⇄ switch to ${accounts.recommendation.best}` : "stay"} · {accounts.recommendation.reason}
                  {accounts.stale ? " · stale" : ""}
                </span>
              ) : null
            }
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {accounts.accounts.map((a) => (
              <AccountCard key={a.slug} a={a} marks={accountCardMarks(a, accounts.recommendation)} />
            ))}
          </div>
        </Panel>
      )}

      {/* The ChatGPT plan the codex workers ride */}
      <Panel>
        <PanelHeader title="Codex accounts" />
        {!codex || codex.length === 0 ? (
          <EmptyState title="No Codex usage yet." hint="bun ~/.claude/LIFEOS/TOOLS/CodexUsage.ts --refresh" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {codex.map((c) => <CodexCard key={c.slug || c.email || c.plan} c={c} />)}
          </div>
        )}
      </Panel>

      {summary && (
        <>
          {/* Subscription gauges */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <GaugeCard label="5-hour window" pct={summary.subscription.fiveHourPct} />
            <GaugeCard label="7-day window" pct={summary.subscription.sevenDayPct} />
            <StatTile icon={Coins} dim="money" label="API spend (month)" value={fmtUsd(summary.monthUsedUsd)} sub={summary.monthUsedSource ?? ""} />
            <StatTile icon={MessagesSquare} dim="ok" label="Messages (30d)" value={summary.month.messages.toLocaleString()} sub={`${fmtTokens(summary.month.totalTokens)} tokens`} />
          </div>

          {/* Today / week / month token+cost */}
          <div className="grid gap-3 sm:grid-cols-3">
            <PeriodCard label="Today" t={summary.today} />
            <PeriodCard label="This week" t={summary.week} />
            <PeriodCard label="This month" t={summary.month} />
          </div>

          <OveragePanel overage={overage} />

          {!summary.hasDaily && (
            <div
              className="text-[13px] rounded-lg px-3 py-2"
              style={{ color: "var(--warn)", border: "1px solid rgba(251,191,36,0.2)", background: "rgba(251,191,36,0.05)" }}
            >
              No per-day rollup yet. Run <code className="mono text-warn">bun ~/.claude/LIFEOS/TOOLS/UsageAggregator.ts</code> (or wait for the nightly job) to populate token/cost history.
            </div>
          )}

          {/* Trend */}
          <Panel>
            <PanelHeader
              title="Cost trend"
              actions={<TabBar tabs={RANGE_TABS} active={range} onChange={setRange} />}
            />
            {trend.length === 0 ? (
              <EmptyState title="No data for this range yet." />
            ) : (
              <div className="flex items-end gap-1 h-48">
                {trend.map((p) => (
                  <div key={p.label} className="flex-1 flex flex-col items-center justify-end group min-w-0" title={`${p.label}: ${fmtUsd(p.costUsd)} · ${fmtTokens(p.totalTokens)} tok · ${p.messages} msgs`}>
                    <div
                      className="w-full rounded-t transition-colors"
                      style={{ height: `${Math.max(2, (p.costUsd / maxCost) * 100)}%`, background: "var(--accent-blue)" }}
                    />
                    <div className="text-[9px] text-ink-3 mt-1 truncate w-full text-center">{p.label.slice(5)}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Model mix */}
          <Panel>
            <PanelHeader title="Model mix (all time)" />
            {models.length === 0 ? (
              <EmptyState title="No model data yet." />
            ) : (
              <div className="flex flex-col gap-3">
                {models.map((m) => (
                  <div key={m.model} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between text-[13px]">
                      <span className="text-ink-1 font-medium">{m.model}</span>
                      <span className="text-ink-3">
                        {m.pct}% · {m.messages.toLocaleString()} msgs · {fmtTokens(m.totalTokens)} tok · {fmtUsd(m.costUsd)}
                      </span>
                    </div>
                    <div className="h-2 rounded bg-surface-3 overflow-hidden">
                      <div className="h-full" style={{ width: `${Math.max(1, m.pct)}%`, background: MODEL_COLOR(m.model) }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </PageShell>
  );
}

function OveragePanel({ overage }: { overage: Overage | null }) {
  return (
    <Panel>
      <PanelHeader title="Overage" actions={overage ? <span className="text-[12px] text-ink-3">Emergency API · {overage.month}</span> : null} />
      {!overage ? <EmptyState title="Loading emergency API spend…" /> : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">This month</div><div className="text-[28px] leading-none font-semibold mono text-ink-1 mt-1">{fmtUsd(overage.spentUsd)}</div></div>
            <div className="text-[13px] text-ink-3">Ceiling <span className="mono text-ink-1">{fmtUsd(overage.ceilingUsd)}</span><br />Remaining <span className="mono text-ink-1">{fmtUsd(overage.remainingUsd)}</span></div>
            <div className="sm:text-right"><span className="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.1em]" style={overage.armed.armed ? { color: "var(--warn)", background: "rgba(251,191,36,0.14)", border: "1px solid rgba(251,191,36,0.4)" } : { color: "var(--ink-3)", background: "var(--surface-3)" }}>{overage.armed.armed ? "Armed" : "Disarmed"}</span>{overage.armed.reason && <div className="text-[11px] text-ink-3 mt-1">{overage.armed.reason}</div>}</div>
          </div>
          {overage.byVendor.length === 0 ? <EmptyState title="$0 this month." hint={`Ceiling ${fmtUsd(overage.ceilingUsd)} · emergency API lane disarmed · no billed calls recorded.`} /> : <OverageTable rows={overage.byVendor} />}
          {overage.recent.length > 0 && <div><div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2">Recent billed calls</div><div className="flex flex-col gap-1">{overage.recent.map((call, index) => <div key={`${call.ts}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px] text-ink-3"><span className="truncate"><span className="text-ink-1">{call.vendor} · {call.lane}</span> · {call.model} · {fmtTokens(call.inputTokens + call.outputTokens)} tok <span className="text-ink-3">· {fmtDateTime(call.ts)}</span></span><span className="mono text-ink-1">{fmtUsd(call.costUsd)}</span></div>)}</div></div>}
        </div>
      )}
    </Panel>
  );
}

function OverageTable({ rows }: { rows: OverageRow[] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-[12px]"><thead className="text-ink-3"><tr><th className="pb-2 font-medium">Vendor / lane</th><th className="pb-2 font-medium">Model</th><th className="pb-2 font-medium text-right">Calls</th><th className="pb-2 font-medium text-right">Tokens</th><th className="pb-2 font-medium text-right">Cost</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.vendor}-${row.lane}-${row.model}`} className="border-t border-surface-3"><td className="py-2 text-ink-1">{row.vendor} · {row.lane}</td><td className="py-2 text-ink-3">{row.model}</td><td className="py-2 text-right mono text-ink-2">{row.calls.toLocaleString()}</td><td className="py-2 text-right mono text-ink-2">{fmtTokens(row.inputTokens + row.outputTokens)}</td><td className="py-2 text-right mono text-ink-1">{fmtUsd(row.costUsd)}</td></tr>)}</tbody></table></div>;
}

function GaugeCard({ label, pct }: { label: string; pct: number | null }) {
  const v = pct ?? 0;
  const dim: Dim = v >= 85 ? "err" : v >= 60 ? "warn" : "ok";
  const color = dim === "err" ? "var(--err)" : dim === "warn" ? "var(--warn)" : "var(--ok)";
  return (
    <Panel className="p-4 flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">{label}</span>
      <div className="text-[28px] leading-none font-semibold mono text-ink-1">{pct == null ? "—" : `${pct}%`}</div>
      <div className="h-2 rounded bg-surface-3 overflow-hidden mt-1">
        <div className="h-full transition-all" style={{ width: `${Math.min(100, v)}%`, background: color }} />
      </div>
    </Panel>
  );
}

const fmtReset = (iso: string | null | undefined) =>
  iso ? fmtWeekdayClock(iso) : "";

function Meter({ label, w }: { label: string; w?: AcctWindow | { pct: number; resets_at: string | null; active: boolean } }) {
  const v = w?.pct ?? null;
  const color = v == null ? "var(--ink-3)" : v >= 85 ? "var(--err)" : v >= 60 ? "var(--warn)" : "var(--ok)";
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className={w?.active ? "text-ink-1 font-semibold" : "text-ink-3"}>{label}</span>
        <span className="mono text-ink-2 whitespace-nowrap">{v == null ? "—" : `${Math.round(v)}%`}<span className="text-ink-3"> {fmtReset(w?.resets_at)}</span></span>
      </div>
      <div className="h-1.5 rounded bg-surface-3 overflow-hidden">
        <div className="h-full" style={{ width: `${Math.min(100, v ?? 0)}%`, background: color }} />
      </div>
    </div>
  );
}

function AccountCard({ a, marks }: { a: Account; marks: CardMarks }) {
  const { active, recommended, orgLabel } = marks;
  const border = recommended ? "1px solid var(--ok)" : active ? "1px solid var(--accent-blue)" : undefined;
  const statusColor = a.status === "ok" ? (a.headroom != null && a.headroom <= 10 ? "var(--err)" : "var(--ok)") : "var(--warn)";
  return (
    <Panel className="p-4 flex flex-col gap-2" style={border ? { border } : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] font-semibold text-ink-1 shrink-0" title={a.email}>{a.slug}</span>
        <span className="text-[11px] uppercase tracking-[0.1em] text-right whitespace-nowrap" style={{ color: statusColor }}>
          {active ? "active · " : ""}{recommended ? "switch here · " : ""}{a.status === "needs-login" ? "log in" : a.status}
        </span>
      </div>
      <div className="text-[11px] text-ink-3 truncate" title={a.email}>{orgLabel ? <span className="text-ink-2">{orgLabel} · </span> : null}{a.email}</div>
      {a.status === "needs-login" ? (
        <>
          {a.login && (
            <>
              <div className="text-[11px] text-ink-3">Run in a plain terminal tab, sign in as {a.email}, then /exit:</div>
              <div className="text-[11px] text-ink-2 mono break-all rounded px-2 py-1.5 bg-surface-3 select-all">{a.login}</div>
            </>
          )}
          {a.error && <div className="text-[11px] text-ink-3 mono break-all">{a.error}</div>}
        </>
      ) : (
        <>
          <div className="text-[26px] leading-none font-semibold mono" style={{ color: statusColor }}>
            {a.headroom == null ? "—" : `${a.headroom}%`} <span className="text-[11px] text-ink-3 font-normal">headroom{a.binding ? ` · ${a.binding} binding` : ""}</span>
          </div>
          <Meter label="5h" w={a.five_hour} />
          <Meter label="7d" w={a.seven_day} />
          {a.windows?.map((w) => <Meter key={w.name} label={w.name} w={w} />)}
          {a.resets && (
            <ResetBlock
              available={a.resets.available + (a.resets.weekly?.available ? 1 : 0)}
              usable={(a.resets.usable_now ? a.resets.available : 0) + (a.resets.weekly?.available ? 1 : 0)}
              note={[...a.resets.grants.map((g) => `${g.label}: ${g.left}/${g.total}${g.ends_at ? ` until ${fmtReset(g.ends_at)}` : ""}`), a.resets.weekly ? `weekly session reset: ${a.resets.weekly.available ? "available" : a.resets.weekly.next_available_at ? `next ${fmtReset(a.resets.weekly.next_available_at)}` : "used"}` : ""].filter(Boolean).join(" · ")}
            />
          )}
          {a.extra?.enabled && (
            <div className="text-[11px] text-ink-3">credits {fmtUsd(a.extra.used_cents / 100)} / {fmtUsd(a.extra.limit_cents / 100)}{a.extra.reached ? " · cap reached" : ""}</div>
          )}
          {a.error && <div className="text-[11px]" style={{ color: "var(--warn)" }}>{a.error}</div>}
        </>
      )}
    </Panel>
  );
}

function ResetBlock({ available, usable, note }: { available: number; usable: number; note?: string }) {
  const tone = usable > 0 ? "ok" : available > 0 ? "neutral" : "err";
  const color = tone === "ok" ? "var(--ok)" : tone === "neutral" ? "var(--ink-1)" : "var(--err)";
  return (
    <div className="flex items-baseline gap-2 rounded-lg px-3 py-2 mt-1" style={{ background: tone === "ok" ? "rgba(52,211,153,0.12)" : tone === "neutral" ? "var(--surface-3)" : "rgba(251,113,133,0.10)", border: `1px solid ${tone === "ok" ? "var(--ok)" : tone === "neutral" ? "var(--surface-3)" : "rgba(251,113,133,0.35)"}` }} title={note}>
      <span className="text-[22px] leading-none font-semibold mono" style={{ color }}>{available}</span>
      <span className="text-[12px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap" style={{ color: tone === "neutral" ? "var(--ink-2)" : color }}>
        {available === 1 ? "reset" : "resets"}{usable > 0 ? ` · ${usable} usable now` : ""}
      </span>
    </div>
  );
}

function CodexCard({ c }: { c: CodexAccount }) {
  const worst = Math.max(0, ...c.windows.map((w) => w.pct));
  const headroom = c.limit_reached ? 0 : Math.round(100 - worst);
  const statusColor = c.limit_reached || headroom <= 10 ? "var(--err)" : "var(--ok)";
  if (c.status === "needs-login") {
    return (
      <Panel className="p-4 flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-semibold text-ink-1 shrink-0">{c.slug}</span>
          <span className="text-[11px] uppercase tracking-[0.1em] whitespace-nowrap" style={{ color: "var(--warn)" }}>log in</span>
        </div>
        <div className="text-[11px] text-ink-3 truncate" title={c.email}>{c.email}</div>
        <div className="text-[11px] text-ink-3 mono break-all">{c.login}</div>
      </Panel>
    );
  }
  return (
    <Panel className="p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] font-semibold text-ink-1 shrink-0 whitespace-nowrap">{c.slug || c.plan || "codex"}{c.slug && c.plan ? <span className="text-[11px] text-ink-3 font-normal"> · {c.plan}</span> : null}</span>
        <span className="text-[11px] uppercase tracking-[0.1em] text-right whitespace-nowrap" style={{ color: c.stale ? "var(--warn)" : statusColor }}>
          {c.limit_reached ? "locked" : "ok"}{c.stale ? " · stale" : ""}
        </span>
      </div>
      <div className="text-[11px] text-ink-3 truncate" title={c.email}>{c.email || "—"}</div>
      <div className="text-[26px] leading-none font-semibold mono" style={{ color: statusColor }}>
        {headroom}% <span className="text-[11px] text-ink-3 font-normal">headroom</span>
      </div>
      {c.windows.map((w) => <Meter key={w.label} label={w.label.toLowerCase()} w={{ pct: w.pct, resets_at: w.resets_at, active: w.pct === worst }} />)}
      {c.resets && <ResetBlock available={c.resets.available} usable={c.resets.applicable} />}
      <div className="text-[11px] text-ink-3">{c.source === "api" ? "live" : "from session log"}{c.fetched_at ? ` · ${fmtReset(c.fetched_at)}` : ""}</div>
    </Panel>
  );
}

function PeriodCard({ label, t }: { label: string; t: Totals }) {
  return (
    <Panel className="p-4 flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold mono text-ink-1">{fmtUsd(t.costUsd)}</span>
        <span className="text-[12px] text-ink-3">{fmtTokens(t.totalTokens)} tok · {t.messages} msgs</span>
      </div>
    </Panel>
  );
}
