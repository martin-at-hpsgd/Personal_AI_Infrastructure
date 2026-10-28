import type { State } from "../State";
import { mtime, type Cache } from "../Cache";
import type { RefreshJob } from "./Background";

export interface VersionDeps {
  /** `claude --version`, first line, first field; empty when unavailable. */
  cli: () => Promise<string>;
}

const VERSION_FILE = "cc-version-cache.txt";
const PROBE_STAMP = "cc-version-probe.stamp";

const liveCli = async (): Promise<string> => {
  const claude = Bun.which("claude");
  if (!claude) return "";
  try {
    const child = Bun.spawn([claude, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 5000);
    try { return ((await new Response(child.stdout).text()).split("\n")[0] ?? "").trim().split(/\s+/)[0] ?? ""; }
    finally { clearTimeout(timer); }
  } catch { return ""; }
};

/** find -mtime +1 means two whole days: a cached version one whole day old still serves. */
const cachedVersionFresh = (cache: Cache): boolean =>
  cache.text(VERSION_FILE) !== null && Math.floor((cache.now - mtime(cache.path(VERSION_FILE))) / 86400) <= 1;

/**
 * Render half. The harness hands the live Claude Code version in stdin, which wins and is cached; the
 * host-local cache is the fallback for harnesses that omit it. The render never asks the CLI: the scheduled refresher keeps
 * the cache fresh (harnessVersionRefresh). Writes the version and shared model-name caches; returns the version it settled on.
 */
export function prepareVersions(state: State): string {
  const { cache } = state;
  let version = state.ccVersionJson;
  if (version) cache.put(VERSION_FILE, `${version}\n`);
  else if (cachedVersionFresh(cache)) version = (cache.text(VERSION_FILE) ?? "").replace(/\n+$/, "");
  if (!version) version = "unknown";
  state.versions.harness = version;
  // Last-writer-wins and not authoritative: it only serves this statusline's own next tick.
  cache.put("model-cache.txt", `${state.model}\n`);
  return version;
}

/**
 * CLI half. When no render has cached a version within the window, ask the CLI. A CLI with nothing to say is
 * asked at most once every five minutes, so a missing binary costs one probe per stamp rather than one per run.
 */
export function harnessVersionRefresh(cache: Cache, deps: VersionDeps = { cli: liveCli }): RefreshJob | null {
  if (cachedVersionFresh(cache)) return null;
  if (cache.now - mtime(cache.path(PROBE_STAMP)) < 300) return null;
  return {
    name: "cc-version",
    async run() {
      const version = await deps.cli();
      if (version) cache.put(VERSION_FILE, `${version}\n`);
      else cache.put(PROBE_STAMP, `${cache.now}\n`);
    },
  };
}
