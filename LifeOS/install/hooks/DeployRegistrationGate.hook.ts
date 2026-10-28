#!/usr/bin/env bun
/**
 * @version 1.10.1
 * 1.10.0 (2026-10-15, security P1 batch 2 S037): discovery runs as an enforce gate through runGate; a
 * transcript that is missing, not a file, or unparseable is unavailable evidence and holds the stop once
 * (the loop-guard re-stop passes), instead of reading as a turn with no deploys. A record the scan cannot read
 * (a line that is not JSON, a paired deploy result with unreadable content) is counted, never skipped as clean
 * and never allowed to erase deploys already found: those are checked first, then the stop is held once.
 * Fix round 2: a paired deploy result in any content shape outside the supported set (null, missing, a number,
 * an object, a text part whose text is not a string) is counted unreadable, and its text is still read the way
 * the earlier scanner read it, so no host it found is discarded (resultText).
 * 1.9.0 (2026-10-15): the default probe egress goes through SafeFetch, so each
 * request and redirect hop resolves the host once and connects to the checked address (no DNS
 * rebinding between the public-address check and the connect).
 * 1.8.0 (2026-10-14): live probes go out only through publicOnlyFetch,
 * which refuses a host that does not resolve or resolves to any non-public address, on every
 * redirect hop; an error after a deploy was detected holds the stop once instead of passing.
 * 1.7.0 (2026-10-10, hosts found live but outside Bunker): the custom-domain leg also requires
 * Bunker adoption, a bunker.config.ts whose url host or `aliases` names the host (www folded),
 * skipped when Bunker is not installed, the same as the workers.dev leg. Discovery reads
 * LIFEOS/USER/ASSETS, the home of public assets with no repo of their own.
 * 1.6.1 (2026-10-09, review-code row 12): the clean mark is bound to the deploy call that printed
 * the host, so a later redeploy of the same host in the session is probed again (once per turn).
 * 1.6.0 (2026-10-09, rule-enforcer audit): blocks once per TURN, and re-checks at the end of
 * every later turn until the host comes back clean (then it is marked clean for that deploy);
 * an analytics or edge probe that cannot read the site is a gap, not a skip. The turn is the
 * last real user prompt's promptId, so a block's own recovery continuation is not re-blocked.
 * Public deploy registration gate: paired session shell deploy output must have
 * a projects row, optional inventory registration, live analytics wiring and
 * optional edge hardening. A workers.dev-only deploy must have a projects row,
 * a scanner target and Bunker adoption, or a reasoned workersDevExempt prefix in
 * the config; all its gaps fold into one block. cf's boxed (│) output parses
 * the same as plain output (1.5.0, 2026-10-06). USER/CONFIG/deploy-registration-gate.json configures
 * the optional analytics registry leg (absent means not required). Registry
 * literals exclude comments and must sit inside the configured object, if any.
 * A domain-field no-analytics marker skips both analytics legs. Probes have
 * deadlines; edge misses retry once. Internal errors with a detected deploy hold the Stop once;
 * probe errors are gaps. Blocks once per host per turn, only after successful state
 * persistence. Compiled observability
 * inventory remains a separate adoption/sync step.
 * TranscriptParser exposes raw JSONL and assistant summaries, not paired calls.
 * Decode raw records and pair shell calls/results by ID; never scan prose.
 * Runnable standalone: bun DeployRegistrationGate.hook.ts < hook-input.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { runGate } from "./lib/gate-run";
import { join } from "path";
import { homedir } from "os";
import { readHookInput, parseTranscriptFromInput } from "./lib/hook-io";
import { getClaudeDir, lifeosPath } from "./lib/paths";
import { invariant } from "../LIFEOS/TOOLS/Invariant";
import { safeFetch, type SafeFetchOptions } from "../LIFEOS/TOOLS/lib/SafeFetch";

const PROJECTS_MD = lifeosPath("USER", "PROJECTS.md");
const INVENTORY_TS = lifeosPath("USER", "CUSTOMIZATIONS", "WORKFLOWS", "Shared", "infra-inventory.ts");
const STATE_DIR = lifeosPath("MEMORY", "STATE");
const STATE_PATH = join(STATE_DIR, "deploy-registration-gate.json");
const REGISTRY_CONFIG = lifeosPath("USER", "CONFIG", "deploy-registration-gate.json");
// The sweep is a USER-tree tool (never ships). Installs without it skip the edge-
// hardening leg, the same contract as the inventory: absent → not required.
const SWEEP_TOOL = lifeosPath("USER", "SECURITY", "Tools", "SecurityHeadersSweep.ts");
const SWEEP_CMD = `bun '${SWEEP_TOOL.replace(/'/g, "'\\''")}'`;
const PROBE_TIMEOUT_MS = 6000;
const PROBE_RETRY_MS = 5000;

export interface HardeningProbe {
  hsts: boolean;
  csp: boolean;
  spf: boolean;
}

/** Live edge probe: response headers over HTTPS + SPF TXT via DoH. Returns null on any error (fail open). */
export async function probeHardening(
  domain: string,
  fetcher: typeof fetch = PROBE_FETCH,
): Promise<HardeningProbe | null> {
  try {
    // Every redirect hop is checked to stay on this host (or its www twin) over https and the
    // final answer must be 2xx: a followed redirect to another host would read that host's
    // headers as this deploy's hardening (2026-10-13 audit, finding 22). An auth-only API answers its root
    // with 401/403 on purpose, and that answer carries the host's real headers, so it is read too; any other
    // non-2xx still means the probe could not complete (#1719, 2026-10-14).
    const page = await fetchAnalyticsUrl(new URL(`https://${domain}/`), domain, fetcher, "HEAD", true);
    if (!page) return null;
    const head = page.response;
    const hsts = head.headers.has("strict-transport-security");
    const csp = head.headers.has("content-security-policy");
    const doh = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`,
      { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (!doh.ok) return null;
    const answers = (JSON.parse(await readTextCapped(doh)) as { Answer?: { data?: string }[] }).Answer ?? [];
    const spf = answers.some((a) => /v=spf1/i.test(a.data ?? ""));
    return { hsts, csp, spf };
  } catch {
    return null;
  }
}

/** Names what the edge is missing; empty when hardened. */
export function hardeningGaps(p: HardeningProbe): string[] {
  const gaps: string[] = [];
  if (!p.hsts) gaps.push("HSTS");
  if (!p.csp) gaps.push("CSP");
  if (!p.spf) gaps.push("SPF");
  return gaps;
}

/** Probe, and on a miss probe once more after a propagation delay. null = could not probe. */
export async function hardeningGapsWithRetry(
  domain: string,
  fetcher: typeof fetch = PROBE_FETCH,
  retryMs = PROBE_RETRY_MS,
): Promise<string[] | null> {
  const first = await probeHardening(domain, fetcher);
  if (first === null) return null;
  const gaps = hardeningGaps(first);
  if (gaps.length === 0) return gaps;
  await new Promise((r) => setTimeout(r, retryMs));
  const second = await probeHardening(domain, fetcher);
  if (second === null) return null;
  return hardeningGaps(second);
}

/** cf sometimes draws its result inside a `│` box; strip it so both formats match (2026-10-06). */
const unbox = (line: string) => line.replace(/^[ \t]*│/, "");

/** Custom domains only; kept for callers that predate the workers.dev leg. */
export function deployedDomains(raw: string, sessionId: string): string[] {
  return deployedHosts(raw, sessionId).custom;
}

/**
 * Pure provenance scan. Malformed records are skipped here (scanDeploys counts them for run(), which treats them as
 * unavailable evidence); a bad record never discards the deploys already found.
 * `workersDev` holds result URLs of deploys that printed no custom domain: a worker with
 * a custom domain is gated on that domain, and its workers.dev twin is the scanner's.
 */
export function deployedHosts(raw: string, sessionId: string): { custom: string[]; workersDev: string[] } {
  const { custom, workersDev } = scanDeploys(raw, sessionId);
  return { custom, workersDev };
}

/**
 * A tool_result's text and whether its shape is one the scan supports (S037 round 2). `text` is read leniently
 * (every text part coerced to a string, a non-object part skipped) so nothing the earlier scanner found is lost;
 * `readable` is false for any shape outside the supported set, which the caller counts as unavailable evidence.
 */
export function resultText(content: unknown): { text: string; readable: boolean } {
  if (typeof content === "string") return { text: content, readable: true };
  if (!Array.isArray(content)) return { text: "", readable: false };
  let readable = true;
  const texts: string[] = [];
  for (const part of content as unknown[]) {
    if (!part || typeof part !== "object" || Array.isArray(part)) { readable = false; continue; }
    const p = part as { type?: unknown; text?: unknown };
    if (p.type !== "text") continue;
    if (typeof p.text !== "string") readable = false;
    texts.push(typeof p.text === "string" ? p.text : p.text == null ? "" : String(p.text));
  }
  return { text: texts.join("\n"), readable };
}

/**
 * deployedHosts plus, for each custom domain, the id of the LAST deploy call that printed it, so
 * a clean mark can be bound to that deploy: a later redeploy of the same host is a new id and is
 * probed again (review-code 2026-10-09, row 12). `unreadable` counts the records that could not be
 * read (a line that is not JSON, a paired deploy result with unreadable content): each is evidence
 * the scan could not see, never a clean record (security P1 batch 2, S037). A bad record is counted
 * on its own and never discards the deploys already found.
 */
export function scanDeploys(raw: string, sessionId: string): { custom: string[]; workersDev: string[]; lastDeploy: Record<string, string>; unreadable: number } {
  const lastDeploy: Record<string, string> = {};
  const calls = new Set<string>();
  const domains = new Set<string>();
  const devHosts = new Set<string>();
  let unreadable = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    // A `null` or non-object record (an array, a number, a string) is not a transcript record: it is counted as
    // unreadable evidence on its own, and it never discards the deploys already found (2026-10-13 audit,
    // finding 18; S037 final round).
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { unreadable++; continue; }
    if (entry.sessionId !== sessionId || entry.isSidechain === true) continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (entry.type === "assistant" && block.type === "tool_use" && block.name === "Bash") {
        const command = block.input?.command;
        if (typeof command !== "string" || typeof block.id !== "string") continue;
        // cf (Wrangler's replacement, 2026-09-29) and CfEnv.ts pair explicitly; most cf deploys also say "deploy".
        if (/deploy|wrangler|\b(?:ship|release|publish)\b|(?<![\w.-])cf\s|\bCfEnv\.ts\b/i.test(command)) calls.add(block.id);
      }
      if (entry.type !== "user" || block.type !== "tool_result") continue;
      const paired = calls.delete(block.tool_use_id);
      if (!paired) continue;
      // Supported shapes are a string, or an array of objects whose text parts carry string text (image and other
      // parts are skipped). Anything else (null, missing, a number, an object, a non-object part, a text part whose
      // text is not a string) is a deploy output the scan cannot read: counted as unavailable evidence. Its text is
      // still read the way the previous scanner read it (each text part coerced to a string), so a host that
      // scanner found is never discarded (S037 round 2).
      const output = resultText(block.content);
      if (!output.readable) unreadable++;
      const lines: string[] = output.text.split(/\r?\n/);
      const deployedAt = lines.findIndex((line) => /^(?:[ \t]*│[ \t]*)?Deployed .+ triggers \(\d+(?:\.\d+)? sec\)\s*$/.test(line));
      if (deployedAt < 0) continue;
      const custom: string[] = [];
      const dev: string[] = [];
      for (const line of lines.slice(deployedAt + 1).map(unbox)) {
        const match = line.match(/^[ \t]{2,}([a-z0-9][a-z0-9.-]+\.[a-z]{2,})[ \t]+\(custom domain(?: - zone (?:id|name): [^)]+)?\)[ \t]*$/i);
        if (match) custom.push(match[1].toLowerCase());
        const url = line.match(/^[ \t]{2,}https:\/\/([a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.workers\.dev)\/?[ \t]*$/i);
        if (url) dev.push(url[1].toLowerCase());
      }
      for (const d of custom) { domains.add(d); lastDeploy[d] = String(block.tool_use_id).replace(/[:\n]/g, "_"); }
      if (!custom.length) for (const d of dev) devHosts.add(d);
    }
  }
  return { custom: [...domains], workersDev: [...devHosts], lastDeploy, unreadable };
}

/**
 * Registration is matched on exact hosts, never substrings (2026-10-13 audit, finding 20):
 * `includes()` counted notexample.com, or a host named only in a comment, as registered.
 */
const HOST_TOKEN = /(?<![a-z0-9.-])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?![a-z0-9-])/gi;

/** Hostnames PROJECTS.md names, HTML comments removed, lowercased. */
export function projectsHosts(projects: string): Set<string> {
  const text = projects.replace(/<!--[\s\S]*?-->/g, " ");
  return new Set([...text.matchAll(HOST_TOKEN)].map((m) => m[1].toLowerCase()));
}

/** Quoted string values in the inventory source, comments removed, lowercased. */
export function inventoryHosts(inventory: string): Set<string> {
  const text = stripComments(inventory);
  return new Set([...text.matchAll(/(["'`])([^"'`\s]+)\1/g)].map((m) => m[2].toLowerCase()));
}

/** An exemption prefix covers a worker name only at a word boundary: "wf-" covers "wf-a", "wf" covers "wf" and "wf-a", never "wfx". */
export function exemptionCovers(name: string, prefix: string): boolean {
  if (/[-_.]$/.test(prefix)) return name.startsWith(prefix) && name.length > prefix.length;
  return name === prefix || name.startsWith(prefix + "-");
}

export interface WorkersDevExemption { prefix: string; reason: string }

/** `workersDevExempt` from the gate config. An entry without a reason exempts nothing. */
export function parseWorkersDevExemptions(source: string | null): WorkersDevExemption[] {
  try {
    if (source === null) return [];
    const list = JSON.parse(source).workersDevExempt;
    if (!Array.isArray(list)) return [];
    return list.filter((e: any) => typeof e?.prefix === "string" && e.prefix.trim() && typeof e?.reason === "string" && e.reason.trim());
  } catch { return []; }
}

/**
 * Registration gaps for a workers.dev-only worker: PROJECTS.md row, scanner target and
 * Bunker adoption, each matched on the exact host. `inventory` or `bunkerConfigs` null =
 * that system is not installed, so its leg is not required.
 */
export function workersDevGaps(
  host: string,
  projects: string,
  inventory: string | null,
  bunkerConfigs: string | null,
  exemptions: WorkersDevExemption[],
): string[] {
  const name = host.split(".")[0];
  if (exemptions.some((e) => exemptionCovers(name, e.prefix))) return [];
  const missing: string[] = [];
  if (!projectsHosts(projects).has(host.toLowerCase())) missing.push("PROJECTS.md row");
  if (inventory !== null && !inventoryHosts(inventory).has(host.toLowerCase()))
    missing.push(`infra-inventory.ts curated target with serviceBinding (plus the scanner wrangler binding and the deploy.sh KNOWN_EXTERNAL_SERVICES entry), then redeploy the scanner`);
  if (bunkerConfigs !== null && !bunkerAdopted(host, bunkerConfigs))
    missing.push(`Bunker adoption (bunker.config.ts with url "https://${host}")`);
  return missing;
}

/** Text of every bunker.config.ts under Bunker's discovery roots; null when Bunker is not installed. */
export function readBunkerConfigs(home = homedir(), bunkerBin = lifeosPath("PULSE", "Bunker", "bin", "bunker.ts")): string | null {
  // Only "not installed" means not required. Once Bunker is installed, a discovery error
  // yields what was read (possibly nothing), so adoption is still required and a gap is
  // named, never silently skipped (2026-10-13 audit, finding 23).
  if (!existsSync(bunkerBin)) return null;
  try {
    const claude = getClaudeDir();
    // Same roots as LIFEOS/PULSE/Bunker/src/registry.ts DEFAULT_ROOTS, USER/ASSETS included
    // (2026-10-10: the home of public assets with no repo of their own).
    const roots = [join(home, "Projects"), join(home, "LocalProjects"), join(claude, "LIFEOS", "USER", "CUSTOMIZATIONS"), join(claude, "LIFEOS", "USER", "ASSETS"), join(claude, "LIFEOS"), claude, home];
    const parts: string[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let entries: string[];
      try { entries = readdirSync(root); } catch { continue; /* unreadable root: its configs adopt nothing */ }
      for (const entry of entries) {
        const config = join(root, entry, "bunker.config.ts");
        try { if (existsSync(config)) parts.push(readFileSync(config, "utf-8")); } catch { /* unreadable config: skip it */ }
      }
    }
    return parts.join("\n");
  } catch { return ""; }
}

/**
 * True when the gate config names an analytics registry, valid or not. The shipped template's
 * contract is that the leg is skipped while `project` is empty OR `files` is empty, so either key
 * absent or blank means not configured. When both keys carry a value (including a malformed one)
 * it is configured, and a bad value is then reported as invalid.
 */
export function analyticsRegistryConfigured(source: string | null): boolean {
  if (source === null) return false;
  try {
    const c = JSON.parse(source);
    if (!c || typeof c !== "object") return false;
    const projectBlank = !("project" in c) || (typeof c.project === "string" && !c.project.trim());
    const filesBlank = !("files" in c) || (Array.isArray(c.files) && c.files.length === 0);
    return !(projectBlank || filesBlank);
  } catch {
    return true; // a config file that does not parse cannot say it is unconfigured
  }
}

/** The inventory text; "" (every inventory leg a gap) when it exists but cannot be read; null when absent. */
export function readInventory(path: string): string | null {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

const canonicalHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/**
 * Every host the Bunker configs name as an app's own: each literal `url: "https://…"` host and
 * each entry of an `aliases: [...]` array, lowercased with `www.` folded into the apex (Bunker's
 * coverage identity). Comments are stripped first, so a commented-out url adopts nothing.
 */
export function bunkerHostsIn(configs: string): Set<string> {
  const hosts = new Set<string>();
  try {
    const text = stripComments(configs);
    for (const m of text.matchAll(/\burl\s*:\s*(["'`])(https?:\/\/[^"'`\s]+)\1/g)) {
      try { hosts.add(canonicalHost(new URL(m[2]).hostname)); } catch { /* not a URL: adopts nothing */ }
    }
    for (const m of text.matchAll(/\baliases\s*:\s*\[([^\]]*)\]/g)) {
      for (const a of m[1].matchAll(/(["'`])([^"'`]+)\1/g)) {
        const h = canonicalHost(a[2]);
        if (h) hosts.add(h);
      }
    }
  } catch { /* unparseable text adopts nothing */ }
  return hosts;
}

/** True when some bunker.config.ts names this host as its url host or one of its aliases. */
export function bunkerAdopted(host: string, configs: string): boolean {
  return bunkerHostsIn(configs).has(canonicalHost(host));
}

function blockedSet(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(STATE_PATH, "utf-8")) as string[]);
  } catch {
    return new Set();
  }
}

/** Most recent state keys kept; per-turn keys would otherwise grow the file without bound. */
const STATE_MAX_KEYS = 2000;

export function recordBlocked(
  fp: string,
  stateDir = STATE_DIR,
  statePath = STATE_PATH,
  writer: (path: string, data: string) => void = writeFileSync,
): boolean {
  invariant(typeof fp === "string" && fp.includes(":") && !fp.includes("\n"), `deploy-registration state key must be "<session>:…" on one line, got ${JSON.stringify(fp)}`);
  try {
    mkdirSync(stateDir, { recursive: true });
    let s: Set<string>;
    try {
      s = new Set(JSON.parse(readFileSync(statePath, "utf-8")) as string[]);
    } catch {
      s = new Set();
    }
    s.delete(fp);
    s.add(fp); // re-adding moves the key to the newest end, so the trim below keeps it
    writer(statePath, JSON.stringify([...s].slice(-STATE_MAX_KEYS)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The current turn's id: the promptId (else uuid) of the session's last real user prompt.
 * Stop-hook feedback, skill bodies and image notes arrive as isMeta user entries with the same
 * promptId, so a block's own recovery turn is the same turn and is never blocked twice.
 */
export function currentTurnId(raw: string, sessionId: string): string {
  let turn = "t0";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true || entry.sessionId !== sessionId) continue;
    const content = entry.message?.content;
    const isPrompt = typeof content === "string" ||
      (Array.isArray(content) && content.some((b: { type?: string }) => b?.type === "text") && !content.some((b: { type?: string }) => b?.type === "tool_result"));
    if (!isPrompt) continue;
    const id = typeof entry.promptId === "string" && entry.promptId ? entry.promptId : typeof entry.uuid === "string" ? entry.uuid : "";
    if (id) turn = id.replace(/[:\n]/g, "_");
  }
  return turn;
}

/**
 * Registration gaps for one served hostname. PROJECTS.md is checked on the apex
 * (one row per site); the scanner inventory must carry the exact hostname, as a
 * curated target `domain` or in its `aliases`, because the scanner and consumers
 * both see www.* as a distinct served host. Bunker adoption (2026-10-10) is the same leg the
 * workers.dev path has: some bunker.config.ts whose url host or `aliases` names this host, www
 * folded. `bunkerConfigs` null = Bunker is not installed, so that leg is not required.
 */
export function registrationGaps(host: string, projects: string, inventory: string | null, bunkerConfigs: string | null = null): string[] {
  const apex = host.replace(/^www\./, "");
  const missing: string[] = [];
  if (!projectsHosts(projects).has(apex.toLowerCase())) missing.push("PROJECTS.md row (+ routing alias)");
  if (inventory !== null && !inventoryHosts(inventory).has(host.toLowerCase())) {
    missing.push(
      host === apex
        ? "infra-inventory.ts curated target (then redeploy the infra-security workers)"
        : `infra-inventory.ts aliases: ["${host}"] on the ${apex} target (then redeploy the infra-security workers)`,
    );
  }
  if (bunkerConfigs !== null && !bunkerAdopted(host, bunkerConfigs)) {
    missing.push(
      `Bunker adoption (a bunker.config.ts with url "https://${apex}", or "${apex}" in an existing app's aliases; ` +
        `an asset with no repo gets its own directory under LIFEOS/USER/ASSETS/ with ISA.md + bunker.config.ts)`,
    );
  }
  return missing;
}

/** True when any PROJECTS.md line names this apex as a whole host token and opts out of both analytics legs. */
export function analyticsOptedOut(projects: string, apex: string): boolean {
  const escapedApex = apex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hostToken = new RegExp(`(^|[^a-z0-9.-])${escapedApex}(?![a-z0-9.-])`, "i");
  return projects.split("\n").some((line) => {
    if (!line.trimStart().startsWith("|")) return false;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const domainCell = cells[2];
    return domainCell !== undefined && /no-analytics/i.test(domainCell) && hostToken.test(domainCell);
  });
}

export interface AnalyticsProbe {
  scriptFound: boolean;
  /** null when no tracker script was found to check; false = fetched but SOURCE doesn't match the apex. */
  sourceMatches: boolean | null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Response bodies read by the probes stop at this many bytes (2026-10-13 audit, finding 22). */
const BODY_CAP_BYTES = 2 * 1024 * 1024;

/** A response body as text, never more than `cap` bytes of it. */
export async function readTextCapped(response: Response, cap = BODY_CAP_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.subarray(0, Math.min(value.byteLength, cap - total));
      chunks.push(take);
      total += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function allowedAnalyticsHost(hostname: string, deployedHost: string): boolean {
  const alternate = deployedHost.startsWith("www.") ? deployedHost.slice(4) : `www.${deployedHost}`;
  return hostname === deployedHost || hostname === alternate;
}

/**
 * True only for a globally routable unicast address. Loopback, private, link-local,
 * CGNAT, documentation, benchmarking, multicast and reserved ranges (v4 and v6, and v4
 * carried inside v6) are refused, so a host name printed in deploy output can never
 * steer a probe at this machine or its network.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    if (v4.slice(1).some((p) => Number(p) > 255)) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!v6.includes(":")) return false; // neither form: not an address we can vouch for
  const dotted = v6.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    // v4 carried in v6 (mapped, compatible, NAT64) is judged as the v4 it carries; any other dotted tail is refused
    return ["::ffff:", "::", "0:0:0:0:0:ffff:", "64:ff9b::"].includes(dotted[1]) && isPublicAddress(dotted[2]);
  }
  if (/^::ffff:/.test(v6) || /^64:ff9b:/.test(v6)) return false; // hex-form embedded v4: not vouched
  if (v6 === "::" || v6 === "::1") return false;
  const first = parseInt(v6.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 site local (deprecated)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0 || first === 0x100) return false; // ::/16 remnants, 100::/64 discard
  if (/^2001:0?db8:/.test(v6)) return false; // documentation
  return (first & 0xe000) === 0x2000; // only 2000::/3 is global unicast
}

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const dnsLookupAll: HostLookup = async (hostname) => {
  const { lookup } = await import("dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
};

/**
 * The egress the live probes use by default: https only, and the host of each request and each
 * redirect hop is resolved ONCE, every address it answers with must be public, and the connection
 * is pinned to the checked address through SafeFetch (original Host, SNI and certificate check), so
 * a rebinding resolver cannot answer the check with one address and the connect with another
 *. Unresolvable or any non-public answer throws, which the probes read as
 * "could not probe" (a gap, never a pass).
 * `inner` replaces the network entirely (tests that never connect): the request is checked the
 * same way and then handed to it. `pin` is a test seam for the pinned path (reach a loopback test
 * server, trust a test CA); production passes neither, so only public addresses are reachable.
 */
export function publicOnlyFetch(
  lookupAll: HostLookup = dnsLookupAll,
  inner?: typeof fetch,
  pin: Pick<SafeFetchOptions, "allow" | "tls"> = {},
): typeof fetch {
  const resolve = async (host: string): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answers = await Promise.race([
      lookupAll(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("probe egress: dns timeout")), PROBE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!Array.isArray(answers) || answers.length === 0) throw new Error("probe egress: host did not resolve");
    const addresses = answers.map((a) => a?.address);
    for (const a of addresses) {
      if (typeof a !== "string") throw new Error("probe egress: host answered with something that is not an address");
      if (!pin.allow && !isPublicAddress(a)) throw new Error("probe egress: host resolves to a non-public address");
    }
    return addresses as string[];
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") throw new Error("probe egress: https only");
    if (inner) {
      await resolve(url.hostname.replace(/^\[|\]$/g, ""));
      return inner(input as never, init);
    }
    return safeFetch(input, init ?? {}, { resolve, httpsOnly: true, timeoutMs: PROBE_TIMEOUT_MS * 2, ...pin });
  }) as typeof fetch;
}

const PROBE_FETCH = publicOnlyFetch();

async function fetchAnalyticsUrl(
  initialUrl: URL,
  deployedHost: string,
  fetcher: typeof fetch,
  method: "GET" | "HEAD" = "GET",
  acceptAuthWall = false,
): Promise<{ response: Response; finalUrl: URL } | null> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
    if (!allowedAnalyticsHost(url.hostname, deployedHost)) return null;
    const response = await fetcher(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      const authWall = acceptAuthWall && (response.status === 401 || response.status === 403);
      return response.ok || authWall ? { response, finalUrl: url } : null;
    }
    if (redirects === 3) return null;
    const location = response.headers.get("location");
    if (!location) return null;
    url = new URL(location, url);
  }
  return null;
}

function stripComments(source: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      result += char;
      if (char === "\\" && i + 1 < source.length) result += source[++i];
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
    } else if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      result += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
    } else {
      result += char;
    }
  }
  return result;
}

/** Live probe: does the deployed page reference an analytics tracker, and does its SOURCE match the apex? Null on any error (fail open). */
export async function probeAnalytics(
  domain: string,
  fetcher: typeof fetch = PROBE_FETCH,
): Promise<AnalyticsProbe | null> {
  try {
    const page = await fetchAnalyticsUrl(new URL(`https://${domain}/`), domain, fetcher);
    if (!page) return null;
    const html = (await readTextCapped(page.response)).replace(/<!--[\s\S]*?-->/g, "");
    let trackerUrl: URL | null = null;
    for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
      const src = tag[0].match(/(?:^|\s)src\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (src === undefined) continue;
      const resolved = new URL(src, page.finalUrl);
      if (resolved.pathname.endsWith("/analytics.js")) {
        trackerUrl = resolved;
        break;
      }
    }
    if (!trackerUrl) return { scriptFound: false, sourceMatches: null };
    if (trackerUrl.protocol !== "https:" || !allowedAnalyticsHost(trackerUrl.hostname, domain)) {
      return { scriptFound: true, sourceMatches: null };
    }
    const tracker = await fetchAnalyticsUrl(trackerUrl, domain, fetcher);
    if (!tracker) return { scriptFound: true, sourceMatches: null };
    const trackerSrc = stripComments(await readTextCapped(tracker.response));
    const apex = domain.replace(/^www\./, "");
    const sourceMatch = trackerSrc.match(/(?:\b(?:const|let|var)\s+)?\bSOURCE\s*=\s*(['"])(.*?)\1/);
    return { scriptFound: true, sourceMatches: sourceMatch ? sourceMatch[2] === apex : false };
  } catch {
    return null;
  }
}

/** Names what's wrong with the analytics wiring on this probe result; empty when fine. */
export function analyticsGaps(p: AnalyticsProbe): string[] {
  if (!p.scriptFound) return ["analytics tracker script not found in page head"];
  if (p.sourceMatches === false) return ["analytics tracker SOURCE does not match the domain's apex"];
  // Unverified is not verified: an off-host, non-https or unreadable tracker proves nothing
  // (2026-10-13 audit, finding 21).
  if (p.sourceMatches !== true) return ["analytics tracker SOURCE could not be verified (tracker off-host, not https, or unreadable)"];
  return [];
}

export interface AnalyticsRegistryConfig {
  project: string;
  files: { path: string; label: string; enclosingObject?: string }[];
}
export interface AnalyticsRegistryFile {
  label: string;
  enclosingObject?: string;
  source: string;
}

/** Absent or invalid USER config skips only the registry leg. */
export function parseAnalyticsRegistryConfig(source: string | null): AnalyticsRegistryConfig | null {
  try {
    if (source === null) return null;
    const config = JSON.parse(source);
    if (typeof config.project !== "string" || !config.project.trim() || !Array.isArray(config.files) || !config.files.length) return null;
    for (const file of config.files) {
      if (typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..") ||
          typeof file.label !== "string" || !file.label.trim() ||
          (file.enclosingObject !== undefined && (typeof file.enclosingObject !== "string" || !/^[A-Za-z_$][\w$]*$/.test(file.enclosingObject)))) return null;
    }
    return config;
  } catch { return null; }
}

/** Resolve the configured exact projects-table row; home is injected. */
export function resolveAnalyticsRegistryDir(projects: string, project: string, home: string): string | null {
  for (const line of projects.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells[0]?.replace(/^\*\*|\*\*$/g, "") !== project) continue;
    const path = cells[1]?.match(/^\x60([^\x60]+)\x60$/)?.[1];
    if (path) return path.startsWith("~/") ? join(home, path.slice(2)) : path;
  }
  return null;
}

/** Injected I/O: absent repo skips; absent file is a gap; read errors skip the leg. */
export function readAnalyticsRegistryFiles(
  dir: string | null, config: AnalyticsRegistryConfig | null,
  reader: (path: string, encoding: "utf-8") => string,
  exists: (path: string) => boolean,
): AnalyticsRegistryFile[] | null {
  try {
    if (config === null || dir === null || !exists(dir)) return null;
    return config.files.map(file => ({ label: file.label, enclosingObject: file.enclosingObject,
      source: exists(join(dir, file.path)) ? reader(join(dir, file.path), "utf-8") : "" }));
  } catch { return null; }
}

/** Exact quoted values excluding comments and unrelated objects. */
export function analyticsRegistryGaps(apex: string, files: AnalyticsRegistryFile[] | null): string[] {
  try {
    if (files === null) return [];
    const quotedLiteral = (source: string): boolean => {
      const escaped = apex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(["'])${escaped}\\1`).test(source);
    };
    const enclosingObjectBody = (source: string, name: string): string | null => {
      const clean = stripComments(source);
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const nameIndex = clean.search(new RegExp("(?<![\\w$])" + escapedName + "(?![\\w$])"));
      if (nameIndex < 0) return null;
      const equalsIndex = clean.indexOf("=", nameIndex);
      const openIndex = equalsIndex < 0 ? -1 : clean.indexOf("{", equalsIndex);
      if (openIndex < 0) return null;
      let depth = 0;
      let quote: "'" | '"' | "`" | null = null;
      for (let i = openIndex; i < clean.length; i++) {
        const char = clean[i];
        if (quote) {
          if (char === "\\") i++;
          else if (char === quote) quote = null;
        } else if (char === "'" || char === '"' || char === "`") {
          quote = char;
        } else if (char === "{") {
          depth++;
        } else if (char === "}" && --depth === 0) {
          return clean.slice(openIndex + 1, i);
        }
      }
      return null;
    };
    return files.filter(file => {
      const source = file.enclosingObject ? enclosingObjectBody(file.source, file.enclosingObject) : stripComments(file.source);
      return source === null || !quotedLiteral(source);
    }).map(file => file.label);
  } catch { return []; }
}

/**
 * TranscriptParser answers a read error with an empty transcript, so empty text is evidence only
 * when the file really is an empty file; anything else (missing, not a file, unreadable bytes) throws.
 */
function assertTranscriptEmpty(path: unknown): void {
  if (typeof path !== "string" || !path) throw new Error("no transcript path, so deployment evidence is unavailable");
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch (err) {
    throw new Error(`transcript unreadable (${(err as Error)?.code ?? (err as Error)?.message ?? "error"}), so deployment evidence is unavailable`);
  }
  if (size > 0) throw new Error("transcript has content but could not be parsed, so deployment evidence is unavailable");
}

export async function run(
  input: NonNullable<Awaited<ReturnType<typeof readHookInput>>>,
): Promise<object | null> {
  // Hosts this turn's paired deploy calls printed; set once the scan has found any, so an
  // error after that point is a deployment that could not be evaluated.
  let detected: string[] = [];
  // Discovery is an enforce gate (security P1 batch 2, S037): a transcript that cannot be read
  // is deployment evidence that is unavailable, never a clean turn, so it holds the stop once
  // with the reason. The re-stop right after passes (the harness loop guard), so a persistent
  // read failure costs one retry per turn, never a wedge. Records the scan could not read (a line
  // that is not JSON, a paired deploy result with unreadable content) are the same: the deploys that
  // were found are still checked first, and then the stop is held once for what could not be seen.
  const found = await runGate("enforce", "DeployRegistrationGate", async () => {
    const parsed = await parseTranscriptFromInput(input);
    if (!parsed.raw) assertTranscriptEmpty(input.transcript_path);
    return { t: parsed, ...scanDeploys(parsed.raw, input.session_id) };
  });
  const stopActive = (input as { stop_hook_active?: unknown }).stop_hook_active === true;
  const unavailable = found.status === "failed" ? found.reason
    : found.value.unreadable > 0 ? `${found.value.unreadable} transcript record(s) could not be read.` : null;
  const hold = (): object | null => (unavailable === null || stopActive ? null : {
    decision: "block",
    reason: `DEPLOY EVIDENCE UNAVAILABLE. ${unavailable} The session transcript could not be read in full, so this turn's deploys ` +
      `were never all checked for registration and hardening. If this turn deployed a public site, confirm its PROJECTS.md row, ` +
      `analytics, edge hardening and Bunker adoption, then restate.`,
  });
  if (found.status === "failed") return hold();
  try {
    const { t, custom: domains, workersDev, lastDeploy } = found.value;
    if (domains.length === 0 && workersDev.length === 0) return hold();
    detected = [...domains, ...workersDev];

    const projects = existsSync(PROJECTS_MD) ? readFileSync(PROJECTS_MD, "utf-8") : "";
    // Optional customization: absent file → check not required on this install.
    const inventory = readInventory(INVENTORY_TS);
    let registryFiles: AnalyticsRegistryFile[] | null = null;
    // Not configured skips the leg; configured but unusable is a gap (2026-10-13 audit, finding 23).
    let registryUnavailable: string | null = null;
    try {
      const raw = existsSync(REGISTRY_CONFIG) ? readFileSync(REGISTRY_CONFIG, "utf-8") : null;
      const config = parseAnalyticsRegistryConfig(raw);
      if (analyticsRegistryConfigured(raw)) {
        if (!config) registryUnavailable = "the analytics registry config in deploy-registration-gate.json is invalid";
        else {
          const dir = resolveAnalyticsRegistryDir(projects, config.project, homedir());
          registryFiles = readAnalyticsRegistryFiles(dir, config, readFileSync, existsSync);
          if (registryFiles === null) registryUnavailable = `the ${config.project} registry repo is missing from PROJECTS.md or unreadable`;
        }
      }
    } catch {
      if (existsSync(REGISTRY_CONFIG)) registryUnavailable = "deploy-registration-gate.json could not be read";
    }
    const seen = blockedSet();
    const sid = (input as { session_id?: string }).session_id ?? "s";
    // 2026-10-09 (rule-enforcer audit): state is keyed per TURN, not per session. A host with
    // gaps blocks once in each turn until a check comes back clean. A clean host is marked clean
    // for the deploy that printed it (review-code row 12): a later redeploy of the same host is a
    // new deploy id, so it is probed again, at most once per turn.
    const turn = currentTurnId(t.raw, sid);
    // Read once per run, shared by both legs. null = Bunker not installed: adoption not required.
    let bunkerConfigsCache: string | null | undefined;
    const bunkerConfigsOnce = () => (bunkerConfigsCache === undefined ? (bunkerConfigsCache = readBunkerConfigs()) : bunkerConfigsCache);

    for (const d of domains) {
      const cleanKey = `${sid}:clean:${d}:${lastDeploy[d] ?? "unknown"}`;
      if (seen.has(cleanKey)) continue;
      const fp = `${sid}:${turn}:${d}`;
      if (seen.has(fp)) continue;
      const apex = d.replace(/^www\./, "");
      const missing: string[] = registrationGaps(d, projects, inventory, bunkerConfigsOnce());

      if (!analyticsOptedOut(projects, apex)) {
        const analytics = await probeAnalytics(d);
        if (analytics) {
          const aGaps = analyticsGaps(analytics);
          if (aGaps.length)
            missing.push(`analytics — ${aGaps.join("; ")} (ship assets/analytics.js with SOURCE = "${apex}")`);
        } else {
          // A probe that could not read the page proves nothing, so it is a gap, not a pass.
          missing.push(`analytics — probe could not read https://${d}/ (unreachable, non-2xx, or redirected off-host); fix the page, or mark the PROJECTS.md domain cell no-analytics if this host serves no pages`);
        }

        if (registryUnavailable) missing.push(`Analytics registries could not be checked: ${registryUnavailable}`);
        const registryGaps = analyticsRegistryGaps(apex, registryFiles);
        if (registryGaps.length) missing.push(`Analytics registries missing "${apex}": ${registryGaps.join(", ")} (then redeploy the analytics registry)`);
      }

      if (existsSync(SWEEP_TOOL)) {
        const gaps = await hardeningGapsWithRetry(d);
        if (gaps === null)
          missing.push(`edge hardening — live probe could not complete (HEAD https://${d}/ or the DoH SPF lookup failed); rerun once the site answers`);
        else if (gaps.length)
          missing.push(`edge hardening — live probe missing ${gaps.join("+")}; run \`${SWEEP_CMD}\` (idempotent, account-wide)`);
      }
      if (missing.length) {
        // A failed state write never cancels a block already decided; it only means the
        // next turn probes again (2026-10-13 audit, finding 19).
        recordBlocked(fp);
        return {
          decision: "block",
          reason:
            `UNREGISTERED PUBLIC DEPLOY. This session deployed a worker with the custom domain ` +
            `"${d}", but it is not fully registered/hardened: ${missing.join(" AND ")}. Every public site is registered in the same ` +
            `motion as its deploy: add the missing registration(s), run ` +
            `\`bunker adopt\` + \`bunker sync-cloud --deploy\` if not yet adopted (where Bunker is installed; it is not in the public release payload), then restate. ` +
            `Fires once per turn, and again at the end of every later turn until the check comes back clean.`,
        };
      }
      recordBlocked(cleanKey); // best effort: a failed write only means one more probe next turn
    }

    // workers.dev-only workers (2026-10-06, a worker shipped unenrolled): one block for
    // every gap this turn, so a fleet deploy asks once, not once per worker; it asks again
    // next turn while any gap remains.
    const fresh = workersDev.filter((h) => !seen.has(`${sid}:${turn}:${h}`));
    if (fresh.length) {
      const bunkerConfigs = bunkerConfigsOnce();
      const exemptions = parseWorkersDevExemptions(existsSync(REGISTRY_CONFIG) ? readFileSync(REGISTRY_CONFIG, "utf-8") : null);
      const gaps = fresh
        .map((h) => ({ h, missing: workersDevGaps(h, projects, inventory, bunkerConfigs, exemptions) }))
        .filter((g) => g.missing.length);
      if (gaps.length) {
        for (const g of gaps) recordBlocked(`${sid}:${turn}:${g.h}`); // best effort: the block stands either way (finding 19)
        return {
          decision: "block",
          reason:
            `UNCLASSIFIED PUBLIC WORKER. This session deployed workers.dev worker(s) that answer on the public internet but are not ` +
            `enrolled. Fix it in this turn by enrolling or exempting each one: ${gaps.map((g) => `"${g.h}" missing ${g.missing.join(" AND ")}`).join("; ")}. A public endpoint gets every missing registration; a worker that needs none (bearer-gated fleet, internal-only) gets a ` +
            `\`workersDevExempt\` entry {prefix, reason} in USER/CONFIG/deploy-registration-gate.json. Atlas picks it up on its own. ` +
            `Fires once per turn, and again at the end of every later turn until every host is enrolled or exempt.`,
        };
      }
    }
    return hold();
  } catch (err) {
    if ((err as Error)?.name === "InvariantViolation") throw err;
    // Once a deploy was found, an error means its registration and hardening were never
    // checked: hold the stop once. The re-stop right after this block passes (the harness
    // loop guard), so a persistent error costs one retry, never a wedge.
    // Before any deploy was found, only unreadable evidence holds the stop (S037).
    console.error("[DeployRegistrationGate] error:", err);
    if (stopActive) return null;
    if (!detected.length) return hold();
    const hostList = detected.slice(0, 5).map((h) => `"${h}"`).join(", ") + (detected.length > 5 ? ` and ${detected.length - 5} more` : "");
    return {
      decision: "block",
      reason:
        `DEPLOY REGISTRATION UNCHECKED. This session deployed ${hostList}, but the registration and hardening check failed ` +
        `(${String((err as Error)?.name ?? "error")}: ${String((err as Error)?.message ?? err).slice(0, 160)}). ` +
        `Confirm each host has its PROJECTS.md row, analytics, edge hardening and Bunker adoption, or fix what broke the check, then restate.`,
    };
  }
}

// Standalone shim
if (import.meta.main) {
  (async () => {
    const input = await readHookInput();
    if (!input) process.exit(0);
    const d = await run(input);
    if (d) console.log(JSON.stringify(d));
    process.exit(0);
  })();
}
