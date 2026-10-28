"use client";
/**
 * "Owed to you" card for Pulse /finances. Renders the output of `Recover.ts summary --json`.
 *
 * Everything here is React text with no raw-HTML sink. Titles come from sender-controlled
 * mail and state records, so they are drawn as text children (escaped by React) and stay inside data-sensitive
 * so Observer mode blurs them. The summary has no claim URLs, mailboxes or ids by contract, so rows carry none.
 */
import {
  Clock,
  Gavel,
  Landmark,
  Plane,
  Receipt,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Panel, Pill } from "@/components/ui/chrome";

// ─── Types: the Recover.ts summary --json contract (version 1) ───

export type OwedAmount =
  | { type: "exact"; value: number; currency: string }
  | { type: "range"; min: number; max: number | null; currency: string }
  | { type: "unknown" };

export interface OwedRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  amount: OwedAmount;
  deadline: string | null;
  days_left: number | null;
  evidence: { kind: "email" | "state-record"; date: string | null; count: number; state: string | null };
  prepared: "gmail-draft" | "web-form" | null;
  claim_link: boolean;
  blocked: boolean;
}

export interface OwedCurrencyTotals {
  exact: number;
  exact_count: number;
  range_min: number;
  range_max: number | null;
  range_count: number;
}

export interface OwedSummaryData {
  version: 1;
  generated_at: string;
  last_run: { at: string; scope: string; outcome: string } | null;
  last_full_run: { at: string; outcome: string } | null;
  totals: {
    by_currency: Record<string, OwedCurrencyTotals>;
    unknown_count: number;
    open_count: number;
    owed_count: number;
    to_verify_count: number;
    untrusted_count: number;
    expired_count: number;
  };
  nearest_deadline: { date: string; days_left: number; kind: string; status: string } | null;
  deadlines_within_window: number;
  states: { state: string; status: string; at: string | null }[];
  states_complete: boolean;
  top: OwedRow[];
  more: number;
}

// ─── Formatting ───

/** Whole units when the amount is whole ($412), cents otherwise ($412.50). The currency code picks the symbol. */
export function fmtMoney(value: number, currency: string): string {
  const whole = Number.isInteger(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(whole ? 0 : 2)}`;
  }
}

export function fmtAmount(a: OwedAmount): string {
  if (a.type === "exact") return `${fmtMoney(a.value, a.currency)} exact`;
  if (a.type === "range") {
    return a.max === null ? `${fmtMoney(a.min, a.currency)}+` : `${fmtMoney(a.min, a.currency)}–${fmtMoney(a.max, a.currency)}`;
  }
  return "amount unknown";
}

/** "$412 exact + $50–$300 range + 2 unknown", one segment group per currency. */
export function totalsLine(t: OwedSummaryData["totals"]): string {
  const perCurrency = Object.entries(t.by_currency).map(([cur, c]) => {
    const parts: string[] = [];
    if (c.exact_count > 0) parts.push(`${fmtMoney(c.exact, cur)} exact`);
    if (c.range_count > 0) {
      parts.push(
        `${c.range_max === null ? `${fmtMoney(c.range_min, cur)}+` : `${fmtMoney(c.range_min, cur)}–${fmtMoney(c.range_max, cur)}`} range`,
      );
    }
    return parts.join(" + ");
  }).filter(Boolean);
  const unknown = t.unknown_count > 0 ? [`${t.unknown_count} unknown`] : [];
  const all = [...perCurrency, ...unknown];
  return all.length > 0 ? all.join(" + ") : "Nothing priced yet";
}

/** Short month-day for a YYYY-MM-DD date, in the mock's style ("11-16"). */
function monthDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(5) : iso;
}

const KIND_ICON: Record<string, LucideIcon> = {
  "unclaimed-property": Landmark,
  flight: Plane,
  refund: Receipt,
  settlement: Gavel,
  insurance: ShieldCheck,
};

const KIND_LABEL: Record<string, string> = {
  "unclaimed-property": "Unclaimed",
  flight: "Flight",
  refund: "Refund",
  settlement: "Settlement",
  insurance: "Insurance",
};

const DEADLINE_WINDOW_DAYS = 14;
// The card shows the first rows of the summary's list; the rest fold into "… N more" so the card stays short on a phone.
const CARD_ROWS = 5;

/** The kind label, unless the title already names the kind in its first words ("Unclaimed property held…", "Cancelled flight…"). */
function kindPrefix(kind: string, title: string): string | null {
  const label = KIND_LABEL[kind] ?? kind;
  const head = title.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
  return head.includes(label.toLowerCase()) ? null : label;
}

function statusPhrase(r: OwedRow): string {
  if (r.status === "filed") return "claim filed";
  if (r.status === "likely") return "likely, verify";
  if (r.status === "possible") return "possible, verify";
  // The title carries the reason (new sender, forwarded, off-domain claim site); every verify row needs the same act.
  if (r.status === "verify") return "verify sender first";
  if (r.prepared === "gmail-draft") return "Gmail draft ready";
  if (r.prepared === "web-form") return "claim drafted";
  if (r.blocked) return "claim blocked";
  return "no claim yet";
}

function evidencePhrase(r: OwedRow): string {
  if (r.evidence.kind === "email") {
    const n = r.evidence.count;
    const what = n > 1 ? `${n} emails` : "email";
    return `evidence: ${what}${r.evidence.date ? ` ${r.evidence.date}` : ""}`;
  }
  return r.claim_link ? "claim link" : `state record${r.evidence.state ? ` · ${r.evidence.state}` : ""}`;
}

const STATE_MARK: Record<string, { mark: string; color: string; word: string }> = {
  searched: { mark: "✓", color: "var(--ok)", word: "searched" },
  "human-step": { mark: "✋", color: "var(--warn)", word: "needs a human step" },
  blocked: { mark: "⚠", color: "var(--warn)", word: "blocked" },
  failed: { mark: "✗", color: "var(--err)", word: "failed" },
  "not-run": { mark: "–", color: "var(--ink-3)", word: "not run yet" },
};

// ─── Rows ───

function OwedRowView({ row }: { row: OwedRow }) {
  const soon = row.days_left !== null && row.days_left <= DEADLINE_WINDOW_DAYS;
  const Icon = soon ? Clock : (KIND_ICON[row.kind] ?? Receipt);
  const iconColor = soon ? "var(--warn)" : "var(--money)";
  const unknownAmount = row.amount.type === "unknown";
  const right = unknownAmount && row.deadline ? `until ${monthDay(row.deadline)}` : fmtAmount(row.amount);
  const alsoDeadline = !unknownAmount && row.deadline ? ` · until ${monthDay(row.deadline)}` : "";
  const kindLabel = kindPrefix(row.kind, row.title);
  return (
    <div className="flex items-start gap-3 py-2 border-b border-line-2 last:border-b-0" data-testid="owed-row" data-finding-status={row.status}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" color={iconColor} aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium line-clamp-2 min-w-0" data-sensitive>
            {kindLabel && <span className="text-ink-2">{kindLabel} · </span>}
            {row.title}
          </span>
          <span
            className="ml-auto text-sm tabular-nums shrink-0 whitespace-nowrap"
            style={{ color: soon && unknownAmount ? "var(--warn)" : "var(--money)" }}
            data-sensitive
          >
            {right}
          </span>
        </div>
        <div className="text-[12px] text-ink-2 mt-0.5">
          {statusPhrase(row)} · {evidencePhrase(row)}
          {alsoDeadline}
        </div>
      </div>
    </div>
  );
}

// ─── Card ───

/**
 * `recovery` is what /api/life/finances sends: the summary, null when the tool failed, undefined when it is
 * not installed (the page does not render the card at all then).
 */
export function OwedCard({ recovery }: { recovery: OwedSummaryData | null | undefined }) {
  if (recovery === undefined) return null;

  if (recovery === null) {
    return (
      <Panel className="border-l-[3px] [border-left-color:var(--warn)]" >
        <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">Owed to you</span>
        <p className="text-sm text-ink-2 mt-2" data-testid="owed-unavailable">
          Recovery summary unavailable. Run the recovery summary in the CFO skill to see why.
        </p>
      </Panel>
    );
  }

  const run = recovery.last_run;
  if (!run) {
    return (
      <Panel className="border-l-[3px] [border-left-color:var(--money)]">
        <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2">Owed to you</span>
        <p className="text-sm text-ink-2 mt-2" data-testid="owed-empty">
          First run pending. The monthly recovery sweep fills this card with unclaimed property, refunds, compensation and settlements, each with its claim drafted.
        </p>
      </Panel>
    );
  }

  const t = recovery.totals;
  const near = recovery.nearest_deadline;
  const inWindow = recovery.deadlines_within_window;
  const runDate = run.at.slice(0, 10);
  const full = recovery.last_full_run;
  const degraded = run.outcome !== "complete";

  // open_count counts every listed finding, the ones to verify included; show those apart.
  const countsBits: string[] = [`${t.open_count - t.to_verify_count} open`];
  if (t.to_verify_count > 0) countsBits.push(`${t.to_verify_count} to verify`);
  const deadlineBit =
    inWindow > 0 && near
      ? `${inWindow} deadline${inWindow === 1 ? "" : "s"} within ${DEADLINE_WINDOW_DAYS} days, nearest in ${near.days_left} day${near.days_left === 1 ? "" : "s"}`
      : near
        ? `next deadline in ${near.days_left} days`
        : null;

  return (
    <Panel className="border-l-[3px] [border-left-color:var(--money)]">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[13px] font-medium uppercase tracking-wider text-ink-2 whitespace-nowrap">Owed to you</span>
        {degraded && <Pill dim="creative" title="The last run did not finish every leg">{run.outcome}</Pill>}
        <span className="ml-auto text-[12px] text-ink-2 tabular-nums whitespace-nowrap shrink-0" data-testid="owed-run">
          run {runDate}
          {run.scope === "inbox-only" && full ? ` · full run ${full.at.slice(0, 10)}` : ""}
        </span>
      </div>

      <div className="mt-1 text-2xl font-medium tabular-nums" style={{ color: "var(--money)", letterSpacing: "-0.01em" }} data-sensitive data-testid="owed-totals">
        {totalsLine(t)}
      </div>

      {/* Plain inline text, not a flex row: it wraps by words and cannot overlap at phone width. */}
      <div className="mt-1 text-sm text-ink-2 leading-relaxed" data-testid="owed-counts">
        {countsBits.join(" · ")}
        {deadlineBit && (
          <>
            {" · "}
            <span style={inWindow > 0 ? { color: "var(--warn)", fontWeight: 500 } : undefined}>{deadlineBit}</span>
          </>
        )}
        {recovery.states.length > 0 && (
          <>
            {" · "}
            <span data-testid="owed-states">
              {recovery.states.map((s) => {
                const m = STATE_MARK[s.status] ?? STATE_MARK["not-run"];
                return (
                  <span key={s.state} className="mr-2 whitespace-nowrap" title={`${s.state}: ${m.word}`}>
                    <span data-sensitive>{s.state}</span>{" "}
                    <span style={{ color: m.color }}>{m.mark}</span>
                  </span>
                );
              })}
            </span>
          </>
        )}
        {!recovery.states_complete && recovery.states.length > 0 && (
          <span className="text-[12px]" style={{ color: "var(--warn)" }}>search incomplete</span>
        )}
      </div>

      <div className="mt-3 border-t border-line-2">
        {recovery.top.length === 0 ? (
          <p className="text-sm text-ink-2 pt-3" data-testid="owed-none">Nothing owed right now. The next run checks again.</p>
        ) : (
          recovery.top.slice(0, CARD_ROWS).map((r) => <OwedRowView key={r.id} row={r} />)
        )}
      </div>

      {recovery.more + Math.max(0, recovery.top.length - CARD_ROWS) > 0 && (
        <div className="text-[12px] text-ink-2 pt-2" data-testid="owed-more">… {recovery.more + Math.max(0, recovery.top.length - CARD_ROWS)} more</div>
      )}
      {(t.untrusted_count > 0 || t.expired_count > 0) && (
        <div className="text-[12px] text-ink-3 pt-2" data-testid="owed-footnote">
          {[
            t.untrusted_count > 0 ? `${t.untrusted_count} flagged untrusted, nothing drafted` : null,
            t.expired_count > 0 ? `${t.expired_count} past their deadline` : null,
          ].filter(Boolean).join(" · ")}
        </div>
      )}
    </Panel>
  );
}
