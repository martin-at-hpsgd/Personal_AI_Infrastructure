#!/usr/bin/env bun
/**
 * PortDuel — a Fabric port against the upstream pattern it replaces, head to head.
 *
 * For each held-out case in Evals/HeldOut/<Intent>.json, the same generator answers the
 * case twice: once with the port intent as its system prompt, once with the upstream
 * pattern's system.md. Assay's Tournament judges the pair in both orders on a judge
 * vendor outside the generator's family (OpenAI by default). The port passes when it
 * wins more than half the cases.
 *
 *   bun skills/Fabric/Tools/PortDuel.ts <Intent> [--heldout <file>] [--concurrency N] [--json]
 *   exit 0 port wins · 1 port does not win · 2 generator or judge unavailable
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CURRENT } from "../../../LIFEOS/TOOLS/models.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SKILL = join(ROOT, "skills", "Fabric");
const QUESTION =
  "Which output better delivers what the request asks for? Judge fidelity to the deliverable the request names (the right kind of output, nothing missing that the request implies), accuracy to the input, specificity to this input rather than generic filler, and usefulness to an expert reader. Length and formatting count only as far as they serve the reader.";

interface HeldOutCase { id: string; pattern: string; input: string; /** what the requester wants, stated from the principal and the upstream deliverable, never from the port */ expects?: string }
interface HeldOut { intent: string; cases: HeldOutCase[] }
export interface CaseResult { id: string; pattern: string; winner: "port" | "upstream" | "tie"; stable: boolean; summary: string; dir: string }
export interface DuelResult { intent: string; generator: string; judge_vendor: string; wins: number; losses: number; ties: number; pass: boolean; unavailable: boolean; cases: CaseResult[] }

async function run(cmd: string[], env: Record<string, string> = {}, timeoutMs = 600_000): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err };
}

async function generate(systemFile: string, input: string): Promise<string | null> {
  const r = await run(["bun", join(ROOT, "LIFEOS", "TOOLS", "Inference.ts"), "--level", "medium", "--vendor", "anthropic", "--timeout", "300000", readFileSync(systemFile, "utf8"), input]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
}

async function duelCase(intent: string, c: HeldOutCase, outDir: string, judgeVendor: string): Promise<CaseResult | null> {
  const upstreamFile = join(SKILL, "Patterns", c.pattern, "system.md");
  if (!existsSync(upstreamFile)) throw new Error(`no upstream pattern ${c.pattern}`);
  const [port, upstream] = await Promise.all([generate(join(SKILL, "Intents", `${intent}.md`), c.input), generate(upstreamFile, c.input)]);
  if (!port || !upstream) return null;
  const dir = join(outDir, c.id);
  mkdirSync(dir, { recursive: true });
  const req = `# Request\n\n${c.input}\n\n${c.expects ? `# What the requester wants\n\n${c.expects}\n\n` : ""}# Output\n\n`;
  const portPath = join(dir, "port.md"), upPath = join(dir, "upstream.md");
  writeFileSync(portPath, req + port);
  writeFileSync(upPath, req + upstream);
  const t = await run(["bun", join(ROOT, "skills", "Assay", "Tools", "Tournament.ts"), "--candidates", `${upPath},${portPath}`, "--question", QUESTION, "--generator", CURRENT.sonnet, "--json"], { LIFEOS_INFERENCE_VENDOR: judgeVendor });
  if (t.code === 2) return null;
  let parsed: { winner: string | null; stable: boolean; summary: string };
  try { parsed = JSON.parse(t.out); } catch { return null; }
  writeFileSync(join(dir, "tournament.json"), t.out);
  const winner = parsed.winner === portPath ? "port" : parsed.winner === upPath ? "upstream" : "tie";
  return { id: c.id, pattern: c.pattern, winner, stable: parsed.stable, summary: parsed.summary, dir };
}

export async function duel(intent: string, heldoutFile: string, concurrency: number, judgeVendor = "openai"): Promise<DuelResult> {
  const h = JSON.parse(readFileSync(heldoutFile, "utf8")) as HeldOut;
  if (!Array.isArray(h.cases) || h.cases.length < 3) throw new Error(`${heldoutFile}: needs at least three cases`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "LIFEOS", "MEMORY", "STATE", "Evals-Results", "fabric-duels", intent, stamp);
  const results: (CaseResult | null)[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < h.cases.length) { const c = h.cases[i++]; results.push(await duelCase(intent, c, outDir, judgeVendor)); }
  }));
  const done = results.filter((r): r is CaseResult => r !== null);
  const wins = done.filter((r) => r.winner === "port").length;
  const losses = done.filter((r) => r.winner === "upstream").length;
  const unavailable = done.length < h.cases.length;
  const r: DuelResult = { intent, generator: CURRENT.sonnet, judge_vendor: judgeVendor, wins, losses, ties: done.length - wins - losses, pass: !unavailable && wins > h.cases.length / 2, unavailable, cases: done };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "duel.json"), JSON.stringify(r, null, 2));
  return r;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { heldout: { type: "string" }, concurrency: { type: "string", default: "3" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  const intent = positionals[0];
  if (values.help || !intent) { console.log(readFileSync(join(import.meta.dir, "PortDuel.help.md"), "utf8")); process.exit(values.help ? 0 : 2); }
  const file = values.heldout ?? join(SKILL, "Evals", "HeldOut", `${intent}.json`);
  const r = await duel(intent, file, Number(values.concurrency));
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${intent}: port ${r.wins} · upstream ${r.losses} · tie ${r.ties}${r.unavailable ? " · some cases unavailable" : ""} → ${r.pass ? "PASS" : r.unavailable ? "DEFER" : "FAIL"}`);
    for (const c of r.cases) console.log(`  ${c.id} (${c.pattern}): ${c.winner}${c.stable ? "" : " (unstable)"}`);
  }
  process.exit(r.unavailable ? 2 : r.pass ? 0 : 1);
}
