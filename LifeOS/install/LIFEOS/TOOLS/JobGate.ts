#!/usr/bin/env bun
import { PRIVATE_SKILL_NAMES } from "./CodeDataBoundary.ts";
/**
 * @version 2.2.0
 * JobGate.ts — deterministic wake-gates for AgentJob.ts. Zero model spend.
 *
 *   bun JobGate.ts new-mail       # actionable Gmail mail newer than the last successful run?
 *   bun JobGate.ts new-command    # the principal's authenticated mail to a command mailbox, for the command pass
 *   bun JobGate.ts new-lifelog    # any Bee conversation, or meeting from any recorder, new since the last successful run?
 *
 * Reads AGENTJOB_LAST_SUCCESS (ISO, set by AgentJob.ts; empty on first run = wake). A 10-minute
 * overlap catches late-arriving items. Emits findings lines then the wake-gate JSON as the final
 * stdout line. Gate errors fail OPEN (wake) so a broken gate never silently stops a monitor;
 * they are reported on stderr so the job log shows them.
 *
 * 2.0.0 (2026-09-07): new-mail reads through gmail.ts across every Google credential (the
 * 1.x gate shelled to `gws`, retired 2026-08 — it failed open on EVERY tick and woke a
 * full model run many times a day to say nothing). "New" alone no longer wakes:
 * a message qualifies when its sender class (senders.yaml) is human/financial/transactional/
 * legal, OR it is addressed to a trusted-command mailbox, OR it is from a configured VIP, OR
 * its subject/snippet carries a calendar signal. Marketing, notification, and unknown-class
 * mail with no calendar signal is skipped, and only the qualifying messages reach the model.
 * 2.1.0 (2026-10-01): new-lifelog also wakes on meetings from every recorder (every
 * USER-zone recorder) via `Timeline.ts fresh`; a recorder that cannot be read is logged as
 * GATE_DEGRADED but never fails open, so a lapsed login cannot wake a run every tick.
 * 2.2.0 (2026-10-25): with `gate.authEnforce` on, mail splits into two passes that never share a model. new-mail
 * (the capture pass, run with no outbound) gets everything except the principal's authenticated commands;
 * new-command (the command pass) gets only those, and writes the addresses each command names in the
 * principal's own words or its forwarded header block to COMMAND_RECIPIENTS, the only guests gcal.ts will invite
 * there. new-command never fails open: off in shadow, closed on its first run, closed when mail cannot be read.
 * Gate config (optional, USER tree): agent-jobs.json top-level
 *   `gate: { vip: [emails or @domains], commandMailboxes: [emails], selfAddresses: [emails], calendarPattern: "<regex>" }`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { invariant } from "./Invariant.ts";

const OVERLAP_MS = 10 * 60_000;
const LIFEOS_ROOT = process.env.LIFEOS_ROOT || getClaudeDir();
const USER = join(LIFEOS_ROOT, "LIFEOS/USER");
const SENDERS_PATH = join(USER, "INBOX/senders.yaml");
const JOBS_PATH = join(USER, "CONFIG/agent-jobs.json");
const GOOGLE_CREDS_DIR = join(USER, "CONFIG/CREDENTIALS/google");
/** Kept outside MEMORY/STATE/agent-jobs, the only place a job's model may write, so no run can widen its own list. */
export const COMMAND_RECIPIENTS = join(USER, "MEMORY/STATE/mail-gate/command-recipients.json");
const JOB_STATE = join(USER, "MEMORY/STATE/agent-jobs");

export type SenderClass = "human" | "financial" | "transactional" | "legal" | "marketing" | "notification" | "unknown";
/**
 * principalSenders: the principal's own addresses, whose mail to a command mailbox is a command once Google's
 * header proves it. authEnforce: false = shadow (today's rules decide; the verdict is only recorded).
 */
export interface GateConfig { vip: string[]; commandMailboxes: string[]; selfAddresses: string[]; calendarPattern: RegExp; principalSenders?: string[]; authEnforce?: boolean }
export interface MailRow { id: string; account: string; from: string; to?: string; subject: string; date: string; snippet?: string; labels?: string[]; authResults?: string[] }

export const DEFAULT_CALENDAR = /\b(meeting|invite|invitation|appointment|reservation|booking|confirmation|confirmed|itinerary|flight|boarding|check-in|hotel|ticket|rsvp|calendar|schedule[d]?|reschedul|interview|call (?:at|on)|deadline|due (?:on|by)|webinar|conference|\.ics)\b/i;
const WAKE_CLASSES: SenderClass[] = ["human", "financial", "transactional", "legal"];

export function loadGateConfig(path = JOBS_PATH): GateConfig {
  let g: any = {};
  try { g = JSON.parse(readFileSync(path, "utf8")).gate ?? {}; } catch { /* no config → defaults */ }
  const lower = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((s) => String(s).toLowerCase());
  return {
    vip: lower(g.vip),
    commandMailboxes: lower(g.commandMailboxes),
    selfAddresses: lower(g.selfAddresses),
    calendarPattern: g.calendarPattern ? new RegExp(g.calendarPattern, "i") : DEFAULT_CALENDAR,
    principalSenders: lower(g.principalSenders),
    authEnforce: g.authEnforce === true,
  };
}

/**
 * True when the From is one of the principal's addresses AND the top Authentication-Results header, which Gmail's
 * own receiving server (mx.google.com) writes, shows DKIM passing for that same domain or DMARC passing for it. Only
 * the top header counts: anything below it came with the message and a sender can forge it.
 */
export function principalAuthenticated(m: MailRow, cfg: GateConfig): boolean {
  const from = address(m.from);
  if (!(cfg.principalSenders ?? []).includes(from)) return false;
  const domain = from.split("@")[1] ?? "";
  const top = (m.authResults ?? [])[0]?.replace(/\s+/g, " ").toLowerCase() ?? "";
  if (!top.startsWith("mx.google.com;")) return false;
  return top.split(";").slice(1).map((c) => c.trim()).some((c) => {
    const tag = (k: string) => c.match(new RegExp(`\\b${k}=([^\\s;]+)`))?.[1] ?? "";
    const dom = (v: string) => v.slice(v.lastIndexOf("@") + 1);
    if (/^dkim=pass\b/.test(c)) return dom(tag("header\\.d") || tag("header\\.i")) === domain;
    if (/^dmarc=pass\b/.test(c)) return tag("header\\.from") === domain;
    return false;
  });
}

/** The command pass's mail: the principal's authenticated mail to a command mailbox, and only while the check is enforced. */
export function isPrincipalCommand(m: MailRow, cfg: GateConfig): boolean {
  const to = (m.to ?? "").toLowerCase();
  return !!cfg.authEnforce && cfg.commandMailboxes.some((c) => to.includes(c)) && principalAuthenticated(m, cfg);
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const QUOTED = [/^-{3,}[^\n]*forwarded message[^\n]*$/im, /^begin forwarded message:/im, /^-{3,}\s*original message\s*-{3,}/im, /^on [^\n]{1,300}wrote:\s*$/im, /^>/m];
const FORWARD_HEADER = /^(?:-{3,}[^\n]*forwarded message[^\n]*|begin forwarded message:[^\n]*)\n([\s\S]*?)(?:\n[ \t]*\n|$)/i;

/**
 * Who a command may invite: addresses in the principal's own typed text (everything above the first forward, reply or
 * quote marker), in the From/To/Cc lines of the forwarded header block directly under it, and in his message's To,
 * minus the command mailboxes. An address that appears only further down, in a forwarded or quoted body, is never
 * included: that text is someone else's, and only a header block placed right under his words is the one Gmail wrote.
 */
export function commandRecipients(body: string, msgTo: string, cfg: GateConfig): string[] {
  const text = body.replace(/\r\n?/g, "\n");
  const cut = Math.min(text.length, ...QUOTED.map((re) => text.search(re)).filter((i) => i >= 0));
  const found = [...(text.slice(0, cut).match(EMAIL) ?? []), ...(msgTo.match(EMAIL) ?? [])];
  const block = text.slice(cut).match(FORWARD_HEADER)?.[1] ?? "";
  for (const line of block.split("\n")) if (/^\s*(from|to|cc)\s*:/i.test(line)) found.push(...(line.match(EMAIL) ?? []));
  return [...new Set(found.map((a) => a.toLowerCase()))].filter((a) => !cfg.commandMailboxes.includes(a)).sort();
}

/** Replaces the recipient list for this tick (an empty list when there is no command), so no allowance outlives it. */
export function writeCommandRecipients(messages: Record<string, string[]>, path = COMMAND_RECIPIENTS): void {
  const recipients = [...new Set(Object.values(messages).flat())].sort();
  invariant(!path.startsWith(JOB_STATE), "the command recipient list must sit outside every job's writable state");
  invariant(recipients.every((a) => a === a.toLowerCase() && new RegExp(`^${EMAIL.source}$`, "i").test(a)), "command recipients are lower-case email addresses");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ generatedAt: new Date().toISOString(), recipients, messages }, null, 2) + "\n");
  renameSync(tmp, path);
}

/** senders.yaml → address → class. The file is our own simple schema (shared with the inbox triage tool). */
export function loadSenderClasses(path = SENDERS_PATH): Map<string, SenderClass> {
  const out = new Map<string, SenderClass>();
  if (!existsSync(path)) return out;
  return parseSenderClasses(readFileSync(path, "utf8"));
}
export function parseSenderClasses(yaml: string): Map<string, SenderClass> {
  const out = new Map<string, SenderClass>();
  let cur: string | null = null;
  for (const line of yaml.split("\n")) {
    const addr = line.match(/^  "([^"]+)":\s*$/) ?? line.match(/^  ([^\s:"][^:]*):\s*$/);
    if (addr) { cur = addr[1]!.toLowerCase(); continue; }
    const cls = cur && line.match(/^    class:\s*(\w+)/);
    if (cls) out.set(cur!, cls[1] as SenderClass);
  }
  return out;
}

export function address(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/** Why a message should wake the model, or null. Pure; unit-tested. */
export function wakeReason(m: MailRow, classes: Map<string, SenderClass>, cfg: GateConfig): string | null {
  const from = address(m.from);
  const domain = from.split("@")[1] ?? "";
  const to = (m.to ?? "").toLowerCase();
  const cmd = cfg.commandMailboxes.find((c) => to.includes(c));
  // Enforced: the principal's authenticated mail to a command mailbox is a command, ahead of the self-send rule that
  // otherwise swallows it; anyone else's mail there gets the ordinary sender rules below, never command standing.
  if (cfg.authEnforce && cmd && principalAuthenticated(m, cfg)) return `command mailbox ${cmd} (principal authenticated)`;
  if (cfg.selfAddresses.includes(from)) return null; // own newsletter / self-sends never wake
  if (cfg.commandMailboxes.includes(from)) return null; // my own automation (scanner reports, briefs) never wakes me
  // Anyone else's mail to a command mailbox still wakes, as before (a human answering {{DA_NAME}} must reach the principal);
  // enforced, it wakes the capture pass as information only.
  if (cmd) return cfg.authEnforce ? `mailbox ${cmd} (not a command)` : `command mailbox ${cmd}`;
  if (cfg.vip.some((v) => (v.startsWith("@") ? domain === v.slice(1) : from === v))) return "vip sender";
  const cls = classes.get(from);
  if (cls && WAKE_CLASSES.includes(cls)) return `sender class ${cls}`;
  if (cls === "marketing" || cls === "notification") return null;
  if (cfg.calendarPattern.test(`${m.subject ?? ""} ${m.snippet ?? ""}`)) return "calendar signal";
  return null;
}

function gate(wake: boolean, findings: string[]): never {
  for (const f of findings) console.log(f);
  console.log(JSON.stringify({ wakeAgent: wake }));
  process.exit(0);
}
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, env: process.env, cwd: LIFEOS_ROOT, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Shadow mode: for every fresh row addressed to a command mailbox, the decision today's rules made beside the one the
 * enforced sender check would make, written to STATVS once per message (ticks overlap) so the switch is judged on
 * real mail. Never fails the gate.
 */
export function shadowVerdict(m: MailRow, classes: Map<string, SenderClass>, cfg: GateConfig) {
  const to = (m.to ?? "").toLowerCase();
  if (!cfg.commandMailboxes.some((c) => to.includes(c))) return null;
  return {
    principal: principalAuthenticated(m, cfg),
    today: wakeReason(m, classes, { ...cfg, authEnforce: false }),
    enforced: wakeReason(m, classes, { ...cfg, authEnforce: true }),
  };
}

async function recordShadowVerdicts(rows: MailRow[], classes: Map<string, SenderClass>, cfg: GateConfig): Promise<void> {
  try {
    const { writeEventOnce } = await import("../STATVS/index.ts");
    for (const m of rows) {
      const v = shadowVerdict(m, classes, cfg);
      if (!v) continue;
      const r = writeEventOnce({
        id: crypto.randomUUID(), source: "mail-gate", ts: new Date().toISOString(), kind: "infra", severity: "info",
        title: `DA-mailbox sender check (shadow): principal=${v.principal} · today=${v.today ?? "no wake"} · enforced=${v.enforced ?? "no wake"}`,
        summary: `${m.account}:${m.id} from ${address(m.from)}. Top auth header: ${(m.authResults ?? [])[0]?.replace(/\s+/g, " ").slice(0, 160) ?? "none"}.`,
        ref: null, url: null, privacy_class: "personal", dedup_key: `mail-gate-auth:${m.account}:${m.id}`,
      });
      if (!r.ok) console.error(`shadow verdict not recorded for ${m.account}:${m.id}: ${r.refused}`);
    }
  } catch (e) { console.error(`shadow verdicts not recorded: ${(e as Error).message}`); }
}

/** Every mailbox credential name under CONFIG/CREDENTIALS/google (one file per mailbox). */
export function mailboxAccounts(dir = GOOGLE_CREDS_DIR): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json") && !/oauth|client_secret/i.test(f)).map((f) => f.replace(/\.json$/, ""));
  } catch { return []; }
}

if (import.meta.main) {
  const lastSuccess = process.env.AGENTJOB_LAST_SUCCESS ? new Date(process.env.AGENTJOB_LAST_SUCCESS) : null;
  const since = lastSuccess && !Number.isNaN(lastSuccess.getTime()) ? new Date(lastSuccess.getTime() - OVERLAP_MS) : null;
  const mode = process.argv[2];
  // Absent-reader check comes BEFORE the first-run fail-open: on a tree without the private
  // lifelog reader even the very first tick must stay closed, or it wakes a model run once to
  // report nothing (Max in-family audit, 7.50.9 cut).
  if (mode === "new-lifelog" && !existsSync(join(LIFEOS_ROOT, `skills/${PRIVATE_SKILL_NAMES.lifelog}/Tools/Bee.ts`))) {
    console.error("lifelog reader not installed on this tree — gate closed");
    gate(false, ["GATE_ABSENT: lifelog reader not installed"]);
  }
  const gmail = join(LIFEOS_ROOT, "LIFEOS/TOOLS/gmail.ts");
  /** Every row newer than `since` across all mailboxes, plus a GATE_DEGRADED line per mailbox that could not be read. */
  const listFresh = (accounts: string[]) => {
    const ageMin = Math.max(30, Math.ceil((Date.now() - since!.getTime()) / 60_000) + 5);
    const rows: MailRow[] = [];
    const degraded: string[] = [];
    for (const account of accounts) {
      const r = run(process.execPath, [gmail, "--account", account, "list", `newer_than:${ageMin}m`, "100"]);
      if (!r.ok) { degraded.push(`GATE_DEGRADED: gmail.ts list failed for ${account}: ${r.stderr.trim().slice(0, 160)}`); continue; }
      for (const line of r.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try { const o = JSON.parse(line); rows.push({ ...o, account }); } catch { /* not a row */ }
      }
    }
    const fresh = rows.filter((m) => { const t = new Date(m.date).getTime(); return !Number.isNaN(t) && t > since!.getTime(); });
    return { rows, fresh, degraded };
  };

  // The command pass can invite people, so unlike every other gate it never fails open: in shadow it is off, on its
  // first run it only records a baseline (an old command is never acted on), and unreadable mail keeps it closed.
  if (mode === "new-command") {
    const cfg = loadGateConfig();
    if (!cfg.authEnforce) { writeCommandRecipients({}); gate(false, ["COMMAND_LANE_OFF: the DA-mailbox sender check is in shadow (gate.authEnforce false)"]); }
    if (!since) { writeCommandRecipients({}); gate(false, ["FIRST_RUN: baseline only; the command pass never acts on mail from before its first run"]); }
    const accounts = mailboxAccounts();
    const { fresh, degraded } = listFresh(accounts);
    for (const d of degraded) console.error(d);
    // Ticks overlap by ten minutes, so a command the pass already recorded in its processed.json is not offered again.
    // The model can only shrink this list by writing there, never grow it.
    let handled = new Set<string>();
    try { handled = new Set(Object.keys(JSON.parse(readFileSync(join(JOB_STATE, process.env.AGENTJOB_ID || "mail-command", "processed.json"), "utf8")).processed ?? {})); } catch { /* none yet */ }
    const seen = new Set<string>();
    const commands = fresh.filter((m) => isPrincipalCommand(m, cfg) && !handled.has(`${m.account}:${m.id}`)).filter((m) => {
      const key = `${address(m.from)}|${m.subject}|${m.date}`; // the same message delivered to two mailboxes runs once
      return seen.has(key) ? false : (seen.add(key), true);
    });
    const allowed: Record<string, string[]> = {};
    const lines = commands.map((m) => {
      const r = run(process.execPath, [gmail, "--account", m.account, "fetchfull", m.id]);
      let body: string | null = null;
      try { body = r.ok ? String(JSON.parse(r.stdout).body ?? "") : null; } catch { body = null; }
      allowed[`${m.account}:${m.id}`] = body === null ? [] : commandRecipients(body, m.to ?? "", cfg);
      const who = allowed[`${m.account}:${m.id}`]!;
      return `COMMAND: ${m.account}:${m.id} · ${m.date} · "${m.subject}" · may invite: ${body === null ? "nobody (message unreadable)" : who.length ? who.join(", ") : "nobody named"}`;
    });
    writeCommandRecipients(allowed);
    console.error(`new-command gate: ${fresh.length} fresh, ${commands.length} principal command(s)${degraded.length ? `, degraded: ${degraded.length}` : ""}`);
    gate(commands.length > 0, [...degraded, ...lines]);
  }

  if (!since) gate(true, [`FIRST_RUN: no previous successful run recorded — full ${mode} pass`]);

  if (mode === "new-mail") {
    const accounts = mailboxAccounts();
    if (accounts.length === 0) { console.error("no Google mailbox credentials found — failing open"); gate(true, ["GATE_DEGRADED: no mailbox credentials"]); }
    const classes = loadSenderClasses();
    const cfg = loadGateConfig();
    const { rows, fresh, degraded } = listFresh(accounts);
    if (degraded.length === accounts.length) { for (const d of degraded) console.error(d); gate(true, degraded); }
    // Enforced, the principal's authenticated commands belong to the command pass and never reach this one.
    const qualifying = fresh.filter((m) => !isPrincipalCommand(m, cfg)).map((m) => ({ m, why: wakeReason(m, classes, cfg) })).filter((x) => x.why);
    if (!cfg.authEnforce) await recordShadowVerdicts(fresh, classes, cfg);
    console.error(`new-mail gate: ${rows.length} rows, ${fresh.length} fresh, ${qualifying.length} qualify${degraded.length ? `, degraded: ${degraded.join("; ")}` : ""}`);
    gate(qualifying.length > 0, [
      ...degraded,
      ...qualifying.map(({ m, why }) => `NEW_MAIL: ${m.account}:${m.id} · ${m.date} · from ${m.from} · to ${m.to ?? "?"} · "${m.subject}" · why: ${why}`),
      `SKIPPED: ${fresh.length - qualifying.length} fresh message(s) with no wake reason (marketing/notification/unknown, no calendar signal)${cfg.authEnforce ? " or a principal command, which the command pass runs" : ""}`,
    ]);
  }

  if (mode === "new-lifelog") {
    const bee = join(LIFEOS_ROOT, `skills/${PRIVATE_SKILL_NAMES.lifelog}/Tools/Bee.ts`);
    // Absent is not broken: the lifelog reader is a private skill that never ships, so on a
    // tree without it the gate must stay CLOSED (no wake) — failing open here would wake a
    // full model run on every tick to report nothing (Forge cross-vendor audit, 7.50.6 cut).
    // A present-but-failing reader still fails open below, so a real outage never goes silent.
    if (!existsSync(bee)) { console.error("lifelog reader not installed on this tree — gate closed"); gate(false, ["GATE_ABSENT: lifelog reader not installed"]); }
    const lines: string[] = [];
    let failOpen = false;
    const r = run(process.execPath, [bee, "recent", "--limit", "50", "--since", since!.toISOString()]);
    if (!r.ok) { console.error(`Bee.ts failed: ${r.stderr.slice(0, 200)} — failing open`); lines.push("GATE_DEGRADED: Bee recent failed"); failOpen = true; }
    else {
      try {
        const j = JSON.parse(r.stdout) as { count: number; conversations: { id: string; start_time: string; updated_at?: string; utterances_count?: number }[] };
        const fresh = j.conversations.filter((c) => new Date(c.updated_at ?? c.start_time).getTime() > since!.getTime());
        lines.push(...fresh.map((c) => `NEW_LIFELOG: ${c.id} · started ${c.start_time} · updated ${c.updated_at ?? "?"} · ${c.utterances_count ?? "?"} utterances`));
      } catch (e) { console.error(`parse failed: ${e} — failing open`); lines.push("GATE_DEGRADED: Bee parse failed"); failOpen = true; }
    }
    // Meeting recorders (every USER-zone recorder) through the lifelog timeline. A recorder
    // that cannot be read is reported but never fails open: a lapsed login would otherwise wake a
    // model run every tick to say nothing, which is the 1.x new-mail failure in a new place.
    const timeline = join(LIFEOS_ROOT, `skills/${PRIVATE_SKILL_NAMES.lifelog}/Tools/Timeline.ts`);
    if (existsSync(timeline)) {
      const t = run(process.execPath, [timeline, "fresh", "--since", since!.toISOString()]);
      try {
        if (!t.ok) throw new Error(t.stderr.trim().slice(0, 160));
        const j = JSON.parse(t.stdout) as { fresh: { source: string; id: string; title: string; start: string }[]; sources: Record<string, { status: string; reason?: string }> };
        lines.push(...j.fresh.map((m) => `NEW_LIFELOG: ${m.source}:${m.id} · started ${m.start} · "${m.title.slice(0, 80)}"`));
        for (const [name, s] of Object.entries(j.sources)) if (s.status !== "ok") { const d = `GATE_DEGRADED: ${name} unreadable: ${(s.reason ?? "").slice(0, 120)}`; console.error(d); lines.push(d); }
      } catch (e) { const d = `GATE_DEGRADED: meeting recorders unreadable: ${(e as Error).message}`; console.error(d); lines.push(d); }
    }
    gate(failOpen || lines.some((l) => l.startsWith("NEW_LIFELOG")), lines);
  }

  console.error(`usage: JobGate.ts new-mail|new-command|new-lifelog (got "${mode}")`);
  process.exit(2);
}
