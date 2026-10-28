/** A deterministic, read-only loader for progressively-loaded skill context. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ContextSection = { file: string; heading?: string; bodyOnly?: boolean; requires?: string[] };
export type ContextManifest = {
  version: 1;
  required: string[];
  sections: Record<string, ContextSection>;
  bundles: Record<string, string[]>;
};
export type ListedSection = { id: string; file: string; heading?: string; bodyOnly?: boolean; requires: string[] };
export type LoadedSection = ListedSection & { content: string; sha256: string };
export type SearchHit = ListedSection & { excerpt: string };

// Provenance is per load, never a persistent receipt. Existing object/JSON callers
// keep their original shape; objects not produced by this loader print in full.
const loadedRanges = new WeakMap<LoadedSection, { source: string; snapshot: string; start: number; end: number; content: string }>();

const MAX_EXCERPT = 280;
const defaultSkillsRoot = resolve(import.meta.dir, "../..", "skills");

function fail(message: string): never { throw new Error(`ContextLoad: ${message}`); }
function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) fail(`${name} must be an array of non-empty strings`);
  return value;
}
function sectionId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(`invalid section id '${id}'`);
}
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function parseManifest(raw: string, where: string): ContextManifest {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail(`invalid JSON in ${where}`); }
  if (!plainObject(value) || value.version !== 1) fail(`${where} must have version: 1`);
  const required = strings(value.required, "required");
  if (!plainObject(value.sections) || !plainObject(value.bundles)) fail(`${where} must contain sections and bundles objects`);
  const sections: Record<string, ContextSection> = Object.create(null);
  for (const [id, entry] of Object.entries(value.sections)) {
    sectionId(id);
    if (!plainObject(entry) || typeof entry.file !== "string" || !entry.file || (entry.heading !== undefined && typeof entry.heading !== "string")) fail(`invalid section '${id}'`);
    if (entry.bodyOnly !== undefined && (typeof entry.bodyOnly !== "boolean" || !entry.heading)) fail(`invalid bodyOnly in '${id}'`);
    const requires = entry.requires === undefined ? [] : strings(entry.requires, `sections.${id}.requires`);
    sections[id] = { file: entry.file, ...(entry.heading === undefined ? {} : { heading: entry.heading }), ...(entry.bodyOnly ? { bodyOnly: true } : {}), requires };
  }
  const bundles: Record<string, string[]> = Object.create(null);
  for (const [id, ids] of Object.entries(value.bundles)) { sectionId(id); bundles[id] = strings(ids, `bundles.${id}`); }
  const manifest: ContextManifest = { version: 1, required, sections, bundles };
  for (const id of [...required, ...Object.values(bundles).flat(), ...Object.values(sections).flatMap((s) => s.requires ?? [])]) {
    if (!sections[id]) fail(`unknown section '${id}' referenced by manifest`);
  }
  assertAcyclic(manifest);
  return manifest;
}

function assertAcyclic(manifest: ContextManifest): void {
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) fail(`dependency cycle at '${id}'`);
    visiting.add(id);
    for (const need of manifest.sections[id].requires ?? []) visit(need);
    visiting.delete(id); done.add(id);
  };
  for (const id of Object.keys(manifest.sections)) visit(id);
}

function skillDirectory(skill: string, skillsRoot: string): string {
  if (!/^_?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill)) fail(`invalid skill '${skill}'`);
  if (!existsSync(skillsRoot)) fail(`skills root does not exist: ${skillsRoot}`);
  const root = realpathSync(skillsRoot);
  const candidate = join(root, skill);
  if (!existsSync(candidate)) fail(`skill '${skill}' does not exist`);
  const dir = realpathSync(candidate);
  if (!isInside(dir, root) || !lstatSync(dir).isDirectory()) fail(`skill '${skill}' is outside the skills root`);
  return dir;
}

function readManifest(skill: string, skillsRoot = defaultSkillsRoot): { dir: string; manifest: ContextManifest } {
  const dir = skillDirectory(skill, skillsRoot);
  const file = join(dir, "Context.json");
  if (!existsSync(file)) fail(`missing manifest for '${skill}'`);
  if (!isInside(realpathSync(file), dir)) fail("manifest escapes its skill directory");
  return { dir, manifest: parseManifest(readFileSync(file, "utf8"), file) };
}

function safeMarkdownFile(dir: string, file: string): string {
  if (!file.endsWith(".md") || isAbsolute(file)) fail(`section file '${file}' must be a relative Markdown file`);
  const candidate = resolve(dir, file);
  if (!existsSync(candidate)) fail(`section file '${file}' does not exist`);
  const resolved = realpathSync(candidate);
  if (!isInside(resolved, dir) || !lstatSync(resolved).isFile()) fail(`section file '${file}' escapes its skill directory`);
  return resolved;
}

type MarkdownHeading = { level: number; text: string; start: number };
export function markdownHeadings(text: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [], lines = text.split(/\r?\n/);
  let fence: { char: string; count: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], count: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.count) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = lines[i].match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) out.push({ level: match[1].length, text: match[2].trim(), start: i });
  }
  return out;
}

function sectionRange(text: string, heading: string | undefined, source: string, bodyOnly = false): { start: number; end: number } {
  if (heading === undefined) return { start: 0, end: text.split(/\r?\n/).length };
  const headings = markdownHeadings(text).filter((item) => item.text === heading);
  if (headings.length === 0) fail(`heading '${heading}' is missing in ${source}`);
  if (headings.length > 1) fail(`heading '${heading}' is ambiguous in ${source}`);
  const chosen = headings[0], lines = text.split(/\r?\n/);
  const end = markdownHeadings(text).find((item) => item.start > chosen.start && (bodyOnly || item.level <= chosen.level))?.start ?? lines.length;
  return { start: chosen.start, end };
}

export function extractSection(text: string, heading: string | undefined, source: string, bodyOnly = false): string {
  const range = sectionRange(text, heading, source, bodyOnly);
  return heading === undefined ? text : text.split(/\r?\n/).slice(range.start, range.end).join("\n");
}

function details(id: string, section: ContextSection): ListedSection {
  return { id, file: section.file, ...(section.heading === undefined ? {} : { heading: section.heading }), ...(section.bodyOnly ? { bodyOnly: true } : {}), requires: section.requires ?? [] };
}

export function listSections(skill: string, skillsRoot = defaultSkillsRoot): ListedSection[] {
  const { manifest } = readManifest(skill, skillsRoot);
  return Object.entries(manifest.sections).map(([id, section]) => details(id, section));
}

export function searchSections(skill: string, query: string, skillsRoot = defaultSkillsRoot): SearchHit[] {
  if (!query.trim()) fail("search query must not be empty");
  const { dir, manifest } = readManifest(skill, skillsRoot);
  const needle = query.toLocaleLowerCase();
  const hits: SearchHit[] = [];
  for (const [id, section] of Object.entries(manifest.sections)) {
    const source = safeMarkdownFile(dir, section.file);
    const content = extractSection(readFileSync(source, "utf8"), section.heading, section.file, section.bodyOnly);
    const haystack = `${id}\n${section.heading ?? ""}\n${content}`.toLocaleLowerCase();
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    const raw = `${id}\n${section.heading ?? ""}\n${content}`.replace(/\s+/g, " ").trim();
    const contentAt = raw.toLocaleLowerCase().indexOf(needle);
    const start = Math.max(0, contentAt - Math.floor(MAX_EXCERPT / 2));
    hits.push({ ...details(id, section), excerpt: raw.slice(start, start + MAX_EXCERPT) });
  }
  return hits;
}

export function loadSections(skill: string, requested: string[], skillsRoot = defaultSkillsRoot): LoadedSection[] {
  if (requested.length === 0) fail("load needs at least one section or bundle id");
  const { dir, manifest } = readManifest(skill, skillsRoot);
  const selected: string[] = [...manifest.required];
  for (const id of requested) {
    if (manifest.sections[id]) selected.push(id);
    else if (manifest.bundles[id]) selected.push(...manifest.bundles[id]);
    else fail(`unknown section or bundle '${id}'`);
  }
  const ordered: string[] = [], added = new Set<string>();
  const add = (id: string) => {
    if (added.has(id)) return;
    for (const need of manifest.sections[id].requires ?? []) add(need);
    added.add(id); ordered.push(id);
  };
  selected.forEach(add);
  // Read and validate every selected source before returning anything.
  const snapshots = new Map<string, string>();
  return ordered.map((id) => {
    const section = manifest.sections[id], source = safeMarkdownFile(dir, section.file);
    if (!snapshots.has(source)) snapshots.set(source, readFileSync(source, "utf8"));
    const text = snapshots.get(source)!;
    const content = extractSection(text, section.heading, section.file, section.bodyOnly);
    const loaded = { ...details(id, section), content, sha256: createHash("sha256").update(content).digest("hex") };
    loadedRanges.set(loaded, { source, snapshot: text, ...sectionRange(text, section.heading, section.file, section.bodyOnly), content });
    return loaded;
  });
}

/** Preserve dependency order/provenance; emit overlapping source text only once. */
export function formatLoadedSections(sections: LoadedSection[]): string {
  const ranges = sections.map(s => {
    const range = loadedRanges.get(s);
    return range?.content === s.content ? range : undefined;
  });
  return sections.map((s, i) => {
    const range = ranges[i];
    let covering = i;
    if (range) for (let j = 0; j < sections.length; j++) {
      const candidate = ranges[j], best = ranges[covering]!;
      if (!candidate || candidate.source !== range.source || candidate.snapshot !== range.snapshot || candidate.start > range.start || candidate.end < range.end) continue;
      const size = candidate.end - candidate.start, bestSize = best.end - best.start;
      if (size > bestSize || (size === bestSize && j < covering)) covering = j;
    }
    const content = covering === i ? s.content : `Included in section: ${sections[covering].id}`;
    return `## Source: ${s.file}${s.heading ? ` — ${s.heading}` : ""}\nSection: ${s.id}; SHA256: ${s.sha256}\n\n${content}`;
  }).join("\n\n");
}

function usage(): string { return "Usage: ContextLoad.ts <Skill> list | search <query> | load <bundle-or-section> [more ids]"; }
export function runCli(args: string[], skillsRoot = defaultSkillsRoot): unknown {
  const [skill, command, ...rest] = args;
  if (!skill || !command) fail(usage());
  if (command === "list" && rest.length === 0) return { bundles: readManifest(skill, skillsRoot).manifest.bundles, sections: listSections(skill, skillsRoot) };
  if (command === "search" && rest.length === 1) return searchSections(skill, rest[0], skillsRoot);
  if (command === "load" && rest.length > 0) return loadSections(skill, rest, skillsRoot);
  fail(usage());
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const result = runCli(args);
    if (args[1] === "load") {
      const sections = result as LoadedSection[];
      const body = formatLoadedSections(sections);
      console.log(`ContextLoad: ${sections.length} sections; ${Buffer.byteLength(body)} bytes. Resolve source-relative paths against the skill root.\n\n${body}\n\nEND CONTEXTLOAD: ${sections.length} sections`);
    } else console.log(JSON.stringify(result, null, 2));
  }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
