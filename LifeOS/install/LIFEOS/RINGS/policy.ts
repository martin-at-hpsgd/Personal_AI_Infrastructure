/**
 * policy.ts — Security Rings engine (Security Rings ISA ISC-1, ISC-3, ISC-5, ISC-12).
 *
 * A ring is a trust level with one policy. Rings hold their members; nothing carries a ring
 * field. Ring 0 is the principal, Ring 1 the inner circle, Ring 2 people the principal knows,
 * Ring 3 everyone and everything else. A conversation takes the highest ring among its members,
 * and anything the engine cannot place, or any error while placing it, is Ring 3.
 *
 * The policy files are USER data (`LIFEOS/USER/SECURITY/RINGS/ring-<n>.yaml`, or
 * `LIFEOS_RINGS_DIR`). This file holds no identity; templates/ ships the empty shape.
 * (Named policy.ts, not rings.ts: macOS treats rings.ts and the Rings.ts CLI as one file.)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosUserDir } from "../TOOLS/LifeosConfig";
import { invariant } from "../TOOLS/Invariant";
import type { PersonRecord } from "../PEOPLE/types";

export type Ring = 0 | 1 | 2 | 3;
export const RINGS: readonly Ring[] = [0, 1, 2, 3];
export const OUTSIDE: Ring = 3;

/** A member names one person by every People record id that is that person. */
export type Member = { name: string; people: string[]; note?: string };
/** A member the principal named who is not yet matched to a People record; it resolves nothing. */
export type PendingMember = { name: string; note?: string };

export type RingPolicy = {
  ring: Ring;
  name: string;
  description: string;
  members: Member[];
  pending: PendingMember[];
  skills: string[];
  data: string[];
  actions: string[];
  /** What members can ask about and get answers to, and what they never get, in plain words (ISC-20). */
  answers: { can: string[]; never: string[] };
  model: Record<string, unknown>;
  caps: Record<string, unknown>;
  logging: Record<string, unknown>;
};

export const SECTIONS = ["members", "answers", "skills", "data", "actions", "model", "caps", "logging"] as const;

export function ringsDir(): string {
  return process.env.LIFEOS_RINGS_DIR || join(lifeosUserDir(), "SECURITY", "RINGS");
}

export const ringFile = (dir: string, ring: Ring) => join(dir, `ring-${ring}.yaml`);

/** Parse one ring file into its policy, reporting every missing or malformed section. */
export function parseRing(text: string, expected: Ring): { policy?: RingPolicy; errors: string[] } {
  const errors: string[] = [];
  let raw: any;
  try { raw = Bun.YAML.parse(text); } catch (e) { return { errors: [`ring-${expected}: not YAML (${String(e).slice(0, 80)})`] }; }
  if (!raw || typeof raw !== "object") return { errors: [`ring-${expected}: empty`] };
  if (raw.ring !== expected) errors.push(`ring-${expected}: ring field is ${JSON.stringify(raw.ring)}`);
  for (const s of SECTIONS) if (!(s in raw)) errors.push(`ring-${expected}: missing section ${s}`);
  const list = (k: string): any[] => {
    if (Array.isArray(raw[k])) return raw[k];
    if (raw[k] != null) errors.push(`ring-${expected}: ${k} must be a list`);
    return [];
  };
  const obj = (k: string): Record<string, unknown> => {
    if (raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k])) return raw[k];
    if (k in raw) errors.push(`ring-${expected}: ${k} must be a map`);
    return {};
  };
  const members: Member[] = [];
  for (const m of list("members")) {
    if (!m || typeof m.name !== "string" || !Array.isArray(m.people) || !m.people.length || !m.people.every((p: unknown) => typeof p === "string" && p)) {
      errors.push(`ring-${expected}: a member needs a name and at least one People id`);
      continue;
    }
    members.push({ name: m.name, people: m.people, ...(m.note ? { note: String(m.note) } : {}) });
  }
  const pending: PendingMember[] = list("pending").filter((p: any) => p && typeof p.name === "string").map((p: any) => ({ name: p.name, ...(p.note ? { note: String(p.note) } : {}) }));
  const strings = (k: string) => list(k).filter((x: unknown) => typeof x === "string") as string[];
  const ans = obj("answers");
  const answerList = (k: "can" | "never"): string[] => {
    const v = ans[k];
    if (Array.isArray(v) && v.every(x => typeof x === "string")) return v as string[];
    if ("answers" in raw) errors.push(`ring-${expected}: answers.${k} must be a list of plain sentences`);
    return [];
  };
  return {
    errors,
    policy: {
      ring: expected, name: String(raw.name ?? `Ring ${expected}`), description: String(raw.description ?? ""),
      members, pending, answers: { can: answerList("can"), never: answerList("never") }, skills: strings("skills"), data: strings("data"), actions: strings("actions"),
      model: obj("model"), caps: obj("caps"), logging: obj("logging"),
    },
  };
}

/** Every ring file, validated together: all four present, every section, no person in two rings. */
export function loadRings(dir = ringsDir()): { rings: RingPolicy[]; errors: string[] } {
  const errors: string[] = [];
  const rings: RingPolicy[] = [];
  for (const r of RINGS) {
    const file = ringFile(dir, r);
    if (!existsSync(file)) { errors.push(`ring-${r}: no file at ${file}`); continue; }
    const { policy, errors: e } = parseRing(readFileSync(file, "utf8"), r);
    errors.push(...e);
    if (policy) rings.push(policy);
  }
  const seen = new Map<string, Ring>();
  for (const p of rings) for (const m of p.members) for (const id of m.people) {
    const prior = seen.get(id);
    if (prior !== undefined && prior !== p.ring) errors.push(`${id} is listed in ring ${prior} and ring ${p.ring}`);
    seen.set(id, p.ring);
  }
  if (rings.find(p => p.ring === 0)?.members.length === 0) errors.push("ring-0: the principal must be a member");
  if (rings.find(p => p.ring === 3)?.members.length) errors.push("ring-3: lists no members; it is everything not in another ring");
  return { rings, errors };
}

/** Rings that loaded clean, or a throw: callers treat a throw as Ring 3 for everyone (ISC-12). */
export function loadValidRings(dir = ringsDir()): RingPolicy[] {
  const { rings, errors } = loadRings(dir);
  if (errors.length) throw new Error(`security rings invalid: ${errors.join("; ")}`);
  invariant(rings.length === RINGS.length, "every ring loaded");
  return rings;
}

export function ringOfPerson(id: string, rings: RingPolicy[]): Ring {
  for (const p of rings) if (p.members.some(m => m.people.includes(id))) return p.ring;
  return OUTSIDE;
}

/** A phone in E.164, or an email lowercased; anything else unchanged. */
export function normalizeHandle(h: string): string {
  const t = h.trim();
  if (t.includes("@")) return t.toLowerCase().replace(/^mailto:/, "");
  let d = t.replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  return d ? "+" + d : t;
}

export function handlesOf(r: PersonRecord): string[] {
  return [...(r.phones ?? []), ...(r.emails ?? [])].map(normalizeHandle);
}

/**
 * The ring a handle belongs to: every People record carrying that handle is found, and the
 * highest ring among them wins, so a handle shared by two people never gains trust. A handle
 * with no record is Ring 3.
 */
export function ringOfHandle(handle: string, rings: RingPolicy[], records: PersonRecord[]): Ring {
  const n = normalizeHandle(handle);
  const hits = records.filter(r => handlesOf(r).includes(n));
  if (!hits.length) return OUTSIDE;
  return Math.max(...hits.map(r => ringOfPerson(r.id, rings))) as Ring;
}

/** A conversation's ring: the highest ring among its members; no members, or any error, is Ring 3. */
export function conversationRing(handles: string[], load: () => { rings: RingPolicy[]; records: PersonRecord[] }): Ring {
  try {
    if (!handles.length) return OUTSIDE;
    const { rings, records } = load();
    return Math.max(...handles.map(h => ringOfHandle(h, rings, records))) as Ring;
  } catch {
    return OUTSIDE;
  }
}

/** Every handle of every member of one ring, normalized and deduped. */
export function ringHandles(ring: Ring, rings: RingPolicy[], records: PersonRecord[]): string[] {
  const ids = new Set(rings.find(p => p.ring === ring)?.members.flatMap(m => m.people) ?? []);
  return [...new Set(records.filter(r => ids.has(r.id)).flatMap(handlesOf))].sort();
}

/** Member ids in a ring file that match no People record: a typo, or a record that was merged away. */
export function unknownIds(rings: RingPolicy[], records: PersonRecord[]): { ring: Ring; name: string; id: string }[] {
  const known = new Set(records.map(r => r.id));
  return rings.flatMap(p => p.members.flatMap(m => m.people.filter(id => !known.has(id)).map(id => ({ ring: p.ring, name: m.name, id }))));
}
