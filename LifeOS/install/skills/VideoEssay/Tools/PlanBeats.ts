#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { verifyAlignment, type AlignmentResult } from "./Align.ts";
import { argValue, readJson, resolveRunDir, runPaths, writeJson, type Post, type RunMeta, type Script, type Timeline, type Visual } from "./Lib.ts";

export interface Plan { inserts: { paragraphs: string[]; visual: Visual; chapter?: string }[] }
export function planBeats(post: Post, aligned: AlignmentResult, meta: RunMeta, plan: Plan = { inserts: [] }): { script: Script; timeline: Timeline } {
  invariant(verifyAlignment(aligned).length === 0, "alignment must pass before planning");
  const ids = post.paragraphs.map(p => p.id), words = aligned.words;
  const inserts = new Map<string, Plan["inserts"][number]>();
  for (const insert of plan.inserts) {
    invariant(insert.paragraphs.length > 0, "empty insert paragraph list");
    const indexes = insert.paragraphs.map(p => ids.indexOf(p));
    invariant(indexes.every(n => n >= 0), "insert references unknown paragraph id");
    invariant(indexes.every((n, i) => !i || n === indexes[i - 1] + 1), "insert paragraphs must be ordered and contiguous");
    for (const p of insert.paragraphs) { invariant(!inserts.has(p), `overlapping inserts at ${p}`); inserts.set(p, insert); }
  }
  const starts = ids.map(id => words.findIndex(w => w.p === id));
  invariant(starts.every((n, i) => n >= 0 && (!i || n > starts[i - 1])), "each paragraph must have ordered aligned words");
  starts[0] = 0;
  const boundary = (n: number) => n === 0 ? 0 : n >= words.length ? aligned.total : (words[n - 1].e + words[n].s) / 2;
  const groups: { a: number; b: number }[] = [];
  for (let a = 0; a < ids.length;) {
    let b = a + 1;
    while (b < ids.length) {
      if (inserts.get(ids[a]) !== inserts.get(ids[b])) break;
      // An insert is one beat for all its paragraphs: splitting it would exit and re-enter the visual mid-claim.
      if (inserts.get(ids[a])) { b++; continue; }
      if (post.paragraphs[b].heading) break;
      const current = boundary(starts[b]) - boundary(starts[a]);
      const extended = boundary(starts[b + 1] ?? words.length) - boundary(starts[a]);
      if (current >= 8 && extended > 25 || current >= 18) break;
      b++;
    }
    groups.push({ a, b }); a = b;
  }
  const timeline: Timeline = { fps: 30, gap: 0, total: aligned.total, narration: "narration.wav", beats: [] };
  const script: Script = { title: post.title, slug: meta.slug, targetMinutes: aligned.total / 60, source: { url: post.url, title: post.title, author: meta.source?.author ?? "" }, links: post.links.map(({ label, url }) => ({ label, url })), beats: [] };
  groups.forEach(({ a, b }, n) => {
    const id = `beat-${n + 1}`, start = starts[a], end = starts[b] ?? words.length;
    const spanWords = words.slice(start, end), insert = inserts.get(ids[a]);
    const chapter = n === 0 ? post.title : insert?.chapter ?? post.paragraphs[a].heading;
    timeline.beats.push({ id, start: boundary(start), end: boundary(end), words: spanWords, chunk: "" });
    script.beats.push({ id, ...(chapter ? { chapter } : {}), narration: spanWords.map(w => w.w).join(" "), visual: insert?.visual ?? { type: "read", paragraphs: ids.slice(a, b) } });
  });
  invariant(timeline.beats[0]?.start === 0 && timeline.beats.at(-1)?.end === aligned.total, "beats must tile the whole narration");
  return { script, timeline };
}

if (import.meta.main) {
  const run = argValue(process.argv.slice(2), "--run");
  invariant(run, "usage: PlanBeats.ts --run <slug>");
  const dir = resolveRunDir(run), paths = runPaths(dir), planPath = join(dir, "Plan.json");
  const result = planBeats(readJson<Post>(join(paths.source, "post.json")), readJson<AlignmentResult>(join(paths.narration, "words.json")), readJson<RunMeta>(paths.meta), existsSync(planPath) ? readJson<Plan>(planPath) : undefined);
  writeJson(paths.script, result.script); writeJson(paths.timeline, result.timeline);
  console.log(`✓ ${result.script.beats.length} beats tile [0, ${result.timeline.total.toFixed(3)}] with gap 0`);
}
