#!/usr/bin/env bun
/**
 * LocalModels — newest open-weight models on the Ollama library, diffed against
 * what a local Ollama host already has, with a VRAM fit estimate per model.
 *
 * Usage:
 *   bun LocalModels.ts                 # markdown table
 *   bun LocalModels.ts --json          # machine-readable
 *   bun LocalModels.ts --limit 40      # how many library entries to consider (default 30)
 *   bun LocalModels.ts --host <ssh>    # override the host from Config.md
 *   bun LocalModels.ts --local         # run ollama and the hardware probes on this machine, no ssh
 *
 * GPU memory comes from nvidia-smi (NVIDIA cards) or, on a Mac without one, from unified
 * memory (parseHostHardware in LocalModelsLib.ts). Other GPUs report no GPU info, so no
 * model is recommended for them.
 *
 * Host comes from LIFEOS/USER/CUSTOMIZATIONS/SKILLS/OpenSourceManagement/Config.md
 * (`## Local Model Host` table, key `ssh_host`). No hostnames live in this file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { lifeosPath } from "../../../LIFEOS/TOOLS/Paths.ts";
import { parseHostHardware, sizeToBillions, parseLibraryCards, parseOllamaList, strip, type GpuKind, type LibModel } from "./LocalModelsLib.ts";

const run = promisify(execFile);

// ---------------------------------------------------------------- config ---

type Config = { ssh_host?: string; ollama_bin?: string };

function loadConfig(): Config {
  const p = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "OpenSourceManagement", "Config.md");
  const cfg: Config = {};
  if (!existsSync(p)) return cfg;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\|\s*`?(\w+)`?\s*\|\s*(.+?)\s*\|$/);
    if (m && m[1] !== "Key") (cfg as Record<string, string>)[m[1]] = m[2];
  }
  return cfg;
}

// ----------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const JSON_OUT = flag("--json");
const LIMIT = Number(opt("--limit") ?? 30);
const LOCAL = flag("--local");
const cfg = loadConfig();
const HOST = opt("--host") ?? cfg.ssh_host;
const OLLAMA = cfg.ollama_bin ?? "ollama";

if (!LOCAL && !HOST) {
  console.error(
    "No host: set `ssh_host` in the Config.md `## Local Model Host` table, pass --host, or use --local.",
  );
  process.exit(2);
}

// ------------------------------------------------------------ library ------

/** Some library cards omit size tags. Try the model page's tag links first; if the
 *  tags are quant-only (q4_K_M, bf16…) fall back to prose like "33B total parameter". */
async function fetchSizes(name: string): Promise<{ sizes: string[]; tagged: boolean }> {
  try {
    const res = await fetch(`https://ollama.com/library/${name}`);
    if (!res.ok) return { sizes: [], tagged: false };
    const html = await res.text();
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`/library/${esc}:(\\d+(?:\\.\\d+)?[bm])\\b`, "gi");
    const tagged = [...new Set([...html.matchAll(re)].map((m) => m[1].toLowerCase()))];
    if (tagged.length) return { sizes: tagged, tagged: true };
    const text = strip(html);
    const prose =
      text.match(/(\d+(?:\.\d+)?)\s*B\s+(?:total\s+)?param/i)?.[1] ??
      text.match(/\b(\d+(?:\.\d+)?)B-A\d+B\b/i)?.[1]; // "118B-A8B" MoE shorthand
    return { sizes: prose ? [`${prose}b`] : [], tagged: false };
  } catch {
    return { sizes: [], tagged: false };
  }
}

async function fetchLibrary(): Promise<LibModel[]> {
  const res = await fetch("https://ollama.com/library?sort=newest");
  if (!res.ok) throw new Error(`ollama.com ${res.status}`);
  // parseLibraryCards throws when no card parses (layout change), so an empty library never reads as normal.
  const out = parseLibraryCards(await res.text(), LIMIT);
  // Second pass: cards with no size and no cloud tag get their sizes from the model page.
  await Promise.all(
    out
      .filter((m) => m.sizes.length === 0 && !m.capabilities.includes("cloud"))
      .map(async (m) => {
        const r = await fetchSizes(m.name);
        m.sizes = r.sizes;
        m.untaggedSize = !r.tagged && r.sizes.length > 0;
      }),
  );
  return out;
}

// --------------------------------------------------------------- host ------

type Host = { models: string[]; gpus: number[]; gpuKind: GpuKind; diskFreeGb: number };

async function sh(cmd: string): Promise<string> {
  if (LOCAL) {
    const { stdout } = await run("bash", ["-lc", cmd]);
    return stdout;
  }
  const { stdout } = await run("ssh", [HOST!, cmd]);
  return stdout;
}

async function readHost(): Promise<Host> {
  // No pipeline here: a non-zero exit from ollama (down, missing) must reach us, not be hidden by awk's exit 0.
  let listOut: string;
  try {
    listOut = await sh(`${OLLAMA} list`);
  } catch (e) {
    throw new Error(`\`${OLLAMA} list\` failed on ${LOCAL ? "this machine" : HOST}: ${(e as Error).message.split("\n")[0]}`);
  }
  const models = parseOllamaList(listOut);
  // Each probe swallows its own failure: missing GPU or disk info shows as "no GPU info" / 0 GB, never a crash.
  const gpu = await sh(
    "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null || true",
  );
  const os = await sh("uname -s 2>/dev/null || true");
  const mem = os.trim() === "Darwin" ? await sh("sysctl -n hw.memsize 2>/dev/null || true") : "";
  // -P keeps each filesystem on one line and -k fixes the unit, on both GNU and BSD/macOS df.
  const disk = await sh("df -Pk ~ 2>/dev/null || true");
  return { models, ...parseHostHardware(gpu, os, mem, disk) };
}

// --------------------------------------------------------------- diff ------

const norm = (s: string) => s.toLowerCase().replace(/^hf\.co\/[^/]+\//, "").replace(/[-_.]/g, "");

function haveStatus(lib: string, local: string[]): "exact" | "variant" | "no" {
  const base = lib.toLowerCase();
  const nb = norm(lib);
  if (local.some((l) => l.toLowerCase().split(":")[0] === base)) return "exact";
  if (local.some((l) => norm(l).includes(nb))) return "variant";
  return "no";
}

/** Q4_K_M weights run ~0.6 GB per billion params once KV cache and overhead are in. */
const estGb = (size: string) => Math.round(sizeToBillions(size) * 0.6);

function fit(sizes: string[], gpus: number[]): { fit: string; largest: string; estGb: number } {
  if (sizes.length === 0) return { fit: "size unknown", largest: "", estGb: 0 };
  // Largest size tag that fits wins; if none fit, report the smallest so the
  // reason is visible.
  const ordered = sizes.map((s) => [sizeToBillions(s), s] as const).filter(([b]) => Number.isFinite(b)).sort((a, b) => b[0] - a[0]);
  if (ordered.length === 0) return { fit: "size unknown", largest: "", estGb: 0 };
  const single = Math.max(...gpus, 0);
  const total = gpus.reduce((a, b) => a + b, 0);
  if (gpus.length === 0) return { fit: "unknown (no GPU info)", largest: ordered[0][1], estGb: estGb(ordered[0][1]) };
  for (const [, s] of ordered) {
    const gb = estGb(s);
    if (gb <= single * 0.9) return { fit: "single GPU", largest: s, estGb: gb };
    if (gb <= total * 0.9) return { fit: "split across GPUs", largest: s, estGb: gb };
  }
  const smallest = ordered[ordered.length - 1][1];
  return { fit: "no (needs offload)", largest: smallest, estGb: estGb(smallest) };
}

// --------------------------------------------------------------- main ------

let lib: LibModel[];
let host: Host;
try {
  [lib, host] = await Promise.all([fetchLibrary(), readHost()]);
} catch (e) {
  console.error(`LocalModels failed: ${(e as Error).message}`);
  process.exit(1);
}

const rows = lib.map((m) => {
  const f = m.cloudOnly ? { fit: "cloud-only", largest: "", estGb: 0 } : fit(m.sizes, host.gpus);
  const have = haveStatus(m.name, host.models);
  const recommend = have === "no" && (f.fit === "single GPU" || f.fit === "split across GPUs");
  const pull = f.largest && !m.untaggedSize ? `${m.name}:${f.largest}` : m.name;
  return { ...m, ...f, have, recommend, pull };
});

if (JSON_OUT) {
  console.log(JSON.stringify({ host: { gpuKind: host.gpuKind, gpusGb: host.gpus, diskFreeGb: host.diskFreeGb, modelCount: host.models.length }, models: rows }, null, 2));
  process.exit(0);
}

const gpuLine =
  host.gpuKind === "apple-unified"
    ? `Apple unified memory, ~${Math.round(host.gpus[0])} GB usable by the GPU (estimate)`
    : host.gpus.length
      ? `${host.gpus.length}× ${Math.round(host.gpus[0])} GB (${Math.round(host.gpus.reduce((a, b) => a + b, 0))} GB total)`
      : "no GPU info (nvidia-smi absent and not a Mac): fit is unknown, nothing is recommended";
console.log(`# Local models vs Ollama library (newest ${rows.length})\n`);
console.log(`Host: ${LOCAL ? "local" : HOST} · GPUs: ${gpuLine} · disk free: ${host.diskFreeGb} GB · models present: ${host.models.length}\n`);
console.log("| Model | Sizes | Caps | Updated | Pulls | Fit (~GB) | Have | Pull |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const fitCol = r.estGb ? `${r.fit} (~${r.estGb})` : r.fit;
  const haveCol = r.have === "exact" ? "yes" : r.have === "variant" ? "variant" : "no";
  console.log(`| ${r.name} | ${r.sizes.join(" ") || "—"} | ${r.capabilities.join(" ") || "—"} | ${r.updated || "—"} | ${r.pulls || "—"} | ${fitCol} | ${haveCol} | ${r.recommend ? "`" + OLLAMA + " pull " + r.pull + "`" : "—"} |`);
}
const recs = rows.filter((r) => r.recommend);
console.log(`\n## Candidates not on the host that fit (${recs.length})\n`);
for (const r of recs) console.log(`- **${r.name}** ${r.largest} (~${r.estGb} GB, ${r.fit}) — ${r.description}`);
console.log(`\nTotal if all pulled: ~${recs.reduce((a, r) => a + r.estGb, 0)} GB of ${host.diskFreeGb} GB free.`);
