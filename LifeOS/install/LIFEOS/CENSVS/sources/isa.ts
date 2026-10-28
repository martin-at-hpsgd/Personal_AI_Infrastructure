/**
 * ISA frontmatter → `isa` RES, and each ISA's criteria → `criterion` RES
 * (git authority). Reads `LIFEOS/MEMORY/WORK/<dir>/ISA.md` and the system ISAs
 * at `LIFEOS/<X>/ISA.md`.
 *
 * Key: the frontmatter `slug`, else the work directory's name, else the system
 * directory lowercased. When two files claim one slug, the file whose directory
 * is named the slug keeps it (else the first by path), and every other file
 * takes its path-derived key, with the slug kept as data.slug.
 *
 * State: the frontmatter `phase`. A few older ISAs wrote a synonym for a
 * declared phase ("DONE", "building"); PHASE_WORDS maps those words and keeps
 * the original as data.sourceState. An ISA with no phase takes the isa kind's
 * draft state, flagged data.phaseMissing. Every other word is counted unmapped.
 *
 * Criteria: every `- [ ] ISC-N` / `- [x] ISC-N` line outside a code fence, keyed
 * `<isa key>/<ISC id>`, with the box as its state and the ISA as its parent. An
 * ISC id that appears again in the same ISA (a Verification list restating the
 * criteria, a retired id reused, two criteria numbered alike) is its own RES,
 * keyed `<isa key>/<ISC id>#<section>` after the `##` heading it sits under
 * (`#<section>-2`, `-3` … if that repeats too), with data.dupOf naming the first.
 * The first occurrence keeps the plain key, so no existing id moves, and a
 * repeat's key changes only when its own section changes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GENERA } from "../genera";
import type { Adapter, Sink } from "./common";
import { clip, compact, frontmatter, slugify } from "./common";

/**
 * Phase words found in existing ISAs that name a declared isa state.
 * Candidates for GENERA `stateAliases` on `isa` in a reviewed commit.
 */
export const PHASE_WORDS: Readonly<Record<string, string>> = {
  building: "build",
  executing: "execute",
  planning: "plan",
  done: "complete",
  closed: "complete",
  shipped: "complete",
  "shipped-local": "complete",
  verified: "complete",
  summit: "complete",
  abandoned: "removed",
};

/** The isa kind's state in the draft bucket: where an ISA with no phase sits. */
export function draftState(): string {
  const s = GENERA.isa.states.find((st) => GENERA.isa.bucket[st] === "draft");
  if (!s) throw new Error("GENERA: the isa kind declares no draft-bucket state");
  return s;
}

const CRITERION = /^\s*[-*] \[(.)\]\s+(~~)?\s*(?:\*\*)?(ISC-[A-Za-z0-9][A-Za-z0-9.\-]*)(?:\*\*)?(.*)$/;
const OPEN_BOXES = new Set([" ", "~", "/", "-", ">"]);
const H2 = /^##\s+(.+?)\s*#*\s*$/;

function criteria(text: string, isaKey: string, isaId: string, sink: Sink): void {
  let fenced = false;
  let section = "top";
  const taken = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = H2.exec(line);
    if (h) {
      section = slugify(h[1]) || "section";
      continue;
    }
    const m = CRITERION.exec(line);
    if (!m) continue;
    const [, box, struck, rawId, rest] = m;
    const isc = rawId.replace(/[.\-]+$/, "");
    const first = `${isaKey}/${isc}`;
    let key = first;
    if (taken.has(key)) {
      key = `${first}#${section}`;
      for (let n = 2; taken.has(key); n++) key = `${first}#${section}-${n}`;
    }
    taken.add(key);
    let state: string;
    if (struck) state = "removed";
    else if (box === "x" || box === "X") state = "passing";
    else if (OPEN_BOXES.has(box)) state = "open";
    else {
      sink.unmapped(key, `criterion box "[${box}]" is not a known mark`);
      continue;
    }
    const body = rest.replace(/^[\s*:—–-]+/, "").replace(/~~/g, "");
    sink.res(key, {
      kind: "criterion",
      key,
      title: clip(body) || isc,
      state,
      parent: isaId,
      data: compact({
        species: /^anti\b/i.test(body) ? "anti" : "isc",
        dupOf: key === first ? undefined : `criterion:${first}`,
        section: key === first ? undefined : section,
      }),
    });
  }
}

interface IsaFile {
  path: string;
  rel: string;
  /** The key when no slug is set, and the key a file falls back to when its slug is taken. */
  pathKey: string;
  alias?: string;
  text?: string;
  fm?: Record<string, string> | null;
}

function readIsa(f: IsaFile, key: string, sink: Sink): void {
  const { rel, fm, text } = f;
  if (text === undefined) {
    sink.unmapped(rel, "ISA.md cannot be read");
    return;
  }
  if (!fm) {
    sink.unmapped(rel, "ISA.md has no frontmatter");
    return;
  }
  const isaId = `isa:${key}`;
  const phase = fm.phase?.toLowerCase();
  const phaseMissing = phase === undefined || phase === "";
  const state = phaseMissing ? draftState() : (PHASE_WORDS[phase] ?? phase);
  const alias = f.alias && f.alias !== key ? f.alias : undefined;
  sink.res(rel, {
    kind: "isa",
    key,
    title: clip(fm.task) || key,
    state,
    links: fm.project ? [{ rel: "project", to: `project:${slugify(fm.project)}` }] : undefined,
    aliases: alias ? [alias] : undefined,
    data: compact({
      species: rel.includes("MEMORY/WORK/") ? "task" : "project",
      path: rel,
      slug: fm.slug && fm.slug !== key ? fm.slug : undefined,
      phaseMissing: phaseMissing ? true : undefined,
      sourceState: !phaseMissing && fm.phase !== state ? fm.phase : undefined,
      progress: fm.progress,
      started: fm.started,
      updated: fm.updated,
    }),
  });
  // Criteria resolve even when their ISA's own phase does not: their boxes are still readable.
  criteria(text, key, isaId, sink);
}

export const isa: Adapter = {
  name: "isa",
  kinds: ["isa", "criterion"],
  read(ctx, sink) {
    const { workDir, lifeosDir, root } = ctx.paths;
    const files: IsaFile[] = [];
    if (existsSync(workDir)) {
      for (const dir of readdirSync(workDir).sort()) {
        const p = join(workDir, dir, "ISA.md");
        if (existsSync(p)) files.push({ path: p, rel: relative(root, p), pathKey: dir, alias: dir });
      }
    }
    if (existsSync(lifeosDir)) {
      for (const dir of readdirSync(lifeosDir).sort()) {
        if (dir === "MEMORY" || dir === "USER") continue;
        const p = join(lifeosDir, dir, "ISA.md");
        if (existsSync(p)) files.push({ path: p, rel: relative(root, p), pathKey: dir.toLowerCase() });
      }
    }
    for (const f of files) {
      try {
        f.text = readFileSync(f.path, "utf8");
        f.fm = frontmatter(f.text);
      } catch {
        f.text = undefined;
      }
    }

    // One slug, one ISA: the file whose directory is named the slug keeps it, else the first by path.
    const wanted = new Map<string, IsaFile[]>();
    for (const f of files) {
      const k = f.fm?.slug || f.pathKey;
      (wanted.get(k) ?? wanted.set(k, []).get(k)!).push(f);
    }
    const keyOf = new Map<IsaFile, string>();
    for (const [k, group] of wanted) {
      const keeper = group.find((f) => f.pathKey === k) ?? group[0];
      for (const f of group) keyOf.set(f, f === keeper ? k : f.pathKey);
    }
    for (const f of files) readIsa(f, keyOf.get(f)!, sink);
  },
};
