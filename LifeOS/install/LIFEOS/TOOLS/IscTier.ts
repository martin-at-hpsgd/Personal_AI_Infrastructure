#!/usr/bin/env bun
/**
 * IscTier — the migration tool that moves a `manual` Test Strategy row down the
 * four-tier ladder (code · glance · judge · human) without anyone hand-editing
 * an ISA table.
 *
 * Born in 20260922-isc-eval-tiers F3 (ISC-14 … ISC-17). An estate can carry
 * far more `manual` rows than judged ones: every one of those is a criterion
 * nobody has written a checker for. This tool reads them, says which could be
 * code, which could be one typed Glance question, and which are genuinely
 * taste — and then waits. A person ratifies; only then does `apply` write.
 *
 *   bun LIFEOS/TOOLS/IscTier.ts triage   --estate [--offline] [--out <dir>]
 *   bun LIFEOS/TOOLS/IscTier.ts propose  <isa> [--offline] [--cwd <dir>] [--out <file>]
 *   bun LIFEOS/TOOLS/IscTier.ts backfill <isa> [--all] [--seeds <dir>] [--json]
 *   bun LIFEOS/TOOLS/IscTier.ts shadow   <isa> [--proposal <file>]
 *   bun LIFEOS/TOOLS/IscTier.ts apply    <isa> --proposal <file> [--dry-run]
 *
 * Uses Assay's judgment layer (engine: Clef-omni) — see LIFEOS/DOCUMENTATION/Assay/AssaySystem.md § Judgment layer.
 * Two callers, both SHADOW, both registered in LIFEOS/USER/CONFIG/assay-callers.json
 * and described in RouterSystem.md § Data class per caller:
 *   `isc-tier-classify`  — `propose` asks which tier a manual row belongs on. The
 *                          answer is a DRAFT a person ratifies; nothing acts on it,
 *                          and a disabled engine falls back to a keyword pass.
 *   `isc-tier-shadow`    — `shadow` runs each proposed question once against current
 *                          state so an agreement rate exists before ratification.
 * Neither ever decides anything: `decide()` is the only thing that may say act, and
 * a shadow caller never gets `act: true`.
 *
 * Four rules this file exists to keep:
 *   1. `propose` NEVER writes to the ISA. It writes one proposal file beside it.
 *   2. `apply` refuses without `--proposal`, and applies only `ratified: true`
 *      rows (ISA anti-criterion A2 — no ISC migrates without a ratification record).
 *   3. No numeric threshold literal lives here. Thresholds are the caller
 *      registry's, and `decide()` is the only thing that may read one.
 *   4. Every command completes with LIFEOS_GLANCE_DISABLED=1. Classification
 *      falls back to a deterministic keyword pass and says so in the proposal.
 *
 * @author LifeOS System
 * @version 1.0.8
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { invariant } from "./Invariant.ts";
import { lifeosPath } from "./Paths.ts";
import { parseIsaClaims, isaBody, type IsaClaim } from "./lib/IsaClaims.ts";
import { isProbeType, parseTestStrategyDiagnostic, type Probe } from "./lib/IsaTestStrategy.ts";
import { isaKeyOf, seedsDir, type CalEntry } from "./lib/Calibration.ts";
import { addSeedEntry, adoptSeedFile, amendSeedEntry, seedViewOf, writeSeedView } from "./lib/LabelStore.ts";
const attestPath = join(import.meta.dir, "../PULSE/Bunker/src/attest.ts");
const attest = existsSync(attestPath) ? await import(attestPath) : undefined;
function requireAttest() {
  invariant(attest, "Bunker attestation is not installed; backfill requires Bunker");
  return attest;
}
import { decide, judgeMany, safeCallerConfig, thresholdRows, yesAt, type ManyResult } from "../ASSAY/Assay.ts";
import { redactForEngine } from "../ASSAY/Engine.ts";
import { PRODUCER_COMMANDS, engineQuestion, pinProducerArgv, validateProducer, readOnlyRefusal, type Producer } from "./lib/GlanceQuestion.ts";
import { atomicWrite } from "./lib/Boundary.ts";
import { discoverStateSources, executeStateSource, matchStateSource, sourceEnv, type SourceCatalog } from "./lib/StateSources.ts";
import { runSandboxed, type SandboxSeams } from "./lib/Sandbox.ts";
import {
  PROPOSAL_VERSION, glancePointer, isTrivial, joinRow, legacyProposalPathFor, parseProposal,
  PROPOSAL_DIR, PROPOSAL_FILENAME, proposalPathFor, questionStem, renderProposal, resolveColumns, satisfies, sha256, splitRow,
  MUTATION_BAR_ID, baselineAnswer, massOnBaseline, mutationTestable, stateText,
  shapeState, validateQuestionFile, firstTermMatch, mutateState,
  isTextGrep, negateExpectation, renderSolBrief, satisfiesNegated,
  type Classification, type ClassifierPath, type DraftedAssert, type DryRun, type Expectation,
  type Confirmation, type IscQuestionFile, type IscTierProposal, type MutationReport, type ProposalRow,
  type AssertSource, type Discrimination, type ScoreDirection, type SolBrief, type StateShaping,
} from "./lib/IscTierProposal.ts";

export const CLASSIFY_CALLER = "isc-tier-classify";
export const SHADOW_CALLER = "isc-tier-shadow";

/** How long a drafted assert or a state producer may run. Not a probability; not a threshold. */
const RUN_TIMEOUT_MS = 15_000;
/** How much of a command's or producer's output is kept. */
const MAX_OUTPUT_CHARS = 8_000;

// ── Environment hygiene ─────────────────────────────────────────────────────

/**
 * Every vendor credential is removed before a drafted assert or a state
 * producer runs (ISC-23). The rule is shape-based, never a list of names we
 * remembered to add: anything that looks like a key, token, secret, password or
 * credential goes, plus the session's own API-lane variables.
 */
export function strippedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return sourceEnv(env);
}

/**
 * A drafted command must be able only to LOOK. `propose` writing to the ISA
 * through a command it drafted would defeat ISC-14 structurally, so the refusal
 * is here rather than in the drafting code that is supposed to be careful.
 */
const WRITE_SHAPES = /(^|[\s;&|])(rm|mv|cp|tee|truncate|dd|install|chmod|chown|mkdir|touch|git\s+(?:add|commit|checkout|reset|apply|stash))\s|>{1,2}|sed\s+-i|perl\s+-i/;

export function refusesToRun(command: string): string | null {
  if (WRITE_SHAPES.test(command)) return "command can write; propose only looks";
  if (command.length > 600) return "command is too long to read before ratifying";
  return null;
}

export interface RunResult { exit: number | null; stdout: string; stderr: string }

/** Run a bounded shell one-liner with every credential stripped. Never throws. */
export function runBounded(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): RunResult {
  try {
    const p = Bun.spawnSync(["bash", "-lc", command], {
      cwd, env: strippedEnv(env), stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS,
    });
    const cut = (b: Uint8Array): string => {
      const s = new TextDecoder().decode(b);
      return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)} …` : s;
    };
    return { exit: p.exitCode, stdout: cut(p.stdout), stderr: cut(p.stderr) };
  } catch (e) {
    return { exit: null, stdout: "", stderr: (e as Error)?.message ?? String(e) };
  }
}

/**
 * A spawned curl reads ~/.curlrc before its own arguments, so a planted rc file
 * can add an output file, a proxy or a header to a probe that was validated as
 * read-only. `-q` as the FIRST argument is the only form curl honours for
 * skipping it. Applied to every curl this tool spawns.
 */
export function withCurlQ(argv: string[]): string[] {
  return argv[0] === "curl" && argv[1] !== "-q" ? ["curl", "-q", ...argv.slice(1)] : argv;
}

/** A probe that runs with no shell: argv, plus an optional in-process line count standing in for `| rg -ic <needle>`. */
export interface ProbeExec { argv: string[]; countLines?: string }

/**
 * An unratified probe's run: the argv inside the read-only OS sandbox (lib/Sandbox.ts), credentials stripped,
 * bounded by RUN_TIMEOUT_MS. Criterion text chose this command or the test file it runs and nobody has ratified
 * it, so it may read but never write outside the temp dirs and the bun cache, and only a curl reaches the network
 *. Where the sandbox cannot be applied nothing runs and `refused` says why.
 *
 * Network is granted to a curl only in the form GlanceQuestion.pinProducerArgv returns, the one shared pin a
 * producer also meets: the GET-only option allowlist and literal-destination policy, every URL operand executed as
 * the canonical href that was checked, every host resolved once with every answer public, curl pinned to that
 * address with `--resolve`, proxies off, globbing off and `-q` first. A URL assert drafted from criterion text took
 * this path with no destination check at all and reached loopback services (S074). The pin never trusts an earlier
 * one: given validateProducer's already-pinned argv it strips the pins and pins again from a fresh lookup, so the
 * argv a producer was validated as is the argv that runs (a local re-check here once refused its own --noproxy and
 * broke every curl producer). Anything pinProducerArgv throws on is refused, never run unpinned.
 */
export type ConfinedSeams = SandboxSeams & {
  /** Resolution seam for curl destinations; defaults to pinProducerArgv's one-shot system lookup. Throws when the name does not resolve. */
  resolveHost?: (host: string) => string[];
};
export function runConfined(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, seams: ConfinedSeams = {}): { exit: number | null; stdout: string; stderr: string; refused?: string } {
  const { resolveHost, ...sandboxSeams } = seams;
  let run = withoutDotEnv(argv);
  if (run[0] === "curl") {
    try {
      run = pinProducerArgv(withoutBareQ(run), resolveHost);
    } catch (e) {
      const refused = `URL probe refused: ${(e as Error)?.message ?? String(e)}`;
      return { exit: null, stdout: "", stderr: refused, refused };
    }
    invariant(run[0] === "curl" && run[1] === "-q", "a networked curl is spawned only in the pinned form, -q first");
  }
  const r = runSandboxed(run, { ...sandboxSeams, cwd, env: strippedEnv(env), timeoutMs: RUN_TIMEOUT_MS, network: run[0] === "curl" });
  if (!r.ran) return { exit: null, stdout: "", stderr: r.err, refused: r.err };
  return { exit: r.code, stdout: r.out, stderr: r.err };
}

/**
 * A probe argv carries a bare leading `-q` (assertSourceFor writes it so the stored bash command skips ~/.curlrc
 * too). pinProducerArgv accepts `-q` only as the start of its own pinned form and puts it back first itself, so a
 * bare one is dropped here. A `-q` that opens the pinned form is left for pinProducerArgv to strip and re-pin, and
 * any other `-q` reaches it as written and is refused.
 */
function withoutBareQ(argv: string[]): string[] {
  return argv[0] === "curl" && argv[1] === "-q" && argv[2] !== "--noproxy" ? ["curl", ...argv.slice(2)] : argv;
}

/**
 * bun loads the cwd's `.env` before anything else, and the sandbox denies every `.env` read, so a confined
 * `bun test` in a repo holding one died with PermissionDenied (measured in this install). Pointing bun at
 * /dev/null keeps it from reading the secrets file at all, which an unratified probe never should (the stripped
 * environment alone did not stop bun re-loading them). A bun call that already names an env file is left alone.
 */
export function withoutDotEnv(argv: string[]): string[] {
  if (argv[0] !== "bun" || argv.some((a) => a === "--env-file" || a.startsWith("--env-file="))) return argv;
  return ["bun", "--env-file=/dev/null", ...argv.slice(1)];
}

/** runBounded for an unratified command (a criterion's quoted command): the same bash one-liner, confined read-only. */
export function runBoundedConfined(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env, seams: SandboxSeams = {}): RunResult & { refused?: string } {
  const r = runConfined(["bash", "-lc", command], cwd, env, seams);
  const cut = (s: string): string => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)} …` : s);
  return { exit: r.exit, stdout: cut(r.stdout), stderr: cut(r.stderr), ...(r.refused ? { refused: r.refused } : {}) };
}

/** Run a probe argv confined, credentials stripped. Never throws; a failed curl is a nonzero exit, not an empty success. */
export function runArgv(exec: ProbeExec, cwd: string, env: NodeJS.ProcessEnv = process.env, seams: ConfinedSeams = {}): RunResult & { refused?: string } {
  try {
    const p = runConfined(exec.argv, cwd, env, seams);
    const cut = (s: string): string => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)} …` : s);
    if (p.refused) return { exit: null, stdout: "", stderr: cut(p.stderr), refused: p.refused };
    const stdout = p.stdout;
    const stderr = cut(p.stderr);
    if (exec.countLines === undefined) return { exit: p.exit, stdout: cut(stdout), stderr };
    // The pipeline form masked a failed curl behind rg's exit code. Here the
    // fetch has to succeed before there is anything to count.
    if (p.exit !== 0) return { exit: p.exit, stdout: "", stderr };
    const needle = exec.countLines.toLowerCase();
    const n = stdout.split(/\r?\n/).filter((l) => l.toLowerCase().includes(needle)).length;
    return { exit: n > 0 ? 0 : 1, stdout: `${n}\n`, stderr };
  } catch (e) {
    return { exit: null, stdout: "", stderr: (e as Error)?.message ?? String(e) };
  }
}

/**
 * The URL a criterion names, or null. Criterion text is data written by anyone
 * who can edit an ISA, so it is parsed as a URL, never trusted as a word of
 * shell: http(s) only, no control characters, no embedded credentials. The
 * returned string is still only ever passed as one argv element, or single
 * quoted when it has to be written into a stored command.
 */
export function probeUrlFrom(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s`'"<>)\]]+/);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?]+$/, "");
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return null;
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "" || u.username !== "" || u.password !== "") return null;
  } catch { return null; }
  return url;
}

/** A word safe to write unquoted into a producer or command line; anything else is single quoted. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9._~:/?=%+,@-]+$/.test(s) ? s : shellQuote(s);
}

// ── State producers ─────────────────────────────────────────────────────────
//
// A glance question points at state that already exists. Two producer forms are
// allowed (ISC-23): `file:<relative path>`, read under the ISA directory after
// realpath resolution — the lexical check is bypassable through a symlinked
// path component, so the boundary test runs on the dereferenced path — and a
// shell command, run bounded with credentials stripped. Either way the result
// passes through redactForEngine before it can reach the engine.

/** The state is what the engine will be shown, so it is narrowed to the shapes Glance accepts. */
export interface ProducedState {
  ok: boolean;
  state: string | object | null;
  error?: string;
  /** Exit code of a command producer; null for a file read or a refusal. */
  exit?: number | null;
  /** Bytes the producer emitted before redaction. Zero output is a failure, not a state. */
  bytes?: number;
  /** How the raw output was turned into state. Absent when it went through as emitted. */
  shaping?: StateShaping;
  /** The criterion term the region window was centred on, when one was. */
  term?: string;
}

/**
 * Run a producer through the canonical allowlist (`validateProducer`, ISC-23),
 * which parses it WITHOUT a shell and refuses anything outside the command set
 * or reaching a denied zone. Two forms come back: a file inside the ISA
 * directory, or an argv to execute. Nothing else runs.
 *
 * An empty result is a failure. A question asked about nothing gets an answer
 * about nothing, and that answer looks exactly like a real one.
 */
export function runProducer(producer: string, isaDir: string, cwd: string, env: NodeJS.ProcessEnv = process.env, claim = "", seams: ConfinedSeams = {}): ProducedState {
  const mutates = readOnlyRefusal(producer, isaDir);
  if (mutates) return { ok: false, state: null, error: `producer refused: ${mutates}` };
  let parsed: Producer;
  try {
    parsed = validateProducer(producer, join(isaDir, "ISA.md"), { resolveHost: seams.resolveHost });
  } catch (e) {
    return { ok: false, state: null, error: (e as Error).message };
  }
  if ("source" in parsed) {
    try {
      // The same resolution seam as a curl producer, so an http-json source is pinned from the same lookup.
      const text = executeStateSource(producer, isaDir, env, undefined, seams.resolveHost);
      return { ok: true, state: JSON.parse(text), exit: 0, bytes: Buffer.byteLength(text) };
    } catch (e) { return { ok: false, state: null, error: (e as Error).message }; }
  }
  if ("file" in parsed) {
    try {
      // validateProducer hands back a REALPATH, so the directory it is made
      // relative to has to be dereferenced too or every path comes back as a
      // ladder of "..": on macOS the temp dir is a symlink.
      let root = isaDir;
      try { root = realpathSync(isaDir); } catch { /* keep the lexical one */ }
      const rel = relative(root, parsed.file);
      const text = readFileSync(parsed.file, "utf8");
      if (text.trim() === "") return { ok: false, state: null, bytes: 0, error: `producer read ${rel} and it was empty` };
      const shaped = shapeState(text, claim, MAX_OUTPUT_CHARS);
      return {
        ok: true, bytes: Buffer.byteLength(text), exit: null, shaping: shaped.shaping, term: shaped.term,
        state: { path: rel, text: redactForEngine(shaped.text, MAX_OUTPUT_CHARS) },
      };
    } catch (e) { return { ok: false, state: null, error: (e as Error).message }; }
  }
  // A producer is read-only by contract, so it runs inside the read-only sandbox.
  let out: { exitCode: number | null; stdout: string; stderr: string };
  try {
    const r = runConfined(parsed.argv, cwd, env, seams);
    if (r.refused) return { ok: false, state: null, error: `producer could not run: ${r.refused}` };
    out = { exitCode: r.exit, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { ok: false, state: null, error: `producer could not run: ${(e as Error)?.message ?? e}` };
  }
  const raw = out.stdout;
  const bytes = Buffer.byteLength(out.stdout);
  if (out.exitCode !== 0) {
    return { ok: false, state: null, exit: out.exitCode, bytes, error: `producer exited ${out.exitCode === null ? "abnormally" : out.exitCode}: ${out.stderr.trim().slice(0, 200)}` };
  }
  if (raw.trim() === "") return { ok: false, state: null, exit: out.exitCode, bytes, error: "producer succeeded but returned nothing" };
  // Shaping runs BEFORE the cap. Capping first is what threw the criterion's own
  // subject away and left the engine reading <head>.
  const shaped = shapeState(raw, claim, MAX_OUTPUT_CHARS);
  const text = redactForEngine(shaped.text, MAX_OUTPUT_CHARS);
  const common = { ok: true as const, exit: out.exitCode, bytes, shaping: shaped.shaping, term: shaped.term };
  try {
    const value: unknown = JSON.parse(text);
    return { ...common, state: value !== null && typeof value === "object" ? (value as object) : { value } };
  } catch { return { ...common, state: { stdout: text } }; }
}

// ── Boundary producers (ISC-27) ─────────────────────────────────────────────
//
// A glance question is only as good as the state it reads. Defaulting every
// question to the ISA's own text made the engine answer questions about the
// SPEC rather than about the thing the spec is about, which is why rows of a site
// ISA came back with a "no" baseline: the criterion was true of the site and
// absent from the ISA prose. The state has to be fetched at the consumer
// boundary the ISA names — the live URL, the build, the CLI invocation.

export interface BoundaryContext {
  isaDir: string;
  sources?: SourceCatalog;
  /** The app's live domain, from its PROJECTS.md row or the ISA frontmatter. */
  domain?: string;
  /** A build/deploy script name from the repo's package.json. */
  buildScript?: string;
  /** The ISA's own filename, for criteria genuinely about the ISA. */
  isaFile: string;
}

export interface DraftedProducer { producer: string; boundary: string }

/**
 * A producer READS. It never changes anything.
 *
 * This exists because it was missing and the gap bit immediately: a site
 * criterion quoted `bun run deploy` to describe its own deploy gate, the
 * quoted-command rule adopted it because `bun` is on the allowlist, and
 * `propose` ran a production deploy chain. The run timeout killed it during the
 * test step, before `wrangler`, and nothing shipped — but only by luck.
 *
 * `validateProducer` is about WHERE a command may reach. This is about WHAT it
 * may do, which that check does not model at all. Both have to hold.
 */
/**
 * A producer that builds or runs a test suite. Read-only in the sense that
 * matters for safety, but `propose` does not execute one: on a live site
 * ISA every attempt blew the run timeout and produced nothing, and a build
 * writes artifacts into the working tree on the way. The row still records what
 * was drafted, so a person can ratify it knowing what it is.
 */
export function isHeavyProducer(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  return argv[0] === "bun" && (argv[1] === "run" || argv[1] === "test");
}

/** A quoted span is an invocation only if it reads like one. `curl + skill log` is prose. */
const INVOCATION_SHAPE = /^[A-Za-z][A-Za-z0-9._/@:-]*(?:\s+[A-Za-z0-9._/@:=~-]+)*$/;

export { readOnlyRefusal } from "./lib/GlanceQuestion.ts";

/**
 * A parenthetical bookkeeping note, which mentions the ISA without being
 * about it: "(ISA decision 2026-07-27)", "per the ISA", "see the ISA". Project
 * rows once got the ISA itself as their state producer because their check
 * cell carried one of these, which is the very thing ISC-27 forbids.
 */
const ISA_ASIDE = /\((?:[^()]*\b(?:ISA|Test Strategy)\b[^()]*)\)|\b(?:per|see|under|noted in|recorded in|decided in)\s+(?:the\s+)?ISA\b/gi;

/**
 * Is the ISA document the SUBJECT of this criterion? Only then does the ISA get
 * to be its own state. The document has to be what the sentence is about —
 * the thing that parses, carries rows, or states something — not a place the
 * criterion points at in passing.
 */
const ISA_SELF = /\b(?:this\s+)?(?:ISA|Test Strategy|claim ledger|frontmatter)\b[^.;]{0,40}\b(?:parses?|carries|carry|lists?|records?|states?|has|have|contains?|declares?|holds?|rows?|is|are)\b|\b(?:every|each|no|any)\s+(?:ISC|row|claim|criterion)\b[^.;]{0,60}\b(?:Test Strategy|ISA)\b/i;
const BUILD_WORDS = /\b(build|deploy|bundle|compile|gate|ship|release|dist|artifact)\b/i;
const RENDER_WORDS = /\b(render|renders|rendered|page|pages|html|markup|browser|screenshot|layout|nav|header|footer|canonical|meta)\b/i;

/**
 * Draft the producer that reads the state a criterion is really about. Returns null
 * when nothing in the criterion names a boundary — better an unresolved row a
 * person fixes than a question quietly asked about the wrong thing.
 */
export function draftProducer(claim: string, check: string, ctx: BoundaryContext): DraftedProducer | null {
  const text = `${claim} ${check}`.trim();

  if (ISA_SELF.test(text.replace(ISA_ASIDE, " "))) return { producer: ctx.isaFile, boundary: "the ISA itself, which this criterion is about" };
  const sources = ctx.sources ?? discoverStateSources(ctx.isaDir);
  const matched = matchStateSource(text, sources);
  if (matched.producer) return { producer: matched.producer, boundary: matched.reason };

  // 1. A URL written into the criterion is the boundary, verbatim.
  const url = probeUrlFrom(text);
  if (url && !matched.kind && RENDER_WORDS.test(text)) return { producer: `curl -s -L ${shellWord(url)}`, boundary: "the URL the criterion names" };

  // 2. A CLI invocation quoted in the criterion, when its command is allowlisted.
  for (const m of text.matchAll(/`([^`]{3,200})`/g)) {
    const candidate = m[1]!.trim();
    // A bare command NAME is a mention, not an invocation. Site checks often
    // say `curl` while describing a probe, and adopting that drafts a producer
    // that cannot run and a brief that points a leg at nothing.
    if (!/\s/.test(candidate)) continue;
    if (!/^[a-z]/.test(candidate) || candidate.includes("://")) continue;
    if (!INVOCATION_SHAPE.test(candidate)) continue;
    if (!(PRODUCER_COMMANDS as readonly string[]).includes(candidate.split(/\s+/)[0] ?? "")) continue;
    if (readOnlyRefusal(candidate, ctx.isaDir)) continue;
    try {
      validateProducer(candidate, join(ctx.isaDir, "ISA.md"));
      return { producer: candidate, boundary: "the command the criterion quotes" };
    } catch { /* not runnable as written; keep looking */ }
  }

  if (matched.kind) return null;

  // 3. A site path plus a known domain: fetch that page.
  if (ctx.domain && RENDER_WORDS.test(text)) {
    const path = text.match(/(?:^|[\s(`"'])(\/[A-Za-z0-9._~\-]+(?:\/[A-Za-z0-9._~\-]+)*\/?)/);
    if (path?.[1] && !/^\/(?:Users|home|etc|var|tmp)\b/.test(path[1])) {
      return { producer: `curl -s -L https://${ctx.domain}${path[1]}`, boundary: `the page ${path[1]} on ${ctx.domain}` };
    }
    if (RENDER_WORDS.test(text)) return { producer: `curl -s -L https://${ctx.domain}/`, boundary: `the rendered home page of ${ctx.domain}` };
  }

  // 4. A build or deploy criterion reads what the build produces.
  if (BUILD_WORDS.test(text) && ctx.buildScript) {
    const command = `bun run ${ctx.buildScript}`;
    if (!readOnlyRefusal(command, ctx.isaDir)) return { producer: command, boundary: `the repo's ${ctx.buildScript} script` };
  }

  return null;
}

/** The app's live domain and build script, from its PROJECTS.md row and its repo. */
export function boundaryContextFor(isaPath: string): BoundaryContext {
  const abs = resolve(isaPath);
  const isaDir = dirname(abs);
  const ctx: BoundaryContext = { isaDir, isaFile: basename(abs), sources: discoverStateSources(isaDir) };

  // ISA frontmatter wins when it names a domain outright.
  const head = readFileSync(abs, "utf8").slice(0, 4000);
  const fmDomain = head.match(/^domain:\s*["']?([A-Za-z0-9.-]+\.[A-Za-z]{2,})["']?\s*$/m);
  if (fmDomain?.[1]) ctx.domain = fmDomain[1];

  if (!ctx.domain) {
    try {
      const projects = readFileSync(lifeosPath("USER", "PROJECTS.md"), "utf8");
      for (const line of projects.split("\n")) {
        if (!line.trim().startsWith("|")) continue;
        const cells = line.split("|").map((c) => c.trim());
        // The row is this ISA's when a cell names its path or its directory.
        const home = process.env.HOME ?? "";
        const names = cells.some((c) => c.replace(/`/g, "").replace(/^~/, home).includes(abs) || c.replace(/`/g, "").replace(/^~/, home) === isaDir);
        if (!names) continue;
        const domain = cells.find((c) => /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(c.replace(/`/g, "")));
        if (domain) ctx.domain = domain.replace(/`/g, "");
        break;
      }
    } catch { /* no PROJECTS.md reachable; the domain stays unknown */ }
  }

  try {
    const pkg = JSON.parse(readFileSync(join(isaDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    ctx.buildScript = ["build", "dist", "compile"].find((s) => pkg.scripts?.[s] && !readOnlyRefusal(`bun run ${s}`, isaDir));
  } catch { /* no package.json; no build boundary */ }

  ctx.domain ??= ctx.sources?.domain;
  return ctx;
}

// ── Reading the ISA ─────────────────────────────────────────────────────────

export interface ManualRow {
  probe: Probe;
  claim: string;
  claimLine: number | null;
  /**
   * Which manual row this is among the ones sharing its ISC id, 1-based. One
   * criterion routinely carries several manual checks — a production app ISA can have
   * several such ids — so the id alone does not name a row, and a question file named
   * after the id alone would silently overwrite its sibling.
   */
  occurrence: number;
  /** Every other Test Strategy row of the same criterion. ISC-35 reads these to spot a dead duplicate. */
  siblings?: Probe[];
}

/** Every `manual` Test Strategy row, paired with its criterion prose when the ISA has one. */
export function manualRows(isaPath: string): ManualRow[] {
  const { probes } = parseTestStrategyDiagnostic(isaPath);
  const text = readFileSync(isaPath, "utf8");
  const bodyLines = isaBody(text).split(/\r?\n/);
  const claims = new Map<string, IsaClaim>();
  for (const c of parseIsaClaims(isaPath).claims) if (!claims.has(c.id)) claims.set(c.id, c);
  const seen = new Map<string, number>();
  // Every other row of the same criterion, manual or not. ISC-35 reads these to see
  // whether a manual row is a dead duplicate of a real one.
  const byIsc = new Map<string, Probe[]>();
  for (const p of probes) byIsc.set(p.isc, [...(byIsc.get(p.isc) ?? []), p]);
  return probes.filter((p) => p.type === "manual").map((probe) => {
    const c = claims.get(probe.isc);
    const raw = c ? (bodyLines[c.line - 1] ?? "") : "";
    const occurrence = (seen.get(probe.isc) ?? 0) + 1;
    seen.set(probe.isc, occurrence);
    const siblings = (byIsc.get(probe.isc) ?? []).filter((p) => p !== probe);
    return { probe, claim: claimProse(raw), claimLine: c?.line ?? null, occurrence, siblings };
  });
}

/** The readable sentence of a criterion line: prefix, id and the trailing Evidence/Falsifier bookkeeping removed. */
export function claimProse(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[^\]]*\]\s*)?/, "")
    .replace(/^\**(?:Anti-(?:claim|criterion)\s+|Anti:\s*)?`?[A-Za-z][A-Za-z0-9.-]*`?\**\s*(?::|[—–])\s*/, "")
    .replace(/\s*(?:Falsifier|Evidence|Probe)\s*:.*$/i, "")
    .trim();
}

// ── Retiring a dead duplicate (ISC-35) ──────────────────────────────────────
//
// Most of a production app ISA's manual rows were `legacy placeholder — superseded
// (...)` rows whose criterion already carries a real deterministic row. They are not
// candidates for an assert or a question: there is nothing left to check, and
// drafting for them is how a table fills with checks that duplicate each other.
// Such a row leaves the table instead of moving down the ladder.

/** A check cell that says outright it is no longer the real check. */
const SUPERSEDED = /\b(supersede[ds]?|superseding|legacy placeholder|placeholder|deprecated|obsolete|no longer (?:used|the check)|replaced by|retired|duplicate of)\b/i;

/** Compare check cells the way a reader does: case, backticks and padding are not content. */
function normalizeCheck(text: string): string {
  return text.toLowerCase().replace(/`/g, "").replace(/\s+/g, " ").replace(/[.;:,]+$/, "").trim();
}

/**
 * Is one check the opening of the other? A manual row left behind when a real
 * row was written is routinely the same sentence, truncated. The floor keeps a
 * short cell like "passes" from matching half the table.
 */
export function prefixMatch(a: string, b: string): boolean {
  const x = normalizeCheck(a);
  const y = normalizeCheck(b);
  if (x === "" || y === "") return false;
  const shorter = x.length <= y.length ? x : y;
  const longer = shorter === x ? y : x;
  if (shorter.length < 12) return false;
  return longer.startsWith(shorter);
}

export interface RetireVerdict { retire: boolean; reason: string; covered_by: string[] }

/**
 * Should this manual row leave the table? Only when the criterion is already
 * checked by something that is not a manual row, AND this row either says it is
 * superseded or reads as a truncated copy of one of those rows. Both halves are
 * required: a criterion with a real row may still carry a genuine extra manual
 * check, and a row that calls itself a placeholder while being the ONLY check
 * of its criterion is an unverified criterion, not a duplicate.
 */
export function retireVerdict(row: ManualRow): RetireVerdict {
  const siblings = (row.siblings ?? []).filter((p) => p.type !== "manual");
  if (siblings.length === 0) return { retire: false, reason: "", covered_by: [] };
  const covered_by = siblings.map((p) => `${p.isc} (${p.type})`);
  const check = row.probe.check ?? "";
  if (SUPERSEDED.test(check)) {
    return {
      retire: true,
      covered_by,
      reason: `retire: the check cell says it is superseded or a placeholder, and the criterion already has ${siblings.length} non-manual row(s): ${covered_by.join(", ")}`,
    };
  }
  const twin = siblings.find((p) => prefixMatch(check, p.check ?? ""));
  if (twin) {
    return {
      retire: true,
      covered_by,
      reason: `retire: this check is a prefix of the ${twin.type} row's check on the same criterion, so it duplicates it: ${covered_by.join(", ")}`,
    };
  }
  return { retire: false, reason: "", covered_by: [] };
}

// ── Classification ──────────────────────────────────────────────────────────

const TASTE_WORDS = /\b(taste|aesthetic|beautiful|elegan\w*|delight\w*|polish\w*|feel|feels|reads?\s+well|voice|tone|prose|copy|wording|design|visual\w*|looks?\s+(?:good|right|professional)|euphoric|surprise|judgment\s+call|subjective|pleasing|craft)\b/i;
const CODE_WORDS = /\b(exit|status|http|\d{3}\b|returns?|file|path|command|grep|rg\b|regex|test|tests|hash|sha256|count|counts?|zero|never|exists?|present|absent|contains?|matches|equals|json|yaml|schema|parses?|flag|env|compiles?|typecheck|lint|byte|bytes|diff|row|rows|column|header|endpoint|response|field|key|id\b|idempotent|timestamp)\b/i;
const READ_WORDS = /\b(reads?|readable|states?|explains?|describes?|documents?|says?|carries?|names?|mentions?|covers?|reflects?|consistent|accurate|correct\w*|clear|complete|coherent|matches\s+the\s+intent|meaning|summar\w+|narrative|rationale|reason)\b/i;

function countHits(re: RegExp, text: string): number {
  const g = new RegExp(re.source, `${re.flags.includes("g") ? re.flags : `${re.flags}g`}`);
  return (text.match(g) ?? []).length;
}

/**
 * The deterministic classifier, used whenever the engine is off, refused or
 * failing. Crude by construction — its output is a draft a person ratifies —
 * but it must never be silent about which path decided, because "a judgment
 * made by keyword" and "a judgment made by a model" are different evidence.
 *
 * Ties break to `readable`: the middle rung costs a question file a human reads
 * before it is ratified, where a wrong `codable` guess costs a drafted assert
 * that may go green on nothing.
 */
export function classifyByKeyword(text: string): { classification: Classification; reason: string } {
  const taste = countHits(TASTE_WORDS, text);
  const code = countHits(CODE_WORDS, text);
  const read = countHits(READ_WORDS, text);
  if (taste > code && taste >= read) return { classification: "taste", reason: `keyword fallback: ${taste} taste cue(s) outweigh ${code} code and ${read} reading cue(s)` };
  if (code > read && code > taste) return { classification: "codable", reason: `keyword fallback: ${code} code cue(s) outweigh ${read} reading and ${taste} taste cue(s)` };
  return { classification: "readable", reason: `keyword fallback: ${read} reading, ${code} code, ${taste} taste cue(s) — no code majority, so a person or a question must read the state` };
}

/**
 * The state every classification question reads. Named fields, referred to by
 * backticked name in the instructions, because a question that says "the thing
 * below" makes the engine guess which part of the state it means.
 */
const CLASSIFY_STATE_FIELDS = "`criterion` is one ideal-state criterion from a software project. `check` is the one-line description of how a person checks it by hand today. `expected` is what they expect that check to show.";

/** The question id whose registry threshold confirms a `codable` choice. */
export const SHELL_SETTLES_ID = "shell-settles";

/**
 * Two questions, one call.
 *
 * The first framing asked for a tier with three loose descriptions and pulled
 * hard toward `codable`: on a production app ISA it answered codable for nearly
 * every row, including rows that plainly turn on reading a rendered page. The definitions are
 * now literal and mutually exclusive, each carrying the test a reader applies,
 * and the ordering rule says take the FIRST that fits so the options cannot
 * overlap their way into the wrong answer.
 *
 * The noul beside it is a second, independent route to the same fact. A choice
 * of `codable` that the noul does not confirm is recorded as readable: one
 * question saying "a command could do this" is a criterion worth a second opinion,
 * because a wrongly-codable row becomes a drafted assert that marks a criterion
 * verified without ever reading the artifact.
 */
const CLASSIFY_QUESTIONS = {
  tier: {
    type: "choice" as const,
    instructions: [
      CLASSIFY_STATE_FIELDS,
      "",
      "Decide which ONE of three kinds `criterion` is. The three are mutually exclusive. Apply the tests in the order written and take the first that fits.",
      "",
      "codable — a shell command that reads no prose and looks at no rendered output can decide `criterion` outright. The test: could it be settled by an exit status, an HTTP status code, a count, a hash, whether a file exists, whether a schema parses, or an exact string match? If yes, `criterion` is codable.",
      "",
      "readable — a competent reader must read the artifact's content, or look at how it renders, to decide `criterion`, and `criterion` can be stated as one yes/no question or one ordered ladder. The test: would two careful readers who both read the artifact reach the same verdict? If yes, and no shell command can get there, `criterion` is readable.",
      "",
      "taste — only the project owner's own preference settles `criterion`. The test: does it turn on whether something looks right, feels right, or reads well? If yes, `criterion` is taste, even when reading is also involved.",
    ].join("\n"),
    criteria: {
      codable: "A shell command reading no prose and no render decides it: exit status, HTTP status, count, hash, file presence, schema parse, exact string.",
      readable: "A competent reader must read the content or look at the render, and two careful readers would agree on the verdict.",
      taste: "Only the project owner's preference settles it: whether it looks right, feels right, or reads well.",
    },
  },
  [SHELL_SETTLES_ID]: {
    type: "noul" as const,
    instructions: [
      CLASSIFY_STATE_FIELDS,
      "",
      "Would a shell command that reads no prose and looks at no rendered output settle `criterion`?",
      "",
      "Answer yes only when such a command could decide it from an exit status, an HTTP status code, a count, a hash, whether a file exists, whether a schema parses, or an exact string match.",
      "Answer no when a person has to read the artifact's content, or look at how it renders, to decide.",
    ].join("\n"),
  },
};

export interface ClassifyOptions {
  /** Triage pools all row questions over one ISA state, costing one registry call. */
  poolPerIsa?: boolean;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  callersPath?: string;
  session?: string;
  /** Test seam, passed straight through to Glance: replaces global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam, passed straight through to Glance: replaces key resolution. */
  apiKey?: string;
}

interface ClassifyOutcome { classification: Classification; by: ClassifierPath; reason: string; confidence?: number; confirmation?: Confirmation }

/**
 * The one address of a manual row: its ISC id plus its position among the rows
 * sharing that id. Used as the judgeMany item key (which must be unique, or the
 * whole batch is refused before a single call goes out) and as the key of the
 * verdict map. Keying either by id alone silently collapses a criterion's several
 * manual checks into one.
 */
export const rowKey = (r: ManualRow): string => `${r.probe.isc}#${r.occurrence}`;

/**
 * Classify every manual row. The engine is asked once for the whole batch
 * through `judgeMany` (a judgment is quick and independent of
 * every other one, so a batch is a pool, never a loop); any row the engine
 * cannot answer falls back to keywords individually, and the proposal records
 * which path decided each row.
 */
export async function classifyRows(rows: ManualRow[], opts: ClassifyOptions = {}): Promise<Map<string, ClassifyOutcome>> {
  const out = new Map<string, ClassifyOutcome>();
  const textOf = (r: ManualRow): string => `${r.claim} ${r.probe.check} ${r.probe.threshold}`.trim();
  if (opts.offline || rows.length === 0) {
    for (const r of rows) out.set(rowKey(r), { ...classifyByKeyword(textOf(r)), by: "fallback" });
    return out;
  }
  let results: ManyResult[] = [];
  try {
    if (opts.poolPerIsa) {
      const cfg = safeCallerConfig(CLASSIFY_CALLER, opts.callersPath);
      if (!cfg || cfg.mode !== "shadow") throw new Error("triage requires the registered shadow classify caller");
      const state = Object.fromEntries(rows.map((r, i) => [`row${i}`, {
        criterion: r.claim || r.probe.check, check: r.probe.check, expected: r.probe.threshold,
      }]));
      const questions = Object.fromEntries(rows.flatMap((_, i) => Object.entries(CLASSIFY_QUESTIONS).map(([id, q]) => [
        `row${i}-${id}`, { ...q, instructions: `Read only state.row${i} for this question.\n${q.instructions}` },
      ])));
      const questionJoins = Object.fromEntries(rows.flatMap((_, i) => Object.keys(CLASSIFY_QUESTIONS).map((id) => [
        `row${i}-${id}`, { turn: rowKey(rows[i]!), question: id },
      ])));
      const pooled = (await judgeMany([{ key: opts.session ?? "isa", state: JSON.parse(redactForEngine(JSON.stringify(state), JSON.stringify(state).length)), questions, questionJoins }], {}, {
        caller: CLASSIFY_CALLER, env: opts.env, logPath: opts.logPath, callersPath: opts.callersPath,
        session: opts.session, fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, retries: 0, concurrency: 1,
      }))[0]!;
      results = rows.map((r, i) => ({ key: rowKey(r), error: pooled.error, result: pooled.result ? Object.fromEntries(
        Object.keys(CLASSIFY_QUESTIONS).filter((id) => pooled.result![`row${i}-${id}`]).map((id) => [id, pooled.result![`row${i}-${id}`]]),
      ) : null }));
    } else {
    results = await judgeMany(
      rows.map((r) => ({
        key: rowKey(r),
        state: redactForEngine(JSON.stringify({ criterion: r.claim || r.probe.check, check: r.probe.check, expected: r.probe.threshold }), MAX_OUTPUT_CHARS),
      })),
      CLASSIFY_QUESTIONS,
      { caller: CLASSIFY_CALLER, env: opts.env, logPath: opts.logPath, callersPath: opts.callersPath, session: opts.session, fetchImpl: opts.fetchImpl, apiKey: opts.apiKey },
    );
    }
  } catch (e) {
    // A batch-level failure (disabled engine, missing key, spent budget) is not
    // an error here: the whole point of the fallback is that propose finishes.
    results = rows.map((r) => ({ key: rowKey(r), result: null, error: (e as Error)?.message ?? String(e) }));
  }
  // The bar the noul has to clear before a `codable` choice is believed. From
  // the registry, like every other threshold in this system; recorded here, and
  // cleared through decide() inside confirmCodable.
  const bar = thresholdRows(safeCallerConfig(CLASSIFY_CALLER, opts.callersPath))[SHELL_SETTLES_ID]?.value;
  const byKey = new Map(results.map((r) => [r.key, r]));
  for (const r of rows) {
    const key = rowKey(r);
    const answer = byKey.get(key)?.result?.tier;
    const pick = answer?.answer.type === "choice" ? answer.answer.choice : null;
    if (pick === "codable" || pick === "readable" || pick === "taste") {
      const p = answer!.answer.type === "choice" ? answer!.answer.probabilities?.[pick] : undefined;
      const certainty = typeof p === "number" ? ` at p=${p.toFixed(2)}` : "";
      const confirmation = confirmCodable(byKey.get(key)?.result?.[SHELL_SETTLES_ID]?.answer, bar, opts.callersPath);
      const base = { by: "engine-shadow" as const, ...(typeof p === "number" ? { confidence: p } : {}), confirmation };
      if (pick === "codable" && !confirmation.confirmed) {
        out.set(key, { ...base, classification: "readable", reason: `codable criterion not confirmed by the noul — ${confirmation.note}` });
        continue;
      }
      out.set(key, { ...base, classification: pick, reason: `Glance answered ${pick}${certainty} under ${CLASSIFY_CALLER} (shadow); a person still ratifies it` });
      continue;
    }
    const why = byKey.get(key)?.error;
    const fb = classifyByKeyword(textOf(r));
    out.set(key, { ...fb, by: "fallback", reason: why ? `${fb.reason} (engine unavailable: ${why})` : fb.reason });
  }
  return out;
}

/**
 * Does the `shell-settles` noul back up a `codable` choice? Unconfirmed on
 * anything short of a clear yes — a missing answer, a missing registry bar and
 * a probability below it all mean the same thing here, which is that one
 * question said "a command could do this" and nothing corroborated it.
 *
 * Deliberately conservative: a wrongly-codable row becomes a drafted shell
 * assert that marks a criterion verified without ever reading the artifact, which
 * is the failure this whole feature exists to prevent. A wrongly-readable row
 * costs a question file a person deletes.
 */
export function confirmCodable(answer: unknown, bar: number | undefined, callersPath?: string): Confirmation {
  const question = SHELL_SETTLES_ID;
  if (typeof bar !== "number") {
    return { question, confirmed: false, note: `no ${SHELL_SETTLES_ID} bar registered for caller ${CLASSIFY_CALLER}, so nothing can confirm a codable choice` };
  }
  const a = answer as { type?: string; noul?: number } | undefined;
  if (!a || a.type !== "noul" || !Number.isFinite(a.noul)) {
    return { question, bar, confirmed: false, note: "the engine returned no usable answer to whether a shell command would settle the criterion" };
  }
  const probability = a.noul as number;
  // The noul's raw probability of yes at or above the registered bar, read from decide().yes (never compared here).
  const decision = decide(CLASSIFY_CALLER, SHELL_SETTLES_ID, { type: "noul", noul: probability }, callersPath);
  const confirmed = decision.yes === true;
  return {
    question, bar, probability, confirmed,
    note: confirmed
      ? "a shell command with no reading would settle this criterion"
      : "asked separately, the engine did not say a shell command with no reading would settle this criterion",
  };
}

// ── Drafting an assert (ISC-33) ─────────────────────────────────────────────
//
// A drafted assert has to be able to FAIL. The first version of this drafter
// fell back to `rg -l <a word from the criterion> .`, which matches the ISA that
// states the criterion: a batch of those were written into a production app ISA, all
// passed, none verified anything. The keyword fallback is gone. A draft now
// comes from one of three places a criterion can actually point at, and it is run
// twice — on the repo, and on a repo where the criterion has been made false.

/** A file path named anywhere in the row, when one is named. */
function namedPath(text: string): string | null {
  const m = text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/);
  return m ? m[0] : null;
}

/** Every path named in the row, longest first, so the most specific one is tried first. */
function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/g)) out.add(m[0].replace(/[.,;:]$/, ""));
  for (const m of text.matchAll(/`([^`]{2,120})`/g)) {
    const inner = m[1]!.trim();
    if (/^[A-Za-z0-9_.@/-]+$/.test(inner) && inner.includes("/")) out.add(inner);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * True only when `rel` names an existing regular file whose real path is inside
 * the real repo root. A lexical check alone is bypassable through `..` and
 * through a symlinked component, so both sides go through realpath first.
 */
export function namedTestInside(cwd: string, rel: string): boolean {
  if (isAbsolute(rel) || rel.split("/").includes("..")) return false;
  let root: string;
  let real: string;
  try { root = realpathSync(cwd); real = realpathSync(resolve(cwd, rel)); } catch { return false; }
  const r = relative(root, real);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) return false;
  try { return statSync(real).isFile(); } catch { return false; }
}

const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|_test\.go|(?:^|\/)tests?\/)/;
const STATUS_CUE = /\b(?:status|code|returns?|responds?|answers?|serves?|http)\b/i;
const HEADER_CUE = /\b(?:header|content-type|cache-control|set-cookie|location|etag|x-[a-z-]+)\b/i;

/**
 * The three allowed sources, in order. Each returns a command whose failure
 * means something: the criterion's own read-only command, the test file the criterion
 * names, or the live status the criterion states.
 */
export function assertSourceFor(
  text: string, cwd: string, isaDir: string,
): { command: string; expected: Expectation; source: AssertSource; target?: string; boundary: string; exec?: ProbeExec } | null {
  // 1. The criterion's own quoted command, when it is read-only.
  for (const m of text.matchAll(/`([^`]{3,200})`/g)) {
    const candidate = m[1]!.trim();
    // A bare command NAME is a mention, not an invocation. Site checks often
    // say `curl` while describing a probe, and adopting that drafts a producer
    // that cannot run and a brief that points a leg at nothing.
    if (!/\s/.test(candidate)) continue;
    if (!/^[a-z]/.test(candidate) || candidate.includes("://")) continue;
    if (!INVOCATION_SHAPE.test(candidate)) continue;
    if (!(PRODUCER_COMMANDS as readonly string[]).includes(candidate.split(/\s+/)[0] ?? "")) continue;
    if (readOnlyRefusal(candidate, isaDir)) continue;
    if (isTextGrep(candidate)) continue;
    return { command: candidate, expected: "exit:0", source: "claim-command", target: namedPath(candidate) ?? undefined, boundary: "the command the criterion quotes" };
  }

  // 2. A test file the criterion names, when it is really there AND really inside
  // the repo. The path is criterion text, so it can say `../x` or sit behind a
  // symlinked directory; both sides are dereferenced before the boundary check, and
  // the run is an argv so no shell ever reads the path.
  for (const p of namedPaths(text)) {
    if (!TEST_FILE.test(p)) continue;
    if (!namedTestInside(cwd, p)) continue;
    return {
      command: `bun test ./${p}`, expected: "exit:0", source: "named-test", target: p, boundary: `the suite in ${p}`,
      exec: { argv: ["bun", "test", `./${p}`] },
    };
  }

  // 3. A URL the criterion names, with the status or header the criterion states.
  const url = probeUrlFrom(text);
  if (url) {
    const status = text.match(/\b([1-5]\d{2})\b/);
    if (status && STATUS_CUE.test(text)) {
      // The URL is criterion text. It is one argv element when the probe runs and one
      // single-quoted word in the stored command, so neither run can read it as shell.
      return {
        command: `curl -q -s -o /dev/null -w '%{http_code}' ${shellQuote(url)}`, expected: `contains:${status[1]}`, source: "url-status", boundary: `the status ${url} answers with`,
        exec: { argv: ["curl", "-q", "-s", "-o", "/dev/null", "-w", "%{http_code}", url] },
      };
    }
    const header = text.match(/\b((?:x-[a-z-]+|content-type|cache-control|set-cookie|location|etag))\b/i);
    if (header && HEADER_CUE.test(text)) {
      return {
        command: `curl -q -sI ${shellQuote(url)} | rg -ic ${shellQuote(header[1]!)}`, expected: "min:1", source: "url-status", boundary: `the ${header[1]} header on ${url}`,
        exec: { argv: ["curl", "-q", "-sI", url], countLines: header[1]! },
      };
    }
  }
  return null;
}

/**
 * A shallow mirror of the repo with one path missing, built from symlinks so
 * nothing is copied. Only the directories along the removed path are real; every
 * sibling is a link, so a command resolves its imports and its node_modules
 * exactly as it would in the repo and simply cannot find the one thing removed.
 */
export function mirrorWithout(root: string, relPath: string): string {
  const dest = mkdtempSync(join(tmpdir(), "isc-tier-mutant-"));
  // "./tests/x" and "tests/x" name the same file; a "." segment left in would
  // make every level descend onto itself and mirror nothing.
  const parts = relPath.split("/").filter((p) => p !== "" && p !== ".");
  let src = realpathSync(root);
  let dst = dest;
  for (let i = 0; i < parts.length; i++) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      if (entry === parts[i]) continue;
      try { symlinkSync(join(src, entry), join(dst, entry)); } catch { /* a name that cannot be linked is simply absent */ }
    }
    if (i === parts.length - 1) break;
    src = join(src, parts[i]!);
    dst = join(dst, parts[i]!);
    if (!existsSync(src)) break;
  }
  return dest;
}

/**
 * Run the draft a second time against a world where the criterion is false, and say
 * whether it noticed. A repo-shaped draft is run in a mirror with its own
 * artifact removed; a live-URL draft has its expectation negated instead,
 * because nothing local can change what the site answers.
 */
export function discriminate(
  command: string, expected: Expectation, repo: DryRun, target: string | undefined, source: AssertSource,
  cwd: string, env: NodeJS.ProcessEnv = process.env,
): Discrimination {
  const passed_on_repo = repo.satisfied;
  if (source === "url-status") {
    // A trivial expectation is satisfied by empty output, and an unreachable
    // host prints nothing. Such a draft goes green when the boundary is DOWN,
    // which is the opposite of what the criterion says.
    if (isTrivial(expected)) {
      return {
        verdict: "not a verifier", mutation: "none needed", passed_on_repo, passed_on_mutation: true,
        note: "the expectation is satisfied by empty output, so an unreachable host would pass it",
      };
    }
    const negated = negateExpectation(expected);
    if (!negated) return { verdict: "unverified", mutation: "none available", passed_on_repo, passed_on_mutation: null, note: `no negation is defined for the expectation ${expected}` };
    const passed_on_mutation = repo.ran && satisfiesNegated(negated, repo.stdout, repo.exit);
    return {
      verdict: !repo.ran ? "unverified" : passed_on_mutation ? "not a verifier" : "discriminating",
      mutation: `the expectation negated to ${negated}`,
      passed_on_repo, passed_on_mutation,
      note: passed_on_mutation
        ? "the same output satisfies the expectation and its negation, so the assert cannot tell a good answer from a bad one"
        : "the output satisfies the expectation and fails its negation",
    };
  }
  // Both sides go through realpath before the boundary check: on macOS a temp
  // dir is a symlink, so a lexical relative() turns a file plainly inside the
  // root into a ladder of "..".
  const real = (p: string): string => { try { return realpathSync(p); } catch { return ""; } };
  const root = real(cwd) || cwd;
  const abs = target ? real(resolve(cwd, target)) : "";
  const rel = abs ? relative(root, abs) : "";
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { verdict: "unverified", mutation: "none available", passed_on_repo, passed_on_mutation: null, note: "the draft names no artifact that could be removed, so it was never shown able to fail" };
  }
  const mutant = mirrorWithout(root, rel);
  try {
    const r = runBoundedConfined(command, mutant, env);
    if (r.refused) return { verdict: "unverified", mutation: `${rel} removed`, passed_on_repo, passed_on_mutation: null, note: `the mutation run did not happen: ${r.refused}` };
    const passed_on_mutation = satisfies(expected, r.stdout, r.exit);
    return {
      verdict: passed_on_mutation ? "not a verifier" : "discriminating",
      mutation: `${rel} removed`,
      passed_on_repo, passed_on_mutation,
      note: passed_on_mutation
        ? `the assert passed with ${rel} removed, so it is not testing what the criterion is about`
        : `the assert failed with ${rel} removed, so it is reading the thing the criterion names`,
    };
  } finally {
    rmSync(mutant, { recursive: true, force: true });
  }
}

/** The five lines a Sol leg needs to write the assert this criterion deserves. */
export function briefFor(row: ManualRow, ctx: BoundaryContext, why: string): SolBrief {
  const claim = (row.claim || row.probe.check).trim();
  const drafted = draftProducer(row.claim, row.probe.check, ctx);
  const isa = join(ctx.isaDir, ctx.isaFile);
  return {
    claim,
    boundary: drafted ? `${drafted.boundary} — ${drafted.producer}` : "not derivable from the criterion; name the artifact this criterion is about",
    commands: `read-only only: ${PRODUCER_COMMANDS.join(", ")}; no deploy, publish, push or write verbs`,
    truth: `${why}. TRUE means the command fails when the claimed property is absent and passes when it is present.`,
    acceptance: `bun LIFEOS/TOOLS/IscTier.ts propose ${isa} records ${row.probe.isc} as codable with a discriminating draft`,
  };
}

/**
 * Draft one shell assert from a manual row, run it on current state, then run it
 * again on a state where the criterion is false. A draft that passes both, or that
 * is only a text search, is refused: the row stays manual and carries a brief.
 */
export function draftAssert(
  row: ManualRow, cwd: string, env: NodeJS.ProcessEnv = process.env, isaDir = cwd,
): { assert: DraftedAssert } | { refused: string } {
  const text = `${row.claim} ${row.probe.check}`.trim();
  const picked = assertSourceFor(text, cwd, isaDir);
  if (!picked) {
    return { refused: "not a verifier: the criterion quotes no read-only command, names no test file that exists, and states no status for a URL" };
  }
  if (isTextGrep(picked.command)) {
    return { refused: "not a verifier: the draft is only a text search, which matches the ISA that states the criterion" };
  }
  const dry_run = dryRun(picked.command, picked.expected, cwd, env, picked.exec);
  const discrimination = discriminate(picked.command, picked.expected, dry_run, picked.target, picked.source, cwd, env);
  if (discrimination.verdict !== "discriminating") {
    return { refused: `not a verifier: ${discrimination.note}` };
  }
  return {
    assert: {
      type: "bash", command: picked.command, expected: picked.expected, dry_run,
      trivial: isTrivial(picked.expected), source: picked.source, discrimination,
    },
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function dryRun(command: string, expected: string, cwd: string, env: NodeJS.ProcessEnv = process.env, exec?: ProbeExec): DryRun {
  const refusal = refusesToRun(command);
  if (refusal) return { ran: false, exit: null, stdout: "", stderr: "", satisfied: false, skipped_reason: refusal };
  // A probe that carries its own argv (a URL taken from a criterion) never goes
  // through a shell; the command string is only what gets stored and shown.
  const r = exec ? runArgv(exec, cwd, env) : runBoundedConfined(command, cwd, env);
  if (r.refused) return { ran: false, exit: null, stdout: "", stderr: r.stderr, satisfied: false, skipped_reason: r.refused };
  return { ran: true, exit: r.exit, stdout: r.stdout, stderr: r.stderr, satisfied: satisfies(expected, r.stdout, r.exit) };
}

// ── Drafting a question ─────────────────────────────────────────────────────

const ORDER_CUE = /\b(ordered|order|ladder|rung|rungs|scale|level|levels|ranked|rank|ascending|descending|worst|best|severity|tier|tiers|band|bands|grade|grades|escalat\w*|from\s+\w+\s+to\s+\w+)\b/i;

/** A criterion that says less is better. Narrow on purpose: a wrong read here inverts the whole mutation test. */
const LOWER_IS_BETTER = /\b(lower|fewer|less|(?<!\bat\s)least|minimi[sz]e|at most|no more than|under|below|reduce[ds]?|shrink|latency|error rate|errors|failures|cost|spend|downtime|debt)\b/i;
/**
 * A criterion that says more is better. Bare "over" is NOT a cue: it is usually
 * the preposition ("observed over the corpus"), and on ISC-63 it set a
 * direction that then reported itself as read from the criterion rather than
 * assumed. It counts only in a comparative phrase — "prefer X over Y",
 * "ranks over Y" — where it really does say which end is good.
 */
const HIGHER_IS_BETTER = /\b(higher|(?<!\bno\s)more|(?<!\bat\s)most|greater|maximi[sz]e|at least|no fewer than|above|increase[ds]?|grow|coverage|uptime|throughput|quality|score)\b|\b(?:prefer\w*|favou?r\w*|rank\w*|chosen|choose|beats?|wins?|select\w*|priorit\w*)\s+(?:\S+\s+){0,3}over\b/i;

/**
 * Which end of a drafted score ladder is good (finding 9). Nothing in the
 * `criteria` array says which way it runs, and the mutation pass used to read
 * index 0 as the bad end on faith. When the criterion gives no cue the default is
 * recorded AS a default, so a reader can see it was assumed rather than read.
 */
export function scoreDirectionOf(text: string): { direction: ScoreDirection; assumed: boolean } {
  const lower = LOWER_IS_BETTER.test(text);
  const higher = HIGHER_IS_BETTER.test(text);
  if (lower && !higher) return { direction: "lower_is_better", assumed: false };
  if (higher && !lower) return { direction: "higher_is_better", assumed: false };
  return { direction: "higher_is_better", assumed: true };
}

/**
 * Is this token a name from the code rather than an option a reader chooses
 * between? `postUrl`, `PrivacyInfo.xcprivacy`, `SESSION_SECRET` and
 * `src/app.ts` are all identifiers. Reading them as an option set drafted
 * questions asking the engine to pick between "success" and "postUrl" while
 * looking at a rendered page, which is not a question anyone can answer.
 */
export function isCodeIdentifier(token: string): boolean {
  const t = token.trim();
  if (t === "") return false;
  if (/[._/\\]/.test(t)) return true;                    // dotted, file-like or pathy
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(t)) return true;  // ALLCAPS_WITH_UNDERSCORES
  if (/_/.test(t)) return true;                           // snake_case
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t)) return true; // camelCase
  if (/^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(t)) return true; // PascalCase
  if (/[()<>[\]{}=;$#@]/.test(t)) return true;            // punctuation no option carries
  return false;
}

/** An option is a plain word or a short phrase of plain words. */
function isPlainOption(token: string): boolean {
  const t = token.trim();
  if (t.length < 1 || t.length > 40) return false;
  if (isCodeIdentifier(t)) return false;
  return /^[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+){0,4}$/.test(t);
}

/** An ordered ladder written as percentage-labelled levels: "5% S / 15% A / 25% B". */
export function percentLadder(text: string): string[] | null {
  const run = text.match(/\b\d{1,3}(?:\.\d+)?%\s*[A-Za-z][A-Za-z0-9-]{0,20}(?:\s*\/\s*\d{1,3}(?:\.\d+)?%\s*[A-Za-z][A-Za-z0-9-]{0,20}){1,7}/);
  if (!run) return null;
  const steps = [...run[0].matchAll(/(\d{1,3}(?:\.\d+)?)%\s*([A-Za-z][A-Za-z0-9-]{0,20})/g)]
    .map((m) => ({ pct: Number(m[1]), level: m[2]!.trim() }));
  if (steps.length < 2) return null;
  // The percentage IS the order key: the rarest band is the top of the ladder,
  // so the levels come back worst-first and `direction` records which end is good.
  const ordered = [...steps].sort((a, b) => b.pct - a.pct).map((s) => s.level);
  const distinct = [...new Set(ordered)];
  return distinct.length >= 2 && distinct.length <= 8 ? distinct : null;
}

/**
 * Pull a named set out of the criterion's own words. Nothing is synthesized:
 * an unanchored rubric with filler rungs is exactly what ISC-3 forbids sending
 * to the engine, so a `score` question only exists when the criterion itself names
 * the ordered levels — and an option set only exists when the criterion names
 * options, not when it happens to quote two identifiers.
 */
export function extractSet(text: string): string[] | null {
  const ladder = percentLadder(text);
  if (ladder) return ladder;
  const braces = text.match(/\{([^{}]{3,160})\}/);
  // Backticked runs joined by "or" or "/" only. A backticked pair joined by
  // "and" is a list of things the criterion mentions together, not alternatives.
  const backticked = text.match(/(?:`[^`]{1,40}`\s*(?:,|\/|\bor\b)\s*){1,7}`[^`]{1,40}`/);
  const oneOf = text.match(/\b(?:one of|among|either)\s+([^.;:]{3,160})/i);
  const bulleted = text.match(/(?:^|\n)\s*[-*]\s+([^\n]{1,60})(?:\n\s*[-*]\s+[^\n]{1,60}){1,7}/);
  // A slash-separated run is an option list only when the slash has whitespace
  // on BOTH sides. `src/app.ts` is a path, and reading it as {src, app} drafted
  // a choice over the halves of a filename; "on /settings" and "rapid /feeds"
  // are a word next to a URL path, which slipped through while a space on one
  // side was enough. A tight list (`code/glance`) is indistinguishable from a
  // path here, so it falls through to a noul that a person can change.
  const slashes = text.match(/\b[A-Za-z][A-Za-z-]{1,20}(?:\s+\/\s+[A-Za-z][A-Za-z-]{1,20}){1,6}\b/);
  const raw = braces?.[1] ?? backticked?.[0] ?? oneOf?.[1] ?? bulleted?.[0] ?? slashes?.[0] ?? null;
  if (!raw) return null;
  const items = raw
    .split(/\s*(?:,|\||\/|\bor\b|\n\s*[-*]\s+)\s*/i)
    .map((s) => s.replace(/`/g, "").replace(/^["']|["']$/g, "").replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  // Every member has to be a plain option. One identifier in the run means the
  // criterion was quoting code, so the whole set is discarded rather than trimmed:
  // a set with a member silently dropped is a different question.
  if (items.some((s) => !isPlainOption(s))) return null;
  const distinct = [...new Set(items)];
  return distinct.length >= 2 && distinct.length <= 8 ? distinct : null;
}

/**
 * Draft the question file for a readable row. The kind follows the shape of the
 * criterion, per the F3 contract: a predicate is a noul, a criterion that names an
 * ordered set is a score over those levels, an unordered set is a choice over
 * those options.
 */
export function draftQuestion(row: ManualRow, caller = SHADOW_CALLER, questionId?: string, producer?: string): IscQuestionFile {
  const claim = row.claim || row.probe.check;
  const text = `${claim} ${row.probe.check}`.trim();
  const set = extractSet(text);
  const id = questionId ?? (row.occurrence > 1 ? `${row.probe.isc}.${row.occurrence}` : row.probe.isc);
  const base = {
    id,
    claim: redactForEngine(claim, 600),
    // No default. A question with no boundary producer is an unresolved row, not
    // a question quietly asked about the ISA's own prose (ISC-27).
    state: { producer: producer ?? "" },
    caller,
  };
  if (set && ORDER_CUE.test(text)) {
    const { direction, assumed } = scoreDirectionOf(text);
    return {
      ...base, kind: "score", criteria: set, direction, ...(assumed ? { direction_assumed: true } : {}),
      instructions: redactForEngine(`${claim}\n\nRead the state below and place it on the levels named in this criterion. The levels are the criterion's own, listed in the order it gives them, and ${direction === "higher_is_better" ? "the LAST level is the best outcome" : "the FIRST level is the best outcome"}.`, 1200),
    };
  }
  if (set) {
    return { ...base, kind: "choice", options: Object.fromEntries(set.map((o) => [o, null])), instructions: redactForEngine(`${claim}\n\nRead the state below and pick which of the criterion's own named options it is.`, 1200) };
  }
  return { ...base, kind: "noul", instructions: redactForEngine(`${claim}\n\nIs this true of the state below? Answer yes only when the state shows it directly; answer no when the state shows it is not so, or shows nothing about it.`, 1200) };
}

// ── Mutation sensitivity (ISC-30) ───────────────────────────────────────────

/**
 * Ask every proposed question twice — once against the state its producer
 * emits, once against that state with the claimed property removed or inverted
 * — and keep only the questions whose confidence in their own answer collapses.
 *
 * A question that answers the same way either way cannot fail, and a check that
 * cannot fail is not a verifier. That is the whole criterion.
 *
 * Two batches, not 2N calls: every baseline goes out together, then every
 * mutation. The mutation for a `choice` question needs the baseline answer
 * first, which is why it is two rounds rather than one.
 *
 * The bar comes from the caller registry and nowhere else. With no bar
 * registered, or with the engine off, or with a producer that will not run, the
 * verdict is `unverified` — never `sensitive` by default.
 */
export async function mutationPass(
  entries: { key: string; q: IscQuestionFile; produced?: ProducedState }[],
  isaDir: string,
  cwd: string,
  opts: ClassifyOptions = {},
): Promise<Map<string, MutationReport>> {
  const out = new Map<string, MutationReport>();
  if (entries.length === 0) return out;

  const bar = thresholdRows(safeCallerConfig(SHADOW_CALLER, opts.callersPath))[MUTATION_BAR_ID]?.value;
  if (typeof bar !== "number") {
    for (const e of entries) out.set(e.key, { verdict: "unverified", note: `no ${MUTATION_BAR_ID} bar registered for caller ${SHADOW_CALLER}; nothing to compare a mutated-state probability against` });
    return out;
  }
  if (opts.offline) {
    for (const e of entries) out.set(e.key, { verdict: "unverified", bar, note: "the engine was not asked (offline), so no question here has been shown able to fail" });
    return out;
  }

  // Producers first: a question whose state will not materialise is unverified,
  // and says which producer failed.
  const live: { key: string; q: IscQuestionFile; state: string | object }[] = [];
  for (const e of entries) {
    const produced = e.produced ?? runProducer(e.q.state.producer, isaDir, cwd, opts.env, e.q.claim);
    if (!produced.ok || produced.state === null) {
      out.set(e.key, { verdict: "unverified", bar, note: `state producer failed, so the question was never asked: ${produced.error ?? "unknown"}` });
      continue;
    }
    live.push({ key: e.key, q: e.q, state: produced.state });
  }
  if (live.length === 0) return out;

  const askAll = async (items: { key: string; state: string | object; q: IscQuestionFile }[]): Promise<Map<string, ManyResult>> => {
    try {
      const results = await judgeMany(
        items.map((i) => ({ key: i.key, state: i.state, questions: { [i.q.id]: engineQuestion(i.q) } })),
        {},
        { caller: SHADOW_CALLER, env: opts.env, logPath: opts.logPath, callersPath: opts.callersPath, session: opts.session, fetchImpl: opts.fetchImpl, apiKey: opts.apiKey },
      );
      return new Map(results.map((r) => [r.key, r]));
    } catch (e) {
      return new Map(items.map((i) => [i.key, { key: i.key, result: null, error: (e as Error)?.message ?? String(e) } as ManyResult]));
    }
  };

  const baselines = await askAll(live);
  const mutatedItems: { key: string; state: string | object; q: IscQuestionFile; baseline: string; baselineMass: number; note: string }[] = [];
  for (const l of live) {
    const answer = baselines.get(l.key)?.result?.[l.q.id]?.answer;
    const err = baselines.get(l.key)?.error;
    if (!answer) { out.set(l.key, { verdict: "unverified", bar, note: `the engine did not answer on the original state: ${err ?? "no answer"}` }); continue; }
    const baseline = baselineAnswer(answer as unknown as { type: string });
    const baselineMass = baseline === null ? null : massOnBaseline(answer as unknown as { type: string }, baseline);
    if (baseline === null || baselineMass === null) { out.set(l.key, { verdict: "unverified", bar, note: "the engine's answer carried no probability mass to compare" }); continue; }
    // The mutation only moves an answer one way, so it is a test only for a
    // baseline it can move. An untestable direction is unverified, never
    // insensitive: saying a question cannot fail when we never gave it the
    // chance is a false finding.
    const direction = mutationTestable(l.q, baseline);
    if (!direction.testable) {
      out.set(l.key, { verdict: "unverified", bar, baseline_probability: baselineMass, baseline_answer: baseline, note: `the mutation could not test this question: ${direction.why}` });
      continue;
    }
    const m = mutateState(l.state, l.q, baseline);
    if (!m.effective) {
      // The state still carries whatever evidence it had; only a bare answer
      // name was appended. Any movement the engine shows is a reaction to that
      // word, not to the criterion going away, so it certifies nothing.
      out.set(l.key, {
        verdict: "unverified", bar, baseline_probability: baselineMass, baseline_answer: baseline, mutation: m.note,
        note: `the mutation changed nothing in the state: ${m.note} — aim the producer at the artifact the criterion is about`,
      });
      continue;
    }
    mutatedItems.push({ key: l.key, state: m.state, q: l.q, baseline, baselineMass, note: m.note });
  }
  if (mutatedItems.length === 0) return out;

  const mutated = await askAll(mutatedItems);
  for (const m of mutatedItems) {
    const answer = mutated.get(m.key)?.result?.[m.q.id]?.answer;
    const err = mutated.get(m.key)?.error;
    const common = { bar, baseline_probability: m.baselineMass, baseline_answer: m.baseline, mutation: m.note };
    if (!answer) { out.set(m.key, { ...common, verdict: "unverified", note: `the engine did not answer on the mutated state: ${err ?? "no answer"}` }); continue; }
    const mass = massOnBaseline(answer as unknown as { type: string }, m.baseline);
    if (mass === null) { out.set(m.key, { ...common, verdict: "unverified", note: "the mutated-state answer carried no comparable probability mass" }); continue; }
    // Did the mass on the baseline answer fall below the bar? The comparison is Glance's yesAt (mass >= bar), so the
    // mutation bar means the same thing here as a cut means in decide(). Exactly the pre-S1b `mass < bar`.
    const fell = yesAt(mass, bar) === false;
    out.set(m.key, {
      ...common,
      verdict: fell ? "sensitive" : "insensitive",
      mutated_probability: mass,
      note: fell
        ? `the engine's confidence in "${m.baseline}" fell below the registered bar once the claimed property was removed`
        : `insensitive: the engine still answered "${m.baseline}" with the same confidence after the claimed property was removed, so this question cannot fail`,
    });
  }
  return out;
}

// ── propose ─────────────────────────────────────────────────────────────────

export interface ProposeOptions extends ClassifyOptions {
  cwd?: string;
  out?: string;
  /** Resolution seam for a drafted curl producer's destination (runConfined); defaults to the one-shot system lookup. */
  resolveHost?: (host: string) => string[];
}

export interface ProposeResult { proposal: IscTierProposal; path: string; kept: { kept: number; dropped: string[] } }


/** What a ratified row decided, keyed the way manual rows are addressed. */
export interface Ratified { classification: Classification; producer?: string }

/**
 * Read the decisions a person already made, out of the proposal a rerun is
 * about to overwrite. Only ratified rows count: an unratified row is a draft
 * and the fresh run is a better draft. A file that cannot be parsed is not an
 * error here — it simply carries nothing, and the caller reports zero.
 */
export function carriedRatifications(path: string): Map<string, Ratified> {
  const out = new Map<string, Ratified>();
  if (!existsSync(path)) return out;
  // Read LENIENTLY, on purpose. A person's decisions must survive a schema
  // change: ISC-33 made every pre-ISC-33 proposal fail validation, and running
  // this through the strict parser threw a person's ratifications away without
  // saying so. Only the three fields a decision consists of are read, and each
  // is type-checked on its own.
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return out; }
  const rows = (raw as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return out;
  // Every classification applyRatifications honours, retire included: a ratified retirement
  // dropped here would come back unratified on the next propose run.
  const RUNGS = new Set<Classification>(["codable", "readable", "taste", "manual", "retire"]);
  for (const value of rows) {
    const r = value as Partial<ProposalRow> | null;
    if (!r || typeof r !== "object" || r.ratified !== true) continue;
    if (typeof r.isc !== "string" || r.isc === "") continue;
    if (!RUNGS.has(r.classification as Classification)) continue;
    const producer = r.question?.state?.producer;
    out.set(`${r.isc}#${Number.isInteger(r.occurrence) ? r.occurrence : 1}`, {
      classification: r.classification as Classification,
      ...(typeof producer === "string" && producer !== "" ? { producer } : {}),
    });
  }
  return out;
}

/**
 * Put the human's decisions back on the fresh rows, in place. A demotion is
 * always honoured; a promotion only when the fresh run can support it, because
 * a codable row with no discriminating draft is a row the schema refuses and
 * ISC-33 exists to stop. Returns how many rows kept their ratification.
 */
export function applyRatifications(rows: ProposalRow[], carried: Map<string, Ratified>): { kept: number; dropped: string[] } {
  let kept = 0;
  const dropped: string[] = [];
  for (const row of rows) {
    const was = carried.get(`${row.isc}#${row.occurrence ?? 1}`);
    if (!was) continue;
    const supported =
      was.classification === "manual" || was.classification === "taste"
        ? true
        : was.classification === "retire"
          ? row.classification === "retire"
          : was.classification === "readable"
            ? row.question !== undefined
            : row.assert !== undefined;
    if (!supported) {
      dropped.push(`${row.isc}#${row.occurrence ?? 1}: ratified as ${was.classification}, but this run cannot support it`);
      continue;
    }
    if (was.classification !== row.classification) {
      // A ratified demotion keeps its question or assert off the row, or the
      // schema would refuse the pair.
      if (was.classification === "manual" || was.classification === "taste") {
        delete row.question;
        delete row.question_file;
        delete row.assert;
        delete row.mutation;
        row.reason = `${row.reason} — ratified onto the human rung`;
      }
      row.classification = was.classification;
    }
    row.ratified = true;
    kept++;
  }
  return { kept, dropped };
}
/**
 * Throws when writing `outPath` would write the ISA: the same path, a symlink to
 * it (leaf or through a linked directory), or a hardlink sharing its inode. The
 * no-modification invariant in propose ran only AFTER the write, so `--out <ISA>`
 * overwrote the ISA and then threw (S075).
 */
export function refuseIsaAlias(isaAbs: string, outPath: string): void {
  if (resolve(outPath) === resolve(isaAbs)) throw new Error(`refusing to write the proposal to ${outPath}: that is the ISA itself`);
  let isa: ReturnType<typeof statSync>;
  try { isa = statSync(isaAbs); } catch { throw new Error(`ISA ${isaAbs} cannot be read to check the proposal path`); }
  let out: ReturnType<typeof statSync> | null = null;
  try { out = statSync(outPath); } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw new Error(`refusing to write the proposal to ${outPath}: it cannot be checked (${code ?? String(e)})`);
  }
  if (out && out.dev === isa.dev && out.ino === isa.ino) throw new Error(`refusing to write the proposal to ${outPath}: it aliases the ISA itself (a link to ${isaAbs})`);
}

/**
 * Classify every manual row, draft what can be drafted, and write ONE file
 * beside the ISA. The ISA itself is never opened for writing on this path —
 * `propose` reads it and nothing else (ISC-14).
 */
export async function propose(isaPath: string, opts: ProposeOptions = {}): Promise<ProposeResult> {
  const abs = resolve(isaPath);
  if (!existsSync(abs)) throw new Error(`no ISA at ${abs}`);
  const isaDir = dirname(abs);
  // Refused before any work, and checked again at the write (S075).
  refuseIsaAlias(abs, opts.out ? resolve(opts.out) : proposalPathFor(isaDir));
  const cwd = opts.cwd ?? repoRootOf(isaDir) ?? isaDir;
  const rows = manualRows(abs);
  const boundary = boundaryContextFor(abs);
  // ISC-35 runs first and costs nothing: a row whose criterion is already covered by
  // a real row is a duplicate, so it is neither judged nor drafted for.
  const retiring = new Map<string, RetireVerdict>();
  for (const row of rows) {
    const v = retireVerdict(row);
    if (v.retire) retiring.set(rowKey(row), v);
  }
  const verdicts = await classifyRows(rows.filter((r) => !retiring.has(rowKey(r))), opts);
  const env = opts.env ?? process.env;
  // A rerun must not throw away a human's ratification. Anything already marked
  // ratified keeps its decision: the rung a person moved the row to, and the
  // producer they re-aimed it at, which is fed back through the normal resolve
  // and mutation path rather than pasted in.
  const carried = carriedRatifications(opts.out ? resolve(opts.out) : defaultProposalPath(isaDir));

  // File stems are assigned HERE and nowhere else, because uniqueness is a
  // property of the whole proposal, not of any one row. `apply` reads the stem
  // back off `question_file` rather than re-deriving it.
  const usedStems = new Set<string>();
  const producedByKey = new Map<string, ProducedState>();
  const proposalRows: ProposalRow[] = rows.map((row) => {
    const retire = retiring.get(rowKey(row));
    if (retire) {
      return {
        isc: row.probe.isc, occurrence: row.occurrence, claim: row.claim,
        check: row.probe.check, threshold: row.probe.threshold,
        classification: "retire" as const, classified_by: "fallback" as const,
        reason: retire.reason, covered_by: retire.covered_by, ratified: false,
      };
    }
    const v = verdicts.get(rowKey(row))!;
    const common = {
      isc: row.probe.isc,
      occurrence: row.occurrence,
      claim: row.claim,
      check: row.probe.check,
      threshold: row.probe.threshold,
      classification: v.classification,
      classified_by: v.by,
      ...(v.confidence !== undefined ? { confidence: v.confidence } : {}),
      ...(v.confirmation ? { confirmation: v.confirmation } : {}),
      reason: v.reason,
      ratified: false,
    };
    if (v.classification === "codable") {
      // ISC-33: a draft that cannot fail is not recorded. The row drops to the
      // human rung carrying the brief that turns it into a dispatch.
      const drafted = draftAssert(row, cwd, env, isaDir);
      if ("refused" in drafted) {
        return {
          ...common, classification: "manual" as const,
          reason: `${common.reason} — stays manual: ${drafted.refused}`,
          brief: briefFor(row, boundary, drafted.refused),
        };
      }
      return { ...common, assert: drafted.assert };
    }
    if (v.classification === "readable") {
      const qid = row.occurrence > 1 ? `${row.probe.isc}.${row.occurrence}` : row.probe.isc;
      let stem = questionStem(qid);
      for (let n = 2; usedStems.has(stem); n++) stem = questionStem(`${qid}-${n}`);
      usedStems.add(stem);
      const ratifiedProducer = carried.get(rowKey(row))?.producer;
      const drafted = ratifiedProducer
        ? { producer: ratifiedProducer, boundary: "the boundary the ratification re-aimed this row at" }
        : draftProducer(row.claim, row.probe.check, boundary);
      const NO_BOUNDARY = `no boundary producer: ${matchStateSource(`${row.claim} ${row.probe.check}`, boundary.sources!).reason}`;
      if (!drafted) {
        return { ...common, classification: "manual" as const, reason: `${common.reason} — stays manual: no boundary producer`, producer: { resolved: false, reason: NO_BOUNDARY } };
      }
      const question = draftQuestion(row, SHADOW_CALLER, qid, drafted.producer);
      try {
        validateQuestionFile(question, `drafted question for ${qid}`, abs);
      } catch (e) {
        const why = `no boundary producer: the drafted one is not allowed — ${(e as Error).message}`;
        return { ...common, classification: "manual" as const, reason: `${common.reason} — stays manual: no boundary producer`, producer: { resolved: false, command: drafted.producer, boundary: drafted.boundary, reason: why } };
      }
      if (isHeavyProducer(drafted.producer)) {
        const why = "no boundary producer yet: a build or test-suite producer is drafted but not run by propose, because it writes into the working tree and exceeds the run timeout — run it yourself and hand-check the state before ratifying";
        return { ...common, classification: "manual" as const, reason: `${common.reason} — stays manual: no boundary producer`, producer: { resolved: false, command: drafted.producer, boundary: drafted.boundary, reason: why } };
      }
      // Run it once, now, so the row records what the boundary actually gave.
      // The same text draftQuestion reads, so the region is centred on the
      // terms the engine will be asked about.
      const produced = runProducer(drafted.producer, isaDir, cwd, env, `${row.claim || row.probe.check} ${row.probe.check}`.trim(), { resolveHost: opts.resolveHost });
      const record = { command: drafted.producer, boundary: drafted.boundary, exit: produced.exit ?? null, bytes: produced.bytes ?? 0 };
      if (!produced.ok) {
        const why = `no boundary producer: the drafted one did not return usable state — ${produced.error ?? "unknown"}`;
        return { ...common, classification: "manual" as const, reason: `${common.reason} — stays manual: no boundary producer`, producer: { ...record, resolved: false, reason: why } };
      }
      if (produced.state === null || !firstTermMatch(stateText(produced.state), row.claim || row.probe.check)) {
        return { ...common, classification: "manual" as const, reason: `${common.reason} — stays manual: output does not reach the criterion`, producer: { ...record, resolved: false, reason: "producer: unresolved (output does not reach the criterion)" } };
      }
      producedByKey.set(rowKey(row), produced);
      return {
        ...common, question, question_file: join("Questions", `${stem}.json`),
        ...(produced.shaping ? { state_shaping: produced.shaping, ...(produced.term ? { state_region_term: produced.term } : {}) } : {}),
        producer: { ...record, resolved: true },
      };
    }
    return { ...common, reason: `${v.reason} — stays manual: a person must judge this one` };
  });

  const kept = applyRatifications(proposalRows, carried);

  const readable = proposalRows.filter((r) => r.classification === "readable" && r.question);
  invariant(new Set(readable.map((r) => r.question_file!)).size === readable.length, "each readable row must draft its own question file");
  invariant(new Set(readable.map((r) => r.question!.id)).size === readable.length, "each readable row must draft its own question id");

  // ISC-30: no question is proposed for real until it has been shown able to fail.
  const keyByRow = new Map(rows.map((r) => [rowKey(r), r]));
  const sensitivity = await mutationPass(
    readable.map((r) => ({ key: `${r.isc}#${r.occurrence ?? 1}`, q: r.question!, produced: producedByKey.get(`${r.isc}#${r.occurrence ?? 1}`) })),
    isaDir, cwd, opts,
  );
  for (const r of readable) {
    const key = `${r.isc}#${r.occurrence ?? 1}`;
    r.mutation = sensitivity.get(key) ?? { verdict: "unverified", note: "the mutation pass returned no report for this row" };
  }
  // A row whose boundary never RESOLVED has no question to test, so its
  // sensitivity is unverified for that reason and not for a probability. A row
  // whose producer resolved and which a person then ratified back onto the human
  // rung is a different thing entirely: it gets no mutation report, because
  // nothing about it is pending. Tagging those read "no producer" on a producer
  // that had just returned plenty of output.
  for (const r of proposalRows.filter((x) => x.classification === "manual" && x.producer && !x.producer.resolved)) {
    r.mutation = { verdict: "unverified", note: `the question was never asked: ${r.producer!.reason ?? "the boundary producer did not resolve"}` };
  }
  invariant(keyByRow.size === rows.length, "every manual row must have a distinct key");

  const decidedByEngine = proposalRows.some((r) => r.classified_by === "engine-shadow");
  const proposal: IscTierProposal = {
    version: PROPOSAL_VERSION,
    isa: abs,
    isa_sha256: sha256(readFileSync(abs, "utf8")),
    generated: new Date().toISOString(),
    classifier: {
      path: decidedByEngine ? "engine-shadow" : "fallback",
      caller: CLASSIFY_CALLER,
      note: decidedByEngine
        ? `the engine answered in shadow mode and its answer was read directly, never decide()'s verdict — a proposal is a draft, not an action; each row records its own path in classified_by`
        : `the engine decided nothing — every row was classified by the deterministic keyword pass`,
    },
    rows: proposalRows,
  };

  const outPath = opts.out ? resolve(opts.out) : proposalPathFor(isaDir);
  refuseIsaAlias(abs, outPath);
  const before = statSync(abs).mtimeMs;
  mkdirSync(dirname(outPath), { recursive: true });
  // Written as a new file renamed into place: even a link planted after the alias
  // check only loses its directory entry; the ISA's own bytes are never opened.
  atomicWrite(outPath, renderProposal(proposal), { mode: replacementMode(outPath) });
  invariant(statSync(abs).mtimeMs === before, "propose must never modify the ISA");
  return { proposal, path: outPath, kept };
}

// ── backfill ────────────────────────────────────────────────────────────────

export type ArtifactKind = "commit" | "file";
export interface BackfillArtifact {
  kind: ArtifactKind;
  ref: string;
  hash: string;
  /**
   * `commit` — the hash IS the tree at close time, so staleness against HEAD is exact.
   * `first-observed` — a file named in the Evidence line, hashed the first time backfill
   * saw it. That is the earliest point the system can observe the artifact; a change
   * between close and first backfill is invisible, which is why such a label is weaker
   * evidence than a commit-bound one even when it is not stale.
   */
  hash_basis: "commit" | "first-observed";
}

export interface BackfillEntry extends CalEntry {
  ts: string;
  provenance: "backfill";
  backfill_key: string;
  artifact?: BackfillArtifact;
  stale?: boolean;
}

export interface BackfillRow {
  claim: string;
  seed: string;
  action: "added" | "refreshed" | "unchanged" | "skipped";
  reason?: string;
  stale?: boolean;
  artifact?: BackfillArtifact;
  /**
   * Whether `computeClaimHash` could bind this label to the criterion's prose and
   * its manual contract. `unbound` means the seed carries no binding, which
   * makes `lookupAttestation` read it as stale forever — worth saying out loud
   * rather than swallowing, since the usual cause is a Test Strategy header the
   * parser does not recognise.
   */
  claim_hash?: "bound" | "unbound";
}

export interface BackfillResult {
  isa: string;
  rows: BackfillRow[];
  added: number;
  refreshed: number;
  skipped: number;
  stale: number;
  unbound: number;
}

/** The `git` repository a path sits in, or null. */
export function repoRootOf(dir: string): string | null {
  const r = runBounded("git rev-parse --show-toplevel", dir);
  const out = r.stdout.trim();
  return r.exit === 0 && out !== "" ? out : null;
}

/** The Evidence text for one criterion: from the criterion line itself, else from a `## Verification` stub. */
export function evidenceFor(isaPath: string, claim: IsaClaim): string | null {
  const body = isaBody(readFileSync(isaPath, "utf8"));
  const lines = body.split(/\r?\n/);
  const own = lines[claim.line - 1]?.match(/\bEvidence\s*:\s*(.+?)\s*$/i);
  if (own?.[1]) return own[1].trim();
  let inVerification = false;
  for (const raw of lines) {
    if (/^##\s+/.test(raw)) { inVerification = /^##\s+Verification\b/i.test(raw); continue; }
    if (!inVerification) continue;
    const m = raw.match(/^\s*[-*+]\s+`?([A-Za-z][A-Za-z0-9.-]*)`?\s*(?::|[—–])\s*(.+?)\s*$/);
    if (m && m[1] === claim.id && m[2]) return m[2].trim();
  }
  return null;
}

/**
 * Recover the artifact an Evidence line points at. A commit hash is preferred
 * because it binds the whole tree at close time; a file path is the fallback
 * and is hashed as first observed (see BackfillArtifact.hash_basis). Returns
 * null when the line names neither — and then the label carries no staleness
 * criterion at all, rather than a guessed one.
 */
export function recoverArtifact(evidence: string, isaDir: string, repo: string | null): BackfillArtifact | null {
  if (repo) {
    for (const m of evidence.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      const r = runBounded(`git rev-parse --verify --quiet ${shellQuote(`${m[0]}^{commit}`)}`, repo);
      const full = r.stdout.trim();
      if (r.exit === 0 && /^[0-9a-f]{40}$/.test(full)) return { kind: "commit", ref: m[0], hash: full, hash_basis: "commit" };
    }
  }
  for (const m of evidence.matchAll(/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+\.[A-Za-z0-9]{1,8}\b/g)) {
    for (const base of [isaDir, ...(repo ? [repo] : [])]) {
      const target = resolve(base, m[0]);
      try {
        const real = realpathSync(target);
        if (!statSync(real).isFile()) continue;
        return { kind: "file", ref: relative(base, real) || m[0], hash: sha256(readFileSync(real, "utf8")), hash_basis: "first-observed" };
      } catch { /* not a readable file here; try the next base */ }
    }
  }
  return null;
}

/** The artifact's hash today, for the staleness comparison. Null when it cannot be computed now. */
export function currentArtifactHash(a: BackfillArtifact, isaDir: string, repo: string | null): string | null {
  if (a.kind === "commit") {
    if (!repo) return null;
    const r = runBounded("git rev-parse HEAD", repo);
    const out = r.stdout.trim();
    return r.exit === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
  }
  for (const base of [isaDir, ...(repo ? [repo] : [])]) {
    const target = resolve(base, a.ref);
    try { return sha256(readFileSync(realpathSync(target), "utf8")); } catch { /* try the next base */ }
  }
  return null;
}

export interface BackfillOptions {
  /** Include every `[x]` criterion, not only the ones still on the human rung. */
  all?: boolean;
  seeds?: string;
  /** LabelStore file the seed records land in (defaults to the store's own path resolution). */
  labelStore?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Record one calibration label per closed criterion from the Evidence line the
 * person wrote when they closed it (ISC-15). The seed format is the one
 * `bunker attest` already writes — never a second one — so these labels sit
 * beside hand-attested ones and feed the same ladder. Like attest it writes
 * LabelStore seed records only; the YAML file is the store's regenerated view.
 *
 * Idempotent by construction: each label carries a key over its criterion and its
 * evidence text, and a re-run with the same evidence refreshes the staleness of
 * the existing entry instead of appending a second one.
 */
export function backfill(isaPath: string, opts: BackfillOptions = {}): BackfillResult {
  const abs = resolve(isaPath);
  if (!existsSync(abs)) throw new Error(`no ISA at ${abs}`);
  const canonical = realpathSync(abs);
  const isaDir = dirname(canonical);
  const repo = repoRootOf(isaDir);
  const seeds = opts.seeds ?? seedsDir(opts.env ?? process.env);
  const now = (opts.now ?? new Date()).toISOString();
  const isaKey = isaKeyOf(canonical);
  const store = opts.labelStore ? { path: opts.labelStore } : {};

  const { probes } = parseTestStrategyDiagnostic(canonical);
  const rowsByIsc = new Map<string, Probe[]>();
  for (const p of probes) rowsByIsc.set(p.isc, [...(rowsByIsc.get(p.isc) ?? []), p]);

  const out: BackfillRow[] = [];
  for (const claim of parseIsaClaims(canonical).claims) {
    if (!claim.checked) continue;
    const rows = rowsByIsc.get(claim.id) ?? [];
    // Default scope is the human rung and the unprobed: a closed criterion that already
    // has a deterministic probe needs no label, and seeding one would make it look
    // judge-ready in the residue report for no reason.
    const onHumanRung = rows.length === 0 || rows.some((p) => p.type === "manual");
    if (!opts.all && !onHumanRung) { out.push({ claim: claim.id, seed: "", action: "skipped", reason: "already has a non-manual probe (pass --all to include it)" }); continue; }
    const evidence = evidenceFor(canonical, claim);
    if (!evidence) { out.push({ claim: claim.id, seed: "", action: "skipped", reason: "closed with no Evidence line to read a label from" }); continue; }

    // LabelStore holds the seed record and the YAML is regenerated from it (ISC-15): adopt any hand-written file first so the
    // store's view is the one this run reads and amends, then write only through addSeedEntry / amendSeedEntry.
    adoptSeedFile(seeds, isaKey, claim.id, store);
    const view = seedViewOf(isaKey, claim.id, store);
    const current0 = view?.entries ?? [];
    const key = sha256(`${claim.id}\u001f${evidence}`);
    const existing = current0.findIndex((e) => e.backfill_key === key);
    const prior = existing >= 0 ? (current0[existing] as unknown as BackfillEntry) : undefined;

    const stored = prior?.artifact;
    const artifact = stored ?? recoverArtifact(evidence, isaDir, repo) ?? undefined;
    const current = artifact ? currentArtifactHash(artifact, isaDir, repo) : null;
    const stale = artifact && current !== null ? current !== artifact.hash : undefined;

    const manualCheck = rows.filter((p) => p.type === "manual").map((p) => p.check).join(" / ");
    const entry: BackfillEntry = {
      output: redactForEngine(evidence, 2000),
      assert: { type: "manual", value: manualCheck || claim.id },
      label: "pass",
      note: "backfilled from the ISA Evidence line at close",
      // A refreshed label keeps the date it was first recorded: only moved evidence or staleness is a new record in the append-only store.
      label_source: prior?.label_source ?? { kind: "principal", delegated: false, labeler: "isc-tier-backfill", date: now, principal_reviewed: false },
      ts: prior?.ts ?? now,
      provenance: "backfill",
      backfill_key: key,
      ...(artifact ? { artifact } : {}),
      ...(stale === undefined ? {} : { stale }),
    };

    const claimHash = claimHashOrNull(canonical, claim.id);
    const asRecord = entry as unknown as Record<string, unknown>;
    let action: BackfillRow["action"];
    let seedPath: string | null;
    if (!prior) {
      seedPath = addSeedEntry(seeds, isaKey, claim.id, { isa: view?.header.isa ?? canonical, claim: claim.id, claim_hash: claimHash }, asRecord, store).path;
      action = "added";
    } else if (JSON.stringify(asRecord) === JSON.stringify(current0[existing])) {
      // Nothing moved: no store record, only make sure the view is on disk.
      seedPath = writeSeedView(seeds, isaKey, claim.id, store);
      action = "unchanged";
    } else {
      seedPath = amendSeedEntry(seeds, isaKey, claim.id, view!.indices[existing]!, current0[existing]!, asRecord, store);
      action = "refreshed";
    }
    const after = seedViewOf(isaKey, claim.id, store)?.entries.length ?? 0;
    invariant(seedPath !== null && after === current0.length + (prior ? 0 : 1), "backfill must append at most one label per criterion per run");
    out.push({
      claim: claim.id, seed: seedPath, action,
      ...(stale === undefined ? {} : { stale }),
      ...(artifact ? { artifact } : {}),
      claim_hash: claimHash ? "bound" : "unbound",
    });
  }

  return {
    isa: canonical,
    rows: out,
    added: out.filter((r) => r.action === "added").length,
    refreshed: out.filter((r) => r.action === "refreshed").length,
    skipped: out.filter((r) => r.action === "skipped").length,
    stale: out.filter((r) => r.stale === true).length,
    unbound: out.filter((r) => r.claim_hash === "unbound").length,
  };
}

/** `computeClaimHash` binds the criterion prose and its manual contract; a criterion with no manual row has no binding to write. */
function claimHashOrNull(isaPath: string, claim: string): string | undefined {
  try { return requireAttest().computeClaimHash(isaPath, claim); } catch { return undefined; }
}

// ── shadow ──────────────────────────────────────────────────────────────────

/**
 * Where a proposal lives when nobody names one: the `.isc-tier` directory
 * beside the ISA, falling back to the pre-2026-09-22 root location so an
 * existing proposal keeps working without being moved by hand.
 */
export function defaultProposalPath(isaDir: string): string {
  const current = proposalPathFor(isaDir);
  if (existsSync(current)) return current;
  const legacy = legacyProposalPathFor(isaDir);
  return existsSync(legacy) ? legacy : current;
}

export interface ShadowOptions {
  proposal?: string;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  callersPath?: string;
  cwd?: string;
  session?: string;
}

export interface ShadowResult {
  questions: number;
  calls: number;
  answered: number;
  failed: number;
  /** Ledger lines the run appended, counted off the shadow log itself. */
  ledgerRows: number;
  producerErrors: { id: string; error: string }[];
  errors: { key: string; error: string }[];
}

/**
 * Run every proposed question once against current state under a shadow caller,
 * so an agreement rate is computable before anything is ratified (ISC-16).
 *
 * Questions that share one state travel together in one call; a question marked
 * `independent` always travels alone, because pooling answers that must not
 * inform each other is the failure ISC-24 names.
 */
export async function shadow(isaPath: string, opts: ShadowOptions = {}): Promise<ShadowResult> {
  const abs = resolve(isaPath);
  const isaDir = dirname(abs);
  const proposalPath = opts.proposal ? resolve(opts.proposal) : defaultProposalPath(isaDir);
  if (!existsSync(proposalPath)) throw new Error(`no proposal at ${proposalPath} — run \`IscTier.ts propose\` first`);
  const proposal = parseProposal(readFileSync(proposalPath, "utf8"), proposalPath, { isaPath: abs, notes: [] });
  const cwd = opts.cwd ?? repoRootOf(isaDir) ?? isaDir;
  const env = opts.env ?? process.env;
  const logPath = opts.logPath;

  const questions = proposal.rows.filter((r) => r.question).map((r) => r.question!);
  const producerErrors: { id: string; error: string }[] = [];

  // Group by the state each question reads. Same state, one call — unless the
  // question is marked independent.
  const pools = new Map<string, { state: string | object; qs: IscQuestionFile[] }>();
  const solo: { state: string | object; q: IscQuestionFile }[] = [];
  for (const q of questions) {
    const produced = runProducer(q.state.producer, isaDir, cwd, env, q.claim);
    if (!produced.ok || produced.state === null) { producerErrors.push({ id: q.id, error: produced.error ?? "producer failed" }); continue; }
    if (q.independent) { solo.push({ state: produced.state, q }); continue; }
    const key = sha256(`${q.state.producer}\u001f${JSON.stringify(produced.state)}`);
    const pool = pools.get(key) ?? { state: produced.state, qs: [] };
    pool.qs.push(q);
    pools.set(key, pool);
  }

  const items = [
    ...[...pools.entries()].map(([key, p]) => ({ key: `pool:${key.slice(0, 12)}`, state: p.state, questions: Object.fromEntries(p.qs.map((q) => [q.id, engineQuestion(q)])) })),
    ...solo.map(({ state, q }) => ({ key: `solo:${q.id}`, state, questions: { [q.id]: engineQuestion(q) } })),
  ];

  const before = ledgerLineCount(logPath);
  let results: ManyResult[] = [];
  if (items.length > 0) {
    try {
      results = await judgeMany(items, {}, { caller: SHADOW_CALLER, env, logPath, callersPath: opts.callersPath, session: opts.session });
    } catch (e) {
      results = items.map((i) => ({ key: i.key, result: null, error: (e as Error)?.message ?? String(e) }));
    }
  }
  const after = ledgerLineCount(logPath);

  const answered = results.filter((r) => r.result !== null).length;
  return {
    questions: questions.length,
    calls: items.length,
    answered,
    failed: results.length - answered,
    ledgerRows: after === null || before === null ? 0 : Math.max(0, after - before),
    producerErrors,
    errors: results.filter((r) => r.error !== null).map((r) => ({ key: r.key, error: r.error! })),
  };
}

function ledgerLineCount(logPath?: string): number | null {
  const p = logPath ?? process.env.LIFEOS_GLANCE_LOG ?? process.env.LIFEOS_JEV_LOG; // LIFEOS_JEV_LOG: legacy fallback from before Jev was retired 2026-10-10
  if (!p) return null;
  try { return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").length; } catch { return 0; }
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface ApplyChange { isc: string; occurrence: number; from: "manual"; to: "bash" | "glance" | "removed"; line: number; wrote?: string }
export interface ApplySkip { isc: string; reason: string }
export interface ApplyResult {
  isa: string;
  changes: ApplyChange[];
  skipped: ApplySkip[];
  questionFiles: string[];
  /** Lines of the ISA that changed. Every other line is byte-identical. */
  changedLines: number;
  diffStat: string;
}

export interface ApplyOptions { proposal?: string; dryRun?: boolean }

/**
 * Where a proposal's question file may be written. The path comes from a
 * proposal file a person ratified, but the proposal is data: a row can say
 * `../../x` or an absolute path or sit behind a symlinked directory, and apply
 * would write there. The target must be relative, and its deepest existing
 * ancestor (and the file itself, when it exists) must dereference to a place
 * inside the ISA directory. The lexical check alone is bypassable through a
 * symlinked path component. Returns the absolute target, or throws.
 */
export function confineQuestionPath(isaDir: string, rel: string): string {
  if (typeof rel !== "string" || rel.trim() === "" || rel.includes("\0")) throw new Error("question_file is empty or malformed");
  if (isAbsolute(rel)) throw new Error(`question_file must be relative to the ISA directory, not "${rel}"`);
  let root: string;
  try { root = realpathSync(isaDir); } catch { throw new Error(`ISA directory ${isaDir} cannot be resolved`); }
  const target = resolve(root, rel);
  const inside = (p: string): boolean => { const r = relative(root, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  if (!inside(target)) throw new Error(`question_file "${rel}" resolves outside the ISA directory`);
  // The file itself is never a link, dangling or not: existsSync reads a dangling
  // link as absent, and the write would then follow it out of the directory.
  const present = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
  if (present(target) && lstatSync(target).isSymbolicLink()) throw new Error(`question_file "${rel}" is a link; question files are never written through one`);
  // A hardlink resolves inside the directory by path while sharing an inode that
  // may live anywhere, so an existing target must be a regular file with one link (S076).
  if (present(target)) {
    const st = lstatSync(target);
    if (!st.isFile()) throw new Error(`question_file "${rel}" exists and is not a regular file`);
    if (st.nlink > 1) throw new Error(`question_file "${rel}" is hardlinked (${st.nlink} links); question files are never written through a shared inode`);
  }
  // Dereference the deepest ancestor that exists (lstat, so a dangling link counts
  // as existing and then fails to resolve); the rest does not exist yet, so it
  // cannot be a link.
  let probe = target;
  while (!present(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real: string;
  try { real = realpathSync(probe); } catch { throw new Error(`question_file "${rel}" cannot be resolved (a dangling link)`); }
  const realRel = relative(root, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(`question_file "${rel}" reaches outside the ISA directory through a link`);
  return target;
}

/**
 * The mode a file written by rename-into-place gets. The truncating writers this
 * replaced kept a replaced file's mode and let the umask narrow a new one, while
 * atomicWrite applies the mode it is given unconditionally; a fixed 0644 widened an
 * existing 0600 file and overrode a restrictive umask (S075/S076 review). So an
 * existing regular file keeps its own bits and a new file gets 0644 less the umask,
 * each capped at 0644, so this never grants more than either writer did.
 */
export function replacementMode(path: string): number {
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(path); } catch { /* absent: a new file */ }
  const mode = st && st.isFile() ? (st.mode & 0o644) : (0o644 & ~process.umask());
  invariant(Number.isInteger(mode) && mode >= 0 && (mode & ~0o644) === 0, `replacementMode: ${mode} is outside 0644`);
  return mode;
}

/**
 * Create or replace one question file by writing a new file beside it and
 * renaming it into place (Boundary.atomicWrite). The rename replaces the
 * directory entry and never opens what was there, so neither a symlink nor a
 * hardlink planted between the confinement check and the write can redirect or
 * truncate another file; the old open-with-O_TRUNC truncated a hardlinked inode (S076).
 */
export function writeQuestionFile(target: string, question: unknown): void {
  const abs = resolve(target);
  // A leaf link handed in directly is still refused loudly (the rename would only
  // replace it, but a caller passing one has skipped confinement).
  let leafIsLink = false;
  try { leafIsLink = lstatSync(abs).isSymbolicLink(); } catch { /* absent: a new file */ }
  if (leafIsLink) throw new Error(`question file ${abs} is a link; question files are never written through one`);
  atomicWrite(abs, `${JSON.stringify(question, null, 2)}\n`, { mode: replacementMode(abs) });
}

/**
 * Write the ratified rows into the ISA's Test Strategy and the question files
 * beside it (ISC-17). Three refusals make this safe to run:
 *
 *   - no `--proposal` at all (anti-criterion A2: no migration without a record);
 *   - a proposal whose `isa_sha256` no longer matches the ISA on disk, because
 *     applying a row drafted against a table nobody has read since is how an
 *     unratified change lands under a ratified row's name;
 *   - a row whose resolved `isc` and `type` cells do not hold what the parser
 *     reported, which is the one way a column-resolution mistake could edit the
 *     wrong cell of the right row.
 *
 * Cells are edited in place, so every other cell of every other row stays
 * byte-identical whatever column order the table uses.
 */
export function apply(isaPath: string, opts: ApplyOptions = {}): ApplyResult {
  if (!opts.proposal) throw new Error("apply refuses without --proposal: a migration needs a ratification record (ISA anti-criterion A2)");
  const abs = resolve(isaPath);
  if (!existsSync(abs)) throw new Error(`no ISA at ${abs}`);
  const proposalPath = resolve(opts.proposal);
  if (!existsSync(proposalPath)) throw new Error(`no proposal at ${proposalPath}`);
  const parseNotes: string[] = [];
  const proposal = parseProposal(readFileSync(proposalPath, "utf8"), proposalPath, { isaPath: abs, notes: parseNotes });

  const original = readFileSync(abs, "utf8");
  if (sha256(original) !== proposal.isa_sha256) {
    throw new Error(`the ISA changed since this proposal was written (sha256 mismatch) — re-run \`IscTier.ts propose\` and re-ratify`);
  }

  const ratified = proposal.rows.filter((r) => r.ratified);
  const skipped: ApplySkip[] = proposal.rows.filter((r) => !r.ratified).map((r) => ({ isc: r.isc, reason: "not ratified" }));
  for (const note of parseNotes) skipped.push({ isc: "(unratified)", reason: note });
  // A ratified row is addressed by its ISC id AND its position among the manual
  // rows sharing that id: one criterion routinely carries several manual checks.
  const keyOf = (r: { isc: string; occurrence?: number }): string => `${r.isc}#${r.occurrence ?? 1}`;
  const pending = new Map(ratified.map((r) => [keyOf(r), r]));
  const wanted = new Set(ratified.map((r) => r.isc));

  const lines = original.split("\n");
  // Line indexes to delete, collected and applied after the walk so the loop
  // never renumbers the table under itself.
  const removals: number[] = [];
  const changes: ApplyChange[] = [];
  const questionFiles: string[] = [];
  const writes: { path: string; question: IscQuestionFile }[] = [];
  const seen = new Map<string, number>();
  let inSection = false;
  let col = resolveColumns(null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.startsWith("## ")) { inSection = /^##\s+Test Strategy\b/i.test(t); if (!inSection) col = resolveColumns(null); continue; }
    if (!inSection || !t.startsWith("|")) continue;
    const cells = splitRow(t);
    if (cells[0]?.toLowerCase() === "isc") { col = resolveColumns(cells); continue; }
    if (cells.every((c) => c === "" || /^:?-+:?$/.test(c))) continue;

    const isc = cells[col.isc] ?? "";
    if (!wanted.has(isc)) continue;
    // Identity guard: a ratified row whose resolved type cell is not even a
    // probe type means the columns did not resolve as the parser resolved them.
    // Refuse rather than edit a cell we cannot name.
    const type = (cells[col.type] ?? "").trim();
    if (!isProbeType(type)) { skipped.push({ isc, reason: `resolved type cell is "${type}", not a probe type — the table's columns did not resolve; refused` }); continue; }
    if (type !== "manual") continue;
    const occurrence = (seen.get(isc) ?? 0) + 1;
    seen.set(isc, occurrence);
    const row = pending.get(`${isc}#${occurrence}`);
    if (!row || row.classification === "taste" || row.classification === "manual") continue;
    if (row.classification === "retire") {
      // ISC-35: the row leaves the table. Nothing is rewritten and no question
      // is written, because the criterion is already checked by the rows named in
      // covered_by; keeping rows like this one is what filled a table with duplicates.
      removals.push(i);
      changes.push({ isc, occurrence, from: "manual", to: "removed", line: i + 1 });
      pending.delete(`${isc}#${occurrence}`);
      continue;
    }
    // ISC-30: a question that was never shown able to fail is not written into
    // an ISA, whatever a person ticked. Ratification says "this is the right
    // check"; sensitivity says "this check can say no". Both are needed.
    if (row.classification === "readable" && row.mutation?.verdict !== "sensitive") {
      skipped.push({ isc, reason: `mutation sensitivity is "${row.mutation?.verdict ?? "missing"}", not "sensitive" — a question that cannot fail is not a verifier (ISC-30): ${row.mutation?.note ?? ""}`.trim() });
      pending.delete(`${isc}#${occurrence}`);
      continue;
    }

    const next = [...cells];
    if (row.classification === "codable") {
      next[col.type] = "bash";
      next[col.tool] = `\`${row.assert!.command}\``;
      next[col.threshold] = row.assert!.expected;
      // A freshly drafted assert must not enter the blocking deploy gate by
      // default: a blank lane cell resolves to liveness for a deterministic row.
      if (laneCellIsLiveness(next[col.tier])) next[col.tier] = "integrity";
      changes.push({ isc, occurrence, from: "manual", to: "bash", line: i + 1 });
    } else {
      const q = row.question!;
      validateQuestionFile(q, `${proposalPath} row ${isc}`, abs);
      // The stem was assigned once, by propose, and lives in `question_file`.
      // Re-deriving it here is how two rows of one ISC end up pointing at the
      // same file, so it is read back rather than recomputed.
      const rel = row.question_file ?? join("Questions", `${questionStem(q.id)}.json`);
      try { confineQuestionPath(dirname(abs), rel); } catch (e) {
        skipped.push({ isc, reason: `question_file refused: ${(e as Error).message}` });
        pending.delete(`${isc}#${occurrence}`);
        continue;
      }
      const stem = basename(rel, ".json");
      next[col.type] = "glance";
      next[col.tool] = `\`${glancePointer(stem, q.id)}\``;
      next[col.threshold] = "answered";
      // A glance row on the liveness lane is DROPPED by the parser, so an
      // explicit liveness cell has to move; a blank one already means integrity.
      if (laneCellIsLiveness(next[col.tier])) next[col.tier] = "integrity";
      // Stage 2 is the asserts-gate-judges rule: a judgment runs only after the
      // deterministic rows of the same ISC have passed. A blank cell already
      // defaults to 2 for a judged row; an explicit 1 inherited from the manual
      // row would put the judgment in front of the gate, so it moves.
      if (/^[1-9]\d*$/.test((next[col.stage] ?? "").trim()) && Number((next[col.stage] ?? "").trim()) < 2) next[col.stage] = "2";
      questionFiles.push(rel);
      writes.push({ path: rel, question: q });
      changes.push({ isc, occurrence, from: "manual", to: "glance", line: i + 1, wrote: rel });
    }
    lines[i] = joinRow(next);
    pending.delete(`${isc}#${occurrence}`);
  }

  for (const [, r] of pending) skipped.push({ isc: r.isc, reason: "ratified but no matching manual row found in the Test Strategy" });

  // Deletions land last, highest index first, so an earlier removal never
  // shifts a later one. changedLines counts a removed row as one changed line.
  const removed = new Set(removals);
  const kept = lines.filter((_, i) => !removed.has(i));
  const updated = kept.join("\n");
  const before = original.split("\n");
  const changedLines = lines.reduce((n, l, i) => n + (l === before[i] ? 0 : 1), 0) + removals.length;

  if (!opts.dryRun) {
    // The question to write is the one the scan loop resolved, carried here by
    // value. Looking the row back up by ISC id would hand both rows of a
    // duplicated id the same question — the bug a production app ISA found.
    for (const w of writes) {
      // Checked again at the write, so the path is dereferenced as late as possible.
      const target = confineQuestionPath(dirname(abs), w.path);
      mkdirSync(dirname(target), { recursive: true });
      confineQuestionPath(dirname(abs), w.path);
      writeQuestionFile(target, w.question);
    }
    if (changes.length > 0) writeFileSync(abs, updated);
  }

  return { isa: abs, changes, skipped, questionFiles, changedLines, diffStat: gitDiffStat(abs) };
}

/** A lane cell that resolves to the liveness lane: blank, `fast`, or `liveness`. */
function laneCellIsLiveness(cell: string | undefined): boolean {
  const c = (cell ?? "").trim().toLowerCase();
  return c === "" || c === "fast" || c === "liveness";
}

function gitDiffStat(path: string): string {
  const repo = repoRootOf(dirname(path));
  if (!repo) return "(not a git repository — no diff stat)";
  const r = runBounded(`git --no-pager diff --stat -- ${shellQuote(relative(repo, path))} ${shellQuote(relative(repo, join(dirname(path), "Questions")))}`, repo);
  const out = r.stdout.trim();
  return out === "" ? "(no tracked changes)" : out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function flag(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string, argv: string[]): boolean => argv.includes(name);

const USAGE = `Usage:
  bun LIFEOS/TOOLS/IscTier.ts triage --estate [--offline] [--out <dir>]
  bun LIFEOS/TOOLS/IscTier.ts propose  <isa> [--offline] [--cwd <dir>] [--out <file>]
  bun LIFEOS/TOOLS/IscTier.ts backfill <isa> [--all] [--seeds <dir>] [--json]
  bun LIFEOS/TOOLS/IscTier.ts shadow   <isa> [--proposal <file>]
  bun LIFEOS/TOOLS/IscTier.ts apply    <isa> --proposal <file> [--dry-run]

propose classifies every manual row as codable / readable / taste, drafts an assert or a
question for the first two, and writes ${PROPOSAL_DIR}/${PROPOSAL_FILENAME} beside the ISA.
It never edits the ISA. Ratify rows by setting "ratified": true, then run apply, which
refuses without --proposal because a migration needs a ratification record.`;

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(USAGE); return 0; }
  if (cmd === "triage") {
    if (!has("--estate", argv)) { console.error("triage requires --estate"); return 1; }
    try {
      const { triage } = await import("./IscTierTriage.ts");
      const report = await triage({ offline: has("--offline", argv), out: flag("--out", argv) });
      console.log(JSON.stringify({ isas: report.isas.length, totals: report.totals, worklist: report.worklist.length, engineRows: report.engineRows, out: report.out }, null, 2));
      return 0;
    } catch (e) { console.error(`triage: ${(e as Error).message}`); return 1; }
  }
  const isa = argv[1];
  if (!isa || isa.startsWith("--")) { console.error(`${cmd}: an ISA path is required\n\n${USAGE}`); return 1; }

  try {
    if (cmd === "propose") {
      const { proposal, path, kept } = await propose(isa, {
        offline: has("--offline", argv),
        cwd: flag("--cwd", argv),
        out: flag("--out", argv),
      });
      const counts = { codable: 0, readable: 0, taste: 0, manual: 0, retire: 0 } as Record<Classification, number>;
      for (const r of proposal.rows) counts[r.classification]++;
      const trivial = proposal.rows.filter((r) => r.assert?.trivial).length;
      const failing = proposal.rows.filter((r) => r.assert && r.assert.dry_run.ran && !r.assert.dry_run.satisfied).length;
      console.log(`proposal: ${path}`);
      console.log(`manual rows: ${proposal.rows.length} · codable ${counts.codable} · readable ${counts.readable} · taste ${counts.taste} · stays manual ${counts.manual} · retire ${counts.retire}`);
      const retiring = proposal.rows.filter((r) => r.classification === "retire");
      if (retiring.length) {
        console.log(`dead duplicates proposed for removal: ${retiring.length} (the criterion is already checked by a real row)`);
        for (const r of retiring) console.log(`  ${r.isc}#${r.occurrence ?? 1}: covered by ${r.covered_by!.join(", ")}`);
      }
      console.log(`classification path: ${proposal.classifier.path} (${proposal.classifier.note})`);
      console.log(`drafted asserts flagged trivial: ${trivial} · drafted asserts already failing on current state: ${failing}`);
      const withAssert = proposal.rows.filter((r) => r.assert);
      const bySource: Record<string, number> = {};
      for (const r of withAssert) bySource[r.assert!.source ?? "unknown"] = (bySource[r.assert!.source ?? "unknown"] ?? 0) + 1;
      const briefed = proposal.rows.filter((r) => r.brief);
      console.log(`discriminating asserts: ${withAssert.length}` + (withAssert.length ? ` (${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""));
      console.log(`refused as not a verifier, with a Sol brief: ${briefed.length}`);
      for (const r of briefed) console.log(`  ${r.isc}#${r.occurrence ?? 1}: ${r.reason.split(" — stays manual: ").pop()}`);
      const mut = { sensitive: 0, insensitive: 0, unverified: 0 };
      for (const r of proposal.rows) if (r.mutation) mut[r.mutation.verdict]++;
      const withProducer = proposal.rows.filter((r) => r.producer);
      const resolvedProducers = withProducer.filter((r) => r.producer!.resolved).length;
      const demoted = proposal.rows.filter((r) => /codable (?:claim|criterion) not confirmed by the noul/.test(r.reason)).length;
      console.log(`codable choices demoted to readable by the shell-settles noul: ${demoted}`);
      console.log(`boundary producers: ${resolvedProducers} resolved · ${withProducer.length - resolvedProducers} unresolved`);
      for (const r of withProducer.filter((x) => !x.producer!.resolved)) console.log(`  ${r.isc}#${r.occurrence ?? 1}: unresolved — ${r.producer!.reason}`);
      for (const r of withProducer.filter((x) => x.producer!.resolved)) console.log(`  ${r.isc}#${r.occurrence ?? 1}: ${r.producer!.command} (${r.producer!.bytes} bytes, exit ${r.producer!.exit})`);
      console.log(`mutation sensitivity: ${mut.sensitive} sensitive · ${mut.insensitive} rejected as insensitive · ${mut.unverified} unverified`);
      for (const r of proposal.rows.filter((x) => x.mutation && x.mutation.verdict !== "sensitive")) {
        console.log(`  ${r.isc}#${r.occurrence ?? 1}: ${r.mutation!.verdict} — ${r.mutation!.note}`);
      }
      if (kept.kept > 0 || kept.dropped.length > 0) {
        console.log(`ratifications carried from the previous proposal: ${kept.kept} kept · ${kept.dropped.length} dropped`);
        for (const line of kept.dropped) console.log(`  ${line}`);
      }
      console.log(`the ISA was not modified. Ratify rows in the proposal, then: bun LIFEOS/TOOLS/IscTier.ts apply ${isa} --proposal ${path}`);
      return 0;
    }

    if (cmd === "backfill") {
      const result = backfill(isa, { all: has("--all", argv), seeds: flag("--seeds", argv) });
      if (has("--json", argv)) { console.log(JSON.stringify(result, null, 2)); return 0; }
      console.log(`backfill: ${result.isa}`);
      console.log(`labels added ${result.added} · refreshed ${result.refreshed} · skipped ${result.skipped} · stale ${result.stale} · unbound criterion hash ${result.unbound}`);
      for (const r of result.rows) {
        const bits = [r.action, r.stale === true ? "stale" : r.stale === false ? "fresh" : "staleness unknown", r.artifact ? `${r.artifact.kind}:${r.artifact.ref}` : "no artifact recovered"];
        if (r.claim_hash === "unbound") bits.push("criterion hash unbound — the seed will read stale until the Test Strategy header parses");
        console.log(`  ${r.claim}: ${bits.join(" · ")}${r.reason ? ` — ${r.reason}` : ""}`);
      }
      console.log(`stale labels are provisional evidence only; they never make a judge earned.`);
      return 0;
    }

    if (cmd === "shadow") {
      const r = await shadow(isa, { proposal: flag("--proposal", argv) });
      console.log(`shadow caller: ${SHADOW_CALLER}`);
      console.log(`questions ${r.questions} · calls ${r.calls} · answered ${r.answered} · failed ${r.failed}`);
      console.log(`ledger rows written: ${r.ledgerRows}`);
      for (const p of r.producerErrors) console.log(`  producer ${p.id}: ${p.error}`);
      for (const e of r.errors) console.log(`  call ${e.key}: ${e.error}`);
      return 0;
    }

    if (cmd === "apply") {
      const r = apply(isa, { proposal: flag("--proposal", argv), dryRun: has("--dry-run", argv) });
      console.log(`${has("--dry-run", argv) ? "would apply" : "applied"}: ${r.changes.length} row(s), ${r.changedLines} ISA line(s) changed`);
      for (const c of r.changes) console.log(`  ${c.isc}: manual → ${c.to}${c.wrote ? ` (${c.wrote})` : ""} at line ${c.line}`);
      const gone = r.changes.filter((c) => c.to === "removed").length;
      if (gone) console.log(`rows removed as dead duplicates (ISC-35): ${gone}`);
      for (const s of r.skipped) console.log(`  skipped ${s.isc}: ${s.reason}`);
      console.log(r.diffStat);
      return 0;
    }

    console.error(`unknown command "${cmd}"\n\n${USAGE}`);
    return 1;
  } catch (e) {
    console.error(`${cmd}: ${(e as Error)?.message ?? e}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
