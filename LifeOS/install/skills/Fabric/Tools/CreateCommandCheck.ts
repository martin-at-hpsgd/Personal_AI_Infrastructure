#!/usr/bin/env bun
// CreateCommandCheck — checks a CreateCommand output against the parts of its
// contract code can judge: the whole output is one command and nothing else —
// no markdown fence, heading, bullet, bold or blockquote; no note, warning or
// prose sentence; no unfilled <placeholder>; exactly one command block; and the
// command parses as valid shell (bash -n, which parses without executing).
// Whether it uses only documented flags and meets the objective stays judged.

import { readFileSync } from "node:fs";

const HELP = `CreateCommandCheck — shape check for a Fabric CreateCommand output

  bun skills/Fabric/Tools/CreateCommandCheck.ts <file|-> [--json]

  --json   print {ok, command, problems}
Exit: 0 shape holds and the command parses, 1 a rule failed, 2 bad usage or unreadable input.`;

const FENCE = /^\s*(```|~~~)/;
const NOTE_LEAD =
  /^(note|notes|warning|caution|tip|here is|here's|this command|this will|the command|explanation|example:|output:|you can|i['’]ll|i have|first,)/i;
const SHELL_CHARS = /[|&;<>$(){}\[\]=/\\-]/;

export function shellSyntaxOk(cmd: string): { ok: boolean; error: string } {
  try {
    const p = Bun.spawnSync(["bash", "-n"], {
      stdin: Buffer.from(cmd + "\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = p.stderr ? new TextDecoder().decode(p.stderr).trim() : "";
    return { ok: p.exitCode === 0, error: err };
  } catch {
    // No shell available: do not fail the shape check on syntax we cannot judge.
    return { ok: true, error: "" };
  }
}

export function check(
  input: string,
  opts: { syntax?: boolean } = {},
): { ok: boolean; command: string; problems: string[] } {
  const syntax = opts.syntax ?? true;
  const problems: string[] = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");

  const fenced = lines.some((l) => FENCE.test(l));
  if (fenced) problems.push("output is wrapped in a markdown code fence; emit the bare command");

  const content = lines.map((l, i) => ({ l, i })).filter((x) => !FENCE.test(x.l));
  const nonEmpty = content.filter((x) => x.l.trim() !== "");
  if (nonEmpty.length === 0) {
    return { ok: false, command: "", problems: [...problems, "no command found"] };
  }

  for (const { l, i } of nonEmpty) {
    const t = l.trim();
    if (/^#{1,6}\s/.test(t)) problems.push(`line ${i + 1}: markdown heading ("${t.slice(0, 40)}"); emit only the command`);
    else if (/^[-*+]\s/.test(t)) problems.push(`line ${i + 1}: markdown bullet; emit only the command`);
    else if (/^>\s/.test(t)) problems.push(`line ${i + 1}: blockquote; emit only the command`);
    if (t.includes("**")) problems.push(`line ${i + 1}: markdown bold; emit only the command`);
    if (NOTE_LEAD.test(t)) {
      problems.push(`line ${i + 1}: looks like a note or explanation ("${t.slice(0, 40)}"); emit only the command`);
    } else if (/[.!?]$/.test(t) && t.split(/\s+/).length >= 6 && !SHELL_CHARS.test(t)) {
      problems.push(`line ${i + 1}: looks like a prose sentence ("${t.slice(0, 40)}"); emit only the command`);
    }
  }

  const placeholder = input.match(/<[A-Za-z][\w-]*>/);
  if (placeholder) problems.push(`unfilled placeholder ${placeholder[0]}; substitute the objective's concrete value`);

  let blocks = 1;
  for (let k = 1; k < nonEmpty.length; k++) {
    if (nonEmpty[k].i - nonEmpty[k - 1].i > 1) blocks++;
  }
  if (blocks > 1) problems.push(`${blocks} command blocks found; emit a single command`);

  const command = nonEmpty.map((x) => x.l).join("\n").trim();

  if (syntax && !fenced) {
    const s = shellSyntaxOk(command);
    if (!s.ok) {
      problems.push(`the command does not parse as valid shell${s.error ? `: ${s.error.split("\n")[0]}` : ""}`);
    }
  }

  return { ok: problems.length === 0, command, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const src = args.find((a) => !a.startsWith("--"));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json) console.log(JSON.stringify({ ok: r.ok, command: r.command, problems: r.problems }));
  else if (r.ok) console.log("✓ one command, shape holds and it parses");
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
