/**
 * GENERA — the closed registry of RES kinds (CENSVS ISA F2, ISC-7..ISC-12).
 *
 * A RES is one object of any kind LifeOS owns or watches; its id is
 * `<kind>:<key>` and its kind must be a key of GENERA. Each entry declares
 * where the kind's truth lives (authority), its default privacy class, its id
 * scheme, its states and allowed moves, the bucket each state reads as, its
 * data schema version and its owner. The registry is frozen: a new kind lands
 * only in a reviewed commit to this file; private skills add species, never
 * kinds.
 *
 * Moves on `observed` kinds are the full graph over their states: an observer
 * reports what it saw, and refusing that would discard the truth. Every
 * observed kind carries Atlas's `active`/`stale`/`expired` so Atlas rows map
 * one to one; its extra states are what tell it apart from its neighbours.
 *
 * Keys (ISC-12, ISC-60). A RES id never carries a person's name, so the key
 * scheme is the guard, not a list of bad words:
 *  - a kind whose key could name a person (person, place, org, account) or
 *    comes from free text (source, piece, media, note) takes a minted opaque
 *    key and nothing else;
 *  - every other kind declares a key grammar, an allowlist (KEY_GRAMMARS), and
 *    a key outside its kind's grammar is refused;
 *  - a natural key whose tokens (split on - _ . @ / : and CamelCase) hold a
 *    first name followed by a surname from the People store's contacts is
 *    refused. The names are read from the People store when it is present,
 *    again only when its file changes, and never written into this registry.
 * Email and phone shapes are refused on every key; a YYYYMMDD-HHMMSS stamp is
 * a time, never a phone number.
 *
 * STATVS core mirrors the kind list, key schemes and grammars for the Worker
 * (LIFEOS/STATVS/core/lib/subject.ts); tests hold the two identical.
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md
 * @version 1.1.0
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosUserDir } from "../TOOLS/LifeosConfig";

export type Authority = "record" | "git" | "observed";
export type Bucket = "draft" | "open" | "active" | "closed" | "gone";
export type KindClass = "public" | "system" | "personal";

export const GROUPS = ["Aims", "Work", "Execution", "Machinery", "Estate", "People and world", "Knowledge"] as const;
export type Group = (typeof GROUPS)[number];
export const BUCKETS: readonly Bucket[] = ["draft", "open", "active", "closed", "gone"];
export const OPS = ["create", "set", "move", "link", "unlink", "observe", "retire"] as const;
export type Op = (typeof OPS)[number];

/**
 * The key grammars a natural kind may declare: each an allowlist of what a key of that kind looks like.
 * Mirrored source for source in LIFEOS/STATVS/core/lib/subject.ts (KEY_GRAMMARS); tests/genera.test.ts holds them equal.
 */
export const KEY_GRAMMARS = Object.freeze({
  /** A lowercase code name: workflow, project, control, followup. */
  slug: /^[a-z0-9][a-z0-9_-]*$/,
  /** A lowercase dotted or namespaced name: app, service, machine, store (`cloudflare:worker:pulse`, `com.lifeos.x`). */
  dotted: /^[a-z0-9][a-z0-9._:-]*$/,
  /** A code identifier: skill, hook, agent, tool (private maintenance tooling (not included), `BitterLessonEngineering`, `claude-code`). */
  code: /^_?[A-Za-z][A-Za-z0-9_-]*$/,
  /** An ISA directory name: `censvs`, `20261018-censvs`, `20260427-013401_slug`. */
  isa: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /** An ISA name, then the criterion's id: `20261018-censvs/ISC-12`, `x/ISC-1#decisions`. */
  criterion: /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Z][A-Za-z0-9._#-]*$/,
  /** A short reference id: `G1`, `r1`, `AD-12`, `R-001`. */
  ref: /^[A-Za-z]{1,6}-?\d{1,6}$/,
  /** A reference id, optionally scoped by the ISA it sits in: `AD-12`, `20261018-censvs/D-3`. */
  scoped_ref: /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z]{1,6}-?\d{1,6}$/,
  /** An Errata id: `ERR-20260117-202018-7810`. */
  errata: /^ERR-\d{1,8}(?:-\d{6})?(?:-[0-9a-z]{1,12})?$/,
  /** An Achilles id: `ACH-` and up to six digits. */
  achilles: /^ACH-\d{1,6}$/,
  /** A Socrates id: `SOC-` and up to six digits. */
  socrates: /^SOC-\d{1,6}$/,
  /** An Upgrades id (`20261018-071621_slug-4ca448`), a minted or short slug, or a reference id (`IS-0001`). */
  proposal: /^(?:[a-z0-9][a-z0-9_-]*|[A-Z]{1,6}-\d{1,6})$/,
  /** A hostname, wildcard and underscore labels included: `example.org`, `_dmarc.example.org`, `*.example.org`. */
  hostname: /^(?:\*\.)?[a-z0-9_][a-z0-9_-]*(?:\.[a-z0-9_][a-z0-9_-]*)+$/,
  /** A DNS record: zone, type, name (`dns:example.org/CNAME/www.example.org`, `example.org:A:www`). */
  dns: /^(?:dns:)?[a-z0-9][a-z0-9._-]*[/:][A-Z]{1,10}[/:][a-z0-9_*@][a-z0-9._*-]*$/,
  /** A repository: host, optional type, owner/name (`github:repo:owner/Name`). */
  repo: /^[a-z0-9-]+:(?:[a-z]+:)?[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._-]+$/,
  /** A model: vendor, then the vendor's id (`anthropic:claude-haiku-4-5`, `replicate:google/nano-banana`). */
  model: /^[a-z0-9][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._@/:-]*$/,
  /** A credential's name, never its value: `CLOUDFLARE_API_TOKEN`, `cf-master`. */
  env: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  /** A machine-issued id: a UUID, a stamp, a minted run id (`3f1c2a9e-…`, `2026-10-17T05:00:00Z`). */
  id: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
  /** A release: name, then a semantic version (`lifeos@8.439.0`, `vector:2.13.1`). */
  release: /^[a-z0-9][a-z0-9._-]*[@:]v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
} as const);
export type GrammarName = keyof typeof KEY_GRAMMARS;

export interface KindDef {
  group: Group;
  authority: Authority;
  class: KindClass;
  key: "natural" | "opaque";
  /** A natural kind's key grammar (KEY_GRAMMARS); an opaque kind has none, its key is OPAQUE_KEY_RE. */
  grammar?: GrammarName;
  states: string[];
  moves: Record<string, string[]>;
  bucket: Record<string, Bucket>;
  species?: string[];
  schema: number;
  owner: string;
  /** Field names this kind's writers may set; omitted means any. */
  fields?: string[];
  /** field → writer prefixes allowed to set it. A set by any other writer is flagged by the fold, never applied. */
  fieldOwners?: Record<string, string[]>;
  /** "from>to" moves that require a principal writer. */
  principalMoves?: string[];
  /** Words an existing store writes for a state, mapped to the state's name here (e.g. Upgrades' `recommended`). */
  stateAliases?: Record<string, string>;
}

/** Kind and species names that may never exist: RES never holds customer, tenant or secret-value content. */
export const FORBIDDEN_NAME = /customer|tenant|secret/i;

/** A minted opaque key: up to two letters, then 5-40 lowercase hex characters, with at least one digit. */
export const OPAQUE_KEY_RE = /^(?=[a-z0-9]*\d)[a-z]{0,2}[0-9a-f]{5,40}$/;

const KIND_RE = /^[a-z_]+$/;
const STATE_RE = /^[a-z][a-z_-]*$/;
const SPECIES_RE = /^[a-z][a-z0-9_-]*$/;
const SUBJECT_RE = /^([a-z_]+):(\S+)$/;
const SUBJECT_MAX = 256;

// ── builder ──────────────────────────────────────────────────────────────────

/** "a:draft b:active" → states in order plus their buckets. */
function lifecycle(spec: string): { states: string[]; bucket: Record<string, Bucket> } {
  const states: string[] = [];
  const bucket: Record<string, Bucket> = {};
  for (const tok of spec.trim().split(/\s+/)) {
    const [s, b, extra] = tok.split(":");
    invariant(s && b && extra === undefined && (BUCKETS as readonly string[]).includes(b), `GENERA: bad lifecycle token "${tok}"`);
    invariant(!(s in bucket), `GENERA: state "${s}" declared twice`);
    states.push(s);
    bucket[s] = b as Bucket;
  }
  return { states, bucket };
}

/** "a>b,c; b>c" → move map. "*" is the full graph over the states (observed kinds). */
function moveMap(spec: string, states: string[]): Record<string, string[]> {
  if (spec === "*") return Object.fromEntries(states.map((s) => [s, states.filter((t) => t !== s)]));
  const moves: Record<string, string[]> = {};
  for (const part of spec.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [from, tos, extra] = part.split(">");
    invariant(from && tos && extra === undefined, `GENERA: bad move spec "${part}"`);
    invariant(!(from.trim() in moves), `GENERA: moves from "${from.trim()}" declared twice`);
    moves[from.trim()] = tos.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return moves;
}

function kind(
  group: Group,
  authority: Authority,
  cls: KindClass,
  owner: string,
  life: string,
  moves: string,
  extra: Partial<Omit<KindDef, "group" | "authority" | "class" | "owner" | "states" | "bucket" | "moves">> = {},
): KindDef {
  const { states, bucket } = lifecycle(life);
  const key = extra.key ?? (cls === "personal" ? "opaque" : "natural");
  invariant(key === "opaque" ? extra.grammar === undefined : extra.grammar !== undefined && Object.hasOwn(KEY_GRAMMARS, extra.grammar),
    `GENERA: a natural kind names one key grammar and an opaque kind none (owner ${owner})`);
  return {
    group,
    authority,
    class: cls,
    states,
    moves: moveMap(moves, states),
    bucket,
    schema: 1,
    owner,
    ...extra,
    key,
  };
}

/** Kinds whose key could name a person, or comes from free text: minted opaque keys only (ISC-60). */
const OPAQUE = { key: "opaque" } as const;

// Atlas's trio for observed kinds: seen now, not seen lately, aged out.
const SEEN = "active:active stale:open";
const AGED = "expired:gone";

// ── the registry ─────────────────────────────────────────────────────────────

const REGISTRY: Record<string, KindDef> = {
  // Aims
  goal: kind("Aims", "record", "system", "LIFEOS/USER/TELOS (Telos skill)",
    "proposed:draft active:active achieved:closed abandoned:closed retired:gone",
    "proposed>active,abandoned,retired; active>achieved,abandoned,retired; achieved>active,retired; abandoned>active,retired",
    { grammar: "ref", species: ["mission", "goal", "strategy"], principalMoves: ["proposed>active"] }),
  risk: kind("Aims", "record", "system", "skills/ThreatModel RiskRegister + TELOS Risks",
    "open:open mitigating:active accepted:closed closed:closed retired:gone",
    "open>mitigating,accepted,closed,retired; mitigating>open,accepted,closed,retired; accepted>open,retired; closed>open,retired",
    { grammar: "ref", species: ["telos", "estate", "threat"], principalMoves: ["open>accepted", "mitigating>accepted"] }),
  question: kind("Aims", "record", "system", "LIFEOS/SOCRATES",
    "active:active unanswerable:open retired:gone",
    "active>unanswerable,retired; unanswerable>active,retired",
    { grammar: "socrates", species: ["standing"] }),
  decision: kind("Aims", "record", "system", "ISA ## Decisions + AD log",
    "proposed:draft decided:closed superseded:closed reversed:closed withdrawn:gone",
    "proposed>decided,withdrawn; decided>superseded,reversed",
    { grammar: "scoped_ref", species: ["arch", "isa", "principal"] }),

  // Work
  isa: kind("Work", "git", "system", "ISA skill + hooks/ISASync",
    // Current phases, `blocked` and `monitoring` (both written in live ISA frontmatter), then the retired
    // station names, which still parse in work.json and are never written.
    "starting:draft scoping:open marking:open climbing:active learn:active blocked:open monitoring:active complete:closed removed:gone " +
      "observe:open think:open plan:open build:active execute:active verify:active verifying:active",
    [
      "starting>scoping,marking,climbing,learn,blocked,monitoring,complete,removed",
      "scoping>marking,climbing,learn,blocked,monitoring,complete,removed",
      "marking>scoping,climbing,learn,blocked,monitoring,complete,removed",
      "climbing>scoping,marking,learn,blocked,monitoring,complete,removed",
      "learn>scoping,marking,climbing,blocked,monitoring,complete,removed",
      // Blocked work resumes at any phase or closes; monitoring watches finished work and reopens on a miss.
      "blocked>scoping,marking,climbing,learn,monitoring,complete,removed",
      "monitoring>scoping,marking,climbing,learn,blocked,complete,removed",
      "complete>learn,climbing,blocked,monitoring,removed",
      ...["observe", "think", "plan", "build", "execute", "verify", "verifying"].map(
        (s) => `${s}>scoping,marking,climbing,learn,blocked,monitoring,complete,removed`,
      ),
    ].join("; "),
    { grammar: "isa", species: ["project", "task"] }),
  criterion: kind("Work", "git", "system", "ISA skill",
    "open:open failing:active passing:closed removed:gone",
    "open>passing,failing,removed; passing>failing,open,removed; failing>passing,open,removed",
    { grammar: "criterion", species: ["isc", "anti"] }),
  issue: kind("Work", "record", "system", "LIFEOS/ERRATA (+ GitHub issues mirrored)",
    // Errata's statuses verbatim, plus GitHub's open/closed for the github species.
    "new:open enriched:open triaged:open open:open upgrade-filed:active fixed:closed wontfix:closed duplicate:closed closed:closed removed:gone",
    "new>enriched,triaged,upgrade-filed,fixed,wontfix,duplicate,removed; enriched>triaged,upgrade-filed,fixed,wontfix,duplicate,removed; " +
      "triaged>upgrade-filed,fixed,wontfix,duplicate,removed; upgrade-filed>fixed,wontfix,triaged,removed; " +
      "fixed>triaged,removed; wontfix>triaged,removed; duplicate>triaged,removed; open>closed,removed; closed>open,removed",
    { grammar: "errata", species: ["complaint", "bug", "feature-request", "correction", "praise", "question", "incident", "github"] }),
  followup: kind("Work", "record", "system", "LIFEOS/WORKFLOWS followup-* workflows",
    "waiting:active due:open answered:closed cancelled:gone",
    "waiting>due,answered,cancelled; due>waiting,answered,cancelled",
    { grammar: "slug" }),
  proposal: kind("Work", "record", "system", "LIFEOS/TOOLS/Upgrades (+ Review, Ideal State, memory review)",
    "proposed:open accepted:active applied:active verified:closed rejected:closed expired:closed dismissed:gone",
    // Mirrors Upgrades.ts TRANSITIONS, plus dismissed.
    "proposed>accepted,rejected,expired,applied,dismissed; accepted>applied,rejected,dismissed; applied>verified",
    {
      grammar: "proposal",
      species: ["upgrade", "review", "ideal_state", "errata", "memory"],
      principalMoves: ["proposed>accepted"],
      stateAliases: { recommended: "proposed" },
      fieldOwners: { ledger_id: ["tool:Upgrades"] },
    }),
  finding: kind("Work", "record", "system", "LIFEOS/TOOLS/Achilles",
    // Achilles' statuses verbatim.
    "open:open in_progress:active remediated:closed accepted:closed false_positive:closed informational:closed withdrawn:gone",
    "open>in_progress,remediated,accepted,false_positive,informational,withdrawn; in_progress>open,remediated,accepted,false_positive,withdrawn; " +
      "remediated>open; accepted>open; false_positive>open; informational>open",
    { grammar: "achilles", species: ["vuln", "integrity", "audit", "review"] }),
  release: kind("Work", "record", "system", "release tooling + ReleaseRecord",
    "tagged:open cut:active published:closed withdrawn:gone",
    "tagged>cut,published,withdrawn; cut>published,withdrawn; published>withdrawn",
    { grammar: "release", species: ["lifeos", "project"], principalMoves: ["tagged>published", "cut>published"] }),

  // Execution
  session: kind("Execution", "record", "system", "hooks (turn record) + LIFEOS/TOOLS/Sessions",
    "active:active idle:active ended:closed archived:gone",
    "active>idle,ended; idle>active,ended; ended>active,archived",
    { grammar: "id", species: ["claude_code", "codex", "hermes", "subagent"] }),
  run: kind("Execution", "record", "system", "LIFEOS/WORKFLOWS/engine",
    // engine/ledger.ts RunStatus, plus running for runs in flight.
    "running:active succeeded:closed failed:closed abandoned:closed timed_out:closed stopped:closed dropped:gone",
    "running>succeeded,failed,abandoned,timed_out,stopped,dropped",
    { grammar: "id", species: ["workflow", "agent_job", "worker", "assay"] }),
  case: kind("Execution", "record", "system", "LIFEOS/ASSAY",
    "captured:draft active:active quarantined:open retired:gone",
    "captured>active,retired; active>quarantined,retired; quarantined>active,retired",
    { grammar: "id", species: ["replay", "eval", "rewind", "gauntlet", "regression"] }),
  suite: kind("Execution", "record", "system", "LIFEOS/ASSAY",
    "draft:draft advisory:active enforcing:active retired:gone",
    "draft>advisory,retired; advisory>enforcing,retired; enforcing>advisory,retired",
    { grammar: "slug" }),

  // Machinery (observed from git, never hand-edited in the record)
  skill: kind("Machinery", "git", "system", "skills/ (CreateSkill)",
    "present:active deprecated:closed removed:gone",
    "present>deprecated,removed; deprecated>present,removed",
    { grammar: "code", species: ["public", "private"] }),
  hook: kind("Machinery", "git", "system", "hooks/ (HookSystem)",
    "armed:active disabled:closed removed:gone",
    "armed>disabled,removed; disabled>armed,removed",
    { grammar: "code", species: ["command", "function", "gate"] }),
  agent: kind("Machinery", "git", "system", "agents/ (AgentSystem)",
    "present:active removed:gone",
    "present>removed",
    { grammar: "code" }),
  workflow: kind("Machinery", "git", "system", "LIFEOS/USER/WORKFLOWS (Workflows)",
    "active:active paused:closed removed:gone",
    "active>paused,removed; paused>active,removed",
    { grammar: "slug", species: ["once", "cron", "after", "followup", "legacy"] }),
  tool: kind("Machinery", "git", "system", "LIFEOS/TOOLS + skills/*/Tools",
    "present:active shim:closed removed:gone",
    "present>shim,removed; shim>present,removed",
    { grammar: "code", species: ["cli", "lib"] }),
  model: kind("Machinery", "git", "system", "LIFEOS/TOOLS/models.ts (ModelSync)",
    "current:active superseded:closed retired:gone",
    "current>superseded,retired; superseded>current,retired",
    { grammar: "model", species: ["carrier", "lane", "open_weight"] }),
  system: kind("Machinery", "git", "system", "LIFEOS/DOCUMENTATION (CoreComponents)",
    "designed:draft building:open live:active retired:gone",
    "designed>building,live,retired; building>live,retired; live>retired",
    { grammar: "slug" }),
  stream: kind("Machinery", "git", "system", "LIFEOS/STATVS/streams.ts",
    "registered:active retired:gone",
    "registered>retired",
    { grammar: "slug" }),
  view: kind("Machinery", "git", "system", "LIFEOS/STATVS/views",
    "registered:active drifted:open retired:gone",
    "registered>drifted,retired; drifted>registered,retired",
    { grammar: "slug" }),

  // Estate (observed from its outside authority; full move graph)
  app: kind("Estate", "observed", "system", "Bunker + PROJECTS.md",
    `building:draft ${SEEN} degraded:open ${AGED}`, "*",
    { grammar: "dotted", species: ["web", "worker", "native", "cli"] }),
  service: kind("Estate", "observed", "system", "LIFEOS/ATLAS collectors",
    `${SEEN} failing:open stopped:closed ${AGED}`, "*",
    { grammar: "dotted", species: ["worker", "launchd", "systemd", "container"] }),
  domain: kind("Estate", "observed", "system", "LIFEOS/ATLAS (Cloudflare collector)",
    `${SEEN} expiring:open ${AGED}`, "*",
    { grammar: "hostname" }),
  dns_record: kind("Estate", "observed", "system", "LIFEOS/ATLAS (Cloudflare collector)",
    `${SEEN} ${AGED}`, "*",
    { grammar: "dns" }),
  store: kind("Estate", "observed", "system", "LIFEOS/ATLAS (Cloudflare collector)",
    `${SEEN} deleted:gone ${AGED}`, "*",
    { grammar: "dotted", species: ["kv", "d1", "r2", "vectorize", "sqlite"] }),
  repo: kind("Estate", "observed", "system", "LIFEOS/ATLAS (GitHub collector)",
    `${SEEN} archived:closed ${AGED}`, "*",
    { grammar: "repo", species: ["public", "private", "fork"] }),
  machine: kind("Estate", "observed", "system", "LIFEOS/ATLAS (host and GEAR collectors)",
    `${SEEN} offline:open ${AGED}`, "*",
    { grammar: "dotted", species: ["host", "device", "vm"] }),
  credential: kind("Estate", "observed", "system", "LIFEOS/ATLAS (names only, never values)",
    `${SEEN} revoked:closed ${AGED}`, "*",
    { grammar: "env", species: ["api_key", "oauth", "ssh_key", "signing_key"] }),
  ingest: kind("Estate", "observed", "system", "LIFEOS/ATLAS (Injection collector)",
    `${SEEN} closed:closed ${AGED}`, "*",
    { grammar: "slug" }),
  capability: kind("Estate", "observed", "system", "LIFEOS/ATLAS (Injection collector)",
    `${SEEN} withdrawn:closed ${AGED}`, "*",
    { grammar: "slug" }),
  control: kind("Estate", "observed", "system", "LIFEOS/ATLAS (Injection collector)",
    `${SEEN} disabled:closed ${AGED}`, "*",
    { grammar: "slug" }),
  // A vendor, subscription or social account is named after its holder as often as not: opaque.
  account: kind("Estate", "observed", "system", "LIFEOS/ATLAS",
    `${SEEN} suspended:closed closed:closed ${AGED}`, "*",
    { ...OPAQUE, species: ["vendor", "subscription", "social"] }),
  project: kind("Estate", "observed", "system", "LIFEOS/ATLAS (PROJECTS.md collector)",
    `${SEEN} paused:closed ${AGED}`, "*",
    { grammar: "slug" }),

  // People and world
  person: kind("People and world", "record", "personal", "LIFEOS/PEOPLE",
    "active:active dormant:open merged:gone",
    "active>dormant,merged; dormant>active,merged",
    { species: ["contact", "public_figure", "candidate"] }),
  // An organization card is often a person's own business, named after them: opaque.
  org: kind("People and world", "record", "system", "LIFEOS/PEOPLE",
    "active:active dormant:open defunct:closed merged:gone",
    "active>dormant,defunct,merged; dormant>active,defunct,merged; defunct>merged",
    { ...OPAQUE, species: ["company", "vendor", "sponsor", "community"] }),
  place: kind("People and world", "record", "personal", "LIFEOS/LOCATION",
    "known:active retired:gone",
    "known>retired",
    { species: ["home", "venue", "restaurant", "city"] }),

  // Knowledge (titles are free text, and free text names people: every key here is minted)
  note: kind("Knowledge", "git", "system", "Cortex (MEMORY/KNOWLEDGE)",
    "draft:draft seed:open budding:active evergreen:closed archived:gone",
    "draft>seed,budding,evergreen,archived; seed>budding,evergreen,archived; budding>seed,evergreen,archived; evergreen>budding,archived",
    { ...OPAQUE, species: ["idea", "research", "lesson", "wisdom"] }),
  source: kind("Knowledge", "record", "system", "the feed skill",
    "active:active paused:closed failing:open removed:gone",
    "active>paused,failing,removed; paused>active,removed; failing>active,paused,removed",
    { ...OPAQUE, species: ["rss", "youtube", "x", "bluesky", "linkedin", "mastodon", "blog", "newsletter"] }),
  piece: kind("Knowledge", "record", "system", "content pipeline (blog, newsletter, social post and video skills)",
    "draft:draft review:open scheduled:active published:closed unpublished:gone",
    "draft>review,scheduled,published,unpublished; review>draft,scheduled,published,unpublished; scheduled>review,published,unpublished; published>unpublished",
    {
      ...OPAQUE,
      species: ["post", "newsletter", "video", "social", "talk", "podcast"],
      principalMoves: ["draft>scheduled", "draft>published", "review>scheduled", "review>published"],
    }),
  media: kind("Knowledge", "record", "system", "the media taste skill",
    // MediaTaste statuses verbatim, plus removed.
    "suggested:draft want:open consuming:active finished:closed liked:closed loved:closed dropped:closed disliked:closed removed:gone",
    "suggested>want,consuming,finished,liked,loved,dropped,disliked,removed; want>consuming,finished,liked,loved,dropped,disliked,removed; " +
      "consuming>finished,liked,loved,dropped,disliked,want,removed; finished>liked,loved,disliked,consuming,removed; " +
      "liked>loved,disliked,consuming,removed; loved>liked,disliked,consuming,removed; dropped>want,consuming,removed; disliked>liked,loved,removed",
    { ...OPAQUE, species: ["book", "show", "movie", "game"] }),
};

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

/** The closed kind registry. Frozen; a kind is a key of this object and nothing else. */
export const GENERA: Readonly<Record<string, Readonly<KindDef>>> = deepFreeze(REGISTRY);

/** Atlas asset kind → RES kind (+ species), or a skip with its reason. */
export type AtlasMapping = { kind: string; species?: string } | { skip: string };
export const ATLAS_KIND_MAP: Readonly<Record<string, AtlasMapping>> = deepFreeze({
  domain: { kind: "domain" },
  dns_record: { kind: "dns_record" },
  worker: { kind: "service", species: "worker" },
  service: { kind: "service" },
  container: { kind: "service", species: "container" },
  machine: { kind: "machine", species: "host" },
  device: { kind: "machine", species: "device" },
  credential: { kind: "credential" },
  repo: { kind: "repo" },
  model: { kind: "model" },
  project: { kind: "project" },
  kv_namespace: { kind: "store", species: "kv" },
  d1_database: { kind: "store", species: "d1" },
  r2_bucket: { kind: "store", species: "r2" },
  vectorize_index: { kind: "store", species: "vectorize" },
  control: { kind: "control" },
  ingest: { kind: "ingest" },
  capability: { kind: "capability" },
  workflow: { kind: "workflow" },
  tool: { kind: "tool" },
  system: { kind: "system" },
  code: { skip: "a source file that consumes a model; its USES edge hangs from the owning skill, hook or workflow RES with data.path" },
  "registry-snapshot": { skip: "a model-registry file snapshot that consumes a model; same treatment as code, a data.path on the owning RES" },
  "model-source": { skip: "a collector run's coverage of one model source, not a noun; it becomes an observe row about the model" },
  target: { skip: "a MONITORS relation stored as a noun (64 of 152 shadow a domain); it becomes a link from the monitored domain or app" },
});

// ── checks ───────────────────────────────────────────────────────────────────

export function isKind(k: unknown): k is string {
  return typeof k === "string" && Object.hasOwn(GENERA, k);
}

/** `<kind>:<key>` → parts; kind is lowercase [a-z_]+, key is non-empty with no whitespace. */
export function parseSubject(s: unknown): { kind: string; key: string } | null {
  if (typeof s !== "string" || s.length > SUBJECT_MAX) return null;
  const m = SUBJECT_RE.exec(s);
  return m ? { kind: m[1], key: m[2] } : null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE_INTL_RE = /\+\d[\d\s().-]{6,}\d/;
const PHONE_GROUPED_RE = /(?:^|\D)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?!\d)/;
const NAME_RE = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/;
/** A YYYYMMDD-HHMMSS (or _ or T) stamp: a time, so its digits are never read as a phone number. */
const STAMP_RE = /(?<!\d)(?:19|20)\d{6}[-_T]?\d{6}(?!\d)/g;

/** The phone-shaped part of a string, with date-time stamps taken out first; true when one is left. */
function hasPhone(s: string): boolean {
  const t = s.replace(STAMP_RE, "~");
  return PHONE_INTL_RE.test(t) || PHONE_GROUPED_RE.test(t);
}

/**
 * True when a string carries personal-looking content: an email address, a
 * phone number (international `+…` or grouped 3-3-4, outside a YYYYMMDD-HHMMSS
 * stamp), or a two-word capitalized name. Built for ids and keys; bare digit
 * runs are left alone because run ids and timestamps are digit runs too.
 */
export function looksPersonal(s: string): boolean {
  if (typeof s !== "string") return false;
  return EMAIL_RE.test(s) || hasPhone(s) || NAME_RE.test(s);
}

// ── the People name check (ISC-60) ──────────────────────────────────────────

interface NameIndex { path: string; mtimeMs: number; size: number; given: ReadonlySet<string>; family: ReadonlySet<string> }
let nameCache: NameIndex | null = null;
const NAME_FIELD_RE = /"(givenName|familyName)":"((?:[^"\\]|\\.)*)"/g;

/**
 * The People contacts file the name check reads: PEOPLE_DIR's (the same override People's own store honours), else
 * USER/CONTACTS (People `peopleDir()`). Under `bun test` only a PEOPLE_DIR a test sets is read, never the live store.
 */
function contactsFile(): string | null {
  const dir = process.env.PEOPLE_DIR || (process.env.NODE_ENV === "test" ? "" : join(lifeosUserDir(), "CONTACTS"));
  return dir ? join(dir, "contacts.jsonl") : null;
}

/** Lowercase name tokens: accents folded, split on anything that is not a letter, two letters or more. */
function nameTokens(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/).filter((t) => t.length >= 2);
}

/**
 * First-name and surname tokens from the People store, or null when it is absent. Read with one pass over the
 * file's given and family name fields (no record is parsed whole), and read again only when the file changes.
 */
function peopleNames(): NameIndex | null {
  const path = contactsFile();
  if (!path) return null;
  let st: { mtimeMs: number; size: number };
  try { st = statSync(path); } catch { return null; }
  if (nameCache && nameCache.path === path && nameCache.mtimeMs === st.mtimeMs && nameCache.size === st.size) return nameCache;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const given = new Set<string>();
  const family = new Set<string>();
  for (const m of text.matchAll(NAME_FIELD_RE)) {
    let raw = m[2]!;
    try { raw = JSON.parse(`"${raw}"`) as string; } catch { /* keep the escaped text */ }
    for (const t of nameTokens(raw)) (m[1] === "givenName" ? given : family).add(t);
  }
  nameCache = { path, mtimeMs: st.mtimeMs, size: st.size, given, family };
  return nameCache;
}

/** A key's tokens for the name check: split on - _ . @ / : and digits, and at CamelCase and ALLCAPS-word boundaries. */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * True when a key holds a first name immediately followed by a surname, both from the People store. The names are
 * never stored here; with no People store on this machine (a fresh install, the Worker) the check finds nothing and
 * the key grammars and opaque kinds stand on their own.
 */
export function namesPerson(key: string): boolean {
  const idx = peopleNames();
  if (!idx || idx.given.size === 0 || idx.family.size === 0) return false;
  const toks = keyTokens(key);
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i]!.length >= 2 && toks[i + 1]!.length >= 2 && idx.given.has(toks[i]!) && idx.family.has(toks[i + 1]!)) return true;
  }
  return false;
}

/** The key grammar a natural kind's key must match, or null for an opaque kind or an unknown one. */
export function keyGrammar(kind: string): RegExp | null {
  if (!isKind(kind)) return null;
  const g = GENERA[kind].grammar;
  return g ? KEY_GRAMMARS[g] : null;
}

/** null when the subject may be written; otherwise the reason it is refused. */
export function validSubject(s: string): string | null {
  const p = parseSubject(s);
  if (!p) return `subject must match the <kind>:<key> grammar (lowercase kind, non-empty key, no whitespace, at most ${SUBJECT_MAX} chars)`;
  if (!isKind(p.kind)) return `unknown kind "${p.kind}": not registered in GENERA`;
  if (looksPersonal(p.key)) return `subject key carries personal-looking content (email, phone or name)`;
  const def = GENERA[p.kind];
  if (def.key === "opaque") {
    return OPAQUE_KEY_RE.test(p.key) ? null : `kind "${p.kind}" takes a minted opaque key, never a readable one`;
  }
  if (!KEY_GRAMMARS[def.grammar!].test(p.key)) return `subject key is outside the ${def.grammar} key grammar of kind "${p.kind}"`;
  if (namesPerson(p.key)) return `subject key carries personal-looking content (a person's name)`;
  return null;
}

/** The bucket a state reads as, or null for an unknown kind or state. Aliases resolve first. */
export function bucketOf(kind: string, state: string): Bucket | null {
  if (!isKind(kind)) return null;
  const s = canonicalState(kind, state);
  return s === null ? null : GENERA[kind].bucket[s];
}

/** The declared state for a state word (itself, or its alias target), or null. */
export function canonicalState(kind: string, state: string): string | null {
  if (!isKind(kind) || typeof state !== "string") return null;
  const d = GENERA[kind];
  if (d.states.includes(state)) return state;
  const alias = d.stateAliases && Object.hasOwn(d.stateAliases, state) ? d.stateAliases[state] : undefined;
  return alias ?? null;
}

/** True when `from>to` is on the kind's move map. A move to the same state is not a move. */
export function canMove(kind: string, from: string, to: string): boolean {
  if (!isKind(kind)) return false;
  const f = canonicalState(kind, from);
  const t = canonicalState(kind, to);
  if (f === null || t === null || f === t) return false;
  const d = GENERA[kind];
  return Object.hasOwn(d.moves, f) && d.moves[f].includes(t);
}

/** True when the move needs a principal writer. */
export function needsPrincipal(kind: string, from: string, to: string): boolean {
  if (!isKind(kind)) return false;
  const f = canonicalState(kind, from) ?? from;
  const t = canonicalState(kind, to) ?? to;
  return (GENERA[kind].principalMoves ?? []).includes(`${f}>${t}`);
}

/** The state `retire` moves a RES to: the kind's first state in the gone bucket. */
export function retireState(kind: string): string | null {
  if (!isKind(kind)) return null;
  const d = GENERA[kind];
  return d.states.find((s) => d.bucket[s] === "gone") ?? null;
}

export interface GeneraAudit {
  shape: string[];
  /** Kinds with more than 8 species. */
  junkDrawer: string[];
  /** Pairs of kinds with identical state sets and move maps, as "a=b". */
  overSplit: string[];
  moves: string[];
  buckets: string[];
  forbidden: string[];
}

/** Every structural problem in a registry (GENERA by default), grouped by alarm. */
export function auditGenera(g: Readonly<Record<string, Readonly<KindDef>>> = GENERA): GeneraAudit {
  const a: GeneraAudit = { shape: [], junkDrawer: [], overSplit: [], moves: [], buckets: [], forbidden: [] };
  const sigs = new Map<string, string>();
  for (const [k, d] of Object.entries(g)) {
    const bad = (why: string) => a.shape.push(`${k}: ${why}`);
    if (!KIND_RE.test(k)) bad("kind name must be lowercase [a-z_]+");
    if (!(GROUPS as readonly string[]).includes(d.group)) bad(`unknown group ${d.group}`);
    if (!["record", "git", "observed"].includes(d.authority)) bad(`bad authority ${d.authority}`);
    if (!["public", "system", "personal"].includes(d.class)) bad(`bad class ${d.class}`);
    if (!["natural", "opaque"].includes(d.key)) bad(`bad key scheme ${d.key}`);
    if (d.class === "personal" && d.key !== "opaque") bad("personal kinds take opaque keys");
    if (d.key === "natural" && !(typeof d.grammar === "string" && Object.hasOwn(KEY_GRAMMARS, d.grammar))) bad("a natural kind names one key grammar");
    if (d.key === "opaque" && d.grammar !== undefined) bad("an opaque kind takes no key grammar");
    if (!Number.isInteger(d.schema) || d.schema < 1) bad("schema must be an integer >= 1");
    if (typeof d.owner !== "string" || !d.owner.trim()) bad("owner is required");
    if (!Array.isArray(d.states) || d.states.length === 0) bad("states are required");
    const states = Array.isArray(d.states) ? d.states : [];
    if (new Set(states).size !== states.length) bad("duplicate state");
    for (const s of states) if (!STATE_RE.test(s)) bad(`bad state name ${s}`);
    const species = d.species ?? [];
    if (new Set(species).size !== species.length) bad("duplicate species");
    for (const s of species) if (!SPECIES_RE.test(s)) bad(`bad species name ${s}`);
    if (d.fields && new Set(d.fields).size !== d.fields.length) bad("duplicate field");
    for (const [f, owners] of Object.entries(d.fieldOwners ?? {})) {
      if (d.fields && !d.fields.includes(f)) bad(`fieldOwners names undeclared field ${f}`);
      if (!Array.isArray(owners) || owners.length === 0) bad(`field ${f} has no owner`);
    }
    const moves = d.moves ?? {};
    for (const pm of d.principalMoves ?? []) {
      const [from, to, extra] = pm.split(">");
      if (extra !== undefined || !moves[from]?.includes(to)) bad(`principal move ${pm} is not on the move map`);
    }
    for (const [alias, to] of Object.entries(d.stateAliases ?? {})) {
      if (!states.includes(to) || states.includes(alias)) bad(`state alias ${alias} → ${to}`);
    }

    if (species.length > 8) a.junkDrawer.push(k);

    for (const [from, tos] of Object.entries(moves)) {
      if (!states.includes(from)) a.moves.push(`${k}: move from undeclared state ${from}`);
      for (const to of tos) {
        if (!states.includes(to)) a.moves.push(`${k}: ${from}>${to} names an undeclared state`);
        else if (to === from) a.moves.push(`${k}: ${from}>${to} is a self-move`);
      }
    }

    const bucket = d.bucket ?? {};
    for (const s of states) {
      if (!Object.hasOwn(bucket, s)) a.buckets.push(`${k}: state ${s} has no bucket`);
      else if (!BUCKETS.includes(bucket[s])) a.buckets.push(`${k}: state ${s} has unknown bucket ${bucket[s]}`);
    }
    for (const s of Object.keys(bucket)) if (!states.includes(s)) a.buckets.push(`${k}: bucket for undeclared state ${s}`);
    if (!states.some((s) => bucket[s] === "gone")) a.buckets.push(`${k}: no state in the gone bucket for retire`);

    if (FORBIDDEN_NAME.test(k)) a.forbidden.push(k);
    for (const s of species) if (FORBIDDEN_NAME.test(s)) a.forbidden.push(`${k}/${s}`);

    const sig = JSON.stringify([
      [...states].sort(),
      Object.entries(moves).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)).sort(),
    ]);
    const twin = sigs.get(sig);
    if (twin) a.overSplit.push(`${twin}=${k}`);
    else sigs.set(sig, k);
  }
  return a;
}
