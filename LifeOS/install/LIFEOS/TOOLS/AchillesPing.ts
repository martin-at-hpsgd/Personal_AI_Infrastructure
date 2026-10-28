#!/usr/bin/env bun
import { PRIVATE_SKILL_NAMES } from "./CodeDataBoundary.ts";
/**
 * AchillesPing — the daily remediation ask.
 *
 * Reads the Achilles vulnerability registry; when any critical or high entry
 * is OPEN (or in_progress), emails the principal the list and asks whether to
 * run the remediation work. Silent when nothing is open — no email, no voice,
 * no output beyond the log line. Scheduled headless by the `achilles-ping`
 * workflow (LIFEOS_NOTIFICATION_CHANNEL=headless; scheduled jobs never
 * voice-notify).
 *
 * IDENTITY: the recipient is resolved at runtime from the authenticated Gmail
 * account (`gmail.ts profile`), never hardcoded — this file ships publicly.
 * Override with ACHILLES_EMAIL_TO.
 *
 *   bun AchillesPing.ts [--dry-run]
 *
 * Doctrine: LIFEOS/ACHILLES/ISA.md (maintainer-side state of record, not in the release) (ISC-9, ISC-24). Since 2026-09-15 the ping
 * reads by FIX CLASS: what closed itself (auto), which worker patches are ready
 * to land (agent — install patches land themselves since 2026-10-03; a project
 * patch waits for "y ACH-NNNN"), what needs the principal (human), and every
 * escalation whose text has not been delivered (ISC-51). Medium and low escalations and y asks are never
 * texted: this email is their only channel, so it lists them (ISC-93), and a SENT email marks each one it
 * listed delivered in the remediation state (ISC-99); a --dry-run never does.
 * Achilles never deploys on its own; the ask is the deploy, not the fix.
 */
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderEmail, cardBlock, esc, T } from "./EmailTemplate.ts";
import { getDAName } from "../../hooks/lib/identity";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const CLAUDE = getClaudeDir();
// The mail tool; ACHILLES_GMAIL_TOOL points a test at a stand-in so the sent path runs without mailing anyone.
const GMAIL = process.env.ACHILLES_GMAIL_TOOL || join(CLAUDE, "LIFEOS/TOOLS/gmail.ts");
const dryRun = process.argv.includes("--dry-run");

type PingEntry = { id: string; title: string; severity: string; status: string; category?: string; work_issue?: number; ul_issue?: number; first_seen: string; closed_at?: string; fix_class?: string; risk_ref?: string; evidence: string[] };
const { loadRegistry, loadRiskMap, isRatified } = (await import(join(CLAUDE, "LIFEOS/TOOLS/Achilles.ts"))) as {
  loadRegistry: (path?: string) => { entries: PingEntry[] };
  loadRiskMap: (path?: string) => { ratified_by?: string; ratified_at?: string; rules: unknown[] } | null;
  isRatified: (m: unknown) => boolean;
};
type PingRecord = { id: string; kind: string; reason: string; at: string; delivered: boolean; event?: string; decision?: string; dropped?: string; via?: "ping" };
type PingAttempt = { outcome: string; patch?: string; note?: string; at: string };
type PingState = { attempts: Record<string, PingAttempt[]>; escalations?: PingRecord[] };
const { loadState, saveState, takeLock, openCloseAsk } = (await import(join(CLAUDE, "LIFEOS/TOOLS/AchillesRemediate.ts"))) as {
  openCloseAsk: (a: PingAttempt | undefined, now: number) => boolean;
  loadState: (path?: string) => PingState;
  saveState: (st: PingState, path?: string) => void;
  takeLock: (lockPath: string, now?: number) => (() => void) | null;
};
// Scratch paths for tests and replays; unset means the live registry and state.
const REGISTRY_PATH = process.env.ACHILLES_REGISTRY_PATH || undefined;
const STATE_PATH = process.env.ACHILLES_REMEDIATION_STATE || undefined;

const all = loadRegistry(REGISTRY_PATH).entries;
const open = all.filter((e) => (e.status === "open" || e.status === "in_progress") && (e.severity === "critical" || e.severity === "high"));
const DAY = 86_400_000;
// Orphans (ISA ISC-27): open entries with no risk above them. Listed only once the risk map is ratified, so the
// first backfill decides the flood, not this email.
const UNMAPPED_SHOWN = 20;
const unmapped = isRatified(loadRiskMap(process.env.ACHILLES_RISK_MAP_PATH || undefined)) ? all.filter((e) => (e.status === "open" || e.status === "in_progress") && e.category === "technical" && !e.risk_ref) : [];
const autoClosed = all.filter((e) => e.fix_class === "auto" && e.closed_at && Date.now() - Date.parse(e.closed_at) < DAY);
const remState = loadState(STATE_PATH);
const attempts = remState.attempts;
const byId = new Map(all.map((e) => [e.id, e] as const));
// ISC-51: every escalation or y ask whose text has not been delivered (overflow, a failed send, a held send).
// An entry that closed first has nothing left to tell: it is neither listed nor a reason to send the email. The open
// state of the entry decides, not the loop's `dropped` mark: a dropped record whose entry is open again goes back in the
// loop's queue on its next pass, so the ping lists it now rather than disagreeing with the loop for one pass.
const stillOpen = (id: string) => { const e = byId.get(id); return !!e && (e.status === "open" || e.status === "in_progress"); };
const undeliveredAll = (remState.escalations ?? []).filter((r) => !r.delivered && stillOpen(r.id));
// ISC-86/93: a medium or low entry's escalation or y ask never texts; this email is where the principal sees it.
const textable = (id: string) => { const s = byId.get(id)?.severity; return s === "critical" || s === "high"; };
const undelivered = undeliveredAll.filter((r) => textable(r.id));
const lastAttempt = (id: string) => (attempts[id] ?? []).slice(-1)[0];
// ISC-93: a delivered medium or low ask is still listed every morning while it waits on the principal; "delivered" (ISC-99)
// means it reached him once, never that he answered. It stops waiting when he answers or the loop withdraws it:
// a close ask until its attempt is answered or seven days pass (ISC-98), a patch y ask while that patch is still the
// entry's last unapplied attempt, an escalation while the entry stays human class (handing it back sets agent).
const NOW = Date.now();
const waitingOnPrincipal = (r: PingRecord): boolean => {
  const a = lastAttempt(r.id);
  if (r.kind === "y_ask" && r.reason === "already_fixed") return openCloseAsk(a, NOW);
  if (r.kind === "y_ask") return a?.outcome === "patch" && !a.note?.startsWith("applied ") && Date.parse(r.at) >= Date.parse(a.at);
  return byId.get(r.id)?.fix_class === "human";
};
const emailOnly = (remState.escalations ?? []).filter((r) => !textable(r.id) && stillOpen(r.id) && (!r.delivered || waitingOnPrincipal(r)));
// A patch the lander refused for good (a reviewer blocker, a gate path) escalated its entry to human: it is never "ready to land".
const ready = open.filter((e) => lastAttempt(e.id)?.outcome === "patch" && e.fix_class !== "human");
const agentPending = open.filter((e) => e.fix_class === "agent" && lastAttempt(e.id)?.outcome !== "patch");
const human = open.filter((e) => e.fix_class === "human" || !e.fix_class);

if (open.length === 0 && autoClosed.length === 0 && undelivered.length === 0 && emailOnly.length === 0 && unmapped.length === 0) {
  console.log(`[achilles-ping] nothing open — silent (${new Date().toISOString()})`);
  process.exit(0);
}

function recipient(): string {
  if (process.env.ACHILLES_EMAIL_TO) return process.env.ACHILLES_EMAIL_TO;
  const r = Bun.spawnSync([process.execPath, GMAIL, "profile"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LIFEOS_SKILL: PRIVATE_SKILL_NAMES.communication } });
  const addr = r.stdout.toString().match(/"emailAddress"\s*:\s*"([^"]+)"/)?.[1];
  if (!addr) { console.error("[achilles-ping] cannot resolve recipient (gmail profile failed)"); process.exit(1); }
  return addr;
}

const sevAccent = (s: string) => (s === "critical" ? T.red : T.amber);
const card = (e: PingEntry, accent: string, line: string) =>
  cardBlock(
    `<div style="font:600 13px/1 ${T.mono};color:${accent};letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">${esc(e.id)} · ${esc(e.severity)}${(e.work_issue ?? e.ul_issue) ? ` · issue #${e.work_issue ?? e.ul_issue}` : ""}</div>
     <div style="color:${T.text};font-weight:600">${esc(e.title)}</div>
     <div style="color:${T.dim};font-size:14px;margin-top:4px">${esc(line)}</div>`,
    { accent },
  );
const section = (label: string, count: number, inner: string) =>
  inner ? `<div style="font:600 14px/1 ${T.mono};color:${T.dim};letter-spacing:.08em;text-transform:uppercase;margin:18px 0 8px">${esc(label)} · ${count}</div>${inner}` : "";
const last = (id: string) => lastAttempt(id);
const bodyHtml = renderEmail({
  system: "Achilles",
  badge: `${ready.length} READY · ${human.length} NEED YOU`,
  accent: open.some((e) => e.severity === "critical") ? T.red : T.amber,
  title: ready.length ? `${ready.length} fix${ready.length === 1 ? "" : "es"} ready to land` : open.length ? "Open weaknesses" : "Closed itself overnight",
  subtitle: `${open.length} open critical/high · ${ready.length} patched by a worker · ${agentPending.length} queued for the nightly worker · ${human.length} need you`,
  bodyHtml: [
    section("Not yet texted — waiting for delivery", undelivered.length, undelivered.map((r) => { const e = byId.get(r.id) ?? { id: r.id, title: "(not in the registry)", severity: "?", status: "?", first_seen: "", evidence: [] }; return card(e, T.amber, `${r.kind === "y_ask" ? "y ask" : "escalation"} (${r.reason}) · ${r.event ? `text ${r.decision ?? "awaiting delivery"}` : r.decision ? `last text ${r.decision}; resent next pass` : "waiting for the next pass text"} · reply y ${r.id}`); }).join("")),
    section("Waiting on you — email only, never texted", emailOnly.length, emailOnly.map((r) => { const e = byId.get(r.id)!; return card(e, sevAccent(e.severity), `${r.kind === "y_ask" ? "y ask" : "escalation"} (${r.reason})${r.delivered ? ` · still waiting, asked ${r.at.slice(0, 10)}` : ""} · reply y ${r.id}`); }).join("")),
    section("Ready to land — say “apply them”", ready.length, ready.map((e) => card(e, T.green, `patch ready: ${last(e.id)?.patch?.split("/").pop() ?? ""} · achilles apply ${e.id}`)).join("")),
    section("Needs you", human.length, human.map((e) => card(e, sevAccent(e.severity), `open since ${e.first_seen.slice(0, 10)} · ${e.evidence.slice(-1)[0] ?? "no evidence yet"}`)).join("")),
    section("Queued for the nightly worker", agentPending.length, agentPending.map((e) => card(e, T.dim, `open since ${e.first_seen.slice(0, 10)}${last(e.id) ? ` · last attempt ${last(e.id)!.outcome}${last(e.id)!.note ? `: ${last(e.id)!.note}` : ""}` : ""}`)).join("")),
    section("Closed itself (last 24h)", autoClosed.length, autoClosed.map((e) => card(e, T.dim, e.evidence.slice(-1)[0] ?? "")).join("")),
    section("Unmapped — no risk above it", unmapped.length, unmapped.slice(0, UNMAPPED_SHOWN).map((e) => card(e, T.dim, `no risk_ref · link it: achilles update ${e.id} --risk-ref R-NNN`)).join("") + (unmapped.length > UNMAPPED_SHOWN ? cardBlock(`<div style="color:${T.dim}">+${unmapped.length - UNMAPPED_SHOWN} more · achilles unmapped</div>`, { accent: T.dim }) : "")),
  ].join(""),
  note: `LifeOS-install patches land on main by themselves once their tests and an independent review pass. Project patches wait for one word to ${getDAName()} ("y ACH-NNNN"): each is applied on main only after it re-applies cleanly and the repo's tests pass, then the repo's own gated deploy ships it. "Needs you" items are decisions, credentials, or dashboards only you can reach. Achilles never deploys on its own.`,
  cta: { label: "Open the Achilles board", url: "http://localhost:31337/achilles" },
});

if (dryRun) { console.log(bodyHtml); process.exit(0); }

const to = recipient();
// A private, owner-only temp file: the body lists open vulnerabilities (round-19 audit).
const tmpDir = mkdtempSync(join(tmpdir(), "achilles-ping-"));
const tmp = join(tmpDir, "body.html");
writeFileSync(tmp, bodyHtml, { mode: 0o600 });
const p = Bun.spawnSync(
  [process.execPath, GMAIL, "send", "--to", to, "--subject", ready.length ? `[Achilles] ${ready.length} fix${ready.length === 1 ? "" : "es"} ready to land · ${human.length} need you` : `[Achilles] ${open.length} open critical/high · ${human.length} need you`, "--body-file", tmp, "--html"],
  { stdout: "pipe", stderr: "pipe", env: { ...process.env, LIFEOS_SKILL: PRIVATE_SKILL_NAMES.communication } },
);
try { unlinkSync(tmp); rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
if (p.exitCode !== 0) { console.error(`[achilles-ping] email failed: ${p.stderr.toString().slice(0, 200)}`); process.exit(1); }
// ISC-99: the email reached him, so every medium or low ask it listed is delivered. Written under the remediation lock;
// when a pass holds it, nothing is marked and the next sent ping lists them again (a repeat, never a loss).
let marked = 0;
if (emailOnly.length) {
  const statePath = STATE_PATH ?? join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/remediation.json");
  const release = takeLock(`${statePath}.lock`);
  if (!release) console.error("[achilles-ping] remediation pass holds the lock; the listed asks stay undelivered until the next ping");
  else try {
    const st = loadState(STATE_PATH);
    const sentAt = new Date().toISOString();
    for (const r of st.escalations ?? []) {
      if (r.delivered || !emailOnly.some((x) => x.id === r.id && x.kind === r.kind && x.at === r.at)) continue;
      r.delivered = true; r.via = "ping"; r.decision = `listed in the morning ping ${sentAt}`; delete r.dropped;
      marked++;
    }
    if (marked) saveState(st, STATE_PATH);
  } finally { release(); }
}
console.log(`[achilles-ping] emailed: ${open.length} open critical/high · ${ready.length} ready · ${human.length} need you · ${autoClosed.length} auto-closed · ${marked} email-only asks delivered`);
