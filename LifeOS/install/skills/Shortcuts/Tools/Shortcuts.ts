#!/usr/bin/env bun
// Shortcuts.ts — deterministic wrapper over the macOS `shortcuts` CLI.
// This is the RUN half of Shortcuts: once a Shortcut exists (built one-time
// via computer use in BuildShortcut), every invocation flows through here as a
// plain CLI call — never pixel-clicking. Shortcuts.app is the bridge to
// Apple-only capabilities (HomeKit, native actions); this turns that bridge
// into something callable.
//
// Usage:
//   bun Shortcuts.ts list                       → JSON array of shortcut names
//   bun Shortcuts.ts exists "<name>"            → exit 0 if present, 1 if not
//   bun Shortcuts.ts run "<name>" [--input X]   → run it, print stdout
//   bun Shortcuts.ts run "<name>" --json        → wrap result as JSON
//
// `shortcuts` exists only on macOS (/usr/bin/shortcuts). exits 1 elsewhere.

export {};

const args = process.argv.slice(2);
const cmd = args[0];

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function listShortcuts(): Promise<string[]> {
  const proc = Bun.spawn(["shortcuts", "list"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) fail("`shortcuts list` failed — is this macOS?");
  // One name per line, kept exactly as registered: a name's leading or trailing spaces are part of it, and
  // `exists` promises an exact match. Only a stray carriage return and blank lines are dropped.
  return out.split("\n").map((s) => s.replace(/\r$/, "")).filter((s) => s.trim() !== "");
}

async function runShortcut(name: string, input?: string): Promise<string> {
  const proc = Bun.spawn(["shortcuts", "run", name], {
    stdin: input !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    // shortcuts CLI is terse; the most common failure is a name mismatch.
    fail(`'${name}' failed (exit ${proc.exitCode}). ${err.trim() || "Check the exact name with `list` — matching is exact, case + spaces."}`);
  }
  return out.trim();
}

function getFlag(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

switch (cmd) {
  case "list": {
    const names = await listShortcuts();
    console.log(JSON.stringify(names, null, 2));
    break;
  }
  case "exists": {
    const name = args[1];
    if (!name) fail("usage: exists \"<name>\"");
    const names = await listShortcuts();
    process.exit(names.includes(name) ? 0 : 1);
  }
  case "run": {
    const name = args[1];
    if (!name) fail("usage: run \"<name>\" [--input X] [--json]");
    const input = getFlag("--input");
    const result = await runShortcut(name, input);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ shortcut: name, input: input ?? null, output: result }));
    } else {
      console.log(result);
    }
    break;
  }
  case "help":
  case "--help":
  case "-h":
    console.log("usage: bun Shortcuts.ts list | exists \"<name>\" | run \"<name>\" [--input X] [--json]\n  list    JSON array of every shortcut name on this Mac\n  exists  exit 0 when that exact name is registered, 1 when not\n  run     run it, input piped to its stdin, its final action's output on stdout");
    break;
  default:
    fail("usage: list | exists \"<name>\" | run \"<name>\" [--input X] [--json]");
}
