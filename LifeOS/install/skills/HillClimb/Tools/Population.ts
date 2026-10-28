#!/usr/bin/env bun
/**
 * Population — the randomness and the generation record behind HillClimb's Ideate intent.
 *
 * A model asked to "pick randomly" picks the typical choice, and a comparator shuffle
 * (`sort(() => Math.random() - 0.5)`) is not uniform. Every draw Ideate needs (which proposers,
 * which far domains, which train misses a dreamer sees, which near-misses get paired, which
 * proposals get the measurement budget) comes from here: a seeded Fisher–Yates shuffle, with the
 * seed printed so a generation can be replayed.
 *
 * Usage:
 *   bun Population.ts roster [--n 6] [--preset explore|dream|directed|surgical] [--seed s] [--climb <id>] [--vendors openai,anthropic]
 *                            [--single-vendor "<reason>"] [--cases a,b,c|@file.json] [--used-domains a,b]
 *   bun Population.ts pick --from a,b,c|@file.json --k <n> [--below <p>] [--seed s]
 *   bun Population.ts pairs --from @rows.json --k <n> [--cross-origin 0.2] [--seed s]
 *   bun Population.ts allot --proposals @file.json --budget <k> [--judged id,id,...] [--random-share 0.25] [--seed s]
 *   bun Population.ts generation <climb-id> --proposals @file.json [--roster-seed s] [--off-roster "<reason>"] [--threshold 0.6] [--validate "<cmd>"] [--validate-timeout 120]
 *   bun Population.ts generation <climb-id> --void <g> --reason "<text>"
 *   bun Population.ts help | <command> --help     (prints Population.help.md; draws nothing)
 *
 * roster      proposer slots spanning the creativity bands (contemplate, daydream, dream) crossed with the vendors
 *             (two or more unless --single-vendor gives a reason), each with a persona, distinct far domains, a
 *             starting operator and, with --cases (ids, or objects with an id), the train misses it sees. One dream
 *             slot is the wildcard, given a domain this climb has not drawn before. Prints a replay block naming
 *             every input the draw depends on. With --climb the draw is appended to <climb>/ideate/draws.jsonl as the
 *             roster for the climb's next generation, and each slot carries the origin its proposals name (persona/band/vendor).
 * pick        k items drawn uniformly; --below keeps only objects whose stated probability `p` is under the
 *             cutoff (Verbalized Sampling's tail), filling from the rest only when the tail is short.
 * pairs       k distinct pairs of rows ({n, origin}) for recombination, at least --cross-origin of them
 *             joining different origins when the rows allow it.
 * allot       which proposals get measured: the judge's order fills (1 - share) of the budget and the rest, at least
 *             one slot, is drawn at random from what the judge did not pick, so judges order measurement, never
 *             decide it (share 0 is refused).
 * generation  persists one generation to <climb>/ideate/gen-NNN.json before any of it is measured, and answers
 *             diverse, narrow (fewer than three kinds: widen) or collapsed (most proposals rephrase earlier ones).
 *             Proposals are checked against the generation's recorded roster: origins must be its slots and the proposers
 *             must span its bands and vendors, unless --off-roster gives a reason. A kind outside the seven is mapped by the
 *             proposal's kind_as_proposed field beside a canonical kind. Held-out keys (test, val, screen, holdout, ci95,
 *             p value) are refused at any depth. --validate runs the target's build check per proposal and records failures
 *             (built / failed_build) instead of dropping them. --void renames a generation nothing was read from.
 *
 * Exit codes: 0 ok or diverse · 1 narrow or collapsed · 2 usage or runtime error.
 * @version 1.4.0
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { KINDS, MIN_KINDS, ledgerDir, loadClimb, loadExperiments, loadReads, normHyp, normOrigin } from "./HillClimb.ts";

// ── seeded randomness ────────────────────────────────────────────────────────

/** mulberry32 seeded from sha256(seed): deterministic per seed, uniform enough for draws. */
export function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates. Every permutation equally likely; never a comparator shuffle. */
export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const freshSeed = (): string => randomBytes(6).toString("hex");

// ── the population ───────────────────────────────────────────────────────────

export const BANDS = ["contemplate", "daydream", "dream"] as const;
export type Band = (typeof BANDS)[number];

/** What each band reads and how far it is invited to reach. Reach is an invitation, never a cap on size. */
export const BAND_SPEC: Record<Band, { reads: string; reach: string; far_domains: number; case_share: number; tail: number | null }> = {
  contemplate: { reads: "every train miss, the train-only digest, the archive and the current target", reach: "argued tightly from the train behaviours, at whatever size they call for", far_domains: 0, case_share: 1, tail: null },
  daydream: { reads: "the train-only digest, the archive, a sample of train misses and one far domain", reach: "the problem held loosely; tangents welcome", far_domains: 1, case_share: 0.5, tail: 0.3 },
  dream: { reads: "a random third of the train misses and two far domains; the goal in one line, not the current text", reach: "may replace the approach outright or break a stated constraint", far_domains: 2, case_share: 1 / 3, tail: 0.1 },
};

export const PERSONAS: Record<Band, string[]> = {
  contemplate: ["statistician", "the target's own maintainer", "reliability engineer", "editor who cuts", "test designer", "security reviewer"],
  daydream: ["ecologist", "game designer", "teacher", "operations lead from another industry", "economist", "librarian"],
  dream: ["sculptor", "jazz improviser", "slime-mould biologist", "science-fiction writer", "child who keeps asking why", "stage magician"],
};

export const DOMAINS = [
  "immunology", "ant colony foraging", "jazz improvisation", "air traffic control", "beekeeping", "chess openings",
  "supply-chain logistics", "typography", "epidemiology", "origami", "aviation checklists", "fermentation",
  "court procedure", "film editing", "restaurant kitchens", "mycology", "orbital mechanics", "card magic",
  "bridge engineering", "translation", "sports scouting", "insurance underwriting", "cartography", "evolutionary biology",
  "compiler design", "theatre rehearsal", "forestry", "urban planning", "cryptography", "music theory",
];

/** Starting lenses, from the retired Ideate mode and BeCreative's retired evolve-ideas intent. A starting point for the proposer, not a limit. */
export const OPERATORS = [
  "flip one assumption", "invert a constraint", "change the scale 10x", "change the time horizon",
  "graft in the best part of a near-miss", "apply a constraint from the far domain", "remove the most complex component",
  "add an adversarial requirement", "clone a kept change with drift",
];

export const VENDORS = ["openai", "anthropic"] as const;

/** The retired Ideate mode's presets, as the band mix of the slots beyond one per band. Every band still appears at n >= 3. */
export const PRESETS: Record<string, Record<Band, number>> = {
  explore: { contemplate: 1 / 3, daydream: 1 / 3, dream: 1 / 3 },
  dream: { contemplate: 0.1, daydream: 0.3, dream: 0.6 },
  directed: { contemplate: 0.5, daydream: 0.35, dream: 0.15 },
  surgical: { contemplate: 0.8, daydream: 0.15, dream: 0.05 },
};
function weighted(w: Record<Band, number>, r: number): Band {
  let acc = 0;
  for (const b of BANDS) { acc += w[b]; if (r < acc) return b; }
  return BANDS[BANDS.length - 1];
}

export interface Slot {
  /** `persona/band/vendor`: what a proposal from this slot names as its origin. */
  slot: number; origin: string; persona: string; band: Band; vendor: string; wildcard: boolean;
  far_domains: string[]; operator: string; reads: string; reach: string; tail: number | null; cases: string[] | null;
}
/** Everything a roster depends on. The same seed with these same inputs replays the same roster, and nothing else does. */
export interface ReplayInputs { seed: string; n: number; preset: string; vendors: string[]; cases: string[] | null; used_domains: string[]; single_vendor: string | null }
export interface Roster {
  seed: string; n: number; preset: string; slots: Slot[]; bands: Band[]; vendors: string[]; domains: string[];
  single_vendor: string | null; replay: ReplayInputs & { argv: string[] };
}

/** Minimum distinct far domains across a roster, when the slots ask for that many. */
export const MIN_DOMAINS = 3;
/** Minimum distinct vendors across a roster of two or more slots, unless a single-vendor reason is given. */
export const MIN_VENDORS = 2;

/**
 * Pure: a roster of n proposer slots, from seed plus the inputs in `replay`. Each concern draws from its own
 * stream (seed:bands, seed:personas, seed:vendors, seed:domains, seed:operators, seed:cases), so changing the
 * cases does not move the bands, and changing the used domains moves only the domains.
 *
 * Guarantees: n >= 3 gives every band; n >= 2 gives at least two vendors (refused with one vendor unless
 * `singleVendor` names a reason); bands are crossed with vendors, so each band's slots rotate through the
 * vendors from a Latin offset and n >= bands x vendors gives every band-vendor cell; far domains are distinct
 * across the roster while the pool lasts, so a roster asking for three or more far domains gets at least three.
 * The preset sets the band mix of the whole roster as far as those guarantees allow.
 */
export function drawRoster(o: { n: number; seed: string; preset?: string; vendors?: readonly string[]; cases?: string[] | null; usedDomains?: Set<string>; singleVendor?: string | null }): Roster {
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > 40) throw new Error(`--n must be an integer 1..40 (got ${o.n})`);
  const preset = o.preset ?? "explore";
  const mix = PRESETS[preset];
  if (!mix) throw new Error(`--preset must be one of ${Object.keys(PRESETS).join("|")} (got ${o.preset})`);
  const vendors = [...new Set((o.vendors ?? VENDORS).map((v) => v.trim()).filter(Boolean))];
  if (vendors.length === 0) throw new Error("--vendors is empty");
  const single = o.singleVendor?.trim() || null;
  if (o.n >= 2 && vendors.length < MIN_VENDORS && !single) throw new Error(`a roster of ${o.n} needs at least ${MIN_VENDORS} vendors (got ${vendors.join(", ")}); pass --single-vendor "<reason>" to run on one`);
  const sub = (k: string) => rng(`${o.seed}:${k}`);
  const rBands = sub("bands"), rPersona = sub("personas"), rVendor = sub("vendors"), rDomain = sub("domains"), rOp = sub("operators"), rCases = sub("cases");
  const B = BANDS.length, V = vendors.length;

  // Bands: the guaranteed cells first, then the preset's mix by deficit against its target counts.
  const bandOrder = shuffle(BANDS, rBands);
  const counts: Record<Band, number> = { contemplate: 0, daydream: 0, dream: 0 };
  const bands: Band[] = [];
  const guaranteed = o.n >= B * V ? B * V : Math.min(o.n, B);
  for (let k = 0; k < guaranteed; k++) { const b = bandOrder[k % B]; bands.push(b); counts[b]++; }
  while (bands.length < o.n) {
    const deficit = Object.fromEntries(BANDS.map((b) => [b, Math.max(0, mix[b] * o.n - counts[b])])) as Record<Band, number>;
    const total = BANDS.reduce((t, b) => t + deficit[b], 0);
    const w = total > 0 ? Object.fromEntries(BANDS.map((b) => [b, deficit[b] / total])) as Record<Band, number> : mix;
    const b = weighted(w, rBands());
    bands.push(b); counts[b]++;
  }

  // Vendors crossed with bands: band i's j-th slot gets vendor (i + j + r) mod V.
  const vendorOrder = shuffle(vendors, rVendor);
  const r0 = Math.floor(rVendor() * V);
  const seenInBand: Record<Band, number> = { contemplate: 0, daydream: 0, dream: 0 };
  const cells = bands.map((band) => {
    const i = bandOrder.indexOf(band);
    const vendor = vendorOrder[(i + seenInBand[band] + r0) % V];
    seenInBand[band]++;
    return { band, vendor };
  });
  const order = shuffle(cells.map((_, k) => k), rBands);
  const placed = order.map((k) => cells[k]);

  // Personas, domains, operators, cases: each from its own stream.
  const personaQueue: Record<Band, string[]> = { contemplate: shuffle(PERSONAS.contemplate, rPersona), daydream: shuffle(PERSONAS.daydream, rPersona), dream: shuffle(PERSONAS.dream, rPersona) };
  const used = o.usedDomains ?? new Set<string>();
  const taken = new Set<string>();
  let pool = shuffle(DOMAINS, rDomain);
  const takeDomain = (avoid: readonly string[], prefer: (d: string) => boolean = () => true): string => {
    const free = (d: string) => !taken.has(d) && !avoid.includes(d);
    let i = pool.findIndex((d) => free(d) && prefer(d));
    if (i < 0) i = pool.findIndex(free);
    if (i < 0) { pool = shuffle(DOMAINS, rDomain); taken.clear(); i = pool.findIndex((d) => !avoid.includes(d)); }
    const d = pool.splice(i, 1)[0];
    taken.add(d);
    return d;
  };
  const wildIdx = placed.findIndex((c) => c.band === "dream");
  const slots: Slot[] = placed.map(({ band, vendor }, i) => {
    const q = personaQueue[band];
    const persona = q.length ? q.shift()! : PERSONAS[band][Math.floor(rPersona() * PERSONAS[band].length)];
    const spec = BAND_SPEC[band];
    const wildcard = i === wildIdx;
    const far: string[] = [];
    if (wildcard) far.push(takeDomain(far, (d) => !used.has(d)));
    while (far.length < spec.far_domains) far.push(takeDomain(far));
    const cases = o.cases && o.cases.length ? shuffle(o.cases, rCases).slice(0, Math.max(1, Math.round(o.cases.length * spec.case_share))).sort() : null;
    return { slot: i + 1, origin: `${persona}/${band}/${vendor}`, persona, band, vendor, wildcard, far_domains: far, operator: OPERATORS[Math.floor(rOp() * OPERATORS.length)], reads: spec.reads, reach: spec.reach, tail: spec.tail, cases };
  });

  const domains = [...new Set(slots.flatMap((x) => x.far_domains))];
  const demand = slots.reduce((t, x) => t + BAND_SPEC[x.band].far_domains, 0);
  invariant(slots.length === o.n, "roster size must equal n");
  invariant(o.n < B || new Set(slots.map((x) => x.band)).size === B, "a roster of three or more spans every band");
  invariant(o.n < 2 || V < 2 || new Set(slots.map((x) => x.vendor)).size >= MIN_VENDORS, "a roster of two or more spans at least two vendors");
  invariant(domains.length >= Math.min(demand, MIN_DOMAINS, DOMAINS.length), `a roster asking for ${demand} far domains draws at least ${Math.min(demand, MIN_DOMAINS)} distinct ones`);
  if (o.n >= B * V) for (const b of BANDS) for (const v of vendors) invariant(slots.some((x) => x.band === b && x.vendor === v), `band ${b} x vendor ${v} missing from a roster of ${o.n}`);

  const replay: ReplayInputs = { seed: o.seed, n: o.n, preset, vendors, cases: o.cases && o.cases.length ? [...o.cases] : null, used_domains: [...used].sort(), single_vendor: single };
  const argv = ["roster", "--seed", o.seed, "--n", String(o.n), "--preset", preset, "--vendors", vendors.join(",")];
  if (replay.cases) argv.push("--cases", replay.cases.join(","));
  if (replay.used_domains.length) argv.push("--used-domains", replay.used_domains.join(","));
  if (single) argv.push("--single-vendor", single);
  return { seed: o.seed, n: o.n, preset, slots, bands: [...new Set(bands)], vendors: [...new Set(slots.map((x) => x.vendor))], domains, single_vendor: single, replay: { ...replay, argv } };
}

/** Pure: k items drawn uniformly. With `below`, only objects whose `p` is under it, filled from the rest only if short. */
export function pick<T>(items: readonly T[], k: number, seed: string, below?: number): { picked: T[]; from_tail: number; filled: number } {
  if (!Number.isInteger(k) || k < 0) throw new Error(`--k must be a non-negative integer (got ${k})`);
  const rnd = rng(seed);
  if (below === undefined) return { picked: shuffle(items, rnd).slice(0, k), from_tail: 0, filled: 0 };
  const pOf = (x: T): number | null => (x && typeof x === "object" && typeof (x as { p?: unknown }).p === "number" ? (x as unknown as { p: number }).p : null);
  const tail = items.filter((x) => { const p = pOf(x); return p !== null && p < below; });
  const rest = items.filter((x) => !tail.includes(x));
  const a = shuffle(tail, rnd).slice(0, k);
  const b = shuffle(rest, rnd).slice(0, k - a.length);
  return { picked: [...a, ...b], from_tail: a.length, filled: b.length };
}

export interface Row { n: number; origin: string | null }
export interface Pair { a: number; b: number; cross_origin: boolean }

/** Pure: k distinct pairs, at least ceil(k * crossShare) across origins when enough such pairs exist. */
export function drawPairs(rows: readonly Row[], k: number, seed: string, crossShare = 0.2): Pair[] {
  const all: Pair[] = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    if (rows[i].n === rows[j].n) continue;
    all.push({ a: rows[i].n, b: rows[j].n, cross_origin: (rows[i].origin ?? "") !== (rows[j].origin ?? "") });
  }
  const s = shuffle(all, rng(seed));
  const need = Math.min(Math.ceil(k * crossShare), s.filter((p) => p.cross_origin).length);
  const cross = s.filter((p) => p.cross_origin).slice(0, need);
  const out = [...cross, ...s.filter((p) => !cross.includes(p)).slice(0, Math.max(0, k - cross.length))];
  return shuffle(out, rng(seed + ":order"));
}

/** Pure: the measurement budget. The judge's order fills (1 - share); the rest is a uniform draw from what it left. */
export function allot(ids: readonly string[], budget: number, seed: string, judged: readonly string[] = [], share = 0.25): { measure: string[]; by_judge: string[]; by_draw: string[] } {
  if (!Number.isInteger(budget) || budget < 1) throw new Error(`--budget must be a positive integer (got ${budget})`);
  if (!(share > 0 && share <= 1)) throw new Error(`--random-share must be in (0, 1] (got ${share}); at 0 the judge would take the whole budget, and judges order measurement, never decide it`);
  const known = new Set(ids);
  const unknown = judged.filter((j) => !known.has(j));
  if (unknown.length) throw new Error(`--judged names ids not in the proposals: ${unknown.join(", ")}`);
  const k = Math.min(budget, ids.length);
  // At least one slot is always drawn, so the judge never takes the whole budget (a budget of 1 is all draw).
  const drawSlots = judged.length === 0 ? k : Math.min(k, Math.max(1, Math.round(k * share)));
  const by_judge = [...new Set(judged)].slice(0, k - drawSlots);
  const by_draw = shuffle(ids.filter((x) => !by_judge.includes(x)), rng(seed)).slice(0, k - by_judge.length);
  invariant(new Set([...by_judge, ...by_draw]).size === by_judge.length + by_draw.length, "allot must not measure a proposal twice");
  invariant(k === 0 || by_judge.length < k || ids.length === by_judge.length, "the judge never takes the whole measurement budget");
  return { measure: [...by_judge, ...by_draw], by_judge, by_draw };
}

// ── diversity of a generation ────────────────────────────────────────────────

const STOP = new Set("the and for with that this from into when then than are was were has have its not but all any each per use add make more less only also".split(" "));
export const tokens = (s: string): Set<string> => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface Proposal { id?: string; hypothesis: string; kind: string; kind_as_proposed?: string | null; origin: string; parents?: number[]; p?: number; [k: string]: unknown }
export type Verdict = "diverse" | "narrow" | "collapsed";
/** What a target-supplied validator said about one proposal: did it build into an applicable candidate. */
export interface BuildResult { ok: boolean; exit: number | null; stderr: string; timed_out: boolean }
export interface GenerationResult {
  generation: number; at: string; roster_seed: string | null; threshold: number;
  proposals: Array<Proposal & { nearest: string | null; similarity: number; rephrase: boolean; build?: BuildResult }>;
  kinds: string[]; rephrasings: number; verdict: Verdict; reason: string;
  /** With --validate: which proposals built (measure these) and which failed (recorded, never measured). */
  validator?: string | null; built?: string[]; failed_build?: string[];
  /** 1.4.0: the roster the proposals were checked against, what their proposers spanned, and any off-roster reason. */
  roster?: RecordedRoster | null; proposers?: ProposerSpan; off_roster?: string | null;
  /** Set on a voided generation's renamed file. */
  voided?: { at: string; reason: string };
}

/** The part of a roster a generation is checked against: every slot's origin, band and vendor. */
export interface RecordedRoster { seed: string; bands: Band[]; vendors: string[]; slots: Array<{ slot: number; origin: string; band: Band; vendor: string }> }
/** Which bands and vendors a generation's proposers covered, which roster ones they missed, and origins not on the roster. */
export interface ProposerSpan { bands: Band[]; vendors: string[]; missing_bands: Band[]; missing_vendors: string[]; off_roster_origins: string[] }

/**
 * Pure: a generation's proposers against its roster. Each proposal's origin must be a slot's origin (case and spacing
 * ignored); the slots it names must cover every band and every vendor the roster has.
 */
export function proposerSpan(props: readonly Proposal[], roster: RecordedRoster): ProposerSpan {
  const bySlot = new Map(roster.slots.map((x) => [normOrigin(x.origin), x]));
  const hits = props.map((p) => bySlot.get(normOrigin(String(p.origin ?? ""))) ?? null);
  const off = [...new Set(props.filter((_, i) => hits[i] === null).map((p) => String(p.origin)))];
  const named = hits.filter((x): x is RecordedRoster["slots"][number] => x !== null);
  const bands = BANDS.filter((b) => named.some((x) => x.band === b));
  const vendors = [...new Set(named.map((x) => x.vendor))].sort();
  return { bands, vendors, missing_bands: roster.bands.filter((b) => !bands.includes(b)), missing_vendors: roster.vendors.filter((v) => !vendors.includes(v)), off_roster_origins: off };
}

/**
 * Fields a proposal may never carry, at any depth: a generation file is proposer material and holds no
 * held-out numbers. A key is split into words (snake, kebab, dot and camel case); it is refused when a word
 * means held-out data (test, val, validation, screen, holdout, held out, ci95, p value). Measurement words
 * (value, score, delta, threshold) are refused only beside one of those (test_score, valAccuracy), so a target
 * whose own grammar uses value, score or threshold passes: a proposer never saw a held-out number to copy.
 */
const SPLIT_WORDS = new Set(["test", "tests", "val", "validation", "screen", "holdout", "holdouts", "heldout", "ci95", "pvalue", "pvalues"]);
export function heldOutKey(key: string): boolean {
  const words = key.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const pair = (a: string, b: (w: string) => boolean) => words.some((w, i) => w === a && i + 1 < words.length && b(words[i + 1]));
  return words.some((w) => SPLIT_WORDS.has(w)) || pair("held", (w) => w === "out") || pair("p", (w) => w === "value" || w === "values") || pair("ci", (w) => w === "95");
}
/** Every held-out key path in a value, at any depth (arrays included). */
export function heldOutPaths(x: unknown, path = ""): string[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => heldOutPaths(v, `${path}[${i}]`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) => [...(heldOutKey(k) ? [path ? `${path}.${k}` : k] : []), ...heldOutPaths(v, path ? `${path}.${k}` : k)]);
  return [];
}

/** Pure: judges one generation against every earlier hypothesis (experiments and earlier generations). */
export function judgeGeneration(props: readonly Proposal[], earlier: readonly string[], generation: number, threshold = 0.6, rosterSeed: string | null = null): GenerationResult {
  if (props.length === 0) throw new Error("--proposals is empty");
  props.forEach((p, i) => {
    if (typeof p.hypothesis !== "string" || !p.hypothesis.trim()) throw new Error(`proposal ${i + 1} has no hypothesis`);
    if (!(KINDS as readonly string[]).includes(p.kind)) throw new Error(`proposal ${i + 1} kind '${p.kind}' is not one of ${KINDS.join("|")}; map it: set kind to the nearest of the seven and keep the proposer's word in kind_as_proposed`);
    if (p.kind_as_proposed !== undefined && p.kind_as_proposed !== null) {
      const w = typeof p.kind_as_proposed === "string" ? p.kind_as_proposed.trim() : "";
      if (!w || /[\r\n]/.test(w)) throw new Error(`proposal ${i + 1} kind_as_proposed is one non-empty line: the proposer's own word for the kind`);
      if ((KINDS as readonly string[]).includes(w.toLowerCase())) throw new Error(`proposal ${i + 1} kind_as_proposed '${w}' is already one of the seven kinds; put it in kind`);
    }
    if (typeof p.origin !== "string" || !p.origin.trim()) throw new Error(`proposal ${i + 1} has no origin`);
    const bad = heldOutPaths(p);
    if (bad.length) throw new Error(`proposal ${i + 1} carries held-out fields (${bad.join(", ")}); a generation holds proposals only`);
  });
  const seen = earlier.map((h) => ({ h, t: tokens(h) }));
  const out = props.map((p) => {
    const t = tokens(p.hypothesis);
    let best = 0, nearest: string | null = null;
    for (const s of seen) { const j = jaccard(t, s.t); if (j > best) { best = j; nearest = s.h; } }
    seen.push({ h: p.hypothesis, t });
    return { ...p, nearest, similarity: Math.round(best * 1000) / 1000, rephrase: best >= threshold };
  });
  const kinds = [...new Set(props.map((p) => p.kind))].sort();
  const rephrasings = out.filter((p) => p.rephrase).length;
  const novel = out.length - rephrasings;
  const verdict: Verdict = rephrasings * 2 > out.length || novel < Math.min(2, out.length) ? "collapsed" : kinds.length < MIN_KINDS ? "narrow" : "diverse";
  const reason = verdict === "collapsed" ? `${rephrasings} of ${out.length} proposals rephrase earlier ones (similarity >= ${threshold}); diversity has collapsed`
    : verdict === "narrow" ? `only ${kinds.length} kind(s) (${kinds.join(", ")}); widen the next roster toward other kinds`
    : `${novel} new proposals across ${kinds.length} kinds`;
  return { generation, at: new Date().toISOString(), roster_seed: rosterSeed, threshold, proposals: out, kinds, rephrasings, verdict, reason };
}

// ── climb-scoped storage ─────────────────────────────────────────────────────

/** The climb's ideate directory, realpath-confined inside the climb's own ledger directory. */
export function ideateDir(id: string, create = true): string {
  if (!loadClimb(id)) throw new Error(`no climb ${id} in ${ledgerDir()}`);
  const climb = realpathSync(join(ledgerDir(), id));
  const dir = join(climb, "ideate");
  if (create) mkdirSync(dir, { recursive: true });
  if (existsSync(dir)) {
    const real = realpathSync(dir);
    invariant(!relative(climb, real).startsWith("..") && real !== climb, `ideate dir ${real} escapes climb ${climb}`);
  }
  return dir;
}

export function usedDomains(id: string): Set<string> {
  const f = join(ideateDir(id, false), "draws.jsonl");
  const used = new Set<string>();
  if (!existsSync(f)) return used;
  for (const l of readFileSync(f, "utf-8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as Roster;
    for (const s of r.slots ?? []) for (const d of s.far_domains ?? []) used.add(d);
  }
  return used;
}

const genFiles = (dir: string): string[] => existsSync(dir) ? readdirSync(dir).filter((f) => /^gen-\d{3}\.json$/.test(f)).sort() : [];
/** The next generation number: one past the highest live generation, so a voided last generation's number is reused. */
export const nextGeneration = (dir: string): number => genFiles(dir).reduce((m, f) => Math.max(m, Number(f.slice(4, 7))), 0) + 1;
const genFile = (dir: string, g: number) => join(dir, `gen-${String(g).padStart(3, "0")}.json`);

/**
 * The roster recorded for generation g: the latest draw in <climb>/ideate/draws.jsonl tagged with g (a draw from
 * before 1.4.0 counts when its seed is the default `<climb>:roster:<g>`), or the one with `seed` when given.
 */
export function rosterFor(id: string, g: number, seed: string | null = null): RecordedRoster | null {
  const f = join(ideateDir(id, false), "draws.jsonl");
  if (!existsSync(f)) return null;
  const rows = readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Roster & { generation?: number })
    .filter((r) => (r.generation ?? (r.seed === `${id}:roster:${g}` ? g : null)) === g)
    .filter((r) => seed === null || r.seed === seed);
  const r = rows.at(-1);
  if (!r) return null;
  const slots = (r.slots ?? []).map((x) => ({ slot: x.slot, origin: x.origin ?? `${x.persona}/${x.band}/${x.vendor}`, band: x.band, vendor: x.vendor }));
  return { seed: r.seed, bands: BANDS.filter((b) => slots.some((x) => x.band === b)), vendors: [...new Set(slots.map((x) => x.vendor))].sort(), slots };
}

/**
 * Runs the target's validator once per proposal: `sh -c <cmd>` with the proposal as JSON on stdin and in
 * $HILLCLIMB_PROPOSAL_FILE, its id in $HILLCLIMB_PROPOSAL_ID. Exit 0 means it built into an applicable candidate.
 */
export function validateProposal(cmd: string, p: Proposal, id: string, timeoutS = 120): BuildResult {
  invariant(cmd.trim().length > 0, "a validator is a non-empty command");
  const dir = mkdtempSync(join(tmpdir(), "hillclimb-validate-"));
  try {
    const file = join(dir, "proposal.json");
    writeFileSync(file, JSON.stringify(p, null, 2));
    const r = Bun.spawnSync(["sh", "-c", cmd], {
      stdin: Buffer.from(JSON.stringify(p)), stdout: "pipe", stderr: "pipe", timeout: timeoutS * 1000,
      env: { ...process.env, HILLCLIMB_PROPOSAL_FILE: file, HILLCLIMB_PROPOSAL_ID: id },
    });
    const timed_out = r.exitCode === null || (r as { signalCode?: string | null }).signalCode != null;
    const stderr = (r.stderr.toString() || r.stdout.toString()).trim().slice(-400);
    return { ok: r.exitCode === 0 && !timed_out, exit: r.exitCode, stderr: timed_out ? `timed out after ${timeoutS} s${stderr ? `: ${stderr}` : ""}` : stderr, timed_out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface GenerationOpts { threshold?: number; rosterSeed?: string | null; validate?: { cmd: string; timeoutS?: number } | null; offRoster?: string | null }

/**
 * Persists one generation. Its proposals are checked against the roster recorded for it (`roster --climb`): every
 * origin must be a slot on that roster, and the proposers must span every band and vendor the roster has. Either
 * miss, or no roster at all, is refused unless `offRoster` gives a reason, which the file records.
 */
export function recordGeneration(id: string, props: Proposal[], o: GenerationOpts = {}): GenerationResult {
  const threshold = o.threshold ?? 0.6;
  const validate = o.validate ?? null;
  const offRoster = o.offRoster?.trim() || null;
  const dir = ideateDir(id);
  const earlier = [
    ...loadExperiments(id).map((e) => e.hypothesis),
    ...genFiles(dir).flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf-8")) as GenerationResult).proposals.map((p) => p.hypothesis)),
  ];
  const n = nextGeneration(dir);
  const roster = rosterFor(id, n, o.rosterSeed ?? null);
  if (!roster && o.rosterSeed) throw new Error(`no roster with seed ${o.rosterSeed} was drawn for generation ${n}; draw it with roster --climb ${id}`);
  const res = judgeGeneration(props, earlier, n, threshold, o.rosterSeed ?? roster?.seed ?? null);
  if (!roster && !offRoster) throw new Error(`generation ${n} has no recorded roster; draw one with roster --climb ${id} before asking proposers, or pass --off-roster "<reason>"`);
  const span = roster ? proposerSpan(props, roster) : null;
  if (span && !offRoster) {
    const why = [
      span.off_roster_origins.length ? `origins not on the roster: ${span.off_roster_origins.join(", ")} (slots: ${roster!.slots.map((x) => x.origin).join(", ")})` : "",
      span.missing_bands.length ? `no proposal from band ${span.missing_bands.join(", ")}` : "",
      span.missing_vendors.length ? `no proposal from vendor ${span.missing_vendors.join(", ")}` : "",
    ].filter(Boolean);
    if (why.length) throw new Error(`generation ${n} does not match its roster (seed ${roster!.seed}): ${why.join("; ")}. Ask the missing slots, or pass --off-roster "<reason>"`);
  }
  res.roster = roster;
  res.proposers = span ?? { bands: [], vendors: [], missing_bands: [], missing_vendors: [], off_roster_origins: [...new Set(props.map((p) => String(p.origin)))] };
  res.off_roster = offRoster;
  // Every proposal gets an id, so a measurement can name it (HillClimb exp --generation n --proposal <id>).
  res.proposals = res.proposals.map((p, i) => ({ ...p, id: typeof p.id === "string" && p.id.trim() ? p.id : `g${n}p${i + 1}` }));
  if (validate) {
    // A proposal that does not build is recorded with its failure, never dropped and never measured.
    res.proposals = res.proposals.map((p) => ({ ...p, build: validateProposal(validate.cmd, p, String(p.id), validate.timeoutS ?? 120) }));
    res.validator = validate.cmd;
    res.built = res.proposals.filter((p) => p.build!.ok).map((p) => String(p.id));
    res.failed_build = res.proposals.filter((p) => !p.build!.ok).map((p) => String(p.id));
  }
  const file = genFile(dir, n);
  invariant(!existsSync(file), `generation file ${file} already exists`);
  invariant(offRoster !== null || (roster !== null && res.proposers!.off_roster_origins.length === 0 && res.proposers!.missing_bands.length === 0 && res.proposers!.missing_vendors.length === 0), "a generation on its roster names only roster slots and spans the roster's bands and vendors");
  invariant(res.proposals.every((p) => heldOutPaths(p).length === 0), "a generation file must hold no held-out field");
  invariant(!validate || res.built!.length + res.failed_build!.length === res.proposals.length, "every proposal is either built or recorded as failed");
  writeFileSync(file, JSON.stringify(res, null, 2) + "\n");
  return res;
}

/**
 * Voids generation g when nothing was screened or measured from it: no experiment row and no screen or test read
 * names it or any of its hypotheses. The file is renamed to gen-NNN.void-<reason>.json with the reason inside, so
 * it is kept and no longer counts; the next generation reuses its number when it was the last.
 */
export function voidGeneration(id: string, g: number, reason: string): { voided: string; file: string; reason: string } {
  if (!Number.isInteger(g) || g < 1) throw new Error(`--void takes a generation number (got ${g})`);
  const why = reason.trim();
  if (!why) throw new Error('--void needs --reason "<why this generation is void>"');
  const dir = ideateDir(id, false);
  const file = genFile(dir, g);
  if (!existsSync(file)) throw new Error(`climb ${id} has no live generation ${g}`);
  const gen = JSON.parse(readFileSync(file, "utf-8")) as GenerationResult;
  const hyps = new Set(gen.proposals.map((p) => normHyp(p.hypothesis)));
  const exps = loadExperiments(id).filter((e) => e.generation === g || hyps.has(normHyp(e.hypothesis)));
  const reads = loadReads(id).filter((r) => r.role !== "baseline" && r.role !== "close" && (r.generation === g || (r.hypothesis !== null && hyps.has(normHyp(r.hypothesis)))));
  if (exps.length || reads.length) {
    throw new Error(`generation ${g} cannot be voided: ${[exps.length ? `experiment(s) ${exps.map((e) => e.n).join(", ")} measured it` : "", reads.length ? `${reads.length} ${[...new Set(reads.map((r) => r.split))].join("/")} read(s) were taken from it` : ""].filter(Boolean).join("; ")}; a generation something was read from stays in the record`);
  }
  const slug = why.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "void";
  let dest = join(dir, `gen-${String(g).padStart(3, "0")}.void-${slug}.json`);
  for (let k = 2; existsSync(dest); k++) dest = join(dir, `gen-${String(g).padStart(3, "0")}.void-${slug}-${k}.json`);
  invariant(realpathSync(dirname(dest)) === realpathSync(dir), "a voided generation stays in the climb's ideate directory");
  renameSync(file, dest);
  writeFileSync(dest, JSON.stringify({ ...gen, voided: { at: new Date().toISOString(), reason: why } }, null, 2) + "\n");
  invariant(!existsSync(file) && existsSync(dest), "a voided generation is renamed, never deleted");
  return { voided: `gen-${String(g).padStart(3, "0")}`, file: dest, reason: why };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const flag = (a: string[], f: string): string | undefined => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const num = (a: string[], f: string): number | undefined => { const v = flag(a, f); if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${f} must be a number (got ${v})`); return n; };
function list(v: string | undefined, name: string): unknown[] {
  if (v === undefined) throw new Error(`${name} is required`);
  if (v.startsWith("@")) {
    const path = v.slice(1);
    let j: unknown;
    try { j = JSON.parse(readFileSync(path, "utf-8")); } catch (e) { throw new Error(`${name} ${path} is not valid JSON (${(e as Error).message.slice(0, 120)}); repair or re-request it, nothing was drawn`); }
    if (!Array.isArray(j)) throw new Error(`${path} must hold a JSON array`);
    return j;
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
/** Case ids from --cases: strings, numbers, or objects with an `id` (a run file's case rows); never "[object Object]". */
export function caseIds(rows: unknown[]): string[] {
  return rows.map((r, i) => {
    if (typeof r === "string" || typeof r === "number") return String(r);
    if (r && typeof r === "object" && (typeof (r as { id?: unknown }).id === "string" || typeof (r as { id?: unknown }).id === "number")) return String((r as { id: string | number }).id);
    throw new Error(`--cases row ${i + 1} is neither an id nor an object with an id field`);
  });
}
const HELP = join(dirname(import.meta.path), "Population.help.md");

export function main(argv: string[]): number {
  const [cmd, ...a] = argv;
  const print = (o: unknown) => console.log(JSON.stringify(o, null, 2));
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || a.includes("--help") || a.includes("-h")) {
    console.log(readFileSync(HELP, "utf-8"));
    return cmd ? 0 : 2;
  }
  try {
    switch (cmd) {
      case "roster": {
        const climb = flag(a, "--climb");
        const gNext = climb ? nextGeneration(ideateDir(climb, false)) : null;
        const seed = flag(a, "--seed") ?? (climb ? `${climb}:roster:${gNext}` : freshSeed());
        const vendors = flag(a, "--vendors")?.split(",").map((s) => s.trim()).filter(Boolean);
        const cases = flag(a, "--cases") !== undefined ? caseIds(list(flag(a, "--cases"), "--cases")) : null;
        const usedFlag = flag(a, "--used-domains")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        const used = new Set([...(climb ? usedDomains(climb) : []), ...usedFlag]);
        const single = a.includes("--single-vendor") ? flag(a, "--single-vendor") : undefined;
        if (a.includes("--single-vendor") && (!single || single.startsWith("--"))) throw new Error('--single-vendor needs a reason: --single-vendor "<why one vendor is enough here>"');
        const r = drawRoster({ n: num(a, "--n") ?? 6, seed, preset: flag(a, "--preset"), vendors, cases, usedDomains: used, singleVendor: single ?? null });
        // The draw is the roster for the next generation: Population.ts generation checks its proposals against it.
        if (climb) appendFileSync(join(ideateDir(climb), "draws.jsonl"), JSON.stringify({ at: new Date().toISOString(), generation: gNext, ...r }) + "\n");
        print(climb ? { generation: gNext, ...r } : r); return 0;
      }
      case "pick": {
        const seed = flag(a, "--seed") ?? freshSeed();
        const k = num(a, "--k"); if (k === undefined) throw new Error("--k is required");
        print({ seed, ...pick(list(flag(a, "--from"), "--from"), k, seed, num(a, "--below")) }); return 0;
      }
      case "pairs": {
        const seed = flag(a, "--seed") ?? freshSeed();
        const k = num(a, "--k"); if (k === undefined) throw new Error("--k is required");
        const rows = list(flag(a, "--from"), "--from").map((r, i) => {
          if (r && typeof r === "object" && typeof (r as Row).n === "number") return { n: (r as Row).n, origin: (r as Row).origin ?? null };
          if (typeof r === "string" && /^\d+(:.*)?$/.test(r)) { const [n, ...o] = r.split(":"); return { n: Number(n), origin: o.join(":") || null }; }
          throw new Error(`--from row ${i + 1} needs a numeric n (object {n, origin} or "n:origin")`);
        });
        print({ seed, pairs: drawPairs(rows, k, seed, num(a, "--cross-origin") ?? 0.2) }); return 0;
      }
      case "allot": {
        const seed = flag(a, "--seed") ?? freshSeed();
        const budget = num(a, "--budget"); if (budget === undefined) throw new Error("--budget is required");
        const ids = list(flag(a, "--proposals"), "--proposals").map((p, i) => typeof p === "string" ? p : String((p as Proposal).id ?? i + 1));
        const judged = flag(a, "--judged")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        print({ seed, ...allot(ids, budget, seed, judged, num(a, "--random-share") ?? 0.25) }); return 0;
      }
      case "generation": {
        const id = a[0]; if (!id || id.startsWith("--")) throw new Error("generation needs a climb id");
        if (a.includes("--void")) {
          const reason = flag(a, "--reason");
          if (!reason || reason.startsWith("--")) throw new Error('--void needs --reason "<why this generation is void>"');
          print(voidGeneration(id, Number(flag(a, "--void")), reason)); return 0;
        }
        const off = a.includes("--off-roster") ? flag(a, "--off-roster") : undefined;
        if (a.includes("--off-roster") && (!off || off.startsWith("--"))) throw new Error('--off-roster needs a reason: --off-roster "<why this generation is off its roster>"');
        const props = list(flag(a, "--proposals"), "--proposals") as Proposal[];
        const vcmd = flag(a, "--validate");
        if (a.includes("--validate") && (!vcmd || vcmd.startsWith("--"))) throw new Error('--validate needs a command: --validate "<cmd that exits 0 when the proposal builds>"');
        const r = recordGeneration(id, props, { threshold: num(a, "--threshold") ?? 0.6, rosterSeed: flag(a, "--roster-seed") ?? null, validate: vcmd ? { cmd: vcmd, timeoutS: num(a, "--validate-timeout") ?? 120 } : null, offRoster: off ?? null });
        print(r); return r.verdict === "diverse" ? 0 : 1;
      }
      default:
        console.error("usage: Population.ts roster | pick | pairs | allot | generation  (see the file header)");
        return 2;
    }
  } catch (e) {
    console.error(`Population: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
