#!/usr/bin/env bun
// TabBar.ts — hide and show kitty's tab bar live (kitty >= 0.48).
// Commands: hide | hide-on [pid] | hide-off [pid] | reset
//   hide      toggles the bar (ctrl+cmd+b).
//   hide-on / hide-off are the pair the `herdr` shell wrapper calls with its shell
//   pid: herdr's sidebar is the session list while a client runs, so the bar goes
//   away and comes back when the LAST herdr client in this kitty instance exits.
//
// kitty 0.48.2 bug: a plain `kitten @ load-config` (no overrides) kills the
// tab bar entirely. Every apply here therefore includes an explicit
// --override tab_bar_edge=top, which forces kitty to rebuild the bar.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// State lives OUTSIDE ~/.config/kitty — kitty's conf watcher reloads on any
// change in that directory, and a plain reload re-triggers the bug above.
// One file per kitty instance: two kitty windows share ~/.cache, and a single
// shared file made one instance's "unchanged" hide a bar another had hidden, so
// its herdr exit never restored the bar. KITTY_PID is set in every kitty child
// shell; the listen socket name is the fallback, then a shared default.
function instanceId(): string {
  const raw = process.env.KITTY_PID || (process.env.KITTY_LISTEN_ON ?? "").split("/").pop() || "";
  const id = raw.replace(/[^A-Za-z0-9_-]/g, "");
  return id || "default";
}
const STATE_FILE = join(homedir(), `.cache/kitty-tabbar-state-${instanceId()}.json`);

// Mirrors the kitty.conf template, with a rendered-empty nonce prepended.
// kitty 0.48.2 caches the bar's template across reloads and only re-renders on
// a genuine option delta — the nonce changes the template string every call
// (forcing the re-render) while rendering to nothing.
const TEMPLATE = "{bell_symbol}{activity_symbol}{title}";

type Mode = "normal" | "hidden";
// clients: shell pids of the herdr clients running in this instance. held: the
// bar is hidden because a client hid it, not by the manual toggle, so the last
// client out restores it. One shared bit used to let the first client to exit
// bring the bar back over a second client still running.
export interface State { mode: Mode; nonce: number; clients: number[]; held: boolean; }

// Older state files carry sidebar fields (edge, width, docked) and no client
// list; only the hidden/normal bit survives from them.
function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      mode: s.mode === "hidden" ? "hidden" : "normal",
      nonce: typeof s.nonce === "number" ? s.nonce : 0,
      clients: Array.isArray(s.clients) ? s.clients.filter((n: unknown) => Number.isInteger(n) && (n as number) > 0) : [],
      held: s.held === true,
    };
  } catch {}
  return { mode: "normal", nonce: 0, clients: [], held: false };
}

function saveState(state: State): void {
  if (!state.clients.every((c) => Number.isInteger(c) && c > 0) || (state.held && state.mode !== "hidden")) {
    throw new Error(`TabBar invariant: bad state ${JSON.stringify(state)}`);
  }
  // A fresh home may have no ~/.cache yet.
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

// A client whose shell died without running hide-off (a closed window) drops
// out, so it cannot pin the bar hidden. EPERM still means the pid exists.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// Pure transition for every command; the I/O lives below. `changed` means the
// mode moved and kitty must be told.
export function decide(cmd: string, prev: State, pid: number | null, alive: (pid: number) => boolean): { state: State; changed: boolean } {
  const s: State = { ...prev, clients: prev.clients.filter((c) => c !== pid && alive(c)) };
  switch (cmd) {
    case "hide":
      s.mode = s.mode === "hidden" ? "normal" : "hidden";
      s.held = false; // the person chose this state; a herdr exit leaves it alone
      break;
    case "hide-on":
      if (pid) s.clients.push(pid);
      if (s.mode !== "hidden") { s.mode = "hidden"; s.held = true; }
      break;
    case "hide-off":
      if (s.clients.length === 0 && s.mode === "hidden" && s.held) { s.mode = "normal"; s.held = false; }
      break;
    case "reset":
      s.mode = "normal"; s.held = false; s.clients = [];
      break;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
  return { state: s, changed: s.mode !== prev.mode };
}

function kittenBin(): string {
  for (const p of ["/opt/homebrew/bin/kitten", "/Applications/kitty.app/Contents/MacOS/kitten"]) {
    if (existsSync(p)) return p;
  }
  return "kitten";
}

function socketArg(): string[] {
  if (process.env.KITTY_LISTEN_ON) return []; // kitten reads the env var itself
  try {
    const socks = readdirSync("/tmp")
      .filter((f) => f.startsWith("kitty-"))
      .map((f) => join("/tmp", f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (socks.length) return ["--to", `unix:${socks[0]}`];
  } catch {}
  return [];
}

function apply(state: State): void {
  state.nonce = (state.nonce % 999983) + 1;
  const nonce = `{'n${state.nonce}'[:0]}`; // unique every call, renders empty
  const overrides = ["tab_bar_edge=top"];
  if (state.mode === "hidden") {
    overrides.push("tab_bar_style=hidden");
  } else {
    // tab_bar.py (tab_bar_style custom) divides the full window width evenly
    // across tabs on every redraw — no max_length cap wanted.
    overrides.push("tab_bar_style=custom", "tab_title_max_length=0", `tab_title_template=${nonce}${TEMPLATE}`);
  }
  const args = ["@", ...socketArg(), "load-config", ...overrides.flatMap((o) => ["--override", o])];
  const proc = Bun.spawnSync([kittenBin(), ...args]);
  if (proc.exitCode !== 0) {
    console.error(`kitten load-config failed: ${proc.stderr.toString()}`);
    process.exit(1);
  }
  saveState(state);
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "";
  if (!["hide", "hide-on", "hide-off", "reset"].includes(cmd)) {
    console.error("usage: TabBar.ts hide|hide-on [pid]|hide-off [pid]|reset");
    process.exit(2);
  }
  const arg = Number(process.argv[3]);
  const pid = Number.isInteger(arg) && arg > 0 ? arg : null;
  const prev = loadState();
  const { state, changed } = decide(cmd, prev, pid, pidAlive);

  // The herdr pair prints "changed" only when the mode actually moved; an
  // unchanged call still records the client list and leaves kitty alone.
  if (cmd === "hide-on" || cmd === "hide-off") {
    console.log(changed ? "changed" : "unchanged");
    if (!changed) { saveState(state); process.exit(0); }
  }

  // Coming back from hidden, kitty 0.48.2 re-shows the tabs but can leave the
  // pane drawn over them until a second option delta lands, so apply twice.
  if (prev.mode === "hidden" && state.mode !== "hidden") apply(state);
  apply(state);
  console.log(`tab bar: ${state.mode}`);
}
