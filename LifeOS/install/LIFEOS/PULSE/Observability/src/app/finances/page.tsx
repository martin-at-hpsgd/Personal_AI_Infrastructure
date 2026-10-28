"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DollarSign,
  Landmark,
  CreditCard,
  PiggyBank,
  Receipt,
  Target,
  Lock,
  TrendingUp,
  TrendingDown,
  Wallet,
  Mail,
  Globe,
  BookOpen,
  Mic,
  Briefcase,
  Home,
  Users,
  Cpu,
  Server,
  Scissors,
  Trophy,
  Sparkles,
  PieChart,
  ArrowDownCircle,
  ArrowUpCircle,
  ArrowLeftRight,
  type LucideIcon,
} from "lucide-react";
import {
  Sankey,
  Rectangle,
  Tooltip,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { FreshnessIndicator, type FreshnessData } from "@/components/FreshnessIndicator";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import { ApiError, useApi } from "@/lib/api";
import {
  PageShell,
  PageHeader,
  Panel,
  PanelHeader,
  StatTile,
  TabBar,
  Pill,
  type Dim,
  type TabSpec,
} from "@/components/ui/chrome";
import { fmtDateParts } from "@/lib/time";
import { OwedCard, type OwedSummaryData } from "./OwedCard";

// ─── Types matching /api/life/finances v2 envelope ───

interface Section {
  heading: string;
  body: string;
}
interface Stream {
  label: string;
  annual: number;
}

interface ResolvedLine {
  id: string;
  name: string;
  scope: string;
  monthly_usd: number;
  annual_usd: number;
  source: "collector" | "manual" | "unconfigured";
  cadence: string;
  tags?: string[];
  notes?: string;
  collector?: string;
}

interface TrendPoint {
  month: string;
  income: number;
  outbound: number;
  net: number;
}

interface InsightLine {
  display: string;
  monthly_usd: number;
  annual_usd: number;
  current_monthly_usd?: number;
  lapsed?: boolean;
  observed_usd: number;
  cadence: string;
  confidence: "high" | "medium" | "low";
  scope: string;
  tags: string[];
  active_months: number;
  charge_count: number;
  last_seen: string;
  reason?: string;
}

interface AiSummary {
  total_annualized: number;
  observed: InsightLine[];
  unattributed_buckets: InsightLine[];
  ledger_blind_spots: { vendor: string; item: string; monthly_usd: number | null }[];
}

interface SpendInsights {
  top_bills: InsightLine[];
  top_ai_services: InsightLine[];
  top_infrastructure_services: InsightLine[];
  cut_candidates: InsightLine[];
  by_category: { category: string; annual_usd: number; merchants: number }[];
  total_annualized: number;
  ai_summary?: AiSummary;
  statement_spend: {
    generated_at: string | null;
    record_count: number;
    jsonl_path: string;
    tool: string;
  };
}

// An operator-side sponsorship report writes FINANCES/sponsorships.json.
// Bookings ≠ revenue; rendered beside
// the income numbers, never summed into them.
interface SponsorshipMonth {
  month: string;
  gross: number;
  deals: number;
  accounts: string[];
  by_product: Record<string, number>;
}
interface SponsorshipDeal {
  close_date: string;
  account: string;
  product: string;
  quantity: number;
  unit_price: number;
  total: number;
}
interface SponsorshipArRow {
  sponsorship: string;
  status: string;
  gross: number;
  commission: number;
  net: number;
  due_date: string;
  overdue: boolean;
}
interface Sponsorships {
  updated: string;
  agency: string;
  commission_rate: number;
  summary: {
    latest_month: string;
    latest_month_gross: number;
    latest_month_deals: number;
    latest_month_net_est: number;
    trailing_months: number;
    trailing_gross: number;
    trailing_avg_per_month: number;
    months_missing: string[];
    first_month: string;
  };
  months: SponsorshipMonth[];
  by_product: Record<string, { gross: number; deals: number; avg_unit_price: number }>;
  top_accounts: { account: string; gross: number }[];
  latest_month_deals: SponsorshipDeal[];
  ar: {
    report_date: string;
    totals: { gross: number; commission: number; net: number; count: number };
    overdue: { count: number; gross: number; net: number };
    rows: SponsorshipArRow[];
  } | null;
}

interface FinancesDataV2 {
  version?: number;
  income?: {
    streams: Stream[];
    annual: number;
    monthly: number;
    mrr_monthly: number;
    mrr_annual: number;
  };
  sponsorships?: Sponsorships | null;
  outbound?: {
    vendors: ResolvedLine[];
    obligations: ResolvedLine[];
    other: ResolvedLine[];
    annual: number;
    monthly: number;
    vendors_annual: number;
    obligations_annual: number;
    other_annual: number;
  };
  overall?: {
    net_pre_tax_annual: number;
    net_pre_tax_monthly: number;
    net_post_tax_annual: number;
    net_post_tax_monthly: number;
    effective_tax_rate: number;
    trend: TrendPoint[];
  };
  collector_status?: {
    configured_vendors: number;
    active_collectors: string[];
    jsonl_path: string;
  };
  cfo?: CfoSummary | null;
  // Owed to you (Recover.ts summary): absent when the CFO tool is not installed, null when it failed.
  recovery?: OwedSummaryData | null;
  insights?: SpendInsights;
  currency?: string;
  // v1 legacy fields (still populated)
  accounts?: Section[];
  goals?: Section[];
  expenses?: Section[];
  investments?: Section[];
  taxes?: Section[];
  overview?: Section[];
  plan?: {
    present: boolean;
    flywheel: { n: number; stage: string; text: string }[];
    targets: { headers: string[]; rows: string[][] } | null;
    sections: Section[];
  };
  incomeStreams?: Stream[];
  expenseCategories?: Stream[];
  annualIncome?: number;
  annualExpenses?: number;
  monthlyIncome?: number;
  monthlyExpenses?: number;
  net?: number;
  freshness?: FreshnessData;
  freshness_per_card?: {
    income?: FreshnessData;
    outbound?: FreshnessData;
    overall?: FreshnessData;
    accounts?: FreshnessData;
    investments?: FreshnessData;
    taxes?: FreshnessData;
    plan?: FreshnessData;
    sponsorships?: FreshnessData | null;
  };
}

// ─── Formatting ───

// Deterministic symbols for the currencies LifeOS ships sample data for —
// checked first so the default ("USD" when [principal].currency is unset)
// resolves to the exact literal this page always used, independent of the
// server's ICU/locale environment. Any other ISO 4217 code falls through to
// Intl as a best-effort lookup.
// ported from public PR #1777, @takanorinishida and public PR #1801, @prafed
const CURRENCY_SYMBOL_FALLBACK: Record<string, string> = { USD: "$", JPY: "¥", EUR: "€", GBP: "£" };

function resolveCurrencySymbol(currency: string): string {
  const known = CURRENCY_SYMBOL_FALLBACK[currency.toUpperCase()];
  if (known) return known;
  try {
    const parts = new Intl.NumberFormat(undefined, { style: "currency", currency }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

// Module-level rather than component state: fmtHero is also called from
// SankeyNode, a plain function recharts invokes directly (not a component in
// the tree), so it has no access to hooks or props threaded from FinancesPage.
// Defaults to "$" — the literal every version of this page has rendered — so
// an install with no [principal].currency configured, or a request that
// hasn't resolved yet, is byte-identical to before currency support existed.
let currencySymbol = "$";

function setCurrency(currency: string | undefined | null): void {
  currencySymbol = resolveCurrencySymbol(currency || "USD");
}

function fmtHero(amount: number | null | undefined): string {
  const n = Number(amount) || 0;
  // Threshold on magnitude, not the signed value. A negative net is a real,
  // common case here (the card renders red ink when spending exceeds income),
  // and it missed every `>=` check, falling through to the unabridged digit
  // string — "$-2,120,000" sitting next to a sibling KPI reading "$2.1M".
  // ported from public PR #1778, @takanorinishida
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${currencySymbol}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${currencySymbol}${Math.round(abs / 1000)}K`;
  if (abs >= 1_000) {
    const k = abs / 1000;
    return k % 1 === 0 ? `${sign}${currencySymbol}${k.toFixed(0)}K` : `${sign}${currencySymbol}${k.toFixed(1)}K`;
  }
  return `${sign}${currencySymbol}${Math.round(abs).toLocaleString()}`;
}

function fmtExact(amount: number | null | undefined): string {
  const n = Number(amount) || 0;
  return `${currencySymbol}${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(rate: number | null | undefined): string {
  const n = Number(rate) || 0;
  return `${(n * 100).toFixed(1)}%`;
}

// ─── Palette — chart color scales (kept as literals; the Sankey/line series
// coloring keys off these exact values). Semantic dimension/status/chrome
// colors elsewhere on the page come from the design tokens in globals.css. ───

const DIMENSION_PALETTE = ["#34D399", "#E0A458", "#7DD3FC", "#F87B7B", "#B794F4", "#2DD4BF"];
const SANKEY_INCOME_PALETTE = ["#34D399", "#E0A458"];
const SANKEY_OUTFLOW_PALETTE = ["#F0A35E", "#F87B7B"];

const SANKEY_COLORS: Record<string, string> = {
  "Gross Income": "#E0A458",
  "Net": "#7DD3FC",
  "Expenses": "#F87B7B",
  "Vendors": "#F0A35E",
  "Obligations": "#F87B7B",
  "Other": "#F0A35E",
};

const INCOME_ICON: Record<string, LucideIcon> = {
  newsletter: Mail,
  podcast: Mic,
  sponsor: Mail,
  membership: Users,
  course: BookOpen,
  speaking: Mic,
  consulting: Briefcase,
  product: Globe,
};

const OUTBOUND_ICON: Record<string, LucideIcon> = {
  aws: Server,
  cloudflare: Server,
  anthropic: Cpu,
  openai: Cpu,
  mortgage: Home,
  property_tax: Home,
  home_insurance: Home,
  tesla_lease: TrendingDown,
  auto_insurance: TrendingDown,
  mobile_phone: Receipt,
  home_internet: Receipt,
};

function pickIcon(
  key: string,
  table: Record<string, LucideIcon>,
  fallback: LucideIcon,
): LucideIcon {
  const lower = key.toLowerCase();
  for (const k of Object.keys(table)) {
    if (lower.includes(k) || k.includes(lower)) return table[k];
  }
  return fallback;
}

function parseSubheadings(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("### "))
    .map((l) => l.replace(/^###\s*/, ""));
}

// ─── Shared bits ───

function KpiChip({
  label,
  value,
  tone,
  sensitive = true,
}: {
  label: string;
  value: string;
  tone: "income" | "outbound" | "net" | "neutral";
  sensitive?: boolean;
}) {
  const dim: Dim | undefined =
    tone === "income"
      ? "money"
      : tone === "outbound"
        ? "creative"
        : tone === "net"
          ? "freedom"
          : undefined;
  return (
    <StatTile
      label={label}
      dim={dim}
      value={sensitive ? <span data-sensitive>{value}</span> : value}
    />
  );
}

function SourceBadge({ source }: { source: string }) {
  return <Pill dim="rhythms">{source}</Pill>;
}

function ScopeBadge({ scope }: { scope: string }) {
  return <Pill dim="money">{scope}</Pill>;
}

function LineRow({ line, tone }: { line: ResolvedLine; tone: "income" | "outbound" }) {
  const Icon = pickIcon(
    line.id,
    tone === "income" ? INCOME_ICON : OUTBOUND_ICON,
    tone === "income" ? Wallet : Receipt,
  );
  const toneColor = tone === "income" ? "var(--money)" : "var(--creative)";
  const accentClass =
    tone === "income" ? "[border-left-color:var(--money)]" : "[border-left-color:var(--creative)]";
  return (
    <Panel className={`p-4 border-l-[3px] ${accentClass}`}>
      <div className="flex items-start gap-3">
        <Icon className="w-4 h-4 mt-1 shrink-0" color={toneColor} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{line.name}</span>
            <ScopeBadge scope={line.scope} />
            <SourceBadge source={line.source} />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className="text-lg font-medium tabular-nums"
              style={{ color: toneColor }}
              data-sensitive
            >
              {fmtHero(line.monthly_usd)}
            </span>
            <span className="text-xs text-ink-2">/mo</span>
            <span className="ml-auto text-xs tabular-nums text-ink-2" data-sensitive>
              {fmtHero(line.annual_usd)}/yr
            </span>
          </div>
          {line.notes && (
            <p className="mt-1 text-[12px] line-clamp-2 text-ink-2">{line.notes}</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function StreamCard({ stream }: { stream: Stream }) {
  const Icon = pickIcon(stream.label, INCOME_ICON, Wallet);
  return (
    <Panel className="p-4 border-l-[3px] [border-left-color:var(--money)]">
      <div className="flex items-start gap-3">
        <Icon className="w-4 h-4 mt-1 shrink-0" color="var(--money)" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium truncate block">{stream.label}</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className="text-lg font-medium tabular-nums"
              style={{ color: "var(--money)" }}
              data-sensitive
            >
              {fmtHero(stream.annual)}
            </span>
            <span className="text-xs text-ink-2">/yr</span>
            <span className="ml-auto text-xs tabular-nums text-ink-2" data-sensitive>
              {fmtHero(stream.annual / 12)}/mo
            </span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ─── Hero banners ───

function IncomeHero({
  data,
  freshness,
}: {
  data: NonNullable<FinancesDataV2["income"]>;
  freshness?: FreshnessData;
}) {
  return (
    <Panel className="relative border-l-[3px] [border-left-color:var(--money)]">
      <div className="absolute top-5 right-5 md:top-6 md:right-6 z-10">
        <FreshnessIndicator freshness={freshness} />
      </div>
      <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">Total Annual Income</span>
      <div className="flex items-baseline gap-3 mt-1">
        <span
          className="text-5xl font-medium tabular-nums"
          style={{ color: "var(--money)", letterSpacing: "-0.02em" }}
          data-sensitive="strong"
        >
          {fmtHero(data.annual)}
        </span>
        <span className="text-sm text-ink-2" data-sensitive>
          {fmtHero(data.monthly)}/mo
        </span>
      </div>
      <span className="text-sm mt-1 block text-ink-2">
        <Lock className="inline w-3 h-3 mr-1" /> Private. Toggle Observer mode to blur.
      </span>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <KpiChip label="Monthly Recurring" value={fmtHero(data.mrr_monthly)} tone="income" />
        <KpiChip label="MRR Annualized" value={fmtHero(data.mrr_annual)} tone="income" />
        <KpiChip label="Streams" value={`${data.streams.length}`} tone="neutral" sensitive={false} />
        <KpiChip label="Monthly Income" value={fmtHero(data.monthly)} tone="income" />
      </div>
    </Panel>
  );
}

// Reconciled spend snapshot: one number every surface shares, with the gaps it
// could not close shown beside it rather than hidden in the total.
interface CfoSummary {
  generated_at: string;
  totals: {
    monthly_known: number;
    annual_known: number;
    obligations_monthly: number;
    monthly_with_obligations: number;
    by_basis: Record<string, number>;
    known_count: number;
    pending_count: number;
    stale_count: number;
  };
  discrepancies: { collector: string; ledger_monthly: number; collected_monthly: number; pct: number; members: string[] }[];
  unledgered: { merchant: string; display: string; monthly_avg_usd: number; last_seen: string }[];
  unledgered_count: number;
  ai: { monthly_dollars: number; subscription_value_30d_usd: number | null; overage_month_usd: number } | null;
  delta: { compared_to: string | null; change_pct: number | null } | null;
  sources: { id: string; status: string; as_of: string | null; detail?: string }[];
  alerts: { id: string; severity: string; title: string }[];
  breakdown?: {
    buckets: { name: string; monthly_usd: number; unknown: string[]; items: { id: string; monthly_usd: number | null }[]; note?: string }[];
    monthly_total: number;
    outside_ledger_monthly: number;
  } | null;
  breakdown_not_counted_monthly?: number;
}

// The principal's own buckets (cfo.json `breakdown`), the same numbers `/ex` reads.
function BreakdownCard({ b, notCounted }: { b: NonNullable<CfoSummary["breakdown"]>; notCounted: number }) {
  return (
    <Panel className="relative border-l-[3px] [border-left-color:var(--money)]">
      <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">Where It Goes Each Month</span>
      <div className="text-3xl font-medium tabular-nums mt-1" style={{ color: "var(--money)" }} data-sensitive>{fmtHero(b.monthly_total)}/mo</div>
      <div className="mt-4">
        {b.buckets.map(k => (
          <div key={k.name} className="flex items-start justify-between gap-4 text-sm py-2 border-b border-white/5">
            <div className="flex flex-col min-w-0 leading-5">
              <span className="text-ink-1 whitespace-nowrap">{k.name}</span>
              {k.note && <span className="text-ink-2 text-[12px] leading-4">{k.note}</span>}
            </div>
            <span className="tabular-nums text-ink-2 whitespace-nowrap leading-5" data-sensitive>
              {k.items.length ? fmtExact(k.monthly_usd) : "Not metered"}
              {k.unknown.length > 0 && <span className="text-[12px]"> + {k.unknown.length} unknown</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[12px] text-ink-2" data-sensitive>
        {b.outside_ledger_monthly > 0 && <>Includes {fmtExact(b.outside_ledger_monthly)}/mo read from statements but not in the ledger. </>}
        {notCounted > 0 && <>Not counted: {fmtExact(notCounted)}/mo of recurring statement charges not in the ledger yet.</>}
      </div>
    </Panel>
  );
}

function CfoCard({ cfo }: { cfo: CfoSummary }) {
  const t = cfo.totals;
  const asOf = cfo.generated_at.slice(0, 16).replace("T", " ");
  const tone = (status: string) => (status === "ok" ? "var(--health)" : status === "failed" ? "var(--danger, #ef4444)" : "var(--creative)");
  return (
    <Panel className="relative border-l-[3px] [border-left-color:var(--money)]">
      <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">Reconciled Monthly Spend</span>
      <div className="flex items-baseline gap-3 mt-1 flex-wrap">
        <span className="text-5xl font-medium tabular-nums" style={{ color: "var(--money)", letterSpacing: "-0.02em" }} data-sensitive>
          {fmtHero(t.monthly_known)}
        </span>
        <span className="text-sm text-ink-2" data-sensitive>
          {fmtHero(t.monthly_with_obligations)}/mo with obligations
        </span>
      </div>
      <span className="text-sm mt-1 block text-ink-2">
        Invoices, vendor APIs and statements applied per line, as of {asOf}
        {cfo.delta?.change_pct != null ? ` · ${cfo.delta.change_pct > 0 ? "+" : ""}${cfo.delta.change_pct}% vs ${cfo.delta.compared_to?.slice(0, 10)}` : ""}
      </span>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <KpiChip label="Priced lines" value={`${t.known_count}`} tone="neutral" sensitive={false} />
        <KpiChip label="No amount yet" value={`${t.pending_count}`} tone="neutral" sensitive={false} />
        <KpiChip label="Billed ≠ ledger" value={`${cfo.discrepancies.length}`} tone="outbound" sensitive={false} />
        <KpiChip label="Not in ledger" value={`${cfo.unledgered_count}`} tone="outbound" sensitive={false} />
      </div>
      {cfo.discrepancies.length > 0 && (
        <div className="mt-5">
          <div className="text-[12px] uppercase tracking-wider text-ink-2 mb-2">Billed vs ledger</div>
          {cfo.discrepancies.map(d => (
            <div key={d.collector} className="flex justify-between text-sm py-1 border-b border-white/5">
              <span className="text-ink-1">{d.collector}</span>
              <span className="tabular-nums text-ink-2" data-sensitive>
                billed {fmtExact(d.collected_monthly)} · ledger {fmtExact(d.ledger_monthly)} ({d.pct}%)
              </span>
            </div>
          ))}
        </div>
      )}
      {cfo.unledgered.length > 0 && (
        <div className="mt-5">
          <div className="text-[12px] uppercase tracking-wider text-ink-2 mb-2">Recurring on statements, not in the ledger</div>
          {cfo.unledgered.map(u => (
            <div key={u.merchant} className="flex justify-between text-sm py-1 border-b border-white/5">
              <span className="text-ink-1">{u.display}</span>
              <span className="tabular-nums text-ink-2" data-sensitive>{fmtExact(u.monthly_avg_usd)}/mo</span>
            </div>
          ))}
        </div>
      )}
      {cfo.ai && (
        <div className="mt-5 text-sm text-ink-2">
          AI paid: <span className="text-ink-1 tabular-nums" data-sensitive>{fmtExact(cfo.ai.monthly_dollars)}/mo</span>
          {cfo.ai.subscription_value_30d_usd != null && (
            <> · usage at API prices on flat plans (value, not spend): <span className="tabular-nums" data-sensitive>{fmtHero(cfo.ai.subscription_value_30d_usd)}</span> over 30 days</>
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {cfo.sources.map(src => (
          <span key={src.id} title={src.detail ?? ""}>
            <span style={{ color: tone(src.status) }}>●</span> {src.id.replace("collector:", "")} {src.status}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function OutboundHero({
  data,
  freshness,
}: {
  data: NonNullable<FinancesDataV2["outbound"]>;
  freshness?: FreshnessData;
}) {
  return (
    <Panel className="relative border-l-[3px] [border-left-color:var(--creative)]">
      <div className="absolute top-5 right-5 md:top-6 md:right-6 z-10">
        <FreshnessIndicator freshness={freshness} />
      </div>
      <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">Total Annual Expenses</span>
      <div className="flex items-baseline gap-3 mt-1">
        <span
          className="text-5xl font-medium tabular-nums"
          style={{ color: "var(--creative)", letterSpacing: "-0.02em" }}
          data-sensitive
        >
          {fmtHero(data.annual)}
        </span>
        <span className="text-sm text-ink-2" data-sensitive>
          {fmtHero(data.monthly)}/mo
        </span>
      </div>
      <span className="text-sm mt-1 block text-ink-2">
        <Lock className="inline w-3 h-3 mr-1" /> Sum of vendors, personal obligations, and other.
      </span>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <KpiChip label="Vendors" value={fmtHero(data.vendors_annual)} tone="outbound" />
        <KpiChip label="Obligations" value={fmtHero(data.obligations_annual)} tone="outbound" />
        <KpiChip label="Other" value={fmtHero(data.other_annual)} tone="outbound" />
        <KpiChip
          label="Lines Tracked"
          value={`${data.vendors.length + data.obligations.length + data.other.length}`}
          tone="neutral"
          sensitive={false}
        />
      </div>
    </Panel>
  );
}

function OverallHero({
  data,
  periodView,
  freshness,
}: {
  data: NonNullable<FinancesDataV2["overall"]>;
  periodView: "monthly" | "annual";
  freshness?: FreshnessData;
}) {
  const pre = periodView === "monthly" ? data.net_pre_tax_monthly : data.net_pre_tax_annual;
  const post = periodView === "monthly" ? data.net_post_tax_monthly : data.net_post_tax_annual;
  const preColor = pre >= 0 ? "var(--freedom)" : "var(--creative)";
  return (
    <Panel className="relative border-l-[3px] [border-left-color:var(--freedom)]">
      <div className="absolute top-5 right-5 md:top-6 md:right-6 z-10">
        <FreshnessIndicator freshness={freshness} />
      </div>
      <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">
        Net ({periodView === "monthly" ? "Monthly" : "Annual"})
      </span>
      <div className="flex items-baseline gap-3 mt-1">
        <span
          className="text-5xl font-medium tabular-nums"
          style={{ color: preColor, letterSpacing: "-0.02em" }}
          data-sensitive
        >
          {fmtHero(pre)}
        </span>
        <span className="text-sm text-ink-2">pre-tax</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <KpiChip
          label="Post-Tax Net"
          value={fmtHero(post)}
          tone={post >= 0 ? "net" : "outbound"}
        />
        <KpiChip
          label="Effective Tax Rate"
          value={fmtPct(data.effective_tax_rate)}
          tone="neutral"
          sensitive={false}
        />
        <KpiChip
          label={periodView === "monthly" ? "Annual Pre-Tax" : "Monthly Pre-Tax"}
          value={fmtHero(
            periodView === "monthly" ? data.net_pre_tax_annual : data.net_pre_tax_monthly,
          )}
          tone="net"
        />
        <KpiChip
          label={periodView === "monthly" ? "Annual Post-Tax" : "Monthly Post-Tax"}
          value={fmtHero(
            periodView === "monthly" ? data.net_post_tax_annual : data.net_post_tax_monthly,
          )}
          tone="net"
        />
      </div>
    </Panel>
  );
}

// ─── Overall trend chart ───

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  return (
    <Panel className="border-l-[3px] [border-left-color:var(--money)]">
      <PanelHeader icon={ArrowLeftRight} title="Income vs Expenses — 12 Month Trend" />
      <div className="w-full h-64" data-sensitive>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line-1)" />
            <XAxis dataKey="month" stroke="var(--ink-3)" fontSize={11} />
            <YAxis
              stroke="var(--ink-3)"
              fontSize={11}
              tickFormatter={(v) => `${currencySymbol}${Math.round(v / 1000)}K`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--surface-1)",
                border: "1px solid var(--line-1)",
                borderRadius: 8,
                color: "var(--ink-1)",
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--ink-2)" }} />
            <Line type="monotone" dataKey="income" stroke="var(--money)" strokeWidth={2} dot={false} name="Income" />
            <Line type="monotone" dataKey="outbound" stroke="var(--creative)" strokeWidth={2} dot={false} name="Expenses" />
            <Line type="monotone" dataKey="net" stroke="var(--freedom)" strokeWidth={2} dot={false} name="Net" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {trend.length > 1 && trend.every((t) => t.income === trend[0].income && t.outbound === trend[0].outbound) ? (
        <p className="text-[12px] mt-2 text-ink-2">
          Flat baseline — no monthly history yet. Pull a books export (P&L by month) to light this up.
        </p>
      ) : (
        <p className="text-[12px] mt-2 text-ink-2">
          Real monthly Income / Expenses / Net from the latest books export.
        </p>
      )}
    </Panel>
  );
}

// ─── Sankey ───

interface SankeyNodePayload {
  name?: string;
  category?: string;
  colorIndex?: number;
  value?: number;
  depth?: number;
}

interface SankeyNodeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: SankeyNodePayload;
}

function SankeyNode(props: SankeyNodeProps) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  const name = payload?.name ?? "";
  const colorIndex = payload?.colorIndex ?? 0;
  const color =
    SANKEY_COLORS[name] ||
    (payload?.category === "income"
      ? SANKEY_INCOME_PALETTE[colorIndex % SANKEY_INCOME_PALETTE.length]
      : payload?.category === "outbound"
        ? SANKEY_OUTFLOW_PALETTE[colorIndex % SANKEY_OUTFLOW_PALETTE.length]
        : payload?.category === "net"
          ? DIMENSION_PALETTE[2]
        : "#6B80AB");
  const isLeft = (payload?.depth ?? 0) === 0;
  return (
    <g>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        fillOpacity={0.9}
        radius={[3, 3, 3, 3]}
      />
      <text
        x={isLeft ? x - 8 : x + width + 8}
        y={y + height / 2}
        textAnchor={isLeft ? "end" : "start"}
        dominantBaseline="central"
        fill="var(--ink-1)"
        fontSize={12}
        fontWeight={500}
      >
        {name}
      </text>
      <text
        x={isLeft ? x - 8 : x + width + 8}
        y={y + height / 2 + 16}
        textAnchor={isLeft ? "end" : "start"}
        dominantBaseline="central"
        fill="var(--ink-2)"
        fontSize={11}
        data-sensitive
      >
        {payload?.value != null ? `${fmtHero(payload.value / 12)}/mo` : ""}
      </text>
    </g>
  );
}

interface SankeyLinkProps {
  sourceX?: number;
  sourceY?: number;
  sourceControlX?: number;
  targetX?: number;
  targetY?: number;
  targetControlX?: number;
  linkWidth?: number;
  payload?: {
    source?: SankeyNodePayload;
    target?: SankeyNodePayload;
  };
}

function SankeyLink(props: SankeyLinkProps) {
  const {
    sourceX = 0,
    sourceY = 0,
    sourceControlX = 0,
    targetX = 0,
    targetY = 0,
    targetControlX = 0,
    linkWidth = 0,
    payload,
  } = props;
  const sourceName = payload?.source?.name ?? "";
  const targetName = payload?.target?.name ?? "";
  const color = SANKEY_COLORS[targetName] || SANKEY_COLORS[sourceName] || "#6B80AB";
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={linkWidth}
      strokeOpacity={0.25}
    />
  );
}

interface SankeyNodeDatum {
  name: string;
  category: "income" | "outbound" | "pool" | "net";
  colorIndex?: number;
}

interface SankeyLinkDatum {
  source: number;
  target: number;
  value: number;
}

function FinancesSankey({
  incomeStreams,
  outbound,
  net,
}: {
  incomeStreams: Stream[];
  outbound: NonNullable<FinancesDataV2["outbound"]>;
  net: number;
}) {
  const data = useMemo<{ nodes: SankeyNodeDatum[]; links: SankeyLinkDatum[] }>(() => {
    const nodes: SankeyNodeDatum[] = [];
    const links: SankeyLinkDatum[] = [];
    const streams = incomeStreams.filter((s) => s.annual > 0);
    streams.forEach((s, i) =>
      nodes.push({ name: s.label, category: "income", colorIndex: i }),
    );
    nodes.push({ name: "Gross Income", category: "pool" });
    const grossIdx = nodes.length - 1;
    streams.forEach((s, i) => {
      links.push({ source: i, target: grossIdx, value: s.annual });
    });
    nodes.push({ name: "Expenses", category: "pool" });
    const outboundIdx = nodes.length - 1;
    if (outbound.annual > 0)
      links.push({ source: grossIdx, target: outboundIdx, value: outbound.annual });
    if (net > 0) {
      nodes.push({ name: "Net", category: "net" });
      links.push({ source: grossIdx, target: nodes.length - 1, value: net });
    }
    if (outbound.vendors_annual > 0) {
      nodes.push({ name: "Vendors", category: "outbound" });
      links.push({ source: outboundIdx, target: nodes.length - 1, value: outbound.vendors_annual });
    }
    if (outbound.obligations_annual > 0) {
      nodes.push({ name: "Obligations", category: "outbound" });
      links.push({
        source: outboundIdx,
        target: nodes.length - 1,
        value: outbound.obligations_annual,
      });
    }
    if (outbound.other_annual > 0) {
      nodes.push({ name: "Other", category: "outbound" });
      links.push({ source: outboundIdx, target: nodes.length - 1, value: outbound.other_annual });
    }
    return { nodes, links };
  }, [incomeStreams, outbound, net]);

  if (data.nodes.length === 0) return null;

  return (
    <Panel className="p-4">
      <div className="w-full h-[460px]" data-sensitive>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            node={<SankeyNode />}
            link={<SankeyLink />}
            nodePadding={36}
            margin={{ top: 24, bottom: 24, left: 175, right: 175 }}
          >
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--surface-1)",
              border: "1px solid var(--line-1)",
              borderRadius: 8,
              color: "var(--ink-1)",
            }}
            formatter={(v: number) => fmtExact(v)}
          />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

// ─── Tabs ───

type TabKey = "income" | "outbound" | "overall" | "plan";
const TABS: TabSpec<TabKey>[] = [
  { id: "income", label: "Income", icon: ArrowUpCircle, dim: "money", hint: "1" },
  { id: "outbound", label: "Expenses", icon: ArrowDownCircle, dim: "creative", hint: "2" },
  { id: "overall", label: "Overall", icon: ArrowLeftRight, dim: "freedom", hint: "3" },
  { id: "plan", label: "Flywheel", icon: TrendingUp, dim: "relationships", hint: "4" },
];

const PERIOD_TABS: TabSpec<"monthly" | "annual">[] = [
  { id: "monthly", label: "Monthly", dim: "freedom" },
  { id: "annual", label: "Annual", dim: "freedom" },
];

// ─── Section renderers ───

function SectionGroup({
  title,
  items,
  icon: Icon,
  freshness,
}: {
  title: string;
  items?: Section[];
  icon: LucideIcon;
  freshness?: FreshnessData;
}) {
  if (!items || items.length === 0) return null;
  const accent =
    title === "Investments" ? "var(--health)" : title === "Goals" ? "var(--relationships)" : "var(--money)";
  const accentClass =
    title === "Investments"
      ? "[border-left-color:var(--health)]"
      : title === "Goals"
        ? "[border-left-color:var(--relationships)]"
        : "[border-left-color:var(--money)]";
  return (
    <section>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
          <Icon className="w-4 h-4" color={accent} /> {title}
        </h2>
        {freshness && <FreshnessIndicator freshness={freshness} />}
      </div>
      <div className="prob-grid">
        {items.map((item, i) => (
          <Panel key={i} className={`border-l-[3px] ${accentClass}`}>
            <h3 className="text-sm font-medium mb-1">{item.heading}</h3>
            <div
              className="text-xs whitespace-pre-wrap line-clamp-5 text-ink-2"
              data-sensitive
            >
              {item.body}
            </div>
          </Panel>
        ))}
      </div>
    </section>
  );
}

function AccountCategory({ item }: { item: Section }) {
  const ACCOUNT_ICON: Record<string, LucideIcon> = {
    Banking: Landmark,
    "Credit Cards": CreditCard,
    "Investment Accounts": PiggyBank,
    Investments: PiggyBank,
    "Account Processing": Receipt,
  };
  const Icon = ACCOUNT_ICON[item.heading] || DollarSign;
  const subs = parseSubheadings(item.body);
  return (
    <Panel className="border-l-[3px] [border-left-color:var(--money)]">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4" color="var(--money)" />
        <h3 className="text-sm font-medium uppercase tracking-wider">{item.heading}</h3>
        <span className="ml-auto text-xs text-ink-2">
          {subs.length > 0 ? `${subs.length} items` : ""}
        </span>
      </div>
      {subs.length > 0 ? (
        <div className="space-y-2" data-sensitive>
          {subs.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: "var(--rhythms)", opacity: 0.6 }}
              />
              <span>{s}</span>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="text-xs whitespace-pre-wrap line-clamp-5 text-ink-2"
          data-sensitive
        >
          {item.body}
        </div>
      )}
    </Panel>
  );
}

// ─── Tabs ───

// ─── Sponsorship pipeline (bookings + AR from the sales agency) ───

function monthLabel(ym: string): string {
  // Calendar-day keys carry no zone: anchor at noon UTC so the principal's zone never shifts the day.
  return fmtDateParts(`${ym}-15T12:00:00Z`, { month: "short", year: "numeric" });
}
function shortDate(iso: string): string {
  return fmtDateParts(`${iso}T12:00:00Z`, { month: "short", day: "numeric" });
}

function SponsorshipPanel({ data, freshness }: { data: Sponsorships; freshness?: FreshnessData | null }) {
  const s = data.summary;
  const ar = data.ar;
  const chart = data.months.map((m) => ({
    month: monthLabel(m.month).replace(" 20", " '"),
    gross: m.gross,
    deals: m.deals,
  }));
  const products = Object.entries(data.by_product).sort((a, b) => b[1].gross - a[1].gross);
  const productTotal = products.reduce((t, [, p]) => t + p.gross, 0);
  return (
    <section>
      <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2 mb-4 flex items-center gap-2 flex-wrap">
        <Briefcase className="w-4 h-4" color="var(--money)" /> Sponsorship Pipeline
        <span className="text-[11px] normal-case tracking-normal text-ink-3">
          via <span data-sensitive>{data.agency}</span> · bookings by close date, not revenue · {Math.round(data.commission_rate * 100)}% agency commission
        </span>
        <span className="ml-auto normal-case tracking-normal">
          <FreshnessIndicator freshness={freshness ?? undefined} />
        </span>
      </h2>
      <Panel className="border-l-[3px] [border-left-color:var(--money)]">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiChip label={`${monthLabel(s.latest_month)} bookings`} value={fmtHero(s.latest_month_gross)} tone="income" />
          <KpiChip label={`Avg / month · ${s.trailing_months} mo`} value={fmtHero(s.trailing_avg_per_month)} tone="income" />
          <KpiChip label="Receivable (net)" value={fmtHero(ar?.totals.net ?? 0)} tone="net" />
          <KpiChip
            label="Overdue"
            value={ar ? `${ar.overdue.count} · ${fmtHero(ar.overdue.net)}` : "—"}
            tone={ar && ar.overdue.count > 0 ? "outbound" : "neutral"}
          />
        </div>
        <div className="mt-2 text-xs text-ink-3">
          {s.latest_month_deals} deal{s.latest_month_deals === 1 ? "" : "s"} closed in {monthLabel(s.latest_month)} ·{" "}
          <span data-sensitive>{fmtHero(s.latest_month_net_est)}</span> net after commission
          {s.months_missing.length > 0 && (
            <> · no report on file for {s.months_missing.map(monthLabel).join(", ")}</>
          )}
        </div>

        <div className="mt-5 h-52" data-sensitive>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line-2)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "var(--ink-3)" }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--ink-3)" }}
                axisLine={false}
                tickLine={false}
                width={52}
                tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
              />
              <Tooltip
                cursor={{ fill: "var(--surface-2)" }}
                contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--line-2)", borderRadius: 10, fontSize: 12 }}
                formatter={(v: number, _n, item) => [`${fmtHero(v)} · ${item?.payload?.deals} deals`, "Bookings"]}
              />
              {/* No mount animation: a backgrounded tab suspends rAF and the bars would stay at zero height. */}
              <Bar dataKey="gross" fill="var(--money)" radius={[6, 6, 0, 0]} maxBarSize={44} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid md:grid-cols-2 gap-5 mt-5">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2">
              {monthLabel(s.latest_month)} — closed deals
            </h3>
            <div className="space-y-1.5">
              {data.latest_month_deals.map((d, i) => (
                <div key={i} className="flex items-baseline gap-2 text-sm">
                  <span className="text-ink-3 tabular-nums w-14 shrink-0 whitespace-nowrap">{shortDate(d.close_date)}</span>
                  <span className="font-medium truncate" data-sensitive>{d.account}</span>
                  <span className="text-ink-3 truncate text-xs">
                    {d.product}
                    {d.quantity > 1 ? ` ×${d.quantity}` : ""}
                  </span>
                  <span className="ml-auto tabular-nums shrink-0" style={{ color: "var(--money)" }} data-sensitive>
                    {fmtHero(d.total)}
                  </span>
                </div>
              ))}
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-3 mt-5 mb-2">
              Product mix · since {monthLabel(s.first_month)}
            </h3>
            <div className="space-y-1">
              {products.map(([name, p]) => (
                <div key={name} className="flex items-center gap-2 text-xs">
                  <span className="w-40 truncate text-ink-2">{name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(p.gross / productTotal) * 100}%`, background: "var(--money)" }} />
                  </div>
                  <span className="tabular-nums text-ink-3 w-16 text-right" data-sensitive>{fmtHero(p.gross)}</span>
                  <span className="tabular-nums text-ink-3 w-10 text-right">{p.deals}×</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2">
              Receivables{ar ? ` · as of ${shortDate(ar.report_date)}` : ""}
            </h3>
            {ar ? (
              <div className="space-y-1.5">
                {ar.rows.map((r, i) => (
                  <div key={i} className="flex items-baseline gap-2 text-sm">
                    <span className={`tabular-nums w-14 shrink-0 whitespace-nowrap ${r.overdue ? "font-semibold" : "text-ink-3"}`} style={r.overdue ? { color: "var(--creative)" } : undefined}>
                      {shortDate(r.due_date)}
                    </span>
                    <span className="truncate" data-sensitive>{r.sponsorship}</span>
                    {r.overdue && <Pill dim="creative">overdue</Pill>}
                    <span className="ml-auto tabular-nums shrink-0" data-sensitive>{fmtHero(r.net)}</span>
                  </div>
                ))}
                <div className="flex items-baseline gap-2 text-sm pt-2 border-t border-line-2">
                  <span className="text-ink-2">{ar.totals.count} open · gross <span data-sensitive>{fmtHero(ar.totals.gross)}</span> · commission <span data-sensitive>{fmtHero(ar.totals.commission)}</span></span>
                  <span className="ml-auto tabular-nums font-medium" style={{ color: "var(--money)" }} data-sensitive>{fmtHero(ar.totals.net)}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-3">No AR report on file.</p>
            )}
          </div>
        </div>
      </Panel>
    </section>
  );
}

function IncomeTab({ data }: { data: FinancesDataV2 }) {
  const income = data.income;
  const streams = income?.streams ?? data.incomeStreams ?? [];
  const incomeFreshness = data.freshness_per_card?.income ?? data.freshness;
  return (
    <div className="space-y-6">
      {income && <IncomeHero data={income} freshness={incomeFreshness} />}
      <OwedCard recovery={data.recovery} />
      {data.sponsorships && (
        <SponsorshipPanel data={data.sponsorships} freshness={data.freshness_per_card?.sponsorships} />
      )}
      {streams.length > 0 && (
        <section>
          <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2 mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" color="var(--money)" /> Income Streams
          </h2>
          <div className="prob-grid">
            {streams.map((s) => (
              <StreamCard key={s.label} stream={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function OutboundSubgroup({
  title,
  icon: Icon,
  lines,
}: {
  title: string;
  icon: LucideIcon;
  lines: ResolvedLine[];
}) {
  if (lines.length === 0) return null;
  const total = lines.reduce((s, l) => s + l.annual_usd, 0);
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
          <Icon className="w-4 h-4" color="var(--creative)" /> {title}
        </h3>
        <span className="text-xs tabular-nums text-ink-2" data-sensitive>
          {fmtHero(total / 12)}/mo · {fmtHero(total)}/yr
        </span>
      </div>
      <div className="prob-grid">
        {lines.map((l) => (
          <LineRow key={l.id} line={l} tone="outbound" />
        ))}
      </div>
    </section>
  );
}

function InsightLineRow({ line, accent }: { line: InsightLine; accent: string }) {
  // Honest cadence labels — only true monthly_recurring shows /yr projection prominently.
  // observed_one_month and one_time show "$X observed (1mo)" so the user sees what we actually saw.
  const isUncertain = line.cadence === "observed_one_month" || (line.cadence === "one_time" && line.charge_count >= 2);
  const cadenceLabel =
    line.lapsed || line.cadence === "lapsed"
      ? `LAPSED — last charge ${fmtDateParts(line.last_seen + "T12:00:00Z", { month: "short", year: "numeric" })}`
      : line.cadence === "monthly_recurring"
        ? `${line.charge_count}× over ${line.active_months}mo · monthly`
        : line.cadence === "annual_subscription"
          ? "annual subscription"
          : line.cadence === "observed_one_month"
            ? `${line.charge_count}× in 1mo · observed only`
            : "one-time";
  const showCurrent =
    !line.lapsed &&
    typeof line.current_monthly_usd === "number" &&
    line.current_monthly_usd > 0 &&
    line.monthly_usd > 0 &&
    Math.abs(line.current_monthly_usd - line.monthly_usd) / line.monthly_usd > 0.25;
  const confidenceColor =
    line.confidence === "high" ? "var(--health)" : line.confidence === "medium" ? "var(--money)" : "var(--ink-2)";
  return (
    <div
      className="bg-surface-2 border border-line-2 rounded-xl p-3.5 border-l-[3px]"
      style={{ borderLeftColor: accent }}
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium truncate">{line.display}</span>
        <span className="text-base font-medium tabular-nums" style={{ color: accent }} data-sensitive>
          {isUncertain ? fmtHero(line.observed_usd) : fmtHero(line.annual_usd)}
          <span className="text-[12px] text-ink-2 ml-1">{isUncertain ? "observed" : "/yr"}</span>
        </span>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-ink-2 flex-wrap mt-1">
        {!isUncertain && line.monthly_usd > 0 && (
          <>
            <span data-sensitive>{fmtHero(line.monthly_usd)}/mo avg</span>
            <span>·</span>
          </>
        )}
        {showCurrent && (
          <>
            <span data-sensitive style={{ color: (line.current_monthly_usd ?? 0) > line.monthly_usd ? "var(--err)" : "var(--health)" }}>
              now {fmtHero(line.current_monthly_usd)}/mo
            </span>
            <span>·</span>
          </>
        )}
        <span style={line.lapsed ? { color: "var(--money)", fontWeight: 500 } : undefined}>{cadenceLabel}</span>
        <span>·</span>
        <span style={{ color: confidenceColor }}>conf: {line.confidence}</span>
        {line.tags.length > 0 && (
          <>
            <span>·</span>
            <span>{line.tags.slice(0, 3).join(" / ")}</span>
          </>
        )}
      </div>
      {line.reason && (
        <p className="text-[12px] mt-1" style={{ color: "var(--err)" }}>{line.reason}</p>
      )}
    </div>
  );
}

function InsightSection({
  title,
  icon: Icon,
  accent,
  description,
  lines,
  emptyHint,
}: {
  title: string;
  icon: LucideIcon;
  accent: string;
  description?: string;
  lines: InsightLine[];
  emptyHint: string;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
            <Icon className="w-4 h-4" color={accent} /> {title}
          </h3>
          {description && <p className="text-[12px] text-ink-2 mt-1">{description}</p>}
        </div>
        {lines.length > 0 && (
          <span className="text-xs tabular-nums text-ink-2" data-sensitive>
            {fmtHero(lines.reduce((s, l) => s + l.annual_usd, 0))}/yr · {lines.length} item{lines.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {lines.length === 0 ? (
        <Panel className="p-4">
          <p className="text-xs text-ink-2">{emptyHint}</p>
        </Panel>
      ) : (
        <div className="prob-grid">
          {lines.map((l, i) => (
            <InsightLineRow key={`${l.display}-${i}`} line={l} accent={accent} />
          ))}
        </div>
      )}
    </section>
  );
}

function CategoryBreakdown({ categories, total }: { categories: SpendInsights["by_category"]; total: number }) {
  if (categories.length === 0) return null;
  const max = Math.max(...categories.map(c => c.annual_usd), 1);
  const CATEGORY_LABEL: Record<string, string> = {
    taxes: "Taxes", payroll: "Payroll / Contractors",
    ai: "AI", infrastructure: "Infrastructure", saas: "SaaS / Subscriptions",
    food: "Food", transportation: "Transportation", utilities: "Utilities",
    entertainment: "Entertainment", health: "Health", news: "News", shopping: "Shopping",
    travel: "Travel", "business-services": "Business Services", debt: "Debt", advertising: "Advertising",
    other: "Other",
  };
  return (
    <section>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
          <PieChart className="w-4 h-4" color="var(--relationships)" /> Spending By Category
        </h3>
        <span className="text-xs tabular-nums text-ink-2" data-sensitive>{fmtHero(total)}/yr total observed</span>
      </div>
      <Panel className="p-4">
        <div className="flex flex-col gap-2.5">
          {categories.map((c) => {
            const pct = total > 0 ? Math.round((c.annual_usd / total) * 100) : 0;
            const barPct = (c.annual_usd / max) * 100;
            return (
              <div key={c.category} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">{CATEGORY_LABEL[c.category] ?? c.category}</span>
                  <span className="tabular-nums text-ink-2" data-sensitive>
                    {fmtHero(c.annual_usd)}/yr · {c.merchants} {c.merchants === 1 ? "merchant" : "merchants"} · {pct}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-1)" }}>
                  <div
                    className="h-full"
                    style={{ width: `${barPct}%`, background: "var(--money)", opacity: 0.8 }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </section>
  );
}

function AiSpendSection({ ai }: { ai: AiSummary }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
            <Cpu className="w-4 h-4" color="var(--relationships)" /> AI Spend Breakdown
          </h3>
          <p className="text-[12px] text-ink-2 mt-1">
            Observed AI vendors, unattributed AI-labeled buckets, and ledger AI lines with no visible charge.
          </p>
        </div>
        <span className="text-lg font-medium tabular-nums" style={{ color: "var(--relationships)" }} data-sensitive>
          {fmtHero(ai.total_annualized)}<span className="text-[12px] text-ink-2 ml-1">/yr observed</span>
        </span>
      </div>
      {ai.observed.length === 0 ? (
        <Panel className="p-4"><p className="text-xs text-ink-2">No AI vendors observed yet — run the finance refresh.</p></Panel>
      ) : (
        <div className="prob-grid">
          {ai.observed.map((l, i) => (
            <InsightLineRow key={`${l.display}-${i}`} line={l} accent="var(--relationships)" />
          ))}
        </div>
      )}
      {ai.unattributed_buckets.length > 0 && (
        <div className="mt-3">
          <p className="text-[12px] text-ink-2 mb-2">
            AI-labeled buckets with no vendor recorded — needs a statement-level look:
          </p>
          <div className="prob-grid">
            {ai.unattributed_buckets.map((l, i) => (
              <InsightLineRow key={`${l.display}-${i}`} line={l} accent="var(--money)" />
            ))}
          </div>
        </div>
      )}
      {ai.ledger_blind_spots.length > 0 && (
        <Panel className="p-3.5 mt-3">
          <p className="text-[12px] text-ink-2 mb-2">
            In the expense ledger but never observed in any statement or books export (personal cards or bundled billing):
          </p>
          <div className="flex flex-wrap gap-2">
            {ai.ledger_blind_spots.map((b, i) => (
              <Pill key={`${b.vendor}-${i}`} dim="rhythms">
                {b.vendor}{b.monthly_usd ? <span data-sensitive>{` · $${Math.round(b.monthly_usd)}/mo`}</span> : " · $?"}
              </Pill>
            ))}
          </div>
        </Panel>
      )}
    </section>
  );
}

function SpendInsightsSection({ insights }: { insights: SpendInsights }) {
  return (
    <div className="space-y-6 pt-4" style={{ borderTop: "1px solid var(--line-1)" }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4" color="var(--money)" /> Spending Analysis
          </h2>
          <p className="text-[12px] text-ink-2 mt-1">
            Derived from statement CSVs in <code className="text-ink-1">FINANCES/Statements/*</code>.
            Re-run with <code className="text-ink-1">bun ~/.claude/LIFEOS/USER/FINANCES/Tools/StatementAnalyzer.ts</code>.
          </p>
        </div>
        {insights.statement_spend.generated_at && (
          <span className="text-[12px] text-ink-2">
            {insights.statement_spend.record_count} merchants · generated{" "}
            {fmtDateParts(insights.statement_spend.generated_at, {
              month: "short", day: "numeric", year: "numeric",
            })}
          </span>
        )}
      </div>

      <CategoryBreakdown categories={insights.by_category} total={insights.total_annualized} />

      <InsightSection
        title="Top Bills"
        icon={Trophy}
        accent="var(--money)"
        description="Highest annualized spend across all sources (transfers excluded)."
        lines={insights.top_bills}
        emptyHint="No statement aggregate yet — run StatementAnalyzer.ts to populate."
      />

      {insights.ai_summary ? (
        <AiSpendSection ai={insights.ai_summary} />
      ) : (
        <InsightSection
          title="Top AI Services"
          icon={Cpu}
          accent="var(--relationships)"
          description="What the AI stack actually costs — sorted by annualized spend."
          lines={insights.top_ai_services}
          emptyHint="No AI services detected yet. Drop more CSV exports under FINANCES/Statements/."
        />
      )}

      <InsightSection
        title="Top Infrastructure Services"
        icon={Server}
        accent="var(--freedom)"
        description="Cloud, hosting, dev, monitoring, networking."
        lines={insights.top_infrastructure_services}
        emptyHint="No infrastructure services detected yet."
      />

      <InsightSection
        title="Cut Candidates"
        icon={Scissors}
        accent="var(--creative)"
        description="Subscriptions flagged for review — single-use annuals, low-value recurring, overlapping tools."
        lines={insights.cut_candidates}
        emptyHint="No obvious cut candidates. Stack is lean (or analyzer needs more data)."
      />
    </div>
  );
}

function OutboundTab({ data }: { data: FinancesDataV2 }) {
  const outbound = data.outbound;
  const outboundFreshness = data.freshness_per_card?.outbound ?? data.freshness;
  if (!outbound) {
    return (
      <Panel>
        <p className="text-sm text-center text-ink-2">
          Expenses data unavailable. Check{" "}
          <code className="text-ink-1">
            ~/.claude/LIFEOS/USER/FINANCES/vendors.yaml
          </code>
          .
        </p>
      </Panel>
    );
  }
  return (
    <div className="space-y-6">
      {data.cfo?.breakdown && <BreakdownCard b={data.cfo.breakdown} notCounted={data.cfo.breakdown_not_counted_monthly ?? 0} />}
      {data.cfo && <CfoCard cfo={data.cfo} />}
      <OutboundHero data={outbound} freshness={outboundFreshness} />
      <OutboundSubgroup
        title="Vendors & Services"
        icon={Server}
        lines={outbound.vendors}
      />
      <OutboundSubgroup
        title="Personal Obligations"
        icon={Home}
        lines={outbound.obligations}
      />
      <OutboundSubgroup title="Other" icon={Receipt} lines={outbound.other} />
      {data.insights && <SpendInsightsSection insights={data.insights} />}
    </div>
  );
}

function OverallTab({
  data,
  periodView,
  onPeriodChange,
}: {
  data: FinancesDataV2;
  periodView: "monthly" | "annual";
  onPeriodChange: (v: "monthly" | "annual") => void;
}) {
  const overall = data.overall;
  const income = data.income;
  const outbound = data.outbound;
  if (!overall || !income || !outbound) {
    return (
      <Panel>
        <p className="text-sm text-center text-ink-2">Overall data unavailable.</p>
      </Panel>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <TabBar tabs={PERIOD_TABS} active={periodView} onChange={onPeriodChange} />
      </div>
      <OverallHero
        data={overall}
        periodView={periodView}
        freshness={data.freshness_per_card?.overall ?? data.freshness}
      />
      <FinancesSankey
        incomeStreams={income.streams}
        outbound={outbound}
        net={overall.net_pre_tax_annual}
      />
      <TrendChart trend={overall.trend} />
      {data.accounts && data.accounts.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2 flex items-center gap-2">
              <Landmark className="w-4 h-4" color="var(--money)" /> Accounts
            </h2>
            <FreshnessIndicator freshness={data.freshness_per_card?.accounts} />
          </div>
          <div className="prob-grid">
            {data.accounts.map((item, i) => (
              <AccountCategory key={i} item={item} />
            ))}
          </div>
        </section>
      )}
      <SectionGroup
        title="Investments"
        items={data.investments}
        icon={PiggyBank}
        freshness={data.freshness_per_card?.investments}
      />
      <SectionGroup title="Goals" items={data.goals} icon={Target} />
      <SectionGroup
        title="Taxes"
        items={data.taxes}
        icon={Receipt}
        freshness={data.freshness_per_card?.taxes}
      />
    </div>
  );
}

// ─── Plan tab (forward financial model + flywheel) ───

// Minimal inline-markdown renderer: **bold**, `- bullets`, pipe-tables, and
// paragraphs. Presentation only — every string comes from PLAN.md via the API.
function boldify(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="text-ink-1">{p.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

function PlanBody({ body }: { body: string }) {
  const lines = body.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("|")) {
      const tbl: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { tbl.push(lines[i].trim()); i++; }
      const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.replace(/\*\*/g, "").trim());
      const isSep = (l: string) => /^\|[\s|:-]+\|?$/.test(l);
      const rows = tbl.filter((l) => !isSep(l)).map(cells);
      if (rows.length) {
        const [head, ...rest] = rows;
        blocks.push(
          <div key={key++} className="overflow-x-auto my-2">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>{head.map((h, j) => (
                  <th key={j} className="text-left px-2 py-1.5 text-xs uppercase tracking-wide text-ink-2" style={{ borderBottom: "1px solid var(--line-1)" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>{rest.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (
                  <td key={ci} className="px-2 py-1.5" style={{ color: ci === 0 ? "var(--ink-1)" : "var(--ink-2)", borderBottom: "1px solid var(--line-1)" }}>{c}</td>
                ))}</tr>
              ))}</tbody>
            </table>
          </div>
        );
      }
      continue;
    }
    if (line.trim().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) { items.push(lines[i].trim().slice(2)); i++; }
      blocks.push(
        <ul key={key++} className="list-disc pl-5 space-y-1 my-2 text-ink-2">
          {items.map((it, j) => <li key={j}>{boldify(it)}</li>)}
        </ul>
      );
      continue;
    }
    if (line.trim()) {
      blocks.push(<p key={key++} className="my-2 text-ink-2">{boldify(line.trim())}</p>);
    }
    i++;
  }
  return <>{blocks}</>;
}

function FlywheelLoop({ stages }: { stages: { n: number; stage: string; text: string }[] }) {
  if (!stages.length) return null;
  // Distinct per-stage loop colors (chart-style scale, not semantic tokens).
  const palette = ["#4F8CFF", "#3FB68B", "#E0A458", "#B98CFF", "#4FC3E0", "#F2789F"];
  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4" color="var(--accent-blue)" />
        <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2">The Flywheel</h2>
        <span className="text-[12px] text-ink-2 ml-1">↻ each turn spins the next</span>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {stages.map((s, i) => {
          const color = palette[i % palette.length];
          return (
            <div
              key={s.n}
              className="bg-surface-2 border border-line-2 rounded-xl p-5 border-t-[3px]"
              style={{ borderTopColor: color }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold"
                  style={{ background: color, color: "var(--ground)" }}>{s.n}</span>
                <span className="font-medium text-ink-1">{s.stage}</span>
                <span className="ml-auto text-lg" style={{ color, opacity: 0.7 }}>
                  {i === stages.length - 1 ? "↻" : "→"}
                </span>
              </div>
              <p className="text-sm text-ink-2">{s.text}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PlanTab({ data }: { data: FinancesDataV2 }) {
  const plan = data.plan;
  if (!plan || !plan.present) {
    return (
      <Panel>
        <p className="text-sm text-center text-ink-2">
          No plan yet. Create <code>USER/FINANCES/PLAN.md</code> — the flywheel, targets, and product ladder render here.
        </p>
      </Panel>
    );
  }
  const special = /^(flywheel|targets)$/i;
  const about = plan.sections.find((s) => /^about/i.test(s.heading));
  const rest = plan.sections.filter((s) => !special.test(s.heading) && !/^about/i.test(s.heading));
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <FreshnessIndicator freshness={data.freshness_per_card?.plan} />
      </div>

      {about && (
        <Panel className="border-l-[3px] [border-left-color:var(--money)]">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4" color="var(--money)" />
            <span className="text-xs uppercase tracking-widest text-ink-2">{about.heading}</span>
          </div>
          <PlanBody body={about.body} />
        </Panel>
      )}

      <FlywheelLoop stages={plan.flywheel} />

      {plan.targets && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Target className="w-4 h-4" color="var(--health)" />
            <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2">Targets</h2>
          </div>
          <Panel className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>{plan.targets.headers.map((h, j) => (
                  <th key={j} className="text-left px-2 py-2 text-xs uppercase tracking-wide text-ink-2" style={{ borderBottom: "1px solid var(--line-1)" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>{plan.targets.rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (
                  <td key={ci} className="px-2 py-2" style={{ color: ci === 0 ? "var(--ink-1)" : "var(--ink-2)", borderBottom: "1px solid var(--line-1)" }}>{c}</td>
                ))}</tr>
              ))}</tbody>
            </table>
          </Panel>
        </section>
      )}

      {rest.map((s, i) => (
        <section key={i}>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4" color="var(--relationships)" />
            <h2 className="text-sm font-medium uppercase tracking-widest text-ink-2">{s.heading}</h2>
          </div>
          <Panel>
            <PlanBody body={s.body} />
          </Panel>
        </section>
      ))}
    </div>
  );
}

// ─── Page ───

export default function FinancesPage() {
  const { data = null, error: queryError } = useApi<FinancesDataV2>("/api/life/finances", { retry: false });
  const error = !data && queryError ? (queryError instanceof ApiError ? `Error: HTTP ${queryError.status}` : String(queryError)) : null;
  const [tab, setTab] = useState<TabKey>("income");
  const [periodView, setPeriodView] = useState<"monthly" | "annual">("monthly");

  // Module-level currency must be set before children render with the data.
  if (data) setCurrency(data.currency);

  // Hash-routed tab state
  useEffect(() => {
    if (typeof window === "undefined") return;
    const valid = (k: string): k is TabKey =>
      k === "income" || k === "outbound" || k === "overall" || k === "plan";
    const hash = window.location.hash.replace("#", "");
    if (valid(hash)) setTab(hash);
    const onHashChange = () => {
      const h = window.location.hash.replace("#", "");
      if (valid(h)) setTab(h);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Keyboard 1/2/3 cycles tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") changeTab("income");
      else if (e.key === "2") changeTab("outbound");
      else if (e.key === "3") changeTab("overall");
      else if (e.key === "4") changeTab("plan");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeTab = (k: TabKey) => {
    setTab(k);
    if (typeof window !== "undefined") window.location.hash = k;
  };

  if (error) {
    return (
      <PageShell>
        <Panel className="border-l-[3px] [border-left-color:var(--err)]">
          <h2 className="font-medium text-err">Failed to load finances</h2>
          <p className="text-sm text-err">{error}</p>
        </Panel>
      </PageShell>
    );
  }
  if (!data) return <div className="p-8 text-sm text-ink-2">Loading Finances...</div>;

  const incomeAnnual = data.income?.annual ?? data.annualIncome ?? 0;
  const outboundAnnual = data.outbound?.annual ?? data.annualExpenses ?? 0;
  const incomeStreams = data.income?.streams ?? data.incomeStreams ?? [];
  const isFreshInstall =
    incomeAnnual === 0 &&
    outboundAnnual === 0 &&
    incomeStreams.length === 0 &&
    (!data.accounts || data.accounts.length === 0);

  return (
    <PageShell>
      <PageHeader
        icon={DollarSign}
        title="Finances"
        subtitle="Income · Expenses · Overall · Flywheel · Press 1/2/3/4 to switch tabs"
      />
      <TabBar tabs={TABS} active={tab} onChange={changeTab} />

      {isFreshInstall && (
        <EmptyStateGuide
          section="Finances"
          description="Accounts, transactions, P&L, and revenue tracked over time."
          userDir="FINANCES"
          daPromptExample="help me wire up my financial data"
        />
      )}

      {tab === "income" && <IncomeTab data={data} />}
      {tab === "outbound" && <OutboundTab data={data} />}
      {tab === "overall" && (
        <OverallTab data={data} periodView={periodView} onPeriodChange={setPeriodView} />
      )}
      {tab === "plan" && <PlanTab data={data} />}
    </PageShell>
  );
}
