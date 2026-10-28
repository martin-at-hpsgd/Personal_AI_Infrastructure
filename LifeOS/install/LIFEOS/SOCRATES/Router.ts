import { PRIVATE_SKILL_NAMES } from "../TOOLS/CodeDataBoundary.ts";
/**
 * Socrates Router — the v1 action slice: a finding that persists becomes an
 * Achilles entry, a work-repo ticket, and (security domain only) an email.
 *
 * Doctrine (SocratesDesign.md v2 § phasing, v1): propose-default — the router
 * REGISTERS and ASKS, it never remediates. Achilles stays the registry of
 * record and owns the ticket lifecycle (its `close` closes the issue in the
 * same motion); this file only feeds it and reports back into the findings
 * journal. `unknown` never routes: an error is not a weakness, it is the
 * board's job to show it loudly.
 *
 * Flap guard (one flapping monitor once opened a finding many times a day): a finding routes only
 * after it has failed ROUTE_AFTER[cadence] consecutive ticks, never more than
 * MAX_ROUTES_PER_TICK per tick, and the same (question, instance) is not sent
 * out again within REROUTE_COOLDOWN_MS of its last routing.
 *
 * Re-entrant ordering (amber achilles-leg pattern): Achilles entry first
 * (durable intent, source_ref idempotent), then the ticket (gh marker search
 * before create), then the journal, then the email. A crash between steps is
 * picked up by the next tick, never duplicated.
 *
 * The close leg: a routed finding that later resolves on a same-question pass
 * tells Achilles the condition CLEARED (evidence says so honestly — a pass
 * proves the condition is gone, not that anyone remediated it).
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRouted, type Store, type FindingRecord, type Routed } from "./Store";
import type { Question } from "./Registry";
import { renderEmail, esc, T } from "../TOOLS/EmailTemplate.ts";

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const ACHILLES = join(CLAUDE, "LIFEOS/TOOLS/Achilles.ts");
const GMAIL = join(CLAUDE, "LIFEOS/TOOLS/gmail.ts");

export const ROUTE_AFTER: Record<Question["cadence"], number> = { hourly: 3, daily: 2, weekly: 1, monthly: 1 };
export const MAX_ROUTES_PER_TICK = 5;
export const REROUTE_COOLDOWN_MS = 24 * 3600_000;

/** Socrates domain → Achilles category. */
export const CATEGORY_BY_DOMAIN: Record<Question["domain"], "technical" | "financial" | "reputational" | "legal" | "physical" | "operational"> = {
  security: "technical", infra: "technical", operations: "operational", ownership: "operational",
  financial: "financial", health: "physical", content: "reputational", prediction: "operational", personal: "operational",
};
const PRIORITY_BY_SEVERITY: Record<Question["severity"], string> = { critical: "Priority:P0", high: "Priority:P1", medium: "Priority:P2", low: "Priority:P3" };

export interface RoutePlan {
  finding: FindingRecord;
  question: Question;
  /** "register" = new Achilles entry + ticket; "ticket" = entry exists, ticket still missing. */
  kind: "register" | "ticket";
}
export interface Held { finding: FindingRecord; why: string }

/**
 * Pure: decide which open findings go out this tick. Deterministic given the
 * inputs so it is fully testable without Achilles or gh.
 */
export function planRoutes(
  open: FindingRecord[],
  questions: Question[],
  lastRoutedAt: (questionId: string, instanceKey: string) => string | null,
  now: number = Date.now(),
  cap: number = MAX_ROUTES_PER_TICK,
): { routes: RoutePlan[]; held: Held[] } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const routes: RoutePlan[] = [];
  const held: Held[] = [];
  for (const f of [...open].sort((a, b) => a.first_seen.localeCompare(b.first_seen))) {
    const q = byId.get(f.question_id);
    if (!q || q.status !== "active") { held.push({ finding: f, why: "question missing or not active" }); continue; }
    if (q.route === "none") { held.push({ finding: f, why: "route: none — a view over Achilles or the scanner; the concrete findings register themselves" }); continue; }
    const routed = normalizeRouted(f.routed);
    if (routed && routed.work_issue !== null) continue; // fully routed — Achilles owns it now
    // Before the ticket retry too: an entry whose ticket failed waits out an unknown verdict.
    if (f.last_verdict !== "fail") { held.push({ finding: f, why: `last verdict ${f.last_verdict} — routes only while failing` }); continue; }
    if (routed && routed.work_issue === null) { routes.push({ finding: f, question: q, kind: "ticket" }); continue; }
    const need = ROUTE_AFTER[q.cadence];
    if (f.seen_count < need) { held.push({ finding: f, why: `failed ${f.seen_count}/${need} ticks (${q.cadence})` }); continue; }
    const last = lastRoutedAt(f.question_id, f.instance_key);
    if (last && now - Date.parse(last) < REROUTE_COOLDOWN_MS) { held.push({ finding: f, why: `routed ${Math.round((now - Date.parse(last)) / 3600_000)}h ago — cooldown` }); continue; }
    if (routes.length >= cap) { held.push({ finding: f, why: `per-tick cap ${cap} reached` }); continue; }
    routes.push({ finding: f, question: q, kind: "register" });
  }
  return { routes, held };
}

// ---------------------------------------------------------------- execution

export interface Runner {
  (argv: string[], env?: Record<string, string>): { code: number; out: string; err: string };
}
export const bunRunner: Runner = (argv, env) => {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(env ?? {}) } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

export interface RouterDeps {
  run: Runner;
  /** work repo (owner/name) or null when the work system is not configured. */
  repo: string | null;
  /** Email recipient; null disables the email leg. */
  emailTo: string | null;
  /** Issue label naming the agent — WORK.AGENT_LABEL from USER/WORK/config.yaml, never a hardcoded DA name. */
  agentLabel: string;
  now: () => string;
  log: (line: string) => void;
}

export const sourceRef = (f: FindingRecord) => `socrates:${f.question_id}|${f.instance_key}#${f.id}`;
const marker = (f: FindingRecord) => `<!-- achilles:${sourceRef(f)} -->`;

export function achillesTitle(f: FindingRecord, q: Question): string {
  return `${q.id}${f.instance_key ? ` ${f.instance_key}` : ""} — ${q.text}`.slice(0, 140);
}

function registerAchilles(plan: RoutePlan, d: RouterDeps): string | null {
  const { finding: f, question: q } = plan;
  const argv = [
    process.execPath, ACHILLES, "add",
    "--title", achillesTitle(f, q),
    "--description", `Socrates standing question ${q.id} has failed ${f.seen_count} consecutive ${q.cadence} ticks since ${f.first_seen}. Ideal: ${q.ideal}${f.last_value != null ? ` Last value: ${f.last_value}.` : ""}`,
    "--category", CATEGORY_BY_DOMAIN[q.domain],
    "--severity", q.severity,
    "--source", "socrates",
    "--source-ref", sourceRef(f),
    "--first-seen", f.first_seen,
    "--evidence", `socrates finding #${f.id}: ${f.seen_count} fails, last ${f.last_seen}`,
  ];
  if (f.instance_key) argv.push("--affected", f.instance_key);
  if (q.risk_ref) argv.push("--risk-ref", q.risk_ref);
  const r = d.run(argv);
  const id = r.out.match(/"id":"(ACH-\d{4})"/)?.[1];
  if (r.code !== 0 || !id) { d.log(`achilles add failed for ${sourceRef(f)}: ${(r.err || r.out).slice(0, 200)}`); return null; }
  return id;
}

function createTicket(plan: RoutePlan, achillesId: string, d: RouterDeps): number | null {
  if (!d.repo) { d.log("no work repo configured — ticket skipped"); return null; }
  const { finding: f, question: q } = plan;
  const search = d.run(["gh", "issue", "list", "--repo", d.repo, "--search", `"${sourceRef(f)}" in:body`, "--state", "all", "--json", "number", "--limit", "1"]);
  try {
    const found = JSON.parse(search.out || "[]") as Array<{ number: number }>;
    if (found[0]?.number) return found[0].number;
  } catch { /* fall through to create */ }
  const labels = ["Status:queued", d.agentLabel, "Type:problem", PRIORITY_BY_SEVERITY[q.severity], ...(q.domain === "security" ? ["security"] : [])];
  const title = `[Socrates] ${achillesTitle(f, q)}`.replace(/"/g, "'").slice(0, 100);
  const body = [
    `## Socrates finding — Achilles ${achillesId}`,
    `Standing question **${q.id}** (${q.domain}/${q.severity}, ${q.cadence}) has been failing since ${f.first_seen.slice(0, 16)}Z — ${f.seen_count} consecutive ticks.`,
    "",
    `- Question: ${q.text}`,
    `- Ideal: ${q.ideal}`,
    f.instance_key ? `- Instance: \`${f.instance_key}\`` : "",
    f.last_value != null ? `- Last value: ${f.last_value}` : "",
    `- Registry: \`bun LIFEOS/TOOLS/Achilles.ts show ${achillesId}\` · closes itself when the question passes again`,
    "",
    "_Registered by the Socrates router (propose-default: this asks, it does not remediate)._",
    marker(f),
  ].filter((l) => l !== "").join("\n");
  const r = d.run(["gh", "issue", "create", "--repo", d.repo, "--title", title, "--label", labels.join(","), "--body", body]);
  const num = Number(r.out.match(/\/issues\/(\d+)/)?.[1]);
  if (r.code !== 0 || !num) { d.log(`issue create failed for ${sourceRef(f)}: ${r.err.slice(0, 200)}`); return null; }
  return num;
}

function sendEmail(plan: RoutePlan, achillesId: string, issue: number | null, d: RouterDeps): boolean {
  if (!d.emailTo) return false;
  const { finding: f, question: q } = plan;
  const subject = `[Socrates] ${q.severity.toUpperCase()} security finding: ${achillesTitle(f, q).slice(0, 60)}`;
  const rows: Array<[string, string]> = [
    ["Question", esc(q.text)],
    ["Ideal", esc(q.ideal)],
    ...(f.instance_key ? [["Instance", `<span style="font-family:${T.mono};font-size:14px">${esc(f.instance_key)}</span>`] as [string, string]] : []),
    ...(f.last_value != null ? [["Last value", esc(String(f.last_value))] as [string, string]] : []),
    ["Achilles", esc(achillesId)],
  ];
  const ticketUrl = issue && d.repo ? `https://github.com/${d.repo}/issues/${issue}` : null;
  const body = renderEmail({
    system: "Socrates",
    badge: q.severity.toUpperCase(),
    accent: q.severity === "critical" || q.severity === "high" ? T.red : T.amber,
    title: achillesTitle(f, q),
    subtitle: `${q.id} failing for ${f.seen_count} consecutive ${q.cadence} ticks — registered in Achilles`,
    rows,
    note: "Nothing has been changed. Reply or open the ticket to decide what to do. Closes itself when the question passes again.",
    ...(ticketUrl ? { cta: { label: `Open issue #${issue}`, url: ticketUrl } } : {}),
    footer: "Socrates router · propose-default: this asks, it does not remediate.",
  });
  // The body names the finding (question, instance key, values, the ticket URL): a private,
  // owner-only temp file, removed after the send, never a fixed name in the shared /tmp
  // (in-family audit, round 24).
  const tmpDir = mkdtempSync(join(tmpdir(), "socrates-route-"));
  const tmp = join(tmpDir, "body.html");
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    const r = d.run([process.execPath, GMAIL, "send", "--to", d.emailTo, "--subject", subject, "--body-file", tmp, "--html"], { LIFEOS_SKILL: PRIVATE_SKILL_NAMES.communication });
    if (r.code !== 0) { d.log(`email failed for ${sourceRef(f)}: ${r.err.slice(0, 160)}`); return false; }
    return true;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface RouteReport { registered: string[]; ticketed: number[]; emailed: number; held: Held[]; closed: string[]; errors: string[] }

/** Run the router over the store's open findings. Never throws — every failure is a logged, retried-next-tick error. */
export function routeFindings(store: Store, questions: Question[], d: RouterDeps, opts: { dryRun?: boolean } = {}): RouteReport {
  const report: RouteReport = { registered: [], ticketed: [], emailed: 0, held: [], closed: [], errors: [] };
  const log = (l: string) => { report.errors.push(l); d.log(l); };
  const { routes, held } = planRoutes(store.openFindings(), questions, (q, i) => store.lastRoutedAt(q, i));
  report.held = held;
  for (const plan of routes) {
    if (opts.dryRun) { d.log(`would ${plan.kind}: ${achillesTitle(plan.finding, plan.question)}`); continue; }
    try {
      const achillesId = plan.kind === "ticket" ? plan.finding.routed!.achilles_id : registerAchilles(plan, { ...d, log });
      if (!achillesId) continue;
      if (plan.kind === "register") report.registered.push(achillesId);
      const issue = createTicket(plan, achillesId, { ...d, log });
      let linked = issue;
      if (issue) {
        const u = d.run([process.execPath, ACHILLES, "update", achillesId, "--work-issue", String(issue)]);
        // Achilles needs the link to close the ticket: journal work_issue null so the next
        // tick plans a "ticket" retry (the marker search finds this issue; no duplicate).
        if (u.code !== 0) { log(`achilles update --work-issue failed for ${achillesId}: ${u.err.slice(0, 160)}`); linked = null; }
        report.ticketed.push(issue);
      }
      const routed: Routed = { achilles_id: achillesId, work_issue: linked, routed_at: d.now() };
      store.markRouted(plan.finding.question_id, plan.finding.instance_key, routed);
      if (plan.kind === "register" && plan.question.domain === "security" && sendEmail(plan, achillesId, issue, { ...d, log })) report.emailed++;
    } catch (err) {
      log(`route failed for ${sourceRef(plan.finding)}: ${String(err).slice(0, 200)}`);
    }
  }
  // Close leg: routed findings that resolved since Achilles last heard.
  for (const ev of store.resolvedButRoutedOpen()) {
    const id = ev.routed!.achilles_id;
    if (opts.dryRun) { d.log(`would close ${id} (cleared ${ev.resolved_at})`); continue; }
    try {
      const show = d.run([process.execPath, ACHILLES, "show", id]);
      const status = show.out.match(/"status":\s*"([a-z_]+)"/)?.[1];
      if (status && ["remediated", "accepted", "false_positive"].includes(status)) {
        store.markAchillesClosed(ev.id, id, d.now()); report.closed.push(id); continue;
      }
      const c = d.run([process.execPath, ACHILLES, "close", id, "--evidence", ev.reason === "instance-gone" ? `condition cannot recur: instance ${ev.instance_key} no longer exists in a complete ${ev.question_id} tick at ${ev.resolved_at} (retired)` : `condition cleared: Socrates same-question pass on ${ev.question_id}${ev.instance_key ? ` (${ev.instance_key})` : ""} at ${ev.resolved_at}`, "--resolution", "remediated"]);
      if (c.code !== 0) { log(`achilles close failed for ${id}: ${(c.err || c.out).slice(0, 160)}`); continue; }
      store.markAchillesClosed(ev.id, id, d.now());
      report.closed.push(id);
    } catch (err) {
      log(`close failed for ${id}: ${String(err).slice(0, 200)}`);
    }
  }
  return report;
}

/** Production deps: real subprocesses, work repo from the Work System config, recipient from the Gmail profile. */
export async function defaultDeps(log: (l: string) => void = (l) => console.error(`[socrates-router] ${l}`)): Promise<RouterDeps> {
  let repo: string | null = null;
  let agentLabel = "Agent:principal"; // work-config's own default when config.yaml is absent
  try {
    const { loadWorkConfig } = await import(join(CLAUDE, "hooks/lib/work-config.ts"));
    const wc = loadWorkConfig();
    repo = wc.repo ?? null;
    agentLabel = wc.agentLabel;
  } catch (err) { log(`work config unavailable: ${String(err).slice(0, 120)}`); }
  let emailTo: string | null = process.env.SOCRATES_EMAIL_TO ?? null;
  if (!emailTo) {
    const r = bunRunner([process.execPath, GMAIL, "profile"], { LIFEOS_SKILL: PRIVATE_SKILL_NAMES.communication });
    emailTo = r.out.match(/"emailAddress"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    if (!emailTo) log("gmail profile unavailable — email leg disabled this tick");
  }
  return { run: bunRunner, repo, emailTo, agentLabel, now: () => new Date().toISOString(), log };
}
