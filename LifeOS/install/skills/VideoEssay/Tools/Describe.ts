#!/usr/bin/env bun
/**
 * Describe.ts — the YouTube description for a run: summary, chapters (mm:ss from the
 * timeline), the source link, and the run's links. A voice run names the post it reads instead of "Responding to";
 * a DA-read voice run also says who reads it: the author's AI assistant, in its own voice, reading the author's words verbatim.
 *
 *   bun Describe.ts --run <slug|dir> [--verify]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadLifeosConfig } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { essayKind, parseFrontmatter, type EssayKind } from "./EssayLint.ts";
import { argValue, ensureDir, hasFlag, isSelfRead, loadScript, loadTimeline, mmss, readJson, resolveRunDir, runPaths, type Narrator, type RunMeta, type Script, type Timeline } from "./Lib.ts";

/** A voice run as the description states it: who narrated, whose words they are, and (DA-read) the DA's name. */
export interface VoiceDescription { narrator?: Narrator; author: string; reader?: string; /** The DA reads a post it wrote (run.json label names the DA); `principal` is the user whose assistant it is. */ self?: boolean; principal?: string }

/**
 * The line that says who reads a voice run. A DA-read run: the author's AI assistant reads the author's words in its own
 * voice, verbatim, and writes none of them. A clone run says an AI voice clone of the author reads the author's words.
 * Only the author's own recording gets no line (undefined).
 */
export function narrationLine(voice: VoiceDescription): string | undefined {
  if (voice.narrator === "clone") {
    if (!voice.author.trim()) throw new Error("a clone-read description needs the author's name");
    return `Narrated by an AI voice clone of ${voice.author.trim()}, reading ${voice.author.trim()}'s own words verbatim from the post.`;
  }
  if (voice.narrator !== "da") return undefined;
  if (!voice.reader?.trim() || !voice.author.trim()) throw new Error("a DA-read description needs the reader's and the author's names");
  if (voice.self) {
    if (!voice.principal?.trim()) throw new Error("a self-read description needs the user's name (LIFEOS_CONFIG.toml principal.name)");
    return `${voice.reader.trim()}, ${voice.principal.trim()}'s AI assistant, wrote this post and reads it here in its own voice. The words are ${voice.reader.trim()}'s own, read verbatim from the post.`;
  }
  return `Read aloud by ${voice.reader.trim()}, ${voice.author.trim()}'s AI assistant, in its own voice. The words are ${voice.author.trim()}'s own, read verbatim from the post; the AI voices them and writes none of them.`;
}

/** The voice description for a run from run.json and the live names (the DA's name, and the user's name from `principal.name` when the post names no author). */
export function voiceDescription(meta: RunMeta, names: () => { principal: string; da: string } = () => { const c = loadLifeosConfig(); return { principal: c.principal.name, da: c.da.name }; }): VoiceDescription | undefined {
  if (meta.mode !== "voice") return undefined;
  const author = meta.source?.author?.trim();
  const needNames = !author || meta.narrator === "da";
  const n = needNames ? names() : undefined;
  const self = meta.narrator === "da" && isSelfRead(meta.label, n!.da);
  return { narrator: meta.narrator, author: author || n!.principal, ...(meta.narrator === "da" ? { reader: n!.da } : {}), ...(self ? { self, principal: n!.principal } : {}) };
}

/** The run's essay kind from Essay.md frontmatter; a run with no Essay.md (a voice run) is an essay for this purpose. */
export function runKind(essayPath: string): EssayKind {
  return existsSync(essayPath) ? essayKind(parseFrontmatter(readFileSync(essayPath, "utf8")).fm) : "essay";
}

export function chapters(script: Script, timeline: Timeline): { time: string; seconds: number; title: string }[] {
  const starts = new Map(timeline.beats.map((b) => [b.id, b.start]));
  return script.beats.filter((b) => b.chapter).map((b) => {
    const s = starts.get(b.id) ?? 0;
    return { time: mmss(s), seconds: s, title: b.chapter! };
  });
}

/**
 * Each link once, first label kept: a post that links the same page twice (in the body and again in its notes) lists it
 * once. Same page means same URL once a trailing slash goes.
 */
export function uniqueLinks(links: readonly { label: string; url: string }[]): { label: string; url: string }[] {
  const seen = new Set<string>();
  return links.filter((l) => { const key = l.url.replace(/\/+$/, ""); if (seen.has(key)) return false; seen.add(key); return true; });
}

/** An essay-mode run: the DA narrates in a synthesized voice and drafted the argument, so the description says so. */
export const ESSAY_DISCLOSURE = "Narrated in a synthesized AI voice. The author's AI assistant drafted this argument and its script.";

/** An explainer run: the DA narrates in a synthesized voice and wrote the explainer of the source, so the description says so. */
export const EXPLAINER_DISCLOSURE = "Narrated in a synthesized AI voice. The author's AI assistant wrote this explainer and its script from the source.";

/** The disclosure an essay-mode run carries, by its Essay.md kind. */
export function essayDisclosure(kind: EssayKind = "essay"): string { return kind === "explainer" ? EXPLAINER_DISCLOSURE : ESSAY_DISCLOSURE; }

export function renderDescription(script: Script, timeline: Timeline, thesis: string, voice?: VoiceDescription, kind: EssayKind = "essay"): string {
  const ch = chapters(script, timeline);
  const read = voice && narrationLine(voice);
  const lines = voice
    ? [thesis.trim(), "", ...(read ? [read, ""] : []), `From the post: ${script.source.title}`, script.source.url, ""]
    : kind === "explainer"
      ? [thesis.trim(), "", EXPLAINER_DISCLOSURE, "", `Explaining: ${script.source.title}${script.source.author ? ` — ${script.source.author}` : ""}`, script.source.url, ""]
      : [thesis.trim(), "", ESSAY_DISCLOSURE, "", `Responding to: ${script.source.title} — ${script.source.author}`, script.source.url, ""];
  if (ch.length) { lines.push("Chapters:"); for (const c of ch) lines.push(`${c.time} ${c.title}`); lines.push(""); }
  const links = uniqueLinks(script.links ?? []);
  if (links.length) { lines.push("Links:"); for (const l of links) lines.push(`${l.label}: ${l.url}`); lines.push(""); }
  return lines.join("\n").trimEnd() + "\n";
}

/** `voice` is the run's voice description (a voice run) or undefined (an essay run); both kinds must carry their synthesized-narration disclosure. */
export function verifyDescription(md: string, script: Script, timeline: Timeline, voice?: VoiceDescription, kind: EssayKind = "essay"): string[] {
  const problems: string[] = [];
  const disclosure = voice ? narrationLine(voice) : essayDisclosure(kind);
  if (disclosure && !md.includes(disclosure)) problems.push("synthesized-narration disclosure missing");
  if (!md.includes(script.source.url)) problems.push("source url missing");
  for (const c of chapters(script, timeline)) if (!md.includes(`${c.time} ${c.title}`)) problems.push(`chapter line missing: ${c.time} ${c.title}`);
  if (!/^00:00 /m.test(md)) problems.push("first chapter must start at 00:00");
  return problems;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: Describe.ts --run <slug|dir> [--verify]"); process.exit(2); }
  const paths = runPaths(resolveRunDir(runArg));
  const script = loadScript(paths.dir);
  const timeline = loadTimeline(paths.dir);
  if (hasFlag(argv, "--verify")) {
    if (!existsSync(paths.description)) { console.log("✗ description.md missing"); process.exit(1); }
    const verifyVoice = existsSync(paths.meta) ? voiceDescription(readJson<RunMeta>(paths.meta)) : undefined;
    const problems = verifyDescription(readFileSync(paths.description, "utf8"), script, timeline, verifyVoice, runKind(paths.essay));
    for (const p of problems) console.log(`✗ ${p}`);
    console.log(problems.length ? "✗ description failed" : "✓ description verified");
    process.exit(problems.length ? 1 : 0);
  }
  const thesis = existsSync(paths.essay) ? String(parseFrontmatter(readFileSync(paths.essay, "utf8")).fm.thesis ?? "") : "";
  const kind = runKind(paths.essay);
  ensureDir(paths.out);
  const voice = existsSync(paths.meta) ? voiceDescription(readJson<RunMeta>(paths.meta)) : undefined;
  writeFileSync(paths.description, renderDescription(script, timeline, thesis || script.title, voice, kind));
  console.log(`✓ ${paths.description}`);
}
