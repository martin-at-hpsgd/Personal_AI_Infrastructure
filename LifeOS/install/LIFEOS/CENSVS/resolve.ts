#!/usr/bin/env bun
/**
 * The read-only resolver (CENSVS ISA F7, ISC-37..ISC-39): maps every record in
 * the stores LifeOS already keeps to a RES, without writing anything, and
 * counts every record it cannot map. It is GENERA's acceptance test: a noun the
 * registry has no kind for shows up here as an unmapped count.
 *
 * Sources (one adapter each, in LIFEOS/CENSVS/sources/): skills, hooks,
 * workflow definitions, ISA frontmatter and criteria, Upgrades, Errata,
 * Socrates, Achilles, People, Atlas. Git-authority sources run first, so when
 * Atlas observes a noun a git source already names (a workflow), the RES keeps
 * the git source's fields and records both in data.seenBy.
 *
 * Every RES is checked here, not in the adapters: its kind must be in GENERA,
 * its id must pass validSubject (grammar, no personal content, opaque keys for
 * personal kinds), and its state must be a declared state of its kind (or an
 * alias GENERA declares). Two records of one source with the same id are a
 * collision and the second is counted unmapped.
 *
 * A record that is not a noun of any kind is excluded by a named rule, never
 * counted unmapped: `excluded` reports each source's exclusions with reasons
 * (adapters' per-record rules plus every policy `skipped` label), so a zero
 * `unmappedTotal` means every record is a RES or excluded by a named rule.
 *
 *   bun LIFEOS/CENSVS/resolve.ts [--json] [--full] [--source <name>]...
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.1.0
 */
import { resolve as resolvePath, join } from "node:path";
import { DB_PATH } from "../ATLAS/Store";
import { ERRATA_DIR, ERRATA_TENANT_DIR } from "../ERRATA/Store";
import { peopleDir } from "../PEOPLE/store";
import { QUESTIONS_DIR } from "../SOCRATES/Registry";
import { registryPath } from "../TOOLS/Achilles";
import { getClaudeDir, getLifeosDir } from "../TOOLS/Paths";
import { GENERA, canonicalState, isKind, parseSubject, validSubject } from "./genera";
import { achilles } from "./sources/achilles";
import { atlas } from "./sources/atlas";
import type { Adapter, Ctx, Draft, Link, Res, Sink, SourcePaths } from "./sources/common";
import { errata } from "./sources/errata";
import { hooks } from "./sources/hooks";
import { isa } from "./sources/isa";
import { people } from "./sources/people";
import { skills } from "./sources/skills";
import { socrates } from "./sources/socrates";
import { upgrades } from "./sources/upgrades";
import { workflows } from "./sources/workflows";

export type { Link, Res, SourcePaths } from "./sources/common";

/** Git-authority sources first, then the record stores, then Atlas's observations. */
const ADAPTERS: readonly Adapter[] = [skills, hooks, workflows, isa, upgrades, errata, socrates, achilles, people, atlas];
export const SOURCE_NAMES = ["skills", "hooks", "workflows", "isa", "upgrades", "errata", "socrates", "achilles", "people", "atlas"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface ResolveOpts {
  /** The LifeOS install root (~/.claude). Defaults to the live one. */
  root?: string;
  /** Only these sources. Defaults to all. */
  sources?: readonly string[];
  /** Override any store path. */
  paths?: Partial<SourcePaths>;
  /** The clock used for age-based states (person active vs dormant). */
  now?: Date;
}

export interface Unmapped {
  count: number;
  /** Up to 5 source record ids, never personal content. */
  examples: string[];
  /** reason → count. */
  reasons: Record<string, number>;
}

export interface ResolveResult {
  res: Res[];
  unmapped: Record<string, Unmapped>;
  unmappedTotal: number;
  /** RES accepted per source (merges included). */
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  /** Records left out by a named policy: source → label → count and reason. Not counted as unmapped. */
  skipped: Record<string, Record<string, { count: number; reason: string }>>;
  /**
   * Every record left out by a named rule, per source: per-record exclusions plus
   * every `skipped` label (reason "<label>: <why>"). Distinct from `unmapped`, so
   * unmappedTotal 0 means each record became a RES or was excluded by a named rule.
   */
  excluded: Record<string, Unmapped>;
  excludedTotal: number;
  /** Source read failures (the source is also counted once in unmapped). */
  errors: Record<string, string>;
  /** RES named by a second source and merged into the first. */
  merged: number;
  /** Aliases claimed by more than one RES (dropped from all of them). */
  aliasConflicts: number;
  /** Links and parents that point at an id no source produced. */
  danglingLinks: number;
}

/** Store paths for an install root; the live root reads each store from the path its own module uses. */
export function defaultPaths(root?: string): SourcePaths {
  const live = getClaudeDir();
  const r = root ?? live;
  const isLive = resolvePath(r) === resolvePath(live);
  return {
    root: r,
    atlasDb: isLive ? DB_PATH : join(r, "atlas.db"),
    upgradesDir: isLive
      ? process.env.LIFEOS_UPGRADES_DIR || join(getLifeosDir(), "MEMORY", "UPGRADES")
      : join(r, "LIFEOS/MEMORY/UPGRADES"),
    errataDir: isLive ? ERRATA_DIR : join(r, "LIFEOS/USER/ERRATA"),
    errataTenantDir: isLive ? ERRATA_TENANT_DIR : join(r, "LIFEOS/USER/ERRATA/tenants"),
    socratesDir: isLive ? QUESTIONS_DIR : join(r, "LIFEOS/USER/SOCRATES/questions"),
    achillesRegistry: isLive ? registryPath() : join(r, "LIFEOS/USER/SECURITY/ACHILLES/registry.json"),
    peopleDir: isLive ? peopleDir() : join(r, "LIFEOS/USER/CONTACTS"),
    workflowsDir: join(r, "LIFEOS/USER/WORKFLOWS"),
    skillsDir: join(r, "skills"),
    hooksDir: join(r, "hooks"),
    settingsFile: join(r, "settings.json"),
    workDir: join(r, "LIFEOS/MEMORY/WORK"),
    lifeosDir: join(r, "LIFEOS"),
  };
}

/** Map every record in the chosen sources to RES. Reads only. */
export function resolveAll(opts: ResolveOpts = {}): ResolveResult {
  const ctx: Ctx = { paths: { ...defaultPaths(opts.root), ...opts.paths }, now: opts.now ?? new Date() };
  const wanted = opts.sources ? new Set(opts.sources) : null;
  for (const s of wanted ?? []) if (!ADAPTERS.some((a) => a.name === s)) throw new Error(`unknown source "${s}"`);

  const out: ResolveResult = {
    res: [],
    unmapped: {},
    unmappedTotal: 0,
    bySource: {},
    byKind: {},
    skipped: {},
    excluded: {},
    excludedTotal: 0,
    errors: {},
    merged: 0,
    aliasConflicts: 0,
    danglingLinks: 0,
  };
  const byId = new Map<string, Res>();
  const ownerOf = new Map<string, string>();

  for (const adapter of ADAPTERS) {
    if (wanted && !wanted.has(adapter.name)) continue;
    const name = adapter.name;
    out.bySource[name] = 0;

    const unmapped = (recordId: string, reason: string) => {
      const u = (out.unmapped[name] ??= { count: 0, examples: [], reasons: {} });
      u.count++;
      if (u.examples.length < 5) u.examples.push(recordId);
      u.reasons[reason] = (u.reasons[reason] ?? 0) + 1;
      out.unmappedTotal++;
    };

    const exclude = (recordId: string | null, reason: string, n: number) => {
      const e = (out.excluded[name] ??= { count: 0, examples: [], reasons: {} });
      e.count += n;
      if (recordId !== null && e.examples.length < 5) e.examples.push(recordId);
      e.reasons[reason] = (e.reasons[reason] ?? 0) + n;
      out.excludedTotal += n;
    };

    const sink: Sink = {
      res(recordId: string, d: Draft): string | null {
        if (!isKind(d.kind)) {
          unmapped(recordId, `kind "${d.kind}" is not in GENERA`);
          return null;
        }
        const id = `${d.kind}:${d.key}`;
        const why = validSubject(id);
        if (why) {
          unmapped(recordId, why);
          return null;
        }
        let state: string | undefined;
        if (d.state !== undefined) {
          const c = canonicalState(d.kind, d.state);
          if (c === null) {
            unmapped(recordId, `${d.kind} state "${d.state}" is not declared in GENERA`);
            return null;
          }
          state = c;
        }
        const data: Record<string, unknown> = { ...(d.data ?? {}), source: name };
        if (d.state !== undefined && state !== d.state && data.sourceState === undefined) data.sourceState = d.state;

        const prev = byId.get(id);
        if (prev) {
          if (ownerOf.get(id) === name) {
            unmapped(recordId, `id collides with another ${name} record`);
            return null;
          }
          // A second source naming the same noun: keep the first source's fields, add what it lacks.
          const pd = (prev.data ??= {});
          const seen = Array.isArray(pd.seenBy) ? (pd.seenBy as string[]) : [];
          if (!seen.includes(name)) seen.push(name);
          pd.seenBy = seen;
          for (const [k, v] of Object.entries(data)) if (!(k in pd) && k !== "source") pd[k] = v;
          for (const l of d.links ?? []) sink.link(id, l);
          if (d.aliases?.length) prev.aliases = [...new Set([...(prev.aliases ?? []), ...d.aliases])];
          out.merged++;
          out.bySource[name]++;
          return id;
        }

        const def = GENERA[d.kind];
        data.seenBy = [name];
        const r: Res = {
          id,
          kind: d.kind,
          title: d.title || id,
          ...(state !== undefined ? { state } : {}),
          ...(d.parent ? { parent: d.parent } : {}),
          ...(d.links?.length ? { links: dedupeLinks(d.links) } : {}),
          class: def.class,
          authority: def.authority,
          data,
          ...(d.aliases?.length ? { aliases: [...new Set(d.aliases)] } : {}),
        };
        byId.set(id, r);
        ownerOf.set(id, name);
        out.bySource[name]++;
        return id;
      },
      unmapped,
      skipped(label: string, reason: string, n = 1) {
        const s = (out.skipped[name] ??= {});
        const e = (s[label] ??= { count: 0, reason });
        e.count += n;
        exclude(null, `${label}: ${reason}`, n);
      },
      excluded(recordId: string, reason: string) {
        exclude(recordId, reason, 1);
      },
      link(fromId: string, link: Link) {
        const r = byId.get(fromId);
        if (!r) return;
        const links = (r.links ??= []);
        if (!links.some((l) => l.rel === link.rel && l.to === link.to)) links.push(link);
      },
    };

    try {
      adapter.read(ctx, sink);
    } catch (e) {
      out.errors[name] = (e as Error).message;
      unmapped("(source read failed)", `source read failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  // Aliases resolve to exactly one RES: an alias claimed twice, or equal to a RES id, is dropped everywhere.
  const aliasOwners = new Map<string, Set<string>>();
  for (const r of byId.values()) for (const a of r.aliases ?? []) (aliasOwners.get(a) ?? aliasOwners.set(a, new Set()).get(a)!).add(r.id);
  for (const [alias, owners] of aliasOwners) {
    if (owners.size === 1 && !byId.has(alias)) continue;
    out.aliasConflicts++;
    for (const id of owners) {
      const r = byId.get(id)!;
      r.aliases = r.aliases!.filter((a) => a !== alias);
      if (!r.aliases.length) delete r.aliases;
    }
  }

  for (const r of byId.values()) {
    out.byKind[r.kind] = (out.byKind[r.kind] ?? 0) + 1;
    if (r.parent && !byId.has(r.parent)) out.danglingLinks++;
    for (const l of r.links ?? []) if (!byId.has(l.to)) out.danglingLinks++;
  }
  out.res = [...byId.values()];
  return out;
}

function dedupeLinks(links: Link[]): Link[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.rel}\u0000${l.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * One RES by id or alias, or null. An id whose kind is registered reads only the
 * sources that can produce that kind; anything else (an alias) reads them all.
 */
export function resolveOne(id: string, opts: ResolveOpts = {}): Res | null {
  const p = parseSubject(id);
  const sources = p && isKind(p.kind) ? ADAPTERS.filter((a) => a.kinds.includes(p.kind)).map((a) => a.name) : [];
  const scoped = sources.length ? sources.filter((s) => !opts.sources || opts.sources.includes(s)) : opts.sources;
  const { res } = resolveAll({ ...opts, sources: scoped });
  return res.find((r) => r.id === id) ?? res.find((r) => r.aliases?.includes(id)) ?? null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sources = args.flatMap((a, i) => (args[i - 1] === "--source" ? [a] : []));
  const out = resolveAll(sources.length ? { sources } : {});
  const { res, ...summary } = out;
  if (args.includes("--json")) {
    console.log(JSON.stringify(args.includes("--full") ? out : { ...summary, resTotal: res.length }, null, 2));
  } else {
    console.log(`RES resolved: ${res.length} · unmapped: ${out.unmappedTotal} · excluded: ${out.excludedTotal} · merged: ${out.merged}`);
    for (const s of Object.keys(out.bySource)) {
      const u = out.unmapped[s];
      console.log(`  ${s.padEnd(10)} ${String(out.bySource[s]).padStart(6)} RES${u ? `   ${u.count} unmapped (${Object.keys(u.reasons).join("; ")})` : ""}`);
    }
    for (const [s, e] of Object.entries(out.excluded))
      for (const [why, n] of Object.entries(e.reasons)) console.log(`  excluded ${s}: ${n} (${why})`);
  }
}
