/**
 * Lib.ts — shared types and helpers for the video-essay pipeline.
 *
 * A run is a directory (outside every git repo) holding:
 *   run.json        { slug, title, source, createdAt }
 *   Source/         transcript.txt, source.json, notes.md
 *   Essay.md        the argument (frontmatter + sections)
 *   Script.json     ordered beats, each with narration + a typed visual
 *   Narration/      per-beat audio chunks + alignment, narration.wav, timeline.json
 *   Assets/         captures (png) + regions (json)
 *   Out/            essay.mp4, thumbnail.png, description.md, verify.json, frames/
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { lifeosUserDir } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { FACE_IDS, FACES, isFaceId, resolveBadgeCopy, resolvePalette, TYPE, type BadgeCopy, type FaceId, type Palette } from "./Theme.ts";

export const FPS = 30;
/**
 * The encode, for text: typography must read perfectly clear. x264 at CRF 10 on the seam's slow preset: on a still
 * page of dark text on flat paper a low QP keeps letter edges (the preset's deblock=1,1 has little left to smooth),
 * and CRF, never a bitrate, so a busy stretch gets the bits it needs. A looser CRF (or an average-bitrate encode) softens
 * small type. Verify fails any render whose recorded rate control is not CRF at or below ENCODE_CRF_MAX.
 */
export const ENCODE_CRF = 10;
export const ENCODE_CRF_MAX = 12;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/**
 * Output pixels per composition pixel. The 1920x1080 composition renders at 4K (3840x2160): text and captures keep full
 * detail, and YouTube serves its high-bitrate 4K encodes to every viewer (principal directive, 2026-10-24: the 1080p upload was
 * "massively blurry"). Verify reads frames back at 1920 wide, so its geometry stays in composition pixels.
 */
export const OUTPUT_SCALE = 2;
export const BEAT_GAP_SECONDS = 0.35;
export const TARGET_LUFS = -16;
/** Voice-mode delivery, the YouTube delivery standard the video skill exports to: −14 LUFS integrated, −1 dBTP. */
export const VOICE_TARGET_LUFS = -14;
export const VOICE_TRUE_PEAK = -1;

export type MotionVisual =
  | { type: "title"; title: string; subtitle?: string }
  | { type: "points"; heading?: string; points: string[] }
  | { type: "compare"; left: { label: string; text: string }; right: { label: string; text: string } }
  | { type: "stat"; value: string; label: string }
  | { type: "quote"; text: string; attribution: string }
  | { type: "diagram"; nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] }
  | RaceVisual;

/**
 * Two or more lanes crossing the same span, from `from` to `to`. A lane with no gates sweeps straight across; a lane
 * with gates stops at each, waits longer every time, and parks short of the finish when the beat ends. `result` is
 * that lane's outcome, one string or pieces revealed at `resultAt` (beat-local seconds, cue them to the spoken words);
 * the last piece of a multi-piece result lands as a stamp.
 */
export type RaceVisual = { type: "race"; from: string; to: string; lanes: RaceLane[] };
export type RaceLane = { label: string; result: string | string[]; gates?: number; resultAt?: number | number[] };

export type CaptureVisual =
  | { type: "screenshot"; url: string; selector?: string; caption?: string }
  | { type: "scroll"; url: string; start?: number; travel?: number; caption?: string }
  | { type: "zoom"; url: string; selector: string; caption?: string };

export type CodeVisual = { type: "code"; code: string; lang: string; highlight?: number[]; title?: string; caption?: string };

export type ReadVisual = { type: "read"; paragraphs: string[]; caption?: string };
export type Visual = MotionVisual | CaptureVisual | CodeVisual | ReadVisual;

export type VisualClass = "motion" | "screenshot" | "scroll" | "zoom" | "code" | "read";

export const MOTION_TYPES = new Set(["title", "points", "compare", "stat", "quote", "diagram", "race"]);
export const VISUAL_TYPES = new Set([...MOTION_TYPES, "screenshot", "scroll", "zoom", "code", "read"]);

export function visualClass(v: Visual): VisualClass {
  if (MOTION_TYPES.has(v.type)) return "motion";
  return v.type as VisualClass;
}

export interface Beat {
  id: string;
  /** When set, this beat opens a chapter with this title (a chapter card precedes the visual). */
  chapter?: string;
  narration: string;
  /** Optional TTS override (what is spoken); narration stays the display text. */
  tts?: string;
  visual: Visual;
}

export interface Script {
  title: string;
  slug: string;
  targetMinutes: number;
  source: { url: string; title: string; author: string };
  links?: { label: string; url: string }[];
  beats: Beat[];
}

export interface Word { w: string; s: number; e: number; p?: string; i?: number }

/** One post paragraph's spoken span in a narration file, seconds from its start. */
export interface ParagraphSpan { p: string; s: number; e: number }
/** Narration/paragraph-spans.json: a clone take's paragraph spans, bound to the source.wav they were measured on. */
export const PARAGRAPH_SPANS_FILE = "paragraph-spans.json";
export interface ParagraphSpansRecord { sha256: string; spans: ParagraphSpan[] }

/** Each paragraph's span from its first word's start to its last word's end, in time order; words with no paragraph are skipped. */
export function spansFromWords(words: Word[]): ParagraphSpan[] {
  const spans = new Map<string, ParagraphSpan>();
  for (const w of words) {
    if (!w.p) continue;
    invariant(Number.isFinite(w.s) && Number.isFinite(w.e) && w.e >= w.s, `word "${w.w}" has an invalid span`);
    const span = spans.get(w.p);
    if (!span) spans.set(w.p, { p: w.p, s: w.s, e: w.e });
    else { span.s = Math.min(span.s, w.s); span.e = Math.max(span.e, w.e); }
  }
  return [...spans.values()].sort((a, b) => a.s - b.s);
}
export interface TimelineBeat { id: string; start: number; end: number; words: Word[]; chunk: string }
export interface Timeline {
  fps: number;
  gap: number;
  total: number;
  narration: string;
  beats: TimelineBeat[];
}

/**
 * Who voiced a voice run (run.json narrator): "recorded" is the author's own recording; "clone" is the author's synthesized
 * voice clone reading the post; "da" is the DA reading the post in its own presenter voice. Both synthesized narrators
 * come from one take of the post's exact words (Ingest), so everything downstream treats them alike.
 */
export const NARRATORS = ["recorded", "clone", "da"] as const;
export type Narrator = (typeof NARRATORS)[number];
export type SynthesizedNarrator = Exclude<Narrator, "recorded">;
export const isNarrator = (v: unknown): v is Narrator => typeof v === "string" && (NARRATORS as readonly string[]).includes(v);
/** A synthesized narration: one take of the post's words, no TightCut, paragraph spans from the TTS alignment. */
export const isSynthesizedNarrator = (v: unknown): v is SynthesizedNarrator => v === "clone" || v === "da";

/**
 * run.json. Voice runs may carry two per-run overrides, both written by Ingest flags: `label` names the author on
 * the corner badge for this run only (it wins over Config.json presenter.label / narrators.da.label, which stay the
 * default for every other run), and `captureUrl` is where Capture loads the post page when the post is not live yet
 * (a local draft server); the post's own URL stays what the video shows and the description links.
 */
export interface RunMeta { slug: string; title: string; mode?: "essay" | "voice"; narrator?: Narrator; source?: { url: string; title?: string; author?: string }; label?: string; captureUrl?: string; createdAt: string }

/** A per-run badge label: one to three words of letters, digits, spaces, dots, apostrophes or hyphens, upper-cased. */
export function normalizeLabel(label: string): string {
  const v = label.trim().replace(/\s+/g, " ").toUpperCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,23}$/u.test(v) || v.split(" ").length > 3) throw new Error(`label must be a short name (1-3 words, at most 24 characters), got ${JSON.stringify(label)}`);
  return v;
}

/** A capture URL: https anywhere, or http only on this machine's loopback (a local draft server). */
export function validCaptureUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`capture URL is not a URL: ${JSON.stringify(url)}`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.href;
  throw new Error(`capture URL must be https, or http on localhost, got ${url}`);
}

export { isSelfRead } from "./Theme.ts";
export interface Post { title: string; url: string; slug: string; links: { label: string; url: string; p: string }[]; paragraphs: { id: string; text: string; heading?: string; kind?: "blockquote" }[] }

/** Inclusive whitespace word indices, shared by capture and composition. */
export function sentencesOf(text: string): { i0: number; i1: number; text: string }[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const result: { i0: number; i1: number; text: string }[] = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    const token = words[i].replace(/["'”’\)\]]+$/, "");
    const abbreviation = /^(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e)\.$/i.test(token) || /^(?:[a-z]\.)+$/i.test(token);
    const ellipsis = /(?:\.{3}|…)$/.test(token);
    const terminal = /[.!?…]$/.test(token) && !abbreviation && (!ellipsis || /^["“']?[A-Z]/.test(words[i + 1] ?? ""));
    if (terminal || i === words.length - 1) {
      result.push({ i0, i1: i, text: words.slice(i0, i + 1).join(" ") });
      i0 = i + 1;
    }
  }
  return result;
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  invariant(path.length > 0 && value !== undefined, "JSON write requires a path and value");
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function ensureDir(path: string): string {
  invariant(path.length > 0, "directory path is empty");
  mkdirSync(path, { recursive: true });
  return path;
}

export interface SkillConfig {
  fonts?: Partial<Record<FaceId, string>>;
  /** Optional: the family name each face's file must report (a prefix, case-insensitive), checked by DesignAudit --check config. */
  fontFamilies?: Partial<Record<FaceId, string | string[]>>;
  avatar?: string;
  /** Optional: a channel mark (PNG) drawn bottom-left on every video, opposite the badge; unset draws none. */
  cornerLogo?: string;
  runsRoot?: string;
  blogBaseUrl?: string;
  /** The author's possessive for the badge's read-by line ("his", "her", "their"); unset means "their". */
  possessive?: string;
  /** Colour overrides (Theme resolvePalette); unset keys take Theme DEFAULT_PALETTE. */
  colors?: unknown;
  /** Voice-badge copy overrides (Theme resolveBadgeCopy); unset keys take Theme DEFAULT_BADGE_COPY. */
  badge?: unknown;
  /** Regular expressions (strings) for post paragraphs that are page metadata and never read aloud. */
  skipParagraphs?: string[];
  /** Per site (hostname, its subdomains included): localStorage values every capture of that site is taken under, so a site's look (a theme the author publishes in) never depends on what the test profile last saved. */
  capturePresets?: Record<string, { localStorage?: Record<string, string> }>;
}

/** The localStorage values a capture of `url` is taken under: every Config.json capturePresets entry whose host is the url's host or a parent of it. */
export function capturePresetFor(url: string, cfg: SkillConfig = loadSkillConfig()): Record<string, string> {
  const host = new URL(url).hostname.toLowerCase();
  const out: Record<string, string> = {};
  for (const [site, p] of Object.entries(cfg.capturePresets ?? {})) {
    const s = site.toLowerCase();
    if (host === s || host.endsWith(`.${s}`)) Object.assign(out, p.localStorage ?? {});
  }
  return out;
}

/** The render palette: Config.json `colors` over the neutral defaults. Throws on a malformed colour. */
export function loadPalette(cfg: SkillConfig = loadSkillConfig()): Palette {
  return resolvePalette(cfg.colors);
}

/** The voice badge's words: Config.json `badge` over the neutral defaults. Throws on a malformed line. */
export function loadBadgeCopy(cfg: SkillConfig = loadSkillConfig()): BadgeCopy {
  return resolveBadgeCopy(cfg.badge);
}

/** Config.json `skipParagraphs` compiled as JavaScript regular expressions (case-sensitive), each tested against a paragraph's visible text. Throws naming an entry that is not a valid expression. */
export function skipParagraphPatterns(cfg: SkillConfig = loadSkillConfig()): RegExp[] {
  const raw = cfg.skipParagraphs ?? [];
  if (!Array.isArray(raw)) throw new Error(`Config.json skipParagraphs must be a list of regular expressions, got ${JSON.stringify(raw)}`);
  return raw.map((p, i) => {
    if (typeof p !== "string" || !p.trim()) throw new Error(`Config.json skipParagraphs[${i}] must be a non-empty string`);
    try { return new RegExp(p); } catch (e) { throw new Error(`Config.json skipParagraphs[${i}] is not a valid regular expression: ${(e as Error).message}`); }
  });
}

/**
 * A path written in Config.json: "~/" expands, an absolute path stands, and a relative path resolves against the
 * config's own directory (Setup.md § Fill in), never the working directory. Every reader of a config path uses this.
 */
export function resolveConfigPath(raw: string, baseDir: string = dirname(skillConfigPath())): string {
  const expanded = raw.replace(/^~(?=\/)/, homedir());
  return isAbsolute(expanded) ? expanded : join(baseDir, expanded);
}

/** A configured face: its Theme FACES entry plus the licensed file it embeds from. */
export interface ConfiguredFace { id: FaceId; family: string; weight: number; style: "normal" | "italic"; path: string }

/**
 * Config.json `fonts`, validated: every face Theme FACES names, each mapped to a font file that exists ("~/" expands;
 * a relative path resolves against the config's own directory, like `presenter.avatar`, never the working directory).
 * Throws naming every missing face, unknown key, or missing file: the composition embeds its faces and never falls
 * back to a system face, so a partial map is refused before anything renders.
 */
export function configuredFaces(cfg: SkillConfig = loadSkillConfig(), baseDir: string = dirname(skillConfigPath())): ConfiguredFace[] {
  const fonts = (cfg.fonts ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(fonts)) if (!isFaceId(key)) problems.push(`fonts.${key} is not a face the composition sets (faces: ${FACE_IDS.join(", ")})`);
  const faces: ConfiguredFace[] = [];
  for (const id of FACE_IDS) {
    const raw = fonts[id];
    if (typeof raw !== "string" || !raw.trim()) { problems.push(`fonts.${id} is missing (${FACES[id].role})`); continue; }
    const path = resolveConfigPath(raw, baseDir);
    if (!existsSync(path)) { problems.push(`fonts.${id}: file not found: ${path}`); continue; }
    faces.push({ id, family: FACES[id].family, weight: FACES[id].weight, style: FACES[id].style, path });
  }
  if (problems.length) throw new Error(`Config.json fonts:\n- ${problems.join("\n- ")}`);
  return faces;
}

/** The house type system every video shares (HyperFrames TypeRoles.json in the USER zone); absent on an install that has none. */
export function houseTypeRolesPath(): string {
  return join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "HyperFrames", "TypeRoles.json");
}

type HouseRoles = Record<string, { case?: string; faces?: { file?: string }[] }>;
const HOUSE_CASE: Record<string, string | undefined> = { title: "title", upper: "uppercase", sentence: undefined };

/**
 * Every way the composition's type roles leave the house type system: a role whose face file is not one of its house
 * role's files, or whose case differs from the house role's case. Code keeps its literal case, so only its face is held.
 * Empty means the video is set in the same faces and case as every other video.
 */
export function houseTypeProblems(faces: ConfiguredFace[], house: HouseRoles): string[] {
  const file = new Map(faces.map((f) => [f.id, f.path.split("/").pop() ?? ""]));
  const out: string[] = [];
  for (const [name, role] of Object.entries(TYPE) as [string, (typeof TYPE)[keyof typeof TYPE]][]) {
    const h = house[role.house];
    if (!h) { out.push(`${name}: house role "${role.house}" is not in TypeRoles.json`); continue; }
    const allowed = (h.faces ?? []).map((f) => f.file).filter((f): f is string => !!f);
    const got = file.get(role.face) ?? "(no file)";
    if (!allowed.includes(got)) out.push(`${name}: face ${role.face} is ${got}, the house ${role.house} faces are ${allowed.join(", ")}`);
    const want = HOUSE_CASE[h.case ?? "sentence"];
    const has = (role as { transform?: string }).transform;
    if (name !== "code" && want !== has) out.push(`${name}: case is ${has ?? "as written"}, the house ${role.house} case is ${h.case}`);
  }
  return out;
}

/** Where the user-zone config lives: CUSTOMIZATIONS/SKILLS/VideoEssay/Config.json under the LifeOS USER dir. */
export function skillConfigPath(): string {
  return join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "VideoEssay", "Config.json");
}

/**
 * User-zone config (fonts, avatar, runsRoot, presenter, narrators). A missing file is a setup error, never an empty
 * config: every face, portrait and label comes from it, so the run stops here and names the guide.
 */
export function loadSkillConfig(path: string = skillConfigPath()): SkillConfig {
  if (!existsSync(path)) {
    throw new Error(`video essay config not found: ${path}\nCreate it as described in skills/VideoEssay/Setup.md (section "Fill in"), then run: bun skills/VideoEssay/Tools/Setup.ts --check`);
  }
  return readJson<SkillConfig>(path);
}

/** Home for runs: outside both git repos. LIFEOS_VIDEOESSAY_DIR, then Config.json runsRoot, then ~/VideoEssays. */
export function runsRoot(): string {
  const configured = process.env.LIFEOS_VIDEOESSAY_DIR ?? loadSkillConfig().runsRoot;
  return configured ? configured.replace(/^~(?=\/)/, homedir()) : join(homedir(), "VideoEssays");
}

/** Directories a run may never live under (git repos carrying system or user data). */
export function forbiddenRunRoots(): string[] {
  const home = homedir();
  const claude = getClaudeDir();
  const userData = join(home, ".config", "LIFEOS", "USER");
  return [claude, userData].map((p) => (existsSync(p) ? realpathSync(p) : resolve(p)));
}

export function assertRunDirAllowed(dir: string, roots: string[] = forbiddenRunRoots()): void {
  const real = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  for (const root of roots) {
    invariant(!(real === root || real.startsWith(root + "/")), `run dir ${dir} is inside a git repo (${root}); runs live outside every repo`);
  }
}

/** Resolve `--run <slug|path>` to an absolute run directory (existing or to be created). */
export function resolveRunDir(arg: string): string {
  const dir = arg.includes("/") ? resolve(arg.replace(/^~(?=\/)/, homedir())) : join(runsRoot(), arg);
  assertRunDirAllowed(dir);
  return dir;
}

export function runPaths(dir: string) {
  return {
    dir,
    meta: join(dir, "run.json"),
    source: join(dir, "Source"),
    transcript: join(dir, "Source", "transcript.txt"),
    essay: join(dir, "Essay.md"),
    script: join(dir, "Script.json"),
    narration: join(dir, "Narration"),
    timeline: join(dir, "Narration", "timeline.json"),
    narrationWav: join(dir, "Narration", "narration.wav"),
    bedWav: join(dir, "Narration", "bed.wav"),
    assets: join(dir, "Assets"),
    out: join(dir, "Out"),
    video: join(dir, "Out", "essay.mp4"),
    thumbnail: join(dir, "Out", "thumbnail.png"),
    description: join(dir, "Out", "description.md"),
    verify: join(dir, "Out", "verify.json"),
    frames: join(dir, "Out", "frames"),
    pronunciations: join(dir, "pronunciations.json"),
  };
}

export function loadScript(dir: string): Script {
  return readJson<Script>(runPaths(dir).script);
}

export function loadTimeline(dir: string): Timeline {
  return readJson<Timeline>(runPaths(dir).timeline);
}

/** Text normalization used for quote matching and transcript comparison. */
export function normalizeText(s: string): string {
  return s
    .replace(/&gt;&gt;|>>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    // Quotes may drop spoken fillers; strip them on both sides so a cleaned quote still matches.
    .replace(/\b(uh|um|er|mm|hmm|ah)\b/g, " ")
    .replace(/\s+/g, " ")
    // Stutters ("a a sort", "like like optimizing") may be cleaned in a quote; collapse immediate repeats on both sides.
    .replace(/\b(\w+)( \1\b)+/g, "$1")
    .trim();
}

export function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Rough speech-time estimate: about 2.7 words per second at a voice speed of 1.0 (ScriptLint divides by the voice's pace); only the script lint's runtime check uses it. */
export function estimateSeconds(text: string, wordsPerSecond = 2.72): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words / wordsPerSecond;
}

export function skillDir(): string {
  return resolve(import.meta.dir, "..");
}

export function compositionDir(): string {
  // The HyperFrames project root is Tools/ (flat-folder rule: two levels max); node_modules/ is gitignored.
  return join(skillDir(), "Tools");
}

/**
 * The composition stages its files under <project>/public, but the avatar cut, fonts and
 * staged runs are the user's data and live under LIFEOS/USER. The USER dir is
 * the store; Tools/public is a symlink to it so the composition still finds them
 * (a symlink is not a file in the skill tree — CodeDataBoundary skips it).
 */
export function publicDir(): string {
  const store = ensureDir(join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "VideoEssay", "public"));
  const link = join(compositionDir(), "public");
  // A link left dangling (its USER folder was renamed) reads as absent to existsSync but blocks symlinkSync: replace it.
  // Only a symlink is ever removed; a real directory here fails the invariant below.
  if (!existsSync(link)) {
    let dangling = false;
    try { dangling = lstatSync(link).isSymbolicLink(); } catch { /* nothing at the path */ }
    if (dangling) unlinkSync(link);
    symlinkSync(store, link);
  }
  invariant(realpathSync(link) === realpathSync(store), `Tools/public must link to ${store}`);
  return store;
}

// ---------- pitch (voice-mode take selection) ----------

/** Sample rate pitch is tracked at: speech f0 lives under 400 Hz, so 16 kHz keeps every harmonic YIN needs. */
export const PITCH_SAMPLE_RATE = 16_000;
const YIN_FRAME = 640, YIN_HOP = 160, YIN_THRESHOLD = 0.15, YIN_MIN_RMS = 0.01;
const YIN_TAU_MIN = Math.floor(PITCH_SAMPLE_RATE / 400), YIN_TAU_MAX = Math.ceil(PITCH_SAMPLE_RATE / 60);
/** A paragraph's median pitch is trusted only over at least this many seconds of span and voiced 10 ms frames. */
export const MIN_SCORED_SECONDS = 1.5;
export const MIN_VOICED_FRAMES = 20;

/** YIN f0 of one 40 ms frame of mono PCM at PITCH_SAMPLE_RATE, or undefined when the frame is quiet, unvoiced, or runs off the end. */
export function yinPitch(x: Float32Array, start: number): number | undefined {
  if (start < 0 || start + YIN_FRAME + YIN_TAU_MAX > x.length) return undefined;
  let energy = 0;
  for (let i = 0; i < YIN_FRAME; i++) energy += x[start + i] ** 2;
  if (Math.sqrt(energy / YIN_FRAME) < YIN_MIN_RMS) return undefined;
  const d = new Float64Array(YIN_TAU_MAX + 1);
  for (let tau = 1; tau <= YIN_TAU_MAX; tau++) { let sum = 0; for (let i = 0; i < YIN_FRAME - YIN_TAU_MAX; i++) { const q = x[start + i] - x[start + i + tau]; sum += q * q; } d[tau] = sum; }
  let running = 0;
  for (let tau = 1; tau <= YIN_TAU_MAX; tau++) {
    running += d[tau];
    if (tau < YIN_TAU_MIN || d[tau] * tau / (running || 1) >= YIN_THRESHOLD) continue;
    // Walk down to the local minimum of the normalized difference so the period is the dip, not its edge.
    let t = tau;
    while (t + 1 <= YIN_TAU_MAX && d[t + 1] * (t + 1) / (running + d[t + 1]) < d[t] * t / running) { running += d[t + 1]; t++; }
    return PITCH_SAMPLE_RATE / t;
  }
  return undefined;
}

export function median(a: number[]): number {
  invariant(a.length > 0, "median of nothing");
  const s = [...a].sort((p, q) => p - q), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Semitones above 100 Hz: a pitch difference in semitones means the same thing at any register. */
export const semitones = (hz: number): number => 12 * Math.log2(hz / 100);

/** One paragraph's pitch: the median over voiced frames and the within-paragraph spread (interquartile range, semitones). */
export interface ParagraphPitch { p: string; s: number; e: number; frames: number; f0: number | null; spreadSt: number | null }

export function paragraphPitch(x: Float32Array, spans: ParagraphSpan[]): ParagraphPitch[] {
  return spans.map(({ p, s, e }) => {
    const f0s: number[] = [];
    for (let i = Math.floor(s * PITCH_SAMPLE_RATE); i < Math.floor(e * PITCH_SAMPLE_RATE); i += YIN_HOP) { const f = yinPitch(x, i); if (f) f0s.push(f); }
    if (e - s < MIN_SCORED_SECONDS || f0s.length < MIN_VOICED_FRAMES) return { p, s, e, frames: f0s.length, f0: null, spreadSt: null };
    const st = f0s.map(semitones).sort((a, b) => a - b);
    const q = (k: number) => st[Math.round(k * (st.length - 1))];
    return { p, s, e, frames: f0s.length, f0: median(f0s), spreadSt: q(0.75) - q(0.25) };
  });
}

/**
 * How steady one take is across the post. drift: the least-squares change in paragraph median pitch from the
 * take's first word to its last (slope over position in the take, 0 to 1). range: highest minus lowest paragraph
 * median. within: the median within-paragraph spread, which the monotone guard reads. score = |driftSt| + rangeSt,
 * both in semitones; the lowest score is the steadiest take.
 */
export interface TakeScore { measured: number; driftSt: number; rangeSt: number; driftHz: number; rangeHz: number; withinSt: number; score: number }
export const TAKE_SCORE_RULE = "score = |drift| + range in semitones over paragraphs with at least 1.5 s and 20 voiced frames; drift = least-squares change in paragraph median pitch from the take's first word to its last; lowest score wins, ties to the earlier seed; rejected first: a take whose alignment misses the words sent, or whose median within-paragraph pitch spread (IQR) is under the monotone floor";

/** Least-squares slope of ys over xs; xs spanning 0..1 makes it the fitted change across the whole take. */
function fitChange(xs: number[], ys: number[]): number {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return sxx > 0 ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx : 0;
}

export function scoreTake(rows: ParagraphPitch[]): TakeScore | null {
  const scored = rows.filter((r): r is ParagraphPitch & { f0: number; spreadSt: number } => r.f0 !== null && r.spreadSt !== null);
  if (!scored.length) return null;
  const start = Math.min(...rows.map((r) => r.s)), length = Math.max(...rows.map((r) => r.e)) - start;
  const at = scored.map((r) => ((r.s + r.e) / 2 - start) / length);
  const hz = scored.map((r) => r.f0), st = hz.map(semitones);
  const driftSt = fitChange(at, st), driftHz = fitChange(at, hz);
  const rangeSt = Math.max(...st) - Math.min(...st), rangeHz = Math.max(...hz) - Math.min(...hz);
  return { measured: scored.length, driftSt, rangeSt, driftHz, rangeHz, withinSt: median(scored.map((r) => r.spreadSt)), score: Math.abs(driftSt) + rangeSt };
}
