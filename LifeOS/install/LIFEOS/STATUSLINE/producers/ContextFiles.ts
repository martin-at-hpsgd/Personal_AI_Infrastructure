import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readText } from "../Cache";
import type { State } from "../State";

export interface ContextFile { bytes: number; name: string }

const CACHE = "ctx-sizes.txt";

/** The CLAUDE.md lines starting with "@", the marker stripped: the startup @-imports (paths relative to the claude dir). */
export function claudeImports(state: State): string[] {
  const text = readText(join(state.claude, "CLAUDE.md"));
  return text === null ? [] : text.split("\n").filter(line => line.startsWith("@")).map(line => line.slice(1)).filter(Boolean);
}

/** `wc -c`: the byte size of a plain file, 0 when unreadable. */
function size(path: string): number { try { return statSync(path).size; } catch { return 0; } }

/**
 * Startup files with their byte sizes, largest first. Sizes are the same for every session and
 * change only when a file does, so one machine-wide file ("<written epoch>" then "<bytes><TAB><path>" lines) is
 * reused per file while that file is not newer than the cache; it expires 300 s after it was first written.
 */
export function contextFiles(state: State): ContextFile[] {
  const { cache, now } = state;
  const known = new Map<string, number>();
  let epoch: number | null = null;
  let cacheMs = 0;
  try {
    const info = statSync(cache.path(CACHE));
    if (info.uid === process.getuid?.()) {
      const [head, ...body] = (cache.text(CACHE) ?? "").split("\n");
      if (/^[1-9][0-9]*$/.test(head) && now - Number(head) >= 0 && now - Number(head) < 300) {
        epoch = Number(head);
        cacheMs = info.mtimeMs;
        for (const line of body) {
          const m = /^([0-9]+)\t(.+)$/.exec(line);
          if (m && !known.has(m[2])) known.set(m[2], Number(m[1]));
        }
      }
    }
  } catch { /* no cache */ }
  let missed = false;
  const fresh: string[] = [];
  const found: ContextFile[] = [];
  const collect = (path: string, name: string): void => {
    if (!existsSync(path) || !statSync(path).isFile()) return;
    let bytes = known.get(path);
    if (bytes === undefined || statSync(path).mtimeMs > cacheMs) { bytes = size(path); missed = true; }
    fresh.push(`${bytes}\t${path}`);
    found.push({ bytes, name });
  };
  collect(join(state.root, "LIFEOS_SYSTEM_PROMPT.md"), "LIFEOS_SYSTEM_PROMPT.md");
  collect(join(state.claude, "CLAUDE.md"), "CLAUDE.md");
  for (const rel of claudeImports(state)) collect(`${state.claude}/${rel}`, basename(rel));
  // A path carrying a tab or newline is never cached.
  if (missed && fresh.length > 0 && fresh.every(entry => entry.split("\t").length === 2 && !entry.includes("\n"))) {
    cache.put(CACHE, `${epoch ?? now}\n${fresh.join("\n")}\n`);
  }
  // sort -rn on the byte column; ties fall back to the whole line, reversed.
  return found.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// SKILL.md files the bash globbed: one level under skills/, and under each plugin's skills/.
function skillFiles(claude: string): string[] {
  const out: string[] = [];
  const dirs = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };
  for (const skill of dirs(join(claude, "skills"))) out.push(join(claude, "skills", skill, "SKILL.md"));
  for (const plugin of dirs(join(claude, ".plugins"))) for (const skill of dirs(join(claude, ".plugins", plugin, "skills"))) out.push(join(claude, ".plugins", plugin, "skills", skill, "SKILL.md"));
  return out.filter(path => existsSync(path));
}

/** The listing attachments Claude Code sends before the first prompt; together they are the harness share of the startup load. */
const LISTINGS = new Set(["skill_listing", "agent_listing_delta", "mcp_instructions_delta"]);
const LISTING_SCAN = 4 * 1024 * 1024;

/**
 * Bytes of the skill, agent and MCP listings exactly as Claude Code sent them this session, read from the
 * transcript's first-turn attachments: every skill entry (ours, commands, plugins, built-ins), not a
 * re-derivation from SKILL.md files. Null until the transcript carries the skill listing.
 */
export function harnessListingBytes(lines: string[]): number | null {
  let total = 0, sawSkills = false;
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "user" && typeof entry.message?.content === "string" && sawSkills) break; // first real prompt
    const attachment = entry.type === "attachment" ? entry.attachment ?? {} : null;
    if (!attachment || !LISTINGS.has(attachment.type)) continue;
    if (attachment.type === "skill_listing") { if (sawSkills) continue; sawSkills = true; total += Buffer.byteLength(String(attachment.content ?? "")); }
    else if (attachment.type === "agent_listing_delta") total += Buffer.byteLength((attachment.addedLines ?? []).join("\n"));
    else total += Buffer.byteLength(JSON.stringify(attachment.addedBlocks ?? []));
  }
  return sawSkills ? total : null;
}

/** Machine-wide: the last session's measured listing and the SKILL.md derivation taken at the same moment. */
const LAST_LISTING = "listing-size-last.sh";

/**
 * Before the first turn: the last measured listing, moved by however much the SKILL.md derivation has
 * changed since, so a new session opens at the figure it will settle on. The bare derivation misses the
 * agent and MCP listings, commands, plugin and built-in skills, which is why LD used to jump on load.
 */
function estimatedListingBytes(state: State): number {
  const derived = skillsDescriptionBytes(state);
  const last = state.cache.text(LAST_LISTING) ?? "";
  const listing = /^_listing_bytes=([0-9]+)$/m.exec(last), skills = /^_skills_total_bytes=([0-9]+)$/m.exec(last);
  return listing && skills ? Math.max(derived, Number(listing[1]) + derived - Number(skills[1])) : derived;
}

/** The startup listings' bytes: Claude Code's own first-turn listings when the transcript has them, else an estimate from the last measurement. */
export function listingBytes(state: State): number {
  const name = `listing-size-${state.session}.sh`;
  const cached = /^_listing_bytes=([0-9]+)$/m.exec(state.cache.text(name) ?? "");
  if (cached) return Number(cached[1]);
  let measured: number | null = null;
  if (state.transcript && existsSync(state.transcript)) {
    try {
      const fd = openSync(state.transcript, "r"), buffer = Buffer.alloc(Math.min(LISTING_SCAN, statSync(state.transcript).size));
      readSync(fd, buffer, 0, buffer.length, 0);
      closeSync(fd);
      measured = harnessListingBytes(buffer.toString("utf8").split("\n"));
    } catch { measured = null; }
  }
  if (measured === null) return estimatedListingBytes(state); // not cached: the listing lands on the first turn
  state.cache.put(name, `_listing_bytes=${measured}\n`);
  state.cache.put(LAST_LISTING, `_listing_bytes=${measured}\n_skills_total_bytes=${skillsDescriptionBytes(state)}\n`);
  return measured;
}

/** settings.json `skillOverrides`: a "name-only" skill loads its name without the description, an "off" skill loads nothing. */
export function skillOverrides(claude: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))?.skillOverrides;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

/**
 * Total bytes of the skill listing as it loads: 4 + the skill directory's name + the description
 * line, quotes trimmed, in bytes. A "name-only" override drops the description and an "off"
 * override drops the skill, so LD counts what the model receives. Session-cached; one pass per session.
 */
export function skillsDescriptionBytes(state: State): number {
  const name = `skills-size-${state.session}.sh`;
  const cached = /^_skills_total_bytes=([0-9]+)$/m.exec(state.cache.text(name) ?? "");
  if (cached) return Number(cached[1]);
  const overrides = skillOverrides(state.claude);
  let total = 0;
  for (const path of skillFiles(state.claude)) {
    const skill = basename(join(path, ".."));
    if (overrides[skill] === "off") continue;
    const line = (readText(path) ?? "").split("\n").find(l => l.startsWith("description:"));
    if (line === undefined) continue;
    const description = overrides[skill] === "name-only" ? "" : line.replace(/^description:[ \t\r\n\f\v]*"?/, "").replace(/"[ \t\r\n\f\v]*$/, "");
    total += 4 + Buffer.byteLength(skill) + Buffer.byteLength(description);
  }
  state.cache.put(name, `_skills_total_bytes=${total}\n`);
  return total;
}
