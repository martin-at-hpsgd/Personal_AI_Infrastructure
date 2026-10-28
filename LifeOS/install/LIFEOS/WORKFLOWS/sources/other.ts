import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { card, cronTrigger, parseJsonc, record } from "./shared.ts";
import type { SopRecord, WorkflowRecord } from "../types.ts";

/**
 * The worker name and cron schedules of a `cloudflare.config.ts`, read from its text
 * (`name: "…"` and `triggers.scheduled({ schedule: "…" })`). The file is never imported:
 * inventorying a repo must not run its code. Returns the same shape the wrangler
 * configs parse to, so the collector below treats both alike.
 */
export function cloudflareConfigView(raw: string): { name?: string; triggers: { crons: string[] } } {
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const name = /\bname\s*:\s*["'`]([^"'`]+)["'`]/.exec(code)?.[1];
  const crons = [...code.matchAll(/\bschedule\s*:\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]);
  return { ...(name ? { name } : {}), triggers: { crons } };
}

/** readdirSync that retries a signal-interrupted scandir. Inside Pulse, a child exiting
 *  mid-scan surfaced as `EINTR: interrupted system call, scandir` on every request and
 *  blanked the whole inventory (2026-09-29). */
export function readdirRetry(path: string, read: (p: string) => string[] = readdirSync, attempts = 5): string[] {
  for (let i = 1; ; i++) {
    try { return read(path); } catch (e) {
      if (i >= attempts || (e as NodeJS.ErrnoException)?.code !== "EINTR") throw e;
    }
  }
}

export function collectProjects(roots: string[], shown: (path: string) => string, error: (source: string, message: string) => void): WorkflowRecord[] {
  const out: WorkflowRecord[] = [];
  const byCron = new Map<string, WorkflowRecord>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[];
    // One unreadable root is one error row, never the whole inventory.
    try { dirs = readdirRetry(root); } catch (e) { error(shown(root), String(e)); continue; }
    for (const dir of dirs) {
      const base = join(root, dir);
      try { if (!statSync(base).isDirectory()) continue; } catch { continue; }
      const file = ["cloudflare.config.ts", "wrangler.toml", "wrangler.jsonc", "wrangler.json"].map(f => join(base, f)).find(existsSync);
      if (!file) continue;
      try {
        const raw = readFileSync(file, "utf8");
        const cfg = file.endsWith(".ts") ? cloudflareConfigView(raw) as any : file.endsWith(".toml") ? Bun.TOML.parse(raw) as any : parseJsonc(raw) as any;
        const groups: Array<[string, string[]]> = [["", cfg.triggers?.crons ?? []]];
        for (const [name, env] of Object.entries(cfg.env ?? {})) groups.push([name, (env as any)?.triggers?.crons ?? []]);
        for (const [env, crons] of groups) crons.forEach((expr, i) => {
          const trigger = cronTrigger(expr);
          const configName = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : null;
          const worker = configName ?? shown(base);
          const named = env ? (cfg.env?.[env]?.name ?? `${configName ?? dir} (${env})`) : configName ?? dir;
          const title = `${String(named).trim()} · ${trigger.display}`;
          const key = JSON.stringify([worker, env, expr]);
          const checkout = shown(base);
          const existing = byCron.get(key);
          if (existing) {
            if (!existing.seenIn?.includes(checkout)) existing.seenIn?.push(checkout);
            return;
          }
          // A LifeOS subsystem keeps its Worker in a folder named for its role (`LIFEOS/LOCATION/worker`), so the id names the subsystem too.
          const idDir = basename(dirname(root)) === "LIFEOS" ? `${basename(root)}/${dir}` : dir;
          const item = record("project-cron", `${idDir}${env ? `:${env}` : ""}:${i + 1}`, title, dir, trigger, checkout,
            { seenIn: [checkout] });
          byCron.set(key, item);
          out.push(item);
        });
      } catch (e) { error(shown(file), String(e)); }
    }
  }
  return out;
}
export function collectSkills(root: string, shown: (path: string) => string, error: (source: string, message: string) => void): WorkflowRecord[] {
  const out: WorkflowRecord[] = [];
  if (!existsSync(root)) return out;
  for (const skill of readdirSync(root)) {
    const workflows = join(root, skill, "Intents");
    if (!existsSync(workflows)) continue;
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        try {
          if (statSync(file).isDirectory()) { visit(file); continue; }
          if (!name.endsWith(".md")) continue;
          const lines = readFileSync(file, "utf8").split("\n");
          const purpose = lines.map(l => l.trim()).find(l => l && !/^(#|```|~~~|<!--|-->)/.test(l)) ?? null;
          const id = `${skill}/${relative(workflows, file).replace(/\.md$/, "")}`;
          out.push(record("skill", id, basename(file, ".md"), skill, { kind: "on-demand", expr: null, display: "on demand", periodMinutes: null }, shown(file),
            { installed: "n/a", card: card({ purpose, steps: [] }) }));
        } catch (e) { error(shown(file), String(e)); }
      }
    };
    visit(workflows);
  }
  return out;
}
export function collectSops(root: string, shown: (path: string) => string, error: (source: string, message: string) => void): SopRecord[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(f => f.endsWith(".md")).flatMap(f => {
    const file = join(root, f);
    try {
      const title = /^# (.+)$/m.exec(readFileSync(file, "utf8"))?.[1] ?? basename(f, ".md");
      return [{ id: basename(f, ".md"), title: title.slice(0, 200), path: shown(file), usedBy: [] }];
    } catch (e) { error(shown(file), String(e)); return []; }
  });
}
