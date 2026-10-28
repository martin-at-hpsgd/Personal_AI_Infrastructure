/**
 * RenderProvenance — which LifeOS pipeline made a video's bytes, read from the STATVS `render` stream, never guessed
 * from a path or a container. Every producer writes one render row for its final file's sha256 at the moment it writes
 * it (VideoEssay Run's build stage, the HyperFrames seam, StoryFilm Build, the video pipeline skill's compositor); VideoEval and the
 * release gates (VideoRecheck) admit an intent only for bytes whose newest render row names that intent's pipeline.
 * Bytes with no row (a remux, a crop, a covered badge, a copy someone re-encoded) are refused under every intent, with
 * the producing tool to re-run.
 *
 * Also here, because the producers and the gates must agree on them byte for byte:
 *   - compositionFiles / compositionDigest: the files of a HyperFrames project and their one digest (VideoEval's
 *     composition input hash is the same value, so its memo keys did not move);
 *   - gateEnvProblem: outside tests the gates refuse to run with a store override set (receipts, memo, record).
 *
 * The STATVS writer (LIFEOS/STATVS/lib/quality.ts) is loaded on first use with a synchronous require, so importing this
 * file costs no record-engine load. Nothing here throws for a missing or broken record: a write failure is logged and
 * returned, and a read failure reads as "no render known", which refuses.
 *
 * Doc: LIFEOS/DOCUMENTATION/Assay/Records.md. The render provenance criteria live in the Assay ISA (maintainer-side; not in the public release).
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { getClaudeDir } from "../Paths.ts";
import { isAbsolute, join, relative, resolve } from "node:path";

// release-allow: private-skill-names (_VIDEO is the camera-footage pipeline value in STATVS render rows and its producer command; an install without the video pipeline skill never writes or reads such a row)
export const PIPELINES = ["VideoEssay", "HyperFrames", "StoryFilm", "_VIDEO"] as const;
export type Pipeline = (typeof PIPELINES)[number];
export interface RenderHit { pipeline: Pipeline; intent?: string; artifact: string; composition?: string; composition_digest?: string; ts: string }
export type RenderLookup = (sha256: string) => RenderHit | null;

/** The install root (…/.claude) this file lives in. */
const CODE_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SHA256 = /^[0-9a-f]{64}$/;

/** The camera-footage compositor, relative to the install root. Optional: it ships only with the video pipeline skill. */
const CAMERA_COMPOSE = "skills/_VIDEO/Tools/Compose.ts";

/** The command that makes a render of each pipeline (and writes its render row). Named in every refusal. */
export const PRODUCER: Readonly<Record<Pipeline, string>> = Object.freeze({
  VideoEssay: "bun ~/.claude/skills/VideoEssay/Tools/Run.ts --run <slug> --from build",
  HyperFrames: "bun ~/.claude/LIFEOS/TOOLS/HyperFrames/HyperFrames.ts render --project <dir> --out <file.mp4> --eval <intent.md>",
  StoryFilm: "bun ~/.claude/skills/StoryFilm/Tools/Run.ts --run <slug> --from build",
  _VIDEO: existsSync(join(CODE_ROOT, CAMERA_COMPOSE))
    ? `bun ${CAMERA_COMPOSE} stack|row|overlay|concat … --out <file.mp4>`
    : "the video pipeline skill's compositor (not installed here)",
});

type Quality = typeof import("../../STATVS/lib/quality.ts");
let Q: Quality | null = null;
/** The STATVS quality writers, loaded on first use (a sync require: the producers and gates stay synchronous where they are). */
function quality(): Quality {
  return (Q ??= createRequire(import.meta.url)("../../STATVS/lib/quality.ts") as Quality);
}

function realOrResolved(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** An intent path (absolute, under a `~/.claude/` prefix, or relative to ~/.claude) as a path relative to ~/.claude, or null outside it. */
export function intentRel(intent: string): string | null {
  let s = intent.trim();
  if (s.startsWith("~/.claude/")) return s.slice("~/.claude/".length);
  if (!isAbsolute(s)) s = join(CODE_ROOT, s.replace(/^\.\//, ""));
  const real = realOrResolved(s);
  for (const root of [realOrResolved(CODE_ROOT), realOrResolved(getClaudeDir())]) {
    const rel = relative(root, real);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return null;
}

/** The pipeline an intent belongs to: skills/<Pipeline>/Intents/<Name>.md, symlinks resolved. Null for any other file. */
export function intentPipeline(intent: string | null | undefined): Pipeline | null {
  if (!intent) return null;
  const rel = intentRel(intent);
  if (!rel) return null;
  const [top, skill, dir, file, ...more] = rel.split("/");
  if (top !== "skills" || dir !== "Intents" || !file?.endsWith(".md") || more.length) return null;
  return (PIPELINES as readonly string[]).includes(skill!) ? (skill as Pipeline) : null;
}

/** sha256 of a file's bytes, read in 4 MiB chunks so a long film never sits in memory. */
export function fileSha256(path: string): string {
  const h = createHash("sha256"), buf = Buffer.allocUnsafe(4 << 20), fd = openSync(path, "r");
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest("hex");
}

/**
 * The files of a HyperFrames project that make up its composition, sorted: everything under the dir but dependencies,
 * dot entries, render outputs (Out/, out/, renders/, <video>.eval/, and mp4/mov/webm/gif/log files). Capped at 5,000.
 */
export function compositionFiles(dir: string): string[] {
  const out: string[] = [];
  const skipDir = (n: string) => n.startsWith(".") || n === "node_modules" || n === "Out" || n === "out" || n === "renders" || n.endsWith(".eval");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 5000) return;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) walk(p); continue; }
      if (e.isFile() && !e.name.startsWith(".") && !/\.(mp4|mov|webm|gif|log)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** One digest over a composition: every file's path relative to the project and its sha256 (VideoEval's composition input hash). */
export function compositionDigest(dir: string): string {
  const fileSha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  return createHash("sha256").update(JSON.stringify(compositionFiles(dir).map((f) => [relative(dir, f), fileSha(f)]))).digest("hex");
}

export type RecordRenderResult = { ok: true; sha256: string } | { ok: false; why: string };

/**
 * Write the render row for `file`: its sha256, the pipeline that made it, the intent it was made for (stored relative to
 * ~/.claude), and for a HyperFrames-built film the composition dir and its digest. Called by a producer right after it
 * wrote its final file. Never throws: any failure (unreadable file, refused or spooled row) is logged and returned, and
 * the producer carries on; the gates then refuse the bytes, naming the tool to re-run.
 */
export function recordRenderOf(file: string, o: { pipeline: Pipeline; intent?: string | null; composition?: string | null }): RecordRenderResult {
  const fail = (why: string): RecordRenderResult => {
    try { process.stderr.write(`render provenance: no render row for ${file}: ${why}\n`); } catch { /* stderr closed */ }
    return { ok: false, why };
  };
  try {
    const artifact = realOrResolved(file);
    if (!existsSync(artifact) || !statSync(artifact).isFile()) return fail("the file is not there");
    const sha256 = fileSha256(artifact);
    const intent = o.intent ? intentRel(o.intent) ?? undefined : undefined;
    const composition = o.composition ? realOrResolved(o.composition) : undefined;
    const composition_digest = composition && existsSync(join(composition, "index.html")) ? compositionDigest(composition) : undefined;
    const r = quality().recordRender({ sha256, pipeline: o.pipeline, artifact, ...(intent ? { intent } : {}), ...(composition ? { composition } : {}), ...(composition_digest ? { composition_digest } : {}) });
    if (r.ok) return { ok: true, sha256 };
    return fail("refused" in r ? r.refused : `spooled: ${r.reason}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** The newest render row for these bytes, or null. Never throws. */
export function renderOf(sha256: string): RenderHit | null {
  try { return SHA256.test(sha256) ? (quality().renderFor(sha256) as RenderHit | null) : null; } catch { return null; }
}

const intentLabel = (intent: string) => intentRel(intent) ?? intent;

/**
 * Why `intent` may not be evaluated or admitted on bytes with this sha256, or null; and the render row it read. No row:
 * refused under every intent. A row from another pipeline: refused. An intent that is no video pipeline's: refused.
 * With no intent, a row of any pipeline admits (the gates still re-measure the bytes).
 */
export function provenanceProblem(sha256: string, intent: string | null, o: { lookup?: RenderLookup } = {}): { hit: RenderHit | null; problem: string | null } {
  const hit = (o.lookup ?? renderOf)(sha256);
  const want = intent ? intentPipeline(intent) : null;
  if (!hit) {
    const tool = want ? `the ${want} pipeline: ${PRODUCER[want]}` : `the pipeline that made it: ${PIPELINES.map((p) => `${p}: ${PRODUCER[p]}`).join("; ")}`;
    return { hit, problem: `no LifeOS pipeline recorded rendering these bytes (sha256 ${sha256.slice(0, 12)}…): the STATVS render stream has no row for them, so they are a remux, crop, cover-up or re-encode of a render, or were never rendered here; nothing is evaluated or admitted under any intent without one. Re-render with ${tool}` };
  }
  if (intent && !want) return { hit, problem: `${intentLabel(intent)} is not a video pipeline's intent (skills/<${PIPELINES.join("|")}>/Intents/*.md), so no render is evaluated or admitted under it` };
  if (want && hit.pipeline !== want) return { hit, problem: `these bytes were rendered by the ${hit.pipeline} pipeline (${hit.ts}${hit.intent ? `, for ${hit.intent}` : ""}), so they are evaluated and admitted only under skills/${hit.pipeline}/Intents/*, never ${intentLabel(intent!)}; a ${want} video comes from ${PRODUCER[want]}` };
  return { hit, problem: null };
}

/**
 * Why `composition` may not be read as the composition these bytes were rendered from, or null: the newest render row
 * for the bytes must name that project dir, and the dir must still hash to the digest the row recorded.
 */
export function compositionProblem(sha256: string, composition: string, o: { lookup?: RenderLookup; hit?: RenderHit | null } = {}): string | null {
  const hit = o.hit !== undefined ? o.hit : (o.lookup ?? renderOf)(sha256);
  const dir = realOrResolved(composition);
  if (!hit?.composition) return `--composition ${dir} is refused: no render row for these bytes names a composition (only the HyperFrames seam records the project it rendered), so the project cannot be tied to them`;
  if (realOrResolved(hit.composition) !== dir) return `--composition ${dir} is refused: these bytes were rendered from ${hit.composition}, not this project`;
  if (!existsSync(join(dir, "index.html"))) return `--composition ${dir} is refused: the project these bytes were rendered from has no index.html any more`;
  const now = compositionDigest(dir);
  if (!hit.composition_digest || hit.composition_digest !== now) return `--composition ${dir} is refused: the project changed since these bytes were rendered from it (digest ${(hit.composition_digest ?? "none").slice(0, 12)}… then, ${now.slice(0, 12)}… now)`;
  return null;
}

/** The env vars that redirect a store a release gate reads: the receipt store, the eval memo, the STATVS record. */
export const GATE_ENV_OVERRIDES = ["LIFEOS_PROOF_RECEIPTS", "LIFEOS_VIDEO_EVAL_MEMO", "STATVS_DIR"] as const;

/** Outside tests (NODE_ENV=test), why a release gate refuses to run in this environment, or null. */
export function gateEnvProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === "test") return null;
  const set = GATE_ENV_OVERRIDES.filter((k) => env[k]);
  if (!set.length) return null;
  return `the release gates do not run with ${set.join(", ")} set outside tests: ${set.length > 1 ? "they redirect" : "it redirects"} a store the gate reads, so a planted receipt, memo or render row could admit bytes; unset ${set.length > 1 ? "them" : "it"} and run again`;
}

/** How a compositor input enters the output: as the picture itself (primary), or laid over it (asset). */
export type InputRole = "primary" | "asset";

/**
 * Why a camera-footage compositor output may not carry a camera-footage render row, or null. An output inherits its
 * inputs: a primary input (overlay base, stack/row slot, concat part) rendered by another pipeline, or any input carrying
 * a VideoEssay or StoryFilm render, makes the output that pipeline's derivative, so no camera-footage row is written and
 * the gates refuse it under camera-footage intents. A HyperFrames-rendered overlay asset (an Enhance card) is allowed.
 */
export function videoInheritanceProblem(inputs: { file: string; role: InputRole }[], o: { lookup?: RenderLookup } = {}): string | null {
  for (const i of inputs) {
    let sha: string;
    try { sha = fileSha256(i.file); } catch { continue; }
    const hit = (o.lookup ?? renderOf)(sha);
    if (!hit || hit.pipeline === "_VIDEO") continue;
    if (i.role === "primary" || hit.pipeline === "VideoEssay" || hit.pipeline === "StoryFilm") return `${i.file} is a ${hit.pipeline} render, so this output is its derivative and is not recorded as camera footage`;
  }
  return null;
}
