#!/usr/bin/env bun
// ported from public PR #1857, @xmasyx (offer #1614)
/**
 * UpgradeVerify.ts — deterministic post-upgrade verification for a LifeOS install.
 *
 *   bun UpgradeVerify.ts --baseline          # BEFORE upgrading: snapshot what "healthy" looks like
 *   bun UpgradeVerify.ts                     # AFTER upgrading: verify against the snapshot
 *   bun UpgradeVerify.ts --json              # machine-readable report
 *   bun UpgradeVerify.ts --selftest          # prove the checks can fail (negative poles)
 *
 * WHY THIS EXISTS. An upgrade that ends with "files copied, exit 0" has proven
 * nothing: the failure modes that actually bite are the ones no copy step sees —
 * a hook registered in settings.json whose file vanished, a typecheck error
 * introduced by lib/consumer version skew, a launchd job whose target moved, a
 * dashboard that never came back up, an evidence log written in the OLD format
 * being judged by a NEW fail-closed validator. Every check below encodes an
 * incident one install actually paid for.
 *
 * DESIGN RULES:
 *   - Read-only except for its own state dir. Never repairs, only reports.
 *   - Every check emits ok/warn/critical — no silent branch (a mute branch is
 *     indistinguishable from a branch that never ran).
 *   - Baseline-relative where absolutes lie: a tree can carry pre-existing
 *     typecheck errors that are NOT the upgrade's fault, so the gate is "no NEW
 *     errors vs the pre-upgrade snapshot", not "zero errors".
 *   - Cross-version evidence skew is reported as its own class: when a JSONL
 *     evidence log's newest row PREDATES the upgrade and a validator calls it
 *     invalid, that is "stale evidence, will self-heal", not a broken system —
 *     and saying "critical" there teaches operators to ignore red.
 *   - Generic: no personal data, no hardcoded user paths; root comes from
 *     --root / CLAUDE_CONFIG_DIR / ~/.claude.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

type Severity = "ok" | "warn" | "critical";
interface Finding { id: string; severity: Severity; message: string }

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

const ROOT = val("--root") || getClaudeDir();
const STATE_DIR = val("--state-dir") || join(ROOT, "LIFEOS/MEMORY/STATE/upgrade-verify");
const BASELINE_PATH = join(STATE_DIR, "baseline.json");
const JSON_OUT = flag("--json");
const BASELINE_MODE = flag("--baseline");

const findings: Finding[] = [];
const add = (id: string, severity: Severity, message: string) => findings.push({ id, severity, message });

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out: String(out) };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : -1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

// ── check 1: version file is coherent ────────────────────────────────────────
function checkVersion(): string {
  const p = join(ROOT, "LIFEOS/VERSION");
  if (!existsSync(p)) { add("version-file", "critical", "LIFEOS/VERSION is missing."); return ""; }
  const v = readFileSync(p, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) { add("version-file", "critical", `LIFEOS/VERSION is not a version: "${v}".`); return v; }
  add("version-file", "ok", `installed version ${v}`);
  return v;
}

// ── check 2: typecheck, baseline-relative ────────────────────────────────────
// `bun build` does NOT typecheck; only tsc answers this question. Errors are
// normalized to file+code (columns shift on unrelated edits) and compared as
// sets: NEW errors are the upgrade's, pre-existing ones are yesterday's debt.
export interface TypecheckRun { errors: string[]; incomplete: string[] }

/**
 * Parse ONE tsc invocation. tsc exits 0 clean, 1 or 2 with diagnostics. Anything
 * else (spawn failure, timeout = -1, a signal, a missing bunx, usage text) is an
 * INCOMPLETE run, never "no errors". A non-zero exit with no recognizable
 * diagnostic line is also incomplete: we could not read what tsc said.
 */
export function parseTscRun(label: string, r: { code: number; out: string }): TypecheckRun {
  const errors: string[] = [];
  for (const raw of r.out.split("\n")) {
    const line = raw.trim();
    const located = /^(.+?)\(\d+,\d+\): (error TS\d+)/.exec(line);
    if (located) { errors.push(`${located[1]} ${located[2]}`); continue; }
    const global = /^error (TS\d+)\b/.exec(line); // option/config errors carry no file
    if (global) errors.push(`<global> ${global[1]}`);
  }
  const incomplete: string[] = [];
  if (r.code !== 0 && r.code !== 1 && r.code !== 2) incomplete.push(`${label}: tsc did not finish (exit ${r.code})`);
  else if (r.code !== 0 && errors.length === 0) incomplete.push(`${label}: tsc exited ${r.code} with no recognizable diagnostics`);
  else if (r.code === 0 && errors.length > 0) incomplete.push(`${label}: tsc exited 0 but printed diagnostics`);
  return { errors: [...new Set(errors)].sort(), incomplete };
}

function collectTypecheckErrors(): TypecheckRun {
  const errors: string[] = [];
  const incomplete: string[] = [];
  const projects: string[][] = [["--noEmit"]];
  const pulseCfg = join(ROOT, "LIFEOS/PULSE/tsconfig.typecheck.json");
  if (existsSync(pulseCfg)) projects.push(["--noEmit", "-p", "LIFEOS/PULSE/tsconfig.typecheck.json"]);
  for (const args of projects) {
    const r = parseTscRun(args.includes("-p") ? "pulse project" : "main project", run("bunx", ["tsc", ...args]));
    errors.push(...r.errors);
    incomplete.push(...r.incomplete);
  }
  return { errors: [...new Set(errors)].sort(), incomplete };
}

function checkTypecheck(baseline: string[] | null, baselineProblem: string | null = null): string[] {
  if (!existsSync(join(ROOT, "tsconfig.json"))) { add("typecheck", "critical", "no tsconfig.json at the root — nothing was typechecked, so the upgrade cannot be verified."); return []; }
  const run1 = collectTypecheckErrors();
  if (run1.incomplete.length > 0) { add("typecheck", "critical", `typecheck could not complete, so new errors cannot be ruled out: ${run1.incomplete.join(" · ")}`); return run1.errors; }
  const now = run1.errors;
  // A baseline that exists but cannot be read is "cannot verify", never "no baseline".
  if (baselineProblem !== null) { add("typecheck", "critical", `baseline snapshot ${BASELINE_PATH} is unusable (${baselineProblem}), so ${now.length} current error(s) cannot be attributed — the upgrade is NOT verified. Re-run --baseline on a known-good tree.`); return now; }
  // With no baseline, errors cannot be told apart from damage this upgrade did, so they block; zero errors has nothing to attribute.
  if (baseline === null && now.length > 0) { add("typecheck", "critical", `no baseline snapshot — ${now.length} current typecheck error(s) cannot be attributed to pre-existing debt, so new errors are not ruled out: ${now.slice(0, 5).join(" · ")}${now.length > 5 ? " …" : ""}. Review them, then run --baseline BEFORE the next upgrade.`); return now; }
  if (baseline === null) { add("typecheck", "warn", "no baseline snapshot — 0 current errors, nothing to attribute. Run --baseline BEFORE the next upgrade."); return now; }
  const base = new Set(baseline);
  const fresh = now.filter((e) => !base.has(e));
  const healed = baseline.filter((e) => !now.includes(e));
  if (fresh.length > 0) add("typecheck", "critical", `${fresh.length} NEW typecheck error(s) vs pre-upgrade baseline: ${fresh.slice(0, 5).join(" · ")}${fresh.length > 5 ? " …" : ""}`);
  else add("typecheck", "ok", `no new typecheck errors (${now.length} pre-existing${healed.length ? `, ${healed.length} healed by the upgrade` : ""})`);
  return now;
}

// ── check 3: every registered hook resolves to a real file ───────────────────
// A registration whose file vanished fails EVERY event of that type, and a hook
// file that lost its execute bit or its registration dies silently. Also lists
// hook files on disk that nothing registers — landed-but-inert is a decision
// someone should be able to see, not an accident.
function checkHooks(): void {
  const settingsPath = join(ROOT, "settings.json");
  if (!existsSync(settingsPath)) { add("hooks-registered", "critical", "settings.json missing — no hook registrations at all."); return; }
  let settings: any;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch { add("hooks-registered", "critical", "settings.json does not parse as JSON."); return; }
  const commands: string[] = [];
  for (const matchers of Object.values(settings.hooks ?? {}) as any[]) {
    for (const m of matchers ?? []) for (const h of m.hooks ?? []) if (h.command) commands.push(String(h.command));
  }
  const missing: string[] = [];
  const referenced = new Set<string>();
  for (const cmd of commands) {
    // The extension must END the token: without the boundary, "settings.system.json"
    // matches as "settings.system.js" and the check reports ghosts (paid on first run).
    for (const m of cmd.matchAll(/([^\s"']+\.(?:hook\.ts|ts|sh|js))(?=$|[\s"'])/g)) {
      let p = m[1]
        .replace(/\$LIFEOS_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, ROOT)
        .replace(/\$HOME|\$\{HOME\}/g, process.env.HOME || homedir())
        .replace(/^~(?=\/)/, process.env.HOME || homedir());
      if (!isAbsolute(p)) p = join(ROOT, p);
      referenced.add(p);
      if (!existsSync(p)) missing.push(p);
    }
  }
  if (missing.length > 0) add("hooks-registered", "critical", `${missing.length} registered hook file(s) do not exist: ${missing.slice(0, 4).join(", ")}`);
  else add("hooks-registered", "ok", `${referenced.size} registered hook/script file(s) all exist on disk`);

  const hooksDir = join(ROOT, "hooks");
  if (existsSync(hooksDir)) {
    const onDisk = readdirSync(hooksDir).filter((f) => f.endsWith(".hook.ts"));
    const direct = onDisk.filter((f) => [...referenced].some((r) => r.endsWith(`/${f}`)) || commands.some((c) => c.includes(f)));
    // Registration is not the only way a hook runs: an aggregator hook (e.g. a
    // Stop gate runner) IMPORTS sibling hooks, and those are live without any
    // settings.json line. Only a file neither registered nor imported by a live
    // hook is truly inert — the class an upgrade quietly creates.
    const reachable = new Set(direct);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of [...reachable]) {
        let src = "";
        try { src = readFileSync(join(hooksDir, f), "utf8"); } catch { continue; }
        for (const m of src.matchAll(/from\s+["']\.\/([A-Za-z0-9_-]+\.hook)["']/g)) {
          const dep = `${m[1]}.ts`;
          if (onDisk.includes(dep) && !reachable.has(dep)) { reachable.add(dep); grew = true; }
        }
      }
    }
    const inert = onDisk.filter((f) => !reachable.has(f));
    if (inert.length > 0) add("hooks-inert", "warn", `${inert.length} hook file(s) neither registered nor imported by a live hook (landed-but-inert): ${inert.slice(0, 8).join(", ")}${inert.length > 8 ? " …" : ""}`);
    else add("hooks-inert", "ok", "every hook file on disk is registered or imported by a live hook");
  }
}

// ── check 4: local-delta registry verification (if this install keeps one) ───
function checkLocalDelta(): void {
  const verifier = join(ROOT, "LIFEOS/TOOLS/VerifyLocalPatches.ts");
  const registry = join(ROOT, "LIFEOS/USER/CONFIG/LocalPatches.json");
  if (!existsSync(registry)) { add("local-delta", "ok", "no local-delta registry on this install — nothing to verify"); return; }
  // A registry is a promise that patches are tracked: a missing verifier means they cannot be checked, never "nothing to verify".
  if (!existsSync(verifier)) { add("local-delta", "critical", `local-delta registry exists but its verifier ${verifier} is missing — patch survival is NOT verified.`); return; }
  const r = run("bun", [verifier], { timeout: 600_000 });
  const summary = /Summary:.*$/m.exec(r.out)?.[0] ?? /Riepilogo:.*$/m.exec(r.out)?.[0] ?? ""; // both spellings: the verifier may be localized
  const regressed = /(\d+)\s+REGRESSED/i.exec(r.out)?.[1] ?? /(\d+)\s+rotte/.exec(r.out)?.[1];
  // A crash, a timeout (-1) or output we cannot read is "cannot verify", never clean.
  if (summary === "" || regressed === undefined) {
    add("local-delta", "critical", `local-delta verifier gave no recognizable result (exit ${r.code}, ${summary === "" ? "no summary line" : "no regression count"}) — patch survival is NOT verified.`);
  } else if (regressed !== "0") {
    add("local-delta", "critical", `local-delta verifier reports regressions — ${summary}`);
  } else if (r.code !== 0) {
    add("local-delta", "critical", `local-delta verifier counted 0 regressions but exited ${r.code} — treating the run as failed. ${summary}`);
  } else add("local-delta", "ok", summary);
}

// ── check 5: launchd jobs point at files that still exist (macOS) ────────────
// Paid lesson: a plist survives every migration, its target does not — and a
// relative ProgramArguments entry must resolve against WorkingDirectory before
// being called missing (a naive absolute-only probe reports a false red).
function checkLaunchd(): void {
  if (process.platform !== "darwin") { add("launchd", "ok", "not macOS — skipped"); return; }
  const dir = join(process.env.HOME || homedir(), "Library/LaunchAgents");
  if (!existsSync(dir)) { add("launchd", "ok", "no LaunchAgents dir"); return; }
  const broken: string[] = [];
  const uninspectable: string[] = [];
  let inspected = 0;
  // PlistBuddy exits non-zero both for an absent key (legitimate: "Does Not Exist")
  // and for a malformed plist, a timeout or a missing binary (not legitimate).
  const readKey = (key: string, p: string): { ok: boolean; out: string } => {
    const r = run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, p], { timeout: 10_000 });
    if (r.code === 0) return { ok: true, out: r.out };
    if (r.code === 1 && /Does Not Exist/i.test(r.out) && !/Doesn't Exist, Will Create/i.test(r.out)) return { ok: true, out: "" };
    return { ok: false, out: r.out };
  };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".plist"))) {
    const p = join(dir, f);
    const pa = readKey("ProgramArguments", p);
    const wdr = readKey("WorkingDirectory", p);
    if (!pa.ok || !wdr.ok) { uninspectable.push(f); continue; }
    const wd = wdr.out.trim();
    const target = pa.out.split("\n").map((l) => l.trim()).find((l) => /\.(ts|sh|js)$/.test(l));
    if (!target) continue;
    inspected++;
    const resolved = isAbsolute(target) ? target : join(wd && existsSync(wd) ? wd : ROOT, target);
    if (!existsSync(resolved)) broken.push(`${f} → ${target}`);
  }
  if (uninspectable.length > 0) add("launchd", "critical", `${uninspectable.length} launchd plist(s) could not be inspected (malformed, unreadable or timed out), so their targets are unverified: ${uninspectable.slice(0, 6).join(", ")}${broken.length ? ` · plus ${broken.length} job(s) pointing at missing files: ${broken.join(" · ")}` : ""}`);
  else if (broken.length > 0) add("launchd", "critical", `${broken.length} launchd job(s) point at missing files: ${broken.join(" · ")}`);
  else add("launchd", "ok", `${inspected} launchd job target(s) all exist`);
}

// ── check 6: local services came back up ─────────────────────────────────────
function checkServices(): void {
  const toml = join(ROOT, "LIFEOS/PULSE/PULSE.toml");
  if (!existsSync(toml)) { add("services", "ok", "no PULSE.toml — no local service expected"); return; }
  const port = /^\s*port\s*=\s*(\d+)/m.exec(readFileSync(toml, "utf8"))?.[1] ?? "31337";
  const r = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://localhost:${port}/`], { timeout: 10_000 });
  // curl can print 200 and still fail (timeout 28, transfer errors 18/56): both the exit and the status must be clean.
  if (r.code === 0 && r.out.trim() === "200") add("services", "ok", `dashboard answers 200 on :${port}`);
  else add("services", "critical", `dashboard on :${port} did not answer cleanly (curl exit ${r.code}, HTTP "${r.out.trim() || "nothing"}") — it did not come back after the upgrade.`);
}

// ── check 7: statusline renders ──────────────────────────────────────────────
function checkStatusline(): void {
  const script = join(ROOT, "LIFEOS/LIFEOS_StatusLine.sh");
  if (!existsSync(script)) { add("statusline", "ok", "no statusline script — skipped"); return; }
  const stdin = JSON.stringify({ session_id: "upgrade-verify", cwd: ROOT, model: { id: "verify", display_name: "verify" }, workspace: { current_dir: ROOT } });
  try {
    const out = execFileSync("bash", [script], { encoding: "utf8", input: stdin, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000, cwd: ROOT });
    if (out.trim().length > 0) add("statusline", "ok", "statusline renders non-empty output");
    else add("statusline", "critical", "statusline produced zero bytes");
  } catch { add("statusline", "critical", "statusline script crashed"); }
}

// ── check 8: cross-version evidence skew ─────────────────────────────────────
// The class this release taught us: an upgrade swaps a validator to a stricter
// row shape, the newest evidence row PREDATES the upgrade, and the system goes
// red while being perfectly healthy. Detect it and NAME it, so the operator
// reads "will self-heal on the next producer run" instead of debugging a ghost.
const HEALTH_STATES = new Set(["ok", "warn", "critical"]);
function checkEvidenceSkew(upgradeAtMs: number | null): void {
  const healthLog = join(ROOT, "LIFEOS/MEMORY/OBSERVABILITY/memory-health.jsonl");
  if (!existsSync(healthLog) || upgradeAtMs === null) { add("evidence-skew", "ok", "no health log or no upgrade timestamp — skipped"); return; }
  const lines = readFileSync(healthLog, "utf8").trim().split("\n");
  let latest: any = null;
  try { latest = JSON.parse(lines[lines.length - 1]); } catch { /* handled below */ }
  // Unreadable evidence is "cannot verify", not a warning: a warning ends in a verified exit.
  if (latest === null || typeof latest !== "object" || Array.isArray(latest)) { add("evidence-skew", "critical", "newest memory-health row is unreadable or not an object — memory health cannot be verified."); return; }
  // Only a known health state counts: a row with no overall (or an unknown one) is unverified evidence, never ok.
  if (!HEALTH_STATES.has(latest.overall)) { add("evidence-skew", "critical", `newest memory-health row has no valid overall state (got ${JSON.stringify(latest.overall ?? null)}) — memory health cannot be verified.`); return; }
  if (latest.overall !== "critical") { add("evidence-skew", "ok", `memory health is "${latest.overall}"`); return; }
  const producerLog = join(ROOT, "LIFEOS/MEMORY/OBSERVABILITY/reviewer-runs.jsonl");
  let producerTs: number | null = null;
  if (existsSync(producerLog)) {
    try { producerTs = Date.parse(JSON.parse(readFileSync(producerLog, "utf8").trim().split("\n").at(-1)!).ts); } catch { /* leave null */ }
  }
  if (producerTs !== null && producerTs < upgradeAtMs) {
    add("evidence-skew", "warn", "memory health is critical but the newest evidence row PREDATES the upgrade: old-format evidence judged by the new validator. Self-heals on the next producer run — re-run this check after one; escalate only if it stays critical.");
  } else {
    add("evidence-skew", "critical", "memory health is critical on evidence produced AFTER the upgrade — this is real, not transitional.");
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main(): void {
  const version = checkVersion();
  let baseline: { version: string; when: string; typecheckErrors: string[] } | null = null;
  let baselineProblem: string | null = null;
  if (existsSync(BASELINE_PATH)) {
    let parsed: any = null;
    try { parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch (e) { baselineProblem = `does not parse: ${(e as Error).message}`; }
    if (baselineProblem === null) {
      const shapeOk = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && Array.isArray(parsed.typecheckErrors) && parsed.typecheckErrors.every((x: unknown) => typeof x === "string")
        && typeof parsed.when === "string" && !Number.isNaN(Date.parse(parsed.when));
      if (shapeOk) baseline = parsed; else baselineProblem = "wrong shape: needs typecheckErrors as a string array and a parseable when";
    }
  }

  if (BASELINE_MODE) {
    const tc = collectTypecheckErrors();
    if (!existsSync(join(ROOT, "tsconfig.json")) || tc.incomplete.length > 0) {
      console.error(`baseline NOT written: typecheck did not complete (${!existsSync(join(ROOT, "tsconfig.json")) ? "no tsconfig.json" : tc.incomplete.join(" · ")}). A partial baseline would hide real errors from the next upgrade.`);
      process.exit(1);
    }
    const errors = tc.errors;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify({ version, when: new Date().toISOString(), typecheckErrors: errors }, null, 2));
    console.log(`baseline written: v${version}, ${errors.length} pre-existing typecheck error(s) → ${BASELINE_PATH}`);
    process.exit(0);
  }

  checkTypecheck(baseline?.typecheckErrors ?? null, baselineProblem);
  checkHooks();
  checkLocalDelta();
  checkLaunchd();
  checkServices();
  checkStatusline();
  checkEvidenceSkew(baseline ? Date.parse(baseline.when) : null);

  const criticals = findings.filter((f) => f.severity === "critical");
  const warns = findings.filter((f) => f.severity === "warn");

  // --decisions [path]: render the findings that are DECISIONS rather than defects
  // as an answer sheet the operator fills in — one question per finding, each with
  // a recommended answer and the reason, an empty "Answer:" line under each. An
  // upgrade's leftovers (inert hooks, unattributed typecheck debt, stale evidence)
  // are choices someone should make once, on paper — not warnings to re-read forever.
  const decisionsIdx = argv.indexOf("--decisions");
  if (decisionsIdx >= 0) {
    const outPath = argv[decisionsIdx + 1] && !argv[decisionsIdx + 1].startsWith("--")
      ? argv[decisionsIdx + 1]
      : join(STATE_DIR, `decisions-v${version}.md`);
    const q: string[] = [
      `# Post-upgrade decisions — v${version}`,
      "",
      `Generated by UpgradeVerify on ${new Date().toISOString().slice(0, 10)}. Answer under each`,
      "question, then act on the answers — this file never acts on its own.",
      "",
    ];
    let n = 0;
    for (const f of findings) {
      if (f.severity === "ok") continue;
      n++;
      q.push(`## ${n}. [${f.severity.toUpperCase()}] ${f.id}`, "", f.message, "");
      if (f.id === "hooks-inert") q.push("**Recommended:** read each listed hook, then register the ones whose rule you want enforced; leave the rest inert deliberately (write the reason next to the name).", "");
      else if (f.id === "typecheck" && f.severity === "warn") q.push("**Recommended:** run `--baseline` now so the NEXT upgrade can tell its own damage from pre-existing debt.", "");
      else if (f.id === "evidence-skew") q.push("**Recommended:** wait one producer run, re-verify; escalate only if still critical.", "");
      else q.push("**Recommended:** fix before trusting the upgrade — a critical here is a verified breakage, not an opinion.", "");
      q.push("Answer:", "", "---", "");
    }
    if (n === 0) q.push("Nothing to decide: every check is green.", "");
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(outPath, q.join("\n"));
    console.log(`decisions sheet: ${outPath} (${n} open item${n === 1 ? "" : "s"})`);
  }

  if (JSON_OUT) console.log(JSON.stringify({ version, baseline: baseline ? { version: baseline.version, when: baseline.when } : null, overall: criticals.length ? "critical" : warns.length ? "warn" : "ok", findings }, null, 2));
  else {
    console.log(`UpgradeVerify — v${version}${baseline ? ` (baseline: v${baseline.version} @ ${baseline.when})` : " (NO baseline)"}`);
    for (const f of findings) console.log(`  ${f.severity === "ok" ? "✅" : f.severity === "warn" ? "⚠️ " : "🔴"} ${f.id}: ${f.message}`);
    console.log(criticals.length ? `\nVERDICT: ${criticals.length} critical — the upgrade is NOT verified.` : warns.length ? `\nVERDICT: verified with ${warns.length} warning(s).` : "\nVERDICT: verified.");
  }
  process.exit(criticals.length ? 1 : 0);
}

// ── selftest: prove the checks CAN fail ──────────────────────────────────────
// A gate never seen red is an assertion dressed as a verification. Fixture
// trees drive the two poles of the hook check; the others are exercised through
// the same code paths on the fixture root.
function selftest(): void {
  const root = mkdtempSync(join(tmpdir(), "upgrade-verify-selftest-"));
  const results: string[] = [];
  const expect = (name: string, cond: boolean) => { results.push(`${cond ? "✅" : "🔴"} ${name}`); if (!cond) process.exitCode = 1; };
  try {
    // Fixture: a root whose settings.json registers a hook that does not exist.
    mkdirSync(join(root, "LIFEOS"), { recursive: true });
    writeFileSync(join(root, "LIFEOS/VERSION"), "1.0.0\n");
    writeFileSync(join(root, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `bun "${root}/hooks/Ghost.hook.ts"` }] }] } }));
    mkdirSync(join(root, "hooks"), { recursive: true });
    let r = run("bun", [import.meta.path, "--root", root, "--json"], { timeout: 600_000 });
    expect("negative pole: missing registered hook → exit 1 + critical", r.code === 1 && /hooks-registered[\s\S]*critical|critical[\s\S]*hooks-registered/.test(r.out) && r.out.includes("Ghost.hook.ts"));
    // Positive pole: register a hook that exists → that check goes ok.
    writeFileSync(join(root, "hooks/Real.hook.ts"), "// present\n");
    writeFileSync(join(root, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `bun "${root}/hooks/Real.hook.ts"` }] }] } }));
    r = run("bun", [import.meta.path, "--root", root, "--json"], { timeout: 600_000 });
    const parsed = JSON.parse(r.out);
    const hookFinding = parsed.findings.find((f: Finding) => f.id === "hooks-registered");
    expect("positive pole: existing registered hook → hooks-registered ok", hookFinding?.severity === "ok");
    // Version pole: a garbage VERSION must be critical.
    writeFileSync(join(root, "LIFEOS/VERSION"), "not-a-version\n");
    r = run("bun", [import.meta.path, "--root", root, "--json"], { timeout: 600_000 });
    expect("negative pole: garbage VERSION → critical", r.code === 1 && /version-file[\s\S]*critical|critical[\s\S]*version-file/.test(r.out));
    // Decisions pole: --decisions writes an answer sheet carrying the open items.
    writeFileSync(join(root, "LIFEOS/VERSION"), "1.0.0\n");
    const sheet = join(root, "decisions.md");
    r = run("bun", [import.meta.path, "--root", root, "--state-dir", join(root, "state"), "--decisions", sheet], { timeout: 600_000 });
    const sheetText = existsSync(sheet) ? readFileSync(sheet, "utf8") : "";
    expect("decisions pole: sheet written with open items and Answer: slots", sheetText.includes("Answer:") && /## \d+\./.test(sheetText));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(results.join("\n"));
  console.log(process.exitCode ? "SELFTEST: FAILED" : "SELFTEST: all poles hold");
}

if (import.meta.main) {
  if (flag("--selftest")) selftest();
  else main();
}
