/**
 * Shared shapes for the resolver's source adapters (CENSVS ISA F7).
 *
 * An adapter reads one existing store, read-only, and hands the resolver a
 * draft per record: the RES kind, its key, its title and the store's own state
 * word. The resolver builds the RES, checks it against GENERA, and counts every
 * record that cannot become one. Adapters never write, never call a CLI that
 * writes, and never put personal content (email, phone) in a key or example.
 */
import type { Authority, KindClass } from "../genera";

export interface Link {
  rel: string;
  to: string;
}

/** One object of a registered kind: the shape every LifeOS noun resolves to. */
export interface Res {
  id: string;
  kind: string;
  title: string;
  state?: string;
  parent?: string;
  links?: Link[];
  class: KindClass;
  authority: Authority;
  data?: Record<string, unknown>;
  aliases?: string[];
}

/** What an adapter proposes for one source record. */
export interface Draft {
  kind: string;
  key: string;
  title: string;
  /** The store's own state word; the resolver maps it to a declared state or counts the record unmapped. */
  state?: string;
  parent?: string;
  links?: Link[];
  data?: Record<string, unknown>;
  aliases?: string[];
}

export interface SourcePaths {
  root: string;
  atlasDb: string;
  upgradesDir: string;
  errataDir: string;
  errataTenantDir: string;
  socratesDir: string;
  achillesRegistry: string;
  peopleDir: string;
  workflowsDir: string;
  skillsDir: string;
  hooksDir: string;
  settingsFile: string;
  workDir: string;
  lifeosDir: string;
}

export interface Ctx {
  paths: SourcePaths;
  now: Date;
}

export interface Sink {
  /** Propose a RES. Returns its id when accepted (new or merged), null when counted unmapped. */
  res(recordId: string, draft: Draft): string | null;
  /** Count a source record that cannot become a RES. `recordId` must carry no personal content. */
  unmapped(recordId: string, reason: string): void;
  /** Count records left out by a named policy (a decision, not a gap). Also reported under `excluded`. */
  skipped(label: string, reason: string, n?: number): void;
  /**
   * Leave one record out by a named rule: it is not a noun of any kind (a harness
   * cache under skills/, say), so it is reported under `excluded`, never as unmapped.
   * `recordId` must carry no personal content.
   */
  excluded(recordId: string, reason: string): void;
  /** Add a link to an accepted RES. */
  link(fromId: string, link: Link): void;
}

export interface Adapter {
  name: string;
  /** The RES kinds this adapter can produce (resolveOne reads only the adapters that can hold an id). */
  kinds: readonly string[];
  read(ctx: Ctx, sink: Sink): void;
}

/** One line, at most `n` characters. */
export function clip(s: unknown, n = 160): string {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** "Acme Corp, Inc." → "acme-corp-inc". */
export function slugify(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Flat `key: value` frontmatter between the opening `---` fences; quotes stripped. Nested values are ignored. */
export function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv || kv[1] in fm) continue;
    fm[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return fm;
}

/** Run `fn` with env vars set, restoring them after, so a store module reads a chosen directory. */
export function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Drop undefined and null values so a RES's data carries only what the source said. */
export function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}
