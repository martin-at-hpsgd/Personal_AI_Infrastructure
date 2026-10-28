#!/usr/bin/env bun
/**
 * @version 2.5.1
 * TextingGuard.hook.ts — PreToolUse security boundary for Relay (the LifeOS text interface).
 *
 * 2.5.0 (2026-10-14): the tap lane runs only with LIFEOS_TEXTING_NTFY_TOKEN
 * (set by the bridge); push, poll and the phone's Approve action all carry it, so the topics must be ACL-protected,
 * and the approval body is a fresh nonce bound to the pending action's fingerprint. Without the token, decide()
 * falls back to the in-thread confirm.
 *
 * Active ONLY when the spawning bridge set LIFEOS_TEXTING_SESSION (the sender)
 * and LIFEOS_TEXTING_STATE (the bridge's 0600 state dir). Terminal sessions pay
 * one env lookup and exit 0.
 *
 * Inside a texting session it is the boundary the principal ratified for Relay
 * (Relay ISA § Articulation, 2026-09-04), so it is FAIL-CLOSED: any internal
 * error denies. Decisions come from hooks/lib/texting-guard-core.ts (pure,
 * tested); this file does I/O:
 *
 *   SENSITIVE   → denies (secrets, guard state, hooks, settings, launchd, ssh, keychain; doctrine writes)
 *   EGRESS      → denies (foreign recipients; shell reach to non-owned hosts)
 *   LOCKED      → records the pending challenge for the bridge, denies with the
 *                 check-in instruction (the model never learns the mechanism)
 *   CONFIRM     → records the pending confirm (exact fingerprint + the command), denies
 *                 with the ask-in-thread instruction; the bridge turns the principal's
 *                 next short yes into a one-shot approval the next decide() honours
 *   CONFIRM_TAP → pushes a single-use approval to the principal's phone over ntfy,
 *                 polls for the token, allows on tap, denies on timeout
 *
 * Personal values (numbers, mailboxes, countersign hash, topics) come from the
 * bridge config in LIFEOS_TEXTING_STATE and from env the bridge sets — none
 * live in this file. Every decision is appended to <state>/guard.log (0600).
 *
 * EXIT CODES: 0 = allow, 2 = deny (message on stderr goes to the model).
 */
const sender = process.env.LIFEOS_TEXTING_SESSION;
const stateDir = process.env.LIFEOS_TEXTING_STATE;
if (!sender && !stateDir) process.exit(0);
// 2.4.0 (Relay ISA F16, ISC-183): only the bridge arms a text session, and it always sets both. One without the
// other is a half-armed or tampered environment, never a terminal session, so it denies instead of allowing.
if (!sender || !stateDir) {
  process.stderr.write("[TEXTING-GUARD] The text-session guard is half-configured and refused this action. Do not retry; tell the principal the text line needs fixing.");
  process.exit(2);
}
// 4.3.0: the bridge registers this hook itself, with --relay, on every text session (session.ts GUARD_SETTINGS) and
// marks the session owned. Any other registration (a leftover harness entry) stands down so one call never runs the
// guard twice, which would spend a one-shot yes and deny the approved call.
if (process.env.LIFEOS_TEXTING_GUARD_OWNED === "1" && !process.argv.slice(2).includes("--relay")) process.exit(0);

// Everything below is loaded INSIDE the fail-closed boundary: a static import that throws would exit 1,
// which the harness treats as non-blocking (the tool call proceeds). Astra 2026-09-04, finding 8b.
process.on("uncaughtException", failClosed);
process.on("unhandledRejection", failClosed);
function failClosed(err: unknown): never {
  try { require("node:fs").appendFileSync(stateDir + "/guard.log", JSON.stringify({ ts: new Date().toISOString(), event: "fail_closed", sender, error: String(err).slice(0, 300) }) + "\n"); } catch { /* best effort */ }
  process.stderr.write("[TEXTING-GUARD] The text-session guard hit an internal error and refused this action. Do not retry; tell the principal this one needs a terminal session for now.");
  process.exit(2);
}
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { randomBytes } = await import("node:crypto");
const { homedir } = await import("node:os");
const { DEFAULT_CONFIG, MSG, approvalMarker, decide, fingerprint, missingInputFiles, summarize, taintStands } = await import("./lib/texting-guard-core.ts");
type AuthState = import("./lib/texting-guard-core.ts").AuthState;
type GuardConfig = import("./lib/texting-guard-core.ts").GuardConfig;
// No identity import: the guard closure is hooks/lib + node builtins only (Max 3.0.0 review, CRITICAL 1).
/** PreToolUse hook timeout registered in settings (seconds); a tap wait must finish well inside it, since a
 *  timed-out command hook is non-blocking (the action would proceed). */
const HOOK_TIMEOUT_MS = 300_000;
/** 2.4.0 (ISC-184): the absolute deadline for this whole process, stdin, sleeps and network included. It sits well
 *  inside the registered timeout so a slow run denies itself before the harness could let the call through. */
const HOOK_DEADLINE_CAP_MS = 270_000;
/** LIFEOS_TEXTING_DEADLINE_MS can only SHORTEN the deadline (a test seam that runs the real watchdog): an earlier
 *  deadline means an earlier deny, never a later allow. Absent, non-numeric or non-positive keeps the cap. A text
 *  session cannot set it: a LIFEOS_TEXTING_* assignment is SENSITIVE and settings env changes to it are refused. */
const HOOK_DEADLINE_MS = (() => {
  const n = Number(process.env.LIFEOS_TEXTING_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(HOOK_DEADLINE_CAP_MS, Math.floor(n)) : HOOK_DEADLINE_CAP_MS;
})();
const DEADLINE_AT = Date.now() + HOOK_DEADLINE_MS;
setTimeout(() => {
  try { require("node:fs").appendFileSync(stateDir + "/guard.log", JSON.stringify({ ts: new Date().toISOString(), event: "deadline_deny", sender }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
  process.stderr.write("[TEXTING-GUARD] The text-session guard ran out of time and refused this action. Do not retry; tell the principal it timed out.");
  process.exit(2);
}, HOOK_DEADLINE_MS);
/** Poll interval bounds (ms): a configured value outside them is clamped, never trusted to fit the window. */
const POLL_MIN_MS = 500, POLL_MAX_MS = 10_000;

const CONFIG_PATH = join(stateDir, "bridge-config.json");
const AUTH_PATH = join(stateDir, "texting-auth.json");
const LOG_PATH = join(stateDir, "guard.log");

function log(event: string, data: Record<string, unknown> = {}) {
  try {
    mkdirSync(stateDir!, { recursive: true });
    // 5 MB cap: rotate to guard.log.1 (0600). Best effort; logging never changes the decision.
    try { const { statSync, renameSync, chmodSync } = require("node:fs"); if (statSync(LOG_PATH).size > 5 * 1024 * 1024) { renameSync(LOG_PATH, LOG_PATH + ".1"); chmodSync(LOG_PATH + ".1", 0o600); } } catch { /* absent or fine */ }
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), event, sender, ...data }) + "\n", { mode: 0o600 });
  } catch { /* logging never changes the decision */ }
}
function deny(message: string, extra: Record<string, unknown> = {}): never {
  log("deny", extra);
  process.stderr.write(message);
  process.exit(2);
}

interface BridgeConfig extends Partial<GuardConfig> {
  approve?: { enabled?: boolean; server?: string; approveTopic?: string; waitMs?: number; pollMs?: number };
}

function loadConfig(): { cfg: GuardConfig; approve: Required<NonNullable<BridgeConfig["approve"]>> & { pushTopic: string } } {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as BridgeConfig;
  const cfg: GuardConfig = {
    ownChannels: {
      numbers: raw.ownChannels?.numbers ?? [],
      emails: raw.ownChannels?.emails ?? [],
      discordUserIds: raw.ownChannels?.discordUserIds ?? [],
    },
    contactChannels: { numbers: raw.contactChannels?.numbers ?? [], emails: raw.contactChannels?.emails ?? [] },
    trustedHandles: (raw as { chatFrom?: string[] }).chatFrom ?? [],
    countersignSalt: raw.countersignSalt,
    unlockIdleMs: raw.unlockIdleMs ?? DEFAULT_CONFIG.unlockIdleMs,
    challengeTtlMs: raw.challengeTtlMs ?? DEFAULT_CONFIG.challengeTtlMs,
    confirmTtlMs: raw.confirmTtlMs ?? DEFAULT_CONFIG.confirmTtlMs,
    countersignSha256: raw.countersignSha256,
    stateDir: stateDir!,
  };
  const approve = {
    enabled: raw.approve?.enabled ?? false,
    server: raw.approve?.server ?? "ntfy.sh",
    approveTopic: raw.approve?.approveTopic ?? "",
    waitMs: Math.max(0, Math.min(Number(raw.approve?.waitMs ?? 240_000) || 0, HOOK_DEADLINE_CAP_MS - 30_000)),
    pollMs: Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Number(raw.approve?.pollMs ?? 3_000) || 3_000)),
    pushTopic: process.env.LIFEOS_TEXTING_PUSH_TOPIC ?? "",
    // 2.5.0: the access token for the ACL-protected push and approve topics,
    // set by the bridge like the push topic. Without it the tap lane is off; it is never logged or printed.
    accessToken: process.env.LIFEOS_TEXTING_NTFY_TOKEN ?? "",
  };
  return { cfg, approve };
}

/**
 * The approval body for one pending action: a fresh nonce bound to the exact action's
 * fingerprint. A tap approves only the action it was pushed for; a bare token, a replayed body for another action,
 * or a body for a different fingerprint never matches.
 */
export function approvalBody(nonce: string, actionFingerprint: string): string {
  return `approve:${nonce}:${actionFingerprint}`;
}
function loadAuth(): AuthState {
  try { return existsSync(AUTH_PATH) ? (JSON.parse(readFileSync(AUTH_PATH, "utf8")) as AuthState) : {}; } catch { return {}; }
}
function saveAuth(state: AuthState) {
  writeFileSync(AUTH_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Read the hook payload to EOF. The harness always closes stdin; a timer here only manufactured fail-closed denies on slow spawns (Max LOW 14). */
async function readStdin(): Promise<string> { return await Bun.stdin.text(); }

/** Out-of-band tap: push an approval with an action button, then poll the approve topic for the token. */
async function requestTap(approve: ReturnType<typeof loadConfig>["approve"], summary: string, actionFingerprint: string): Promise<boolean> {
  // Authenticated delivery only: the push and the poll carry the access token, and the
  // phone's Approve action carries it too, so an unauthenticated subscriber can neither read the approval body
  // nor publish one. The body is bound to this exact action.
  if (!approve.accessToken) { log("tap_unauthenticated_refused"); return false; }
  const token = approvalBody(randomBytes(16).toString("hex"), actionFingerprint);
  const since = Math.floor(Date.now() / 1000) - 1;
  const base = `https://${approve.server}`;
  const auth = `Bearer ${approve.accessToken}`;
  const pushRes = await fetch(`${base}/${approve.pushTopic}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: auth,
      Title: "Relay needs a tap",
      Priority: "5",
      Tags: "lock",
      Actions: `http, Approve, ${base}/${approve.approveTopic}, method=POST, headers.Authorization=${auth}, body=${token}, clear=true`,
    },
    body: `Text session wants to: ${summary.slice(0, 180)}\nTap Approve to allow this once.`,
    signal: AbortSignal.timeout(8000),
  });
  if (!pushRes.ok) { log("tap_push_failed", { status: pushRes.status }); return false; }
  log("tap_pushed", { summary: summary.slice(0, 120) });
  // The wait ends at the earlier of its own window and the process deadline; no single sleep may cross either.
  const deadline = Math.min(Date.now() + approve.waitMs, DEADLINE_AT - 10_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(approve.pollMs, deadline - Date.now()))));
    if (Date.now() >= deadline) break;
    try {
      const res = await fetch(`${base}/${approve.approveTopic}/json?poll=1&since=${since}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const body = await res.text();
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m?.event === "message" && typeof m.message === "string" && m.message.trim() === token) { log("tap_approved"); return true; }
        } catch { /* not json */ }
      }
    } catch { /* transient; keep polling */ }
  }
  log("tap_timeout");
  return false;
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw) as { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string; cwd?: string };
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input;
  const { cfg, approve } = loadConfig();
  // The tap lane needs authenticated topics; without the access token decide() falls back
  // to the in-thread confirm.
  const tapConfigured = approve.enabled && !!approve.approveTopic && !!approve.pushTopic && !!approve.accessToken;
  const auth = loadAuth();
  const now = Date.now();
  const tainted = taintStands(input.session_id, now);
  const d = decide({ toolName, toolInput, auth: auth[sender!], cfg, now, tapConfigured, tainted, cwd: typeof input.cwd === "string" ? input.cwd : undefined });
  const summary = summarize(toolName, toolInput);
  log("decision", { tool: toolName, reason: d.reason, allow: d.allow, kind: d.kind ?? null, summary: summary.slice(0, 160) });

  if (d.allow) {
    if (d.consumeApproval && toolName === "Bash" && typeof toolInput?.command === "string") {
      // A run that would fail on a missing input file must not spend the yes; the approval stays for the same call.
      const missing = missingInputFiles(toolInput.command, (p) => existsSync(p), homedir(), typeof input.cwd === "string" ? input.cwd : undefined);
      if (missing.length) {
        log("approval_kept_missing_file", { reason: d.reason, missing: missing.length });
        deny(`[TEXTING-MISSING-FILE] Approved, but this command reads a file that does not exist: ${missing.join(", ")}. The approval is still valid. Recreate that file with the same content and re-run the exact same command now. Do not ask him again.`, { kind: "MISSING_FILE", reason: d.reason });
      }
    }
    if (d.consumeApproval) {
      // One-shot means one shot even under parallel hook processes: the consumption is a create-exclusive marker,
      // not a read-modify-write of texting-auth.json that a sibling hook could overwrite (Max MEDIUM 8).
      // Keyed on the grant, not the command: a fresh yes on the same command is a new grant (Relay ISA ISC-202).
      const marker = join(stateDir!, approvalMarker(fingerprint(toolName, toolInput), auth[sender!]?.approved?.until ?? ""));
      try { writeFileSync(marker, new Date(now).toISOString(), { flag: "wx", mode: 0o600 }); }
      catch { deny(MSG.CONFIRM, { kind: "CONFIRM", reason: `replay:${d.reason}` }); }
      auth[sender!] = { ...(auth[sender!] ?? {}), approved: undefined };
      saveAuth(auth);
      log("approval_consumed", { reason: d.reason });
    }
    process.exit(0);
  }
  if (d.kind === "LOCKED") {
    auth[sender!] = { ...(auth[sender!] ?? {}), challengePending: { ts: new Date(now).toISOString(), fingerprint: fingerprint(toolName, toolInput), summary: summary.slice(0, 400) } };
    saveAuth(auth);
    deny(d.message!, { kind: d.kind, reason: d.reason });
  }
  if (d.kind === "SENSITIVE" || d.kind === "EGRESS") deny(d.message!, { kind: d.kind, reason: d.reason });
  if (d.kind === "CONFIRM") {
    // In-thread confirm: the bridge maps the principal's next short yes to approve(); the model re-issues the exact call.
    const fp = fingerprint(toolName, toolInput);
    const open = auth[sender!]?.confirmPending;
    if (open && open.fingerprint !== fp && now - new Date(open.ts).getTime() <= cfg.confirmTtlMs) {
      // A second held action while one is already awaiting a yes voids BOTH: a yes must never approve something he did not see asked (Max HIGH 6a).
      auth[sender!] = { ...(auth[sender!] ?? {}), confirmPending: undefined };
      saveAuth(auth);
      deny("[TEXTING-CONFIRM-VOID] Two different held actions were queued in one turn, so neither is held any more. Ask him about ONE action only, as a single plain question, and re-run only that one after he answers.", { kind: "CONFIRM_VOID", reason: d.reason });
    }
    auth[sender!] = { ...(auth[sender!] ?? {}), confirmPending: { ts: new Date(now).toISOString(), fingerprint: fp, tool: toolName, summary } };
    saveAuth(auth);
    deny(d.message!, { kind: d.kind, reason: d.reason });
  }
  if (d.kind === "CONFIRM_TAP") {
    const ok = await requestTap(approve, summary, fingerprint(toolName, toolInput));
    if (ok) { log("allow_after_tap", { reason: d.reason }); process.exit(0); }
    deny(MSG.CONFIRM_TIMEOUT, { kind: "CONFIRM_TIMEOUT", reason: d.reason });
  }
  deny(MSG.LOCKED, { kind: "UNKNOWN", reason: d.reason });
}

main().catch(failClosed);
export {};
