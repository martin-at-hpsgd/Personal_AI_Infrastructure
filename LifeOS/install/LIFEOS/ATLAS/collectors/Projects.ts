/**
 * Projects collector — parses PROJECTS.md's main table (deployed/live apps routing table).
 * Observes projects and links them to the domains they serve and repos they deploy from.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AssetObs, CollectResult, Collector, EdgeObs } from "../Store";

const PROJECTS_PATH = join(homedir(), ".claude/LIFEOS/USER/PROJECTS.md");

const strip = (s: string) => s.replace(/\*\*/g, "").replace(/[🟡🟢🎯🚨⚠️]/gu, "").trim();

/**
 * Served hostnames in a PROJECTS.md URL cell. Only what the row SERVES:
 * parenthetical notes are dropped whole (they hold legacy 301 hosts, lost
 * domains, price tags), a host needs an alphabetic TLD (`9.95` is a price),
 * and a token preceded by `/` is a path segment (`/Applications/Example.app`).
 * Found when `atlas unregistered` listed version strings, an app bundle name and a
 * domain a third party owns.
 */
export function hostsFromUrlCell(cell: string): string[] {
  const out: string[] = [];
  // A scheme ("https://") is dropped first: the "/" boundary below exists to skip path tokens,
  // and it would otherwise skip the host of every full URL too.
  const noParens = cell.replace(/\([^)]*\)/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\//gi, " ");
  for (const m of noParens.matchAll(/(^|[^\/\w.-])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*)(?![\w.-])/gi)) {
    const host = m[2].toLowerCase();
    if (host.includes("localhost") || host.endsWith(".lan") || host.startsWith("github.com")) continue;
    if (host === "workers.dev") continue;
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export const projects: Collector = {
  name: "projects",
  async collect(): Promise<CollectResult> {
  // Absent source ⇒ degrade, never throw (ratchet gate 3). `atlas sync` runs
  // every collector and turns the failure count into its exit code, so throwing
  // because this machine simply lacks the source makes sync exit non-zero forever
  // on most public installs. A source that EXISTS but parses to zero rows is
  // reported partial (complete: false) below, so Atlas never sweeps on it.
    if (!existsSync(PROJECTS_PATH)) return { complete: false, assets: [], edges: [] };
    const md = readFileSync(PROJECTS_PATH, "utf8");
    const assets: AssetObs[] = [];
    const edges: EdgeObs[] = [];

    // Main table only (stop at "## Routing Aliases").
    const main = md.split(/^## Routing Aliases/m)[0];
    const rows = main.split("\n").filter((l) => /^\|/.test(l)).slice(2); // drop header + separator

    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
      if (cells.length < 4) continue;
      const name = strip(cells[0].split("(")[0]).replace(/\s+WIP.*$/, "").trim();
      if (!name) continue;
      const key = `project:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      assets.push({ kind: "project", key, name, attrs: { path: strip(cells[1]).slice(0, 200), deploy: strip(cells[3]).slice(0, 120) } });

      // URL column → served domains (skip localhost, ssh hosts, parenthetical notes).
      const urlCell = cells[2] ?? "";
      for (const host of hostsFromUrlCell(urlCell)) {
        edges.push({ kind: "SERVES", srcKey: key, dstKey: `domain:${host}`, srcKind: "project", dstKind: "domain" });
      }
      // github.com/owner/repo anywhere in the row → DEPLOYED_FROM.
      for (const m of row.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
        edges.push({
          kind: "DEPLOYED_FROM",
          srcKey: key,
          dstKey: `github:repo:${m[1]}/${m[2].replace(/\.git$/, "")}`,
          srcKind: "project",
          dstKind: "repo",
        });
      }
    }
    // A PROJECTS.md that exists but yields zero rows was reshaped, not emptied.
    // A complete run is the only thing allowed to sweep, so report partial.
    // public issue #2219, @timrutzen
    if (assets.length === 0) return { complete: false, assets, edges };
    return { complete: true, assets, edges };
  },
};
