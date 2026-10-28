/**
 * Injection surfaces — the structural trust-boundary registry for LifeOS.
 *
 * Atlas models infrastructure. This file models the OTHER estate: every place
 * where text somebody else wrote can reach the agent's context, every
 * consequential thing the agent can then do, and the controls standing between
 * the two. Prompt injection is a confused-deputy problem, so the graph has to
 * carry both halves — a surface is only as dangerous as the capability it can
 * borrow.
 *
 * SYSTEM-SIDE AND PUBLISHABLE. Structural surfaces only: no handles, no
 * hostnames, no personal data. Instance specifics (which repos, which senders,
 * which feeds) belong in the optional USER overlay the collector merges in —
 * see `Injection.ts`. So does every control whose implementation is not in
 * this tree (a cloud worker, a private scanner): a shipped control's `impl`
 * names a file that ships, and the release emitter resolves it (in-family
 * audit, round 11, 7.52.0 cut) — a census row for a control the machine does
 * not have is reassurance, not inventory.
 *
 * Trust classes:
 *   principal  the principal's own channel; the only source of commands
 *   semi       a known human or vetted party, still not an authority for actions
 *   untrusted  anybody on the internet can author it
 *
 * `persists: true` is the class that matters most. A poisoned page ruins one
 * turn. A poisoned surface that writes into memory, the ledger, or the archive
 * re-enters context on every later recall, so one bad read becomes permanent.
 *
 * Retired 2026-10-24 (ISA 20261024-native-security): the per-call hook layer.
 * safety-hook (data-not-instructions framing and the injection-shape scan, with
 * its untrusted-bash-sources allowlist) and taint-gate (TaintGuard, the blocking
 * half that refused outbound and irreversible commands after an outside read)
 * are gone, and so are pretool-guard, egress-class-guard, secret-egress-scan,
 * system-file-guard, comm-skill-guard and public-push-gate. Claude Code has no
 * native taint tracking, so every Bash- and tool-delivered surface that carried
 * them now rests on the constitution alone: advisory, fail-open. Blocking stays
 * on the capability side, where the native permission rules and the private
 * trees' git hooks stand (HookSystem.md § Native enforcement).
 *
 * @version 1.3.0
 */

export type Trust = "principal" | "semi" | "untrusted";
export type Channel = "web" | "mail" | "chat" | "feed" | "repo" | "mcp" | "sensor" | "file" | "memory" | "voice";
export type Blast = "self" | "estate" | "public" | "money" | "physical" | "local";
export type ControlMode = "blocking" | "advisory" | "human-gate";

export interface Surface {
  /** Stable slug; becomes `ingest:<id>` in the graph. */
  id: string;
  name: string;
  trust: Trust;
  channel: Channel;
  /** Does content from here survive the session (memory, archive, ledger, DB)? */
  persists: boolean;
  /** Is there an identity barrier on the sender, or can anyone author into it? */
  authenticated: boolean;
  /** Control ids standing between this surface and agent context. */
  controls: string[];
  notes: string;
}

export interface Capability {
  id: string;
  name: string;
  blast: Blast;
  /** Can the principal undo it after the fact without external help? */
  reversible: boolean;
  controls: string[];
}

export interface Control {
  id: string;
  name: string;
  /** Layer per the security posture's layered model (L1 constitutional … L6 monitoring). */
  layer: "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "app";
  mode: ControlMode;
  /** Fail-open controls degrade to nothing on error — tracked because it changes the math. */
  failOpen: boolean;
  impl: string;
}

export const CONTROLS: Control[] = [
  { id: "constitution", name: "Constitutional rule 4 — external content is READ-ONLY", layer: "L1", mode: "advisory", failOpen: true, impl: "LIFEOS_SYSTEM_PROMPT.md § Security Protocol" },
  { id: "analysis-readonly", name: "Constitutional rule 5 — analysis means read-only", layer: "L1", mode: "advisory", failOpen: true, impl: "LIFEOS_SYSTEM_PROMPT.md § Hard Prohibitions" },
  { id: "permissions-deny", name: "Native permissions.deny", layer: "L2", mode: "blocking", failOpen: false, impl: "settings.system.json permissions" },
  { id: "permissions-ask", name: "Native permissions.ask — human prompt", layer: "L2", mode: "human-gate", failOpen: false, impl: "settings.system.json permissions" },
  { id: "precommit-leak-scan", name: "Git pre-commit leak scan — plaintext .env, secret-shaped values and user-identifying content refused in staged bytes", layer: "L3", mode: "blocking", failOpen: false, impl: "LIFEOS/TOOLS/githooks/StagedLeakScan.ts" },
  { id: "prepush-private-only", name: "Git pre-push check — a private tree pushes only to a remote GitHub confirms private", layer: "L5", mode: "blocking", failOpen: false, impl: "LIFEOS/TOOLS/githooks/PrePush.ts" },
  { id: "sender-allowlist", name: "Sender-handle allowlist on the messaging channel", layer: "app", mode: "blocking", failOpen: false, impl: "LIFEOS/HERMES/Policy.ts + LIFEOS/RELAY/bridge/session.ts allowFrom" },
  { id: "message-sanitize", name: "Injection-shape tripwire — injection-shaped texts are dropped before any texting session spawns", layer: "app", mode: "blocking", failOpen: false, impl: "hooks/lib/texting-guard-core.ts injectionShaped via LIFEOS/RELAY/bridge/session.ts admit" },
  { id: "hermes-policy", name: "Sidecar shell/tool deny policy", layer: "app", mode: "blocking", failOpen: false, impl: "LIFEOS/HERMES/Policy.ts" },
  { id: "permission-boundaries", name: "Permission boundaries — ask before irreversible or outward actions", layer: "L1", mode: "human-gate", failOpen: true, impl: "LIFEOS_SYSTEM_PROMPT.md § Permission Boundaries" },
  { id: "knowledge-write-guard", name: "KnowledgeWriteGuard — archive write shape enforcement", layer: "L3", mode: "blocking", failOpen: false, impl: "hooks/KnowledgeWriteGuard.hook.ts" },
  { id: "source-provenance", name: "Third-party provenance carried on written artifacts so recall cannot launder it", layer: "app", mode: "advisory", failOpen: true, impl: "LIFEOS/PULSE/Conduit/cortexNote.ts authored_by" },
  { id: "memory-write-gate", name: "Hot-layer write gate — instruction-shaped entries refused at the write, not hidden at display", layer: "L3", mode: "blocking", failOpen: false, impl: "LIFEOS/TOOLS/MemoryWriter.ts validateAndDedup" },
  { id: "untrusted-data-framing", name: "Nonce-delimited data framing around untrusted content in model prompts", layer: "app", mode: "advisory", failOpen: true, impl: "LIFEOS/TOOLS/InjectionShapes.ts asUntrustedData" },
  { id: "sender-policy", name: "Source-address policy on network ingest — private ranges only, or an explicit allowlist", layer: "app", mode: "blocking", failOpen: false, impl: "LIFEOS/PULSE/modules/syslog.ts senderAllowed" },
  { id: "ingest-rate-limit", name: "Per-sender rate ceiling on network ingest, excess dropped and counted", layer: "app", mode: "blocking", failOpen: false, impl: "LIFEOS/PULSE/modules/syslog.ts rateLimited" },
  { id: "ingest-sanitize", name: "NFKC fold, zero-width/bidi/control strip, and length cap at ingest", layer: "app", mode: "blocking", failOpen: false, impl: "LIFEOS/PULSE/modules/syslog.ts sanitize" },
];

export const CAPABILITIES: Capability[] = [
  { id: "self-modify", name: "Modify the harness itself (doctrine, hooks, skills, settings)", blast: "self", reversible: true, controls: ["precommit-leak-scan", "permissions-deny", "analysis-readonly"] },
  { id: "credential-read", name: "Read credentials and the secret store", blast: "estate", reversible: false, controls: ["permissions-deny", "permissions-ask"] },
  { id: "private-data-read", name: "Read the private USER tree — identity, health, finances, contacts", blast: "estate", reversible: false, controls: ["constitution"] },
  { id: "deploy", name: "Deploy to production infrastructure", blast: "estate", reversible: true, controls: ["permission-boundaries"] },
  { id: "repo-write", name: "Write to repositories, including visibility changes", blast: "public", reversible: false, controls: ["prepush-private-only", "permissions-deny", "permission-boundaries"] },
  { id: "publish", name: "Publish under the principal's name (social, blog, community)", blast: "public", reversible: false, controls: ["permission-boundaries"] },
  { id: "message-external", name: "Send mail, SMS, or chat to third parties", blast: "public", reversible: false, controls: ["permissions-ask", "permission-boundaries"] },
  { id: "spend", name: "Move money — payments, refunds, purchases, orders", blast: "money", reversible: false, controls: ["permission-boundaries"] },
  { id: "physical", name: "Act on the physical world — locks, doors, lights, climate", blast: "physical", reversible: true, controls: ["permission-boundaries"] },
  { id: "memory-write", name: "Write durable memory — hot layer, archive, ledger", blast: "self", reversible: true, controls: ["knowledge-write-guard"] },
  { id: "local-exec", name: "Execute local commands and edit local files", blast: "local", reversible: true, controls: ["permissions-deny", "permissions-ask"] },
];

export const SURFACES: Surface[] = [
  // ── open web ───────────────────────────────────────────────────────
  { id: "web-fetch", name: "Web page and search results (WebFetch / WebSearch)", trust: "untrusted", channel: "web", persists: false, authenticated: false, controls: ["constitution"], notes: "The canonical indirect-injection path. The page author controls every byte." },
  { id: "scrape", name: "Bulk scraping and crawl output", trust: "untrusted", channel: "web", persists: true, authenticated: false, controls: ["constitution"], notes: "Scraped bodies are often written to files or datasets before anyone reads them." },
  { id: "browser-runtime", name: "Browser DOM, console, and network capture during verification", trust: "untrusted", channel: "web", persists: false, authenticated: false, controls: ["constitution"], notes: "Page-controlled strings reach context verbatim as debugging evidence." },
  { id: "external-api", name: "Third-party API and dataset responses", trust: "untrusted", channel: "web", persists: true, authenticated: false, controls: ["constitution"], notes: "Rendered as facts, rarely read as adversary-controlled text." },

  // ── mail and messaging ─────────────────────────────────────────────
  { id: "email-inbox", name: "Inbound email", trust: "untrusted", channel: "mail", persists: true, authenticated: false, controls: ["constitution"], notes: "Anyone who knows the address can author into it, and derived contact records persist." },
  { id: "calendar-invite", name: "Calendar invitations from third parties", trust: "untrusted", channel: "mail", persists: true, authenticated: false, controls: ["constitution"], notes: "Event titles, descriptions, and locations are attacker-authored free text." },
  { id: "messaging", name: "Direct messages on the personal messaging channel", trust: "semi", channel: "chat", persists: true, authenticated: true, controls: ["sender-allowlist", "message-sanitize", "hermes-policy"], notes: "The allowlist is load-bearing; trusted senders authorize conversation, never actions." },
  { id: "community-chat", name: "Community chat servers and workspaces", trust: "untrusted", channel: "chat", persists: false, authenticated: false, controls: ["constitution"], notes: "Community members author freely, and read paths carry their text into context." },

  // ── feeds and capture ──────────────────────────────────────────────
  { id: "feed", name: "Subscribed content feeds (RSS, video, social, newsletters)", trust: "untrusted", channel: "feed", persists: true, authenticated: false, controls: ["constitution"], notes: "Publisher-controlled text, polled automatically, stored, then summarized by a model. The pipeline-side model is tool-less and binding-less (output JSON, every field clamped), so the live exposure is the skill that pulls stories into a full-authority session over Bash — framed by safety-hook since 2026-08-30." },
  { id: "social-read", name: "Social posts, bookmarks, and profiles pulled by handle", trust: "untrusted", channel: "feed", persists: true, authenticated: false, controls: ["constitution"], notes: "Bookmark sweeps feed the upgrade pipeline, which proposes changes to the system itself." },
  { id: "file-drop", name: "Documents handed over that originated elsewhere (PDF, transcript, export)", trust: "untrusted", channel: "file", persists: true, authenticated: false, controls: ["constitution"], notes: "Principal-delivered does not mean principal-authored." },
  { id: "transcript", name: "Meeting and wearable transcripts containing other speakers", trust: "semi", channel: "voice", persists: true, authenticated: false, controls: ["constitution"], notes: "A third party in the room can speak an instruction into the record." },
  { id: "sensor-syslog", name: "Unauthenticated network log ingest", trust: "untrusted", channel: "sensor", persists: true, authenticated: false, controls: ["sender-policy", "ingest-rate-limit", "ingest-sanitize"], notes: "Any host that can reach the port writes into a file the dashboard reads. Narrowed 2026-08-19 on three shipped axes: source policy, per-sender rate ceiling, and ingest sanitization. UDP source addresses are spoofable, so this bounds damage rather than authenticating anyone — the listener also stays off by default." },

  // ── code and tooling ───────────────────────────────────────────────
  { id: "repo-community", name: "Public-repo issues, pull requests, and discussions", trust: "untrusted", channel: "repo", persists: true, authenticated: false, controls: ["constitution"], notes: "Triage skills read community-authored text while holding repo-write capability." },
  { id: "contributed-code", name: "Contributed code and skill files adopted from outside", trust: "untrusted", channel: "repo", persists: true, authenticated: false, controls: ["constitution"], notes: "Supply chain into the harness itself: adopted instructions execute forever, not once." },
  { id: "mcp-result", name: "MCP tool results", trust: "untrusted", channel: "mcp", persists: false, authenticated: false, controls: ["constitution"], notes: "Server-controlled payloads from an integration the principal trusted once." },
  { id: "mcp-schema", name: "MCP tool descriptions and schemas", trust: "untrusted", channel: "mcp", persists: false, authenticated: false, controls: ["constitution"], notes: "Tool poisoning: the description IS a prompt, and a server can change it between fetch and call." },
  { id: "subagent-return", name: "Subagent and cross-vendor agent returns", trust: "untrusted", channel: "mcp", persists: false, authenticated: false, controls: ["constitution"], notes: "An agent that read a poisoned page returns its text upward as a trusted-looking result." },

  // ── second order: content the system re-injects into itself ────────
  { id: "memory-hot-layer", name: "Auto-curated hot-layer memory", trust: "untrusted", channel: "memory", persists: true, authenticated: false, controls: ["memory-write-gate"], notes: "The highest durability in the system: written by a reviewer reading transcripts that contain external text, then injected on EVERY turn. Narrowed 2026-08-19 — instruction-shaped entries are refused at the write chokepoint and returned for review. Before that the only check hid the sample from a notification while the entry still loaded." },
  { id: "knowledge-archive", name: "Knowledge archive notes ingested from external content", trust: "untrusted", channel: "memory", persists: true, authenticated: false, controls: ["knowledge-write-guard", "source-provenance"], notes: "Recall re-injects the original text months later. Routed notes now carry authored_by/trust frontmatter so provenance survives the trip." },
  { id: "observability-log", name: "Logs and observability records replayed into context", trust: "untrusted", channel: "memory", persists: true, authenticated: false, controls: ["constitution"], notes: "Any surface that writes a log line can write into whatever later reads that log. Governed 2026-09-15: Bash reads of MEMORY/OBSERVABILITY|STATE|LOGS *.log/*.jsonl, ~/Library/Logs, .wrangler/logs and /var/log are framed as data by the Safety hook (advisory, no taint mark — the logs are ours, the lines in them are not)." },
  {
    id: "harvest-target",
    name: "Arbitrary URLs and documents pulled in by the harvest and upgrade lanes",
    trust: "untrusted",
    channel: "web",
    persists: true,
    authenticated: false,
    controls: ["constitution"],
    notes:
      "The sharpest end of the mining lanes: content is fetched specifically to be mined for changes to this system, so a page that proposes a plausible-sounding system change is proposing it straight into the pipeline that adopts changes.",
  },
];
