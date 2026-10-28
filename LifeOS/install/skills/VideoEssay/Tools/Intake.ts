#!/usr/bin/env bun
/**
 * Intake.ts — create a run and pull its source.
 *
 *   bun Intake.ts --run <slug> --youtube <url> [--title "..."] [--notes <file>]
 *   bun Intake.ts --run <slug> --url <url>
 *   bun Intake.ts --run <slug> --file <path>
 *
 * Writes <run>/run.json, Source/transcript.txt, Source/source.json, and copies the
 * user's notes (a stance, bullet points, anything) to Source/notes.md.
 * YouTube goes through `fabric -y` (transcript) and `yt-dlp` (metadata); the run
 * directory is created under the runs root, never inside a git repo.
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { argValue, ensureDir, resolveRunDir, runPaths, writeJson, type RunMeta } from "./Lib.ts";

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-300)}`);
  return out;
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  invariant(runArg, "usage: Intake.ts --run <slug> (--youtube <url> | --url <url> | --file <path>) [--title t] [--notes f]");
  const dir = resolveRunDir(runArg);
  const paths = runPaths(dir);
  ensureDir(paths.source);
  const yt = argValue(argv, "--youtube");
  const url = argValue(argv, "--url");
  const file = argValue(argv, "--file");
  let source: RunMeta["source"] = { url: yt ?? url ?? `file://${file}` };
  let transcript = "";
  if (yt) {
    const meta = (await sh(["yt-dlp", "--skip-download", "--print", "%(title)s\t%(channel)s\t%(id)s", yt])).trim().split("\t");
    source = { url: yt, title: meta[0], author: meta[1] };
    transcript = await sh(["fabric", "-y", yt]);
    writeJson(join(paths.source, "source.json"), { ...source, videoId: meta[2] });
  } else if (url) {
    const r = await fetch(url, { headers: { "User-Agent": "LifeOS-VideoEssay/1.0 (page intake)" } });
    invariant(r.ok, `fetch ${url} → ${r.status}`);
    const html = await r.text();
    source = { url, title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? url };
    transcript = stripHtml(html);
    writeJson(join(paths.source, "source.json"), source);
  } else if (file) {
    invariant(existsSync(file), `file missing: ${file}`);
    transcript = await Bun.file(file).text();
    writeJson(join(paths.source, "source.json"), source);
  } else {
    throw new Error("one of --youtube, --url, --file is required");
  }
  invariant(transcript.trim().split(/\s+/).length > 50, "source produced under 50 words; nothing to argue with");
  writeFileSync(paths.transcript, transcript);
  const notes = argValue(argv, "--notes");
  if (notes) copyFileSync(notes, join(paths.source, "notes.md"));
  const meta: RunMeta = { slug: runArg.split("/").pop()!, title: argValue(argv, "--title") ?? source.title ?? runArg, source, createdAt: new Date().toISOString() };
  writeJson(paths.meta, meta);
  console.log(`✓ run ${dir}\n  ${transcript.trim().split(/\s+/).length} words in Source/transcript.txt`);
}
