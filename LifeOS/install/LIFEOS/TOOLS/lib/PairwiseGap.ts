/**
 * PairwiseGap — the one rule for when a judged eval also needs a side-by-side
 * comparison (20261010-evals-in-the-isa F10, ISC-49, ISC-55, ISC-57, ISC-58).
 *
 * A criterion judged by a rubric (a suite or an inline rubric) whose output is a
 * file, a page or a screenshot is also compared against the last output the
 * principal accepted: a `pairwise` stage after the rubric whose champion (its
 * first candidate) is the slot `champion:last-accepted`. The rubric stays the
 * deciding stage while no champion is recorded (Bunker reports the pairwise stage
 * as skip). These problems break the rule:
 *   gap        a rubric over a captured output, no pairwise stage after it
 *   champion   the pairwise stage after the rubric names a fixed champion file,
 *              never the last accepted output
 *   no-rubric  a pairwise stage against champion:last-accepted with no rubric,
 *              so nothing decides while no champion is recorded (ISC-54)
 *   misplaced  a pairwise stage before the rubric
 *   stale      a pairwise candidate (any candidate after the champion) that no
 *              earlier code stage of the same block writes (for a pairwise row:
 *              no code row or block of the criterion on a lower stage), so it is
 *              a file already on disk and never this run's output (ISC-57)
 *   capture    the command that writes a candidate captures a page with
 *              something other than one plain call of the sanctioned browser
 *              tool, Interceptor's Capture.sh (curl or wget of a URL, Playwright,
 *              Puppeteer, screencapture, a script writing a page image, Capture.sh
 *              chained with another command), or captures a page the eval does
 *              not grade
 * A pairwise check with a fixed champion and no rubric is not a gap: its
 * champion always exists, so it decides every run (ISC-43). Its candidates must
 * still be fresh, so a compiled pairwise check is always a block stage: a row has
 * no earlier stage to write its candidate.
 *
 * "Capturable output" is decided from the eval alone, never from a model: a URL,
 * a path with an output extension (a page, image, video, audio, Markdown or text
 * file), or the word screenshot, found in a rubric subject, a glance producer, a
 * pairwise candidate after the champion, or a judged row's tool cell. Code-stage
 * commands are read only when a suite judges: an inline rubric names the subject
 * it grades, so `test -s out/page.html` beside it checks that a file exists and
 * hands nothing to the judge, while a suite names no subject, so the code gate is
 * where the output is named. With no output in the block, a suite falls back to
 * the criterion's other code rows and then the criterion's own text: a suite stage
 * standing alone never hides the page its criterion is about (the census
 * predicate for ISC-58). JSON, YAML and script paths are state or code, not
 * outputs, and the ISA file itself is the description of the output, never the
 * output.
 *
 * "Written by an earlier stage" (ISC-57) is also decided in code: a code-stage
 * command writes the operand of an output flag (`--out`, `--output`, `--outfile`,
 * `-o`) or of a `>` redirect, never `/dev/...`. `test -s ./x.png` names a file
 * and writes nothing, so a candidate it names is stale. Copies are not writes: a
 * `>>` append keeps the old bytes, and a redirect of a pipeline that starts with a
 * copier (`cat ./old.png > ./shot.png`, `echo x > shot.png`) re-emits bytes already
 * on disk. This is a read of the command text, so a build script that copies a
 * file inside itself is not caught; what closes that for pages is the capture
 * rule: an image candidate of an eval that grades a page comes only from
 * Capture.sh, and a capture must be of a page the eval grades (a rubric subject,
 * glance producer, code gate, the criterion's text or code rows), when it names one.
 *
 * Recompiles (ISC-58): a new eval for a criterion that already has one keeps
 * every capturable output the previous eval named (namedOutputs: every stage and
 * row except what it compared, in whichever stage names it, so a stale old
 * candidate and its `test -s` gate can be replaced by a fresh capture; the word
 * screenshot is kept by any image the new eval names); keeps at least as many
 * code gates on each of those outputs as before (a gate is a code check that is
 * not a capture: a capture does not replace a curl status or content check); and,
 * when the previous eval was judged by a rubric or suite, keeps a rubric or suite
 * stage, whether or not it named an output. Compile refuses a recompile that drops
 * any of these (recompileProblems). The census holds no previous eval, so it
 * cannot see a rubric turned into a glance question (it cannot tell a holistic
 * criterion from a readable one in code); the suite fallback above is what it can
 * see.
 *
 * Compile.ts refuses an eval with a problem (so the model regenerates it), and
 * EvalCensus.ts --pairwise-gaps lists the problems already in the estate
 * (pairwiseGaps), through the same functions here. Read-only.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { claimText, isaBody, parseIsaClaimsText, stripBulletPrefix } from "./IsaClaims.ts";
import { evalRefOf, parseTestStrategyDiagnostic, type Probe, type StagedEval } from "./IsaTestStrategy.ts";

/** The slot Bunker's champion.ts fills with the last accepted output (CHAMPION_SLOT there). */
export const LAST_ACCEPTED = "champion:last-accepted";
/** The sanctioned browser capture, run from the config root (Bunker resolves `skills/...` from any probe directory, ISC-59). */
export const CAPTURE_TOOL = "skills/Interceptor/Tools/Capture.sh";
/** Where a compiled capture stage writes, relative to the probe directory; `<isc>` is the criterion id. */
export const CAPTURE_DIR = "./.assay/captures";

const OUTPUT_EXT = "html?|png|jpe?g|webp|gif|svg|pdf|mp4|mov|webm|mkv|mp3|wav|m4a|md|txt";
const URL_REF = /\bhttps?:\/\/[^\s"'`<>|;,)]+/gi;
const HAS_URL = /\bhttps?:\/\/[^\s"'`<>|;,)]+/i;
const PATH_REF = new RegExp(`(?:^|[\\s"'=,(])((?:\\.{1,2}\\/|\\/)?[\\w@%+~.-]+(?:\\/[\\w@%+~.-]+)*\\.(?:${OUTPUT_EXT}))(?=$|[\\s"',;)|&<>?#])`, "gi");
const SCREENSHOT = /\bscreenshots?\b/i;
const ISA_FILE = /(?:^|\/)(?:ISA|[\w.-]+\.isa)\.md$/i;
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;
/** A judged row naming a suite (`suite:<name>`, or EvalRunner with `-s <name>` and no input): it grades no subject from the row. */
const suiteRow = (tool: string): boolean => /^\s*suite:/.test(tool) || (/\s-s\s+[A-Za-z0-9._-]+/.test(tool) && !/--input\b/.test(tool));
/** A champion slot is filled at run time; it is never a candidate this run writes. */
const isSlot = (c: string): boolean => /^champion:/.test(c);

/** Every capturable output reference in these strings, URLs first, de-duplicated in order. */
export function capturableOutputs(texts: readonly string[]): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  for (const t of texts) {
    for (const m of t.matchAll(URL_REF)) add(m[0]);
    const rest = t.replace(URL_REF, " ");
    // The ISA describes the output; a rubric that reads it for context is not grading it as an output.
    for (const m of rest.matchAll(PATH_REF)) if (!ISA_FILE.test(m[1]!)) add(m[1]!);
    if (SCREENSHOT.test(rest)) add("screenshot");
  }
  return out;
}

/** One spelling per output, so `./out/a.png` and `out/a.png`, or a URL with and without its trailing slash, compare equal. */
export function normOutput(o: string): string {
  if (/^https?:\/\//i.test(o)) return o.replace(/\/+$/, "");
  if (o === "screenshot") return o;
  return posix.normalize(o.replace(/^["']|["']$/g, "")).replace(/^\.\//, "");
}

/** The candidates of a Tournament command, the champion first; empty when it names none. */
export function pairwiseCandidates(cmd: string): string[] {
  const m = /--candidates(?:=|\s+)(["']?)([^\s"']+)\1/.exec(cmd);
  return m ? m[2]!.split(",").filter(Boolean) : [];
}

/** True when a Tournament command's champion, its first candidate, is the last-accepted slot. */
export function againstLastAccepted(cmd: string): boolean {
  return pairwiseCandidates(cmd)[0] === LAST_ACCEPTED;
}

/** The command with every quoted region's inside replaced by `_`, same length: a `;`, `>` or `-o` inside quotes is text. */
function maskQuotes(cmd: string): string {
  return cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => q[0] + "_".repeat(q.length - 2) + q[q.length - 1]);
}

/** The command word of a shell segment (env assignments aside), basename, lower-cased. */
function commandWord(segment: string): string {
  return /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(\S+)/.exec(segment)?.[1]?.replace(/^.*\//, "").toLowerCase() ?? "";
}

/** The pipelines of a command, each as its parts' [start, end) offsets: lists split on `&&` `||` `;`, parts on `|`. */
function pipelines(masked: string): [number, number][][] {
  const out: [number, number][][] = [];
  let parts: [number, number][] = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    const two = masked.slice(i, i + 2);
    const end = i === masked.length;
    if (end || two === "&&" || two === "||" || masked[i] === ";" || masked[i] === "|") {
      parts.push([start, i]);
      if (masked[i] === "|" && two !== "||") { start = i + 1; continue; }
      out.push(parts); parts = [];
      start = i + (end ? 0 : two === "&&" || two === "||" ? 2 : 1);
      if (two === "&&" || two === "||") i++;
    }
  }
  return out;
}

/** `-o` is an operator or another flag here, never an output: `test a -o b`, `find -o`, `rg -o`, `install -o owner`. */
const O_IS_NOT_OUTPUT = new Set(["test", "[", "[[", "find", "grep", "egrep", "rg", "install", "chown", "ls", "ps", "ssh"]);
/** Commands that only re-emit bytes already on disk or typed inline: a redirect of their output is a copy, never this run's output. */
const COPIES = new Set(["cat", "cp", "echo", "printf", "head", "tail", "dd", "tee", "true", ":", "yes", "base64", "xxd", "tr", "cut", "sort", "uniq", "rev", "sed", "awk"]);
const OUT_FLAG = /(?:^|\s)(--out(?:put)?|--out-?file|-o)(?:=|\s+)((["']?)[^\s"'|;&<>]+\3)/g;
const REDIRECT = /(?:^|[^\d&<>])(>>?)\s*((["']?)[^\s"'|;&<>]+\3)/g;

/**
 * The files a code command writes as fresh output: output-flag operands (`--out`, `--output`, `--outfile`, `-o`) and
 * `>` redirect operands, `/dev/...` aside. Never runs anything. Not a write: an append (`>>` keeps the old bytes), a
 * redirect of a pipeline that starts with a copier (`cat ./old.png > ./shot.png`, `echo x > shot.png`), an operand that
 * is itself a flag, and `-o` on a command where it means something else (`test -s a -o -s b`).
 */
export function writtenPaths(cmd: string): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (p && !/^\/dev\//.test(p) && !p.startsWith("-") && !out.includes(p)) out.push(p); };
  const masked = maskQuotes(cmd);
  /** The operand as written in the original command (quotes dropped), from where the masked match put it. */
  const operand = (m: RegExpMatchArray, offset: number) => {
    const end = offset + m.index! + m[0].length;
    return cmd.slice(end - m[2]!.length, end).replace(/^["']|["']$/g, "");
  };
  for (const parts of pipelines(masked)) {
    const producer = commandWord(masked.slice(...parts[0]!));
    for (const [s, e] of parts) {
      const part = masked.slice(s, e);
      const word = commandWord(part);
      for (const m of part.matchAll(OUT_FLAG)) if (!(m[1] === "-o" && O_IS_NOT_OUTPUT.has(word))) add(operand(m, s));
      for (const m of part.matchAll(REDIRECT)) if (m[1] === ">" && !COPIES.has(producer)) add(operand(m, s));
    }
  }
  return out;
}

const MENTIONS_CAPTURE = /\bInterceptor\/Tools\/Capture\.sh\b/;
/** The sanctioned capture as one whole command: `bash|sh [<path>/]skills/Interceptor/Tools/Capture.sh <args>`, no shell composition or expansion. */
const CAPTURE_CALL = /^\s*(?:bash|sh)\s+(?:[^\s;&|<>`$()'"\\]*\/)?skills\/Interceptor\/Tools\/Capture\.sh((?:\s+[^\s;&|<>`$()'"\\]+)*)\s*$/;
const BANNED_CAPTURE = /\b(?:playwright|puppeteer|screencapture|shot-scraper|wkhtmltoimage|webkit2png)\b|--headless\b/i;
const FETCHER = /(?:^|[\s;&|(])(?:curl|wget)\s/;

/** A sanctioned capture: the page it captures and the file it writes. */
export interface SanctionedCapture { url: string; out: string }

/**
 * The command as a sanctioned capture, or null. It is exactly one call of Capture.sh on one http(s) URL with `--out
 * <path>`, plus only `--full`, `--pixel` or `--scale N`: nothing chained, piped or expanded, never `--current` (no page
 * named) or `--allow-unchecked` (a capture whose blank-frame check did not run is not a verified one).
 */
export function sanctionedCapture(cmd: string): SanctionedCapture | null {
  const m = CAPTURE_CALL.exec(cmd);
  if (!m) return null;
  const args = m[1]!.trim().split(/\s+/).filter(Boolean);
  let url = "", out = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out" || a === "--scale") { const v = args[++i]; if (!v || v.startsWith("-")) return null; if (a === "--out") out = v; continue; }
    if (a.startsWith("--out=")) { out = a.slice(6); continue; }
    if (a === "--full" || a === "--pixel") continue;
    if (/^https?:\/\//i.test(a) && !url) { url = a; continue; }
    return null;
  }
  return url && out ? { url, out } : null;
}

/** Whether a code command captures a page (sanctioned or not) rather than checking it: such a command is a capture, never a code gate. */
export function isCaptureCommand(cmd: string): boolean {
  if (MENTIONS_CAPTURE.test(cmd) || BANNED_CAPTURE.test(cmd)) return true;
  if (!HAS_URL.test(cmd)) return false;
  const writes = writtenPaths(cmd);
  return SCREENSHOT.test(cmd) || writes.some((p) => IMAGE.test(p)) || (FETCHER.test(cmd) && writes.length > 0);
}

/**
 * Why a code command is not an acceptable writer of a pairwise candidate, or null. `pageUrls` are the pages the eval
 * grades (gradedPages): its inline rubric subjects' pages when they name any, else those its glance producers, code
 * gates, criterion text and code rows name, sanctioned captures aside.
 *   - A sanctioned capture is accepted when it captures one of those pages, or when the eval names no page elsewhere.
 *   - Capture.sh in any other shape (chained, piped, `--current`, `--allow-unchecked`) is refused.
 *   - A banned browser driver is refused whatever it writes.
 *   - An image candidate of an eval about a page comes only from the sanctioned capture: a command naming a URL, or a
 *     script that names none but may drive a browser inside, is refused for it.
 *   - curl or wget writing a page is refused.
 * A build that reads a URL as data and writes its own non-image file is a build, not a capture.
 */
function captureProblem(cmd: string, candidate: string, pageUrls: readonly string[]): string | null {
  const sanctioned = sanctionedCapture(cmd);
  if (sanctioned) {
    if (!pageUrls.length || pageUrls.includes(normOutput(sanctioned.url))) return null;
    return `"${cmd}" captures ${sanctioned.url}, a page the eval does not grade (it grades ${pageUrls.join(", ")})`;
  }
  if (MENTIONS_CAPTURE.test(cmd)) return `"${cmd}" is not one plain call of Capture.sh on a URL with --out (nothing chained, no --current or --allow-unchecked)`;
  if (BANNED_CAPTURE.test(cmd)) return `"${cmd}" drives a browser with a banned tool`;
  if (IMAGE.test(candidate) && (HAS_URL.test(cmd) || pageUrls.length)) return `"${cmd}" writes the page image ${candidate} without the sanctioned capture`;
  if (HAS_URL.test(cmd) && FETCHER.test(cmd)) return `"${cmd}" fetches the page with curl or wget`;
  return null;
}

/** The parts of a judged eval this rule reads: stage positions of rubrics and pairwise checks, and the outputs found. */
export interface JudgedShape {
  /** 0-based stage indexes holding an `eval` (suite or inline rubric) check. */
  rubricAt: number[];
  /** 0-based stage indexes holding a `pairwise` check. */
  pairwiseAt: number[];
  /** The pairwiseAt indexes whose champion is `champion:last-accepted`. */
  lastAcceptedAt: number[];
  /** Capturable output references, in order. */
  outputs: string[];
  /** Pairwise candidates no earlier code stage of the block writes (ISC-57). */
  stale?: string[];
  /** Commands that capture a candidate page with something other than the sanctioned browser tool. */
  badCapture?: string[];
}

export type PairwiseProblem = "gap" | "champion" | "no-rubric" | "misplaced" | "stale" | "capture";

/** Every problem a judged eval has with the rule, most structural first: misplaced, then the rubric/champion problem, then stale and capture. */
export function problemsOf(shape: JudgedShape): PairwiseProblem[] {
  const out: PairwiseProblem[] = [];
  const lastRubric = shape.rubricAt.length ? Math.max(...shape.rubricAt) : -1;
  if (lastRubric >= 0 && shape.pairwiseAt.some((i) => i < lastRubric)) out.push("misplaced");
  else if (lastRubric < 0) { if (shape.lastAcceptedAt.length) out.push("no-rubric"); }
  else if (shape.outputs.length && !shape.lastAcceptedAt.some((i) => i > lastRubric)) out.push(shape.pairwiseAt.some((i) => i > lastRubric) ? "champion" : "gap");
  if (shape.stale?.length) out.push("stale");
  if (shape.badCapture?.length) out.push("capture");
  return out;
}

/** The one problem a judged eval has with the rule (the first problemsOf names), or null. */
export function verdictOf(shape: JudgedShape): PairwiseProblem | null {
  return problemsOf(shape)[0] ?? null;
}

/** The pages (http(s) URLs, normalized) named in these strings. */
function pagesIn(texts: readonly string[]): string[] {
  return [...new Set(capturableOutputs(texts).filter((o) => /^https?:\/\//i.test(o)).map(normOutput))];
}

/** The pages an eval grades: those its inline rubric subjects name when they name any (the rubric says exactly what it grades), else every page it names elsewhere. */
function gradedPages(subjects: readonly string[], others: readonly string[]): string[] {
  const exact = pagesIn(subjects);
  return exact.length ? exact : pagesIn(others);
}

/** A code command of an earlier stage or row, with the files it writes as fresh output. */
interface Writer { cmd: string; writes: Set<string> }
const writerOf = (cmd: string): Writer => ({ cmd, writes: new Set(writtenPaths(cmd).map(normOutput)) });

/**
 * The freshness of pairwise candidates (ISC-57): each non-slot candidate is written by one of `writers` (the code
 * commands that run before its check), and each writer of it is an acceptable one for the pages the eval grades.
 */
function freshness(candidates: readonly string[], writers: readonly Writer[], pageUrls: readonly string[], stale: string[], badCapture: string[]): void {
  for (const c of candidates.filter((x) => !isSlot(x))) {
    const by = writers.filter((w) => w.writes.has(normOutput(c)));
    if (!by.length) { if (!stale.includes(c)) stale.push(c); continue; }
    for (const w of by) { const bad = captureProblem(w.cmd, c, pageUrls); if (bad && !badCapture.includes(bad)) badCapture.push(bad); }
  }
}

/**
 * A parsed staged eval's shape. The champion is never an output; code stages are read only when a suite judges, and
 * then `context` (the criterion's other code rows and its own text) is read when the block names no output itself.
 * The pages the eval grades, for the capture check, are read from every check but the sanctioned captures, plus `context`.
 */
export function shapeOfStaged(staged: StagedEval, context: readonly string[] = []): JudgedShape {
  const rubricAt: number[] = [];
  const pairwiseAt: number[] = [];
  const lastAcceptedAt: number[] = [];
  const texts: string[] = [];
  const code: string[] = [];
  const subjects: string[] = [];
  const graded: string[] = [...context];
  /** Each non-slot candidate with the code commands of the stages before its pairwise check. */
  const pending: { candidates: string[]; writers: Writer[] }[] = [];
  /** Code commands of the stages before the current one. */
  const writers: Writer[] = [];
  let suiteJudged = false;
  staged.stages.forEach((st, i) => {
    const here: Writer[] = [];
    for (const ch of st.checks) {
      if (ch.kind === "eval") { rubricAt.push(i); if (ch.rubric) { texts.push(ch.rubric.subject); subjects.push(ch.rubric.subject); } else suiteJudged = true; }
      else if (ch.kind === "pairwise") {
        pairwiseAt.push(i);
        if (againstLastAccepted(ch.tool)) lastAcceptedAt.push(i);
        const candidates = pairwiseCandidates(ch.tool).slice(1);
        texts.push(candidates.join(" "));
        pending.push({ candidates, writers: [...writers] });
      }
      else if (ch.kind === "glance" && ch.question) { texts.push(ch.question.state.producer); graded.push(ch.question.state.producer); }
      else if (ch.kind === "code") {
        code.push(ch.tool);
        here.push(writerOf(ch.tool));
        if (!sanctionedCapture(ch.tool)) graded.push(ch.tool);
      }
    }
    // A stage's own writes count only for later stages: checks in one stage run side by side.
    writers.push(...here);
  });
  const pageUrls = gradedPages(subjects, graded);
  const stale: string[] = [];
  const badCapture: string[] = [];
  for (const p of pending) freshness(p.candidates, p.writers, pageUrls, stale, badCapture);
  if (suiteJudged) texts.push(...code);
  let outputs = capturableOutputs(texts);
  if (suiteJudged && !outputs.length) outputs = capturableOutputs(context);
  return {
    rubricAt: [...new Set(rubricAt)], pairwiseAt: [...new Set(pairwiseAt)], lastAcceptedAt: [...new Set(lastAcceptedAt)], outputs,
    ...(stale.length ? { stale } : {}), ...(badCapture.length ? { badCapture } : {}),
  };
}

/** The refusal Compile gives for a problem: what is wrong and the stage that fixes it. `detail` names stale candidates or bad capture commands. */
export function problemReason(problem: PairwiseProblem, outputs: readonly string[], detail: readonly string[] = [], isc = "<isc>"): string {
  const captured = `a judged eval whose output is captured (${outputs[0] ?? "?"})`;
  switch (problem) {
    case "misplaced": return "the pairwise stage comes after the rubric, never before it: the rubric decides while no champion is recorded";
    case "gap": return `${captured} adds a pairwise stage after its rubric: ${suggestedPairwise(outputs, isc)}`;
    case "champion": return `${captured} is compared with ${LAST_ACCEPTED}, the last output the principal accepted, named as the first candidate; a fixed champion file is not that output: ${suggestedPairwise(outputs, isc)}`;
    case "no-rubric": return `a pairwise stage against ${LAST_ACCEPTED} follows a rubric stage: with no champion recorded it reports skip, and the rubric is the verdict`;
    case "stale": return `pairwise candidate ${detail.map((d) => `"${d}"`).join(", ") || "?"} is not written by an earlier code stage of this block, so it is a file already on disk, never this run's output: add a code stage before the rubric that writes it (a page: bash ${CAPTURE_TOOL} <url> --out ${CAPTURE_DIR}/${isc}.png; a file the block builds: its build command with --out <path>, -o <path> or > <path>) and name exactly that path as the candidate`;
    case "capture": return `the block captures a page with something other than the sanctioned browser tool, or captures a page the eval does not grade (${detail.join("; ") || "a stage"}): capture the page the rubric grades with one plain call, bash ${CAPTURE_TOOL} <url> --out ${CAPTURE_DIR}/${isc}.png (curl, wget, Playwright, Puppeteer and screencapture are not it, and an image of a page comes from no other command)`;
  }
}

/** The stages a gap is closed with: for a page, the capture stage and a pairwise stage on the capture; for a file, the pairwise stage on it. */
export function suggestedPairwise(outputs: readonly string[], isc = "<isc>"): string {
  const path = outputs.find((o) => o !== "screenshot" && !/^https?:/i.test(o));
  const tournament = (candidate: string) => `{"pairwise": "bun skills/Assay/Tools/Tournament.ts --candidates ${LAST_ACCEPTED},${candidate} --question \\"...\\" --json"}`;
  if (path) return `${tournament(path)}, with ${path} written by an earlier code stage of the block (its build command with --out ${path})`;
  const url = outputs.find((o) => /^https?:/i.test(o)) ?? "<url of the page>";
  const shot = `${CAPTURE_DIR}/${isc}.png`;
  return `{"code": ["bash ${CAPTURE_TOOL} ${url} --out ${shot}"]} before the rubric, then ${tournament(shot)}`;
}

// ── recompiles (ISC-58) ──────────────────────────────────────────────────────

/** What a criterion's eval named, checked and how it judged: the yardstick a recompile is held to. */
export interface PreviousEval {
  /** Every capturable output named anywhere in the eval (the champion and the compared candidates aside), in order. */
  outputs: string[];
  /** Whether a rubric or suite judged it. */
  judged: boolean;
  /** Its code gates: code commands (block code stages and code rows) that check one of `outputs` and are not captures. */
  gates: string[];
}

/** The non-slot candidates of every pairwise check in a staged eval and its pairwise rows, normalized. */
function comparedIn(staged: StagedEval | undefined, rows: readonly Pick<Probe, "type" | "tool">[] = []): Set<string> {
  const tools = [
    ...(staged?.stages.flatMap((st) => st.checks.filter((ch) => ch.kind === "pairwise").map((ch) => ch.tool)) ?? []),
    ...rows.filter((p) => p.type === "pairwise").map((p) => p.tool),
  ];
  return new Set(tools.flatMap((t) => pairwiseCandidates(t).slice(1).filter((c) => !isSlot(c)).map(normOutput)));
}

/**
 * Every capturable output a staged eval names in any stage (code, glance, rubric subject, and with `candidates` the
 * pairwise candidates after the champion); manual prose aside. A previous eval is read without what it compared, in any
 * stage that names it: an old candidate may be exactly the stale file a recompile exists to replace (ISC-57), and a
 * `test -s` gate on that file goes with it.
 */
export function namedOutputs(staged: StagedEval, candidates = true): string[] {
  const texts: string[] = [];
  for (const st of staged.stages) for (const ch of st.checks) {
    if (ch.kind === "code") texts.push(ch.tool);
    else if (ch.kind === "glance" && ch.question) texts.push(ch.question.state.producer);
    else if (ch.kind === "eval" && ch.rubric) texts.push(ch.rubric.subject);
    else if (ch.kind === "pairwise" && candidates) texts.push(pairwiseCandidates(ch.tool).slice(1).filter((c) => !isSlot(c)).join(" "));
  }
  const all = capturableOutputs(texts);
  if (candidates) return all;
  const compared = comparedIn(staged);
  return all.filter((o) => !compared.has(normOutput(o)));
}

/** The code gates among these commands: not captures (isCaptureCommand), each naming at least one of `outputs` when given. */
export function codeGates(cmds: readonly string[], outputs?: readonly string[]): string[] {
  const keep = outputs ? new Set(outputs.map(normOutput)) : null;
  return cmds.filter((c) => !isCaptureCommand(c) && (!keep || capturableOutputs([c]).some((o) => keep.has(normOutput(o)))));
}

/** The code commands of a staged eval, in stage order. */
export function codeCommands(staged: StagedEval | undefined): string[] {
  return staged?.stages.flatMap((st) => st.checks.filter((ch) => ch.kind === "code").map((ch) => ch.tool)) ?? [];
}

/** The previous eval of a criterion from its block and its other rows (manual rows and eval refs aside), or null when it has none. */
export function previousEvalOf(staged: StagedEval | undefined, rows: readonly Pick<Probe, "type" | "tool" | "tier">[]): PreviousEval | null {
  const live = rows.filter((p) => p.type !== "manual" && !evalRefOf(p.tool));
  if (!staged && !live.length) return null;
  const compared = comparedIn(staged, live);
  const rowTexts = live.filter((p) => p.type !== "pairwise").map((p) => p.tool);
  const outputs = capturableOutputs([...(staged ? namedOutputs(staged, false) : []), ...rowTexts]).filter((o) => !compared.has(normOutput(o)));
  const judged = !!staged?.stages.some((st) => st.checks.some((ch) => ch.kind === "eval")) || live.some((p) => p.type === "eval");
  const gates = codeGates([...codeCommands(staged), ...live.filter((p) => p.tier === "code").map((p) => p.tool)], outputs);
  return { outputs, judged, gates };
}

/** The gates among these that name output `o`. */
const gatesOn = (gates: readonly string[], o: string): string[] => gates.filter((g) => capturableOutputs([g]).some((x) => normOutput(x) === normOutput(o)));

/**
 * Why a new eval may not replace the previous one: an output it no longer names, an output it checks with fewer code
 * gates than before (the curl status and content checks a capture does not replace), or a rubric/suite judge it
 * dropped. The judge rule holds whether or not the previous eval named an output (a suite alone over the page its
 * criterion names is still a judged criterion). Gates are compared per output by count, never by their exact text, so
 * a recompile may rewrite a gate; it may not drop one.
 */
export function recompileProblems(previous: PreviousEval | null | undefined, next: PreviousEval): string[] {
  if (!previous) return [];
  const have = new Set(next.outputs.map(normOutput));
  // "screenshot" (the word, from a flag or a file name) is kept by any image the new eval names, a capture included.
  if (next.outputs.some((o) => IMAGE.test(o))) have.add("screenshot");
  const lost = previous.outputs.filter((o) => !have.has(normOutput(o)));
  const out: string[] = [];
  if (lost.length) out.push(`the previous eval named ${lost.map((o) => `"${o}"`).join(", ")} and this one does not: a recompile keeps every output its criterion's previous eval named, so keep a stage that names each (a page: capture it with bash ${CAPTURE_TOOL} <url> --out <path>)`);
  const dropped = previous.outputs.flatMap((o) => {
    const before = gatesOn(previous.gates, o);
    const after = gatesOn(next.gates, o);
    return after.length < before.length ? [{ o, before, after: after.length }] : [];
  });
  for (const d of dropped) {
    out.push(`the previous eval checked "${d.o}" with ${d.before.length} code check${d.before.length > 1 ? "s" : ""} and this one has ${d.after}: a recompile keeps its code checks (a capture is not one), so keep ${d.before.map((g) => `"${g}"`).join(", ")} in a code stage`);
  }
  if (previous.judged && !next.judged) out.push(`the previous eval judged ${previous.outputs[0] ?? "this criterion"} with a rubric or suite and this one has none: a recompile keeps that rubric or suite stage, then the pairwise stage after it, never a glance question or code check alone`);
  return out;
}

// ── the census (ISC-55) ──────────────────────────────────────────────────────

export interface PairwiseGapRow { isc: string; problem: PairwiseProblem; outputs: string[]; detail?: string[] }

/** A criterion's text from its ISA body line, as Compile's planCriteria reads it. */
export function criterionTextOf(raw: string): string {
  return (raw.trim().startsWith("|") ? raw.split("|").slice(2).join(" ").trim() : claimText(stripBulletPrefix(raw))?.body ?? raw).trim();
}

/**
 * Every criterion in one ISA with a pairwise problem (ISC-55): judged by a rubric over a capturable output with no
 * pairwise stage against champion:last-accepted after it, or one of the other problems problemsOf names. A criterion
 * with an `## Evals` block is read through the block (a suite-judged block with no output in it falls back to the
 * criterion's code rows, then its text); one with only Test Strategy rows is read through its judged rows' tool cells
 * (plus its code rows and its text when a judged row names a suite) and any pairwise row for the same id, which counts
 * as following the rubric. Freshness (stale, capture) holds for rows too: a pairwise row's candidate is written by a
 * code row of the same criterion on a lower stage, or by a code stage of its block when the block's row is on a lower
 * stage (rows of one stage run side by side, so a writer on the same stage never counts), and a page image only by the
 * sanctioned capture of a page the criterion grades. Tombstoned criteria are skipped, as Compile and the without-eval
 * census skip them. Read-only.
 */
export function pairwiseGaps(isaPath: string, text: string = readFileSync(isaPath, "utf8"), ts = parseTestStrategyDiagnostic(isaPath)): PairwiseGapRow[] {
  const out: PairwiseGapRow[] = [];
  const body = isaBody(text).split(/\r?\n/);
  for (const c of parseIsaClaimsText(text, { path: isaPath }).claims) {
    const raw = body[c.line - 1] ?? "";
    if (/\[DROPPED\b/.test(raw)) continue;
    const criterion = criterionTextOf(raw);
    const rows = ts.probes.filter((p) => p.isc === c.id);
    // A pairwise row beside a block or a judged row runs after it; only one against the last accepted output closes a gap.
    const pairwiseRows = rows.filter((p) => p.type === "pairwise");
    const codeRows = rows.filter((p) => p.tier === "code" && !evalRefOf(p.tool)).map((p) => p.tool);
    const staged = ts.evals?.evals.get(c.id);
    let shape: JudgedShape;
    if (staged) shape = shapeOfStaged(staged, [...codeRows, criterion]);
    else {
      const judged = rows.filter((p) => p.type === "eval" && !evalRefOf(p.tool));
      const suiteJudged = judged.some((p) => suiteRow(p.tool));
      let outputs = capturableOutputs([...judged.map((p) => p.tool), ...(suiteJudged ? codeRows : [])]);
      if (suiteJudged && !outputs.length) outputs = capturableOutputs([criterion]);
      shape = { rubricAt: judged.length ? [0] : [], pairwiseAt: [], lastAcceptedAt: [], outputs };
    }
    if (pairwiseRows.length) {
      const after = Number.MAX_SAFE_INTEGER;
      // ISC-57 for rows: the writers that run before each pairwise row, and the pages the criterion grades.
      const code = rows.filter((p) => p.tier === "code" && !evalRefOf(p.tool));
      const blockRow = rows.find((p) => evalRefOf(p.tool));
      const blockCode = codeCommands(staged);
      const subjects = staged?.stages.flatMap((st) => st.checks.flatMap((ch) => ch.kind === "eval" && ch.rubric ? [ch.rubric.subject] : [])) ?? [];
      const graded = [criterion, ...code.map((p) => p.tool), ...rows.filter((p) => p.type === "eval" && !evalRefOf(p.tool)).map((p) => p.tool),
        ...(staged?.stages.flatMap((st) => st.checks.flatMap((ch) => ch.kind === "glance" && ch.question ? [ch.question.state.producer] : [])) ?? []),
        ...blockCode].filter((t) => !sanctionedCapture(t));
      const pageUrls = gradedPages(subjects, graded);
      const stale = [...(shape.stale ?? [])];
      const badCapture = [...(shape.badCapture ?? [])];
      for (const pw of pairwiseRows) {
        const before = [...code.filter((p) => p.stage < pw.stage).map((p) => p.tool), ...(blockRow && blockRow.stage < pw.stage ? blockCode : [])];
        freshness(pairwiseCandidates(pw.tool).slice(1), before.map(writerOf), pageUrls, stale, badCapture);
      }
      shape = {
        ...shape,
        ...(stale.length ? { stale } : {}), ...(badCapture.length ? { badCapture } : {}),
        pairwiseAt: [...shape.pairwiseAt, after],
        lastAcceptedAt: pairwiseRows.some((p) => againstLastAccepted(p.tool)) ? [...shape.lastAcceptedAt, after] : shape.lastAcceptedAt,
        outputs: capturableOutputs([...shape.outputs, ...pairwiseRows.map((p) => pairwiseCandidates(p.tool).slice(1).join(" "))]),
      };
    }
    const problem = verdictOf(shape);
    if (!problem) continue;
    const detail = problem === "stale" ? shape.stale : problem === "capture" ? shape.badCapture : undefined;
    out.push({ isc: c.id, problem, outputs: shape.outputs, ...(detail?.length ? { detail } : {}) });
  }
  return out;
}
