#!/usr/bin/env bun
// Installs, removes or reports the herdr web bridge: a launchd agent on
// 127.0.0.1 plus a tailnet-only `tailscale serve --http` in front of it.
// usage: bun manage.ts install|uninstall|status

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { getClaudeDir } from "../../TOOLS/Paths";

const LABEL = "com.lifeos.herdr-bridge";
const HOME = homedir();
const HERE = import.meta.dir;
const CLAUDE_DIR = getClaudeDir();
const CONFIG = join(CLAUDE_DIR, "LIFEOS/USER/CONFIG/herdr-bridge.json");
const PLIST = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const LOGS = join(HERE, "../logs");
const UID = process.getuid?.() ?? 501;
const TS = Bun.which("tailscale") ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const BUN = process.execPath;
// launchd's PATH misses ~/.local/bin, where herdr installs itself, so the plist pins the binary.
const HERDR = process.env.HERDR_BIN_PATH || Bun.which("herdr") || join(HOME, ".local/bin/herdr");

function run(argv: string[]) {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
}

// The bridge accepts only its own Host names. It cannot ask Tailscale itself
// (the CLI hangs under launchd), so install records them in the USER config.
async function recordPublicHosts(servePort: number): Promise<string[]> {
  const st = run([TS, "status", "--json"]);
  if (!st.ok) throw new Error(`tailscale status failed: ${st.out}`);
  const fqdn = String(JSON.parse(st.out)?.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  if (!fqdn) throw new Error("tailscale reported no MagicDNS name for this machine");
  const hosts = [`${fqdn}:${servePort}`, `${fqdn.split(".")[0]}:${servePort}`];
  const c = await Bun.file(CONFIG).json();
  await Bun.write(CONFIG, JSON.stringify({ ...c, publicHosts: hosts }, null, 2) + "\n");
  return hosts;
}

// Every device on the tailnet shares one login, servers included, so the bridge
// also checks which device is calling. Install records the tailnet IPs of this
// machine and of every peer whose OS is in `allowedOS` (phones, tablets, Macs by default).
async function recordAllowedDevices(): Promise<{ name: string; os: string }[]> {
  const st = run([TS, "status", "--json"]);
  if (!st.ok) throw new Error(`tailscale status failed: ${st.out}`);
  const j = JSON.parse(st.out);
  const c = await Bun.file(CONFIG).json();
  const allowedOS: string[] = Array.isArray(c.allowedOS) ? c.allowedOS : ["iOS", "iPadOS", "macOS"];
  const nodes = [j.Self, ...Object.values(j.Peer ?? {})] as any[];
  const devices = nodes
    .filter(n => n && (n === j.Self || allowedOS.includes(String(n.OS))) && !(n.Tags?.length))
    .map(n => ({ name: String(n.HostName), os: String(n.OS), ips: (n.TailscaleIPs ?? []).map(String) }));
  await Bun.write(CONFIG, JSON.stringify({ ...c, allowedOS, allowedDevices: devices }, null, 2) + "\n");
  return devices.map(({ name, os }) => ({ name, os }));
}

async function config() {
  const f = Bun.file(CONFIG);
  if (!(await f.exists())) throw new Error(`missing ${CONFIG}: write {"principalLogin": "<your tailnet login>"} first`);
  const c = await f.json();
  if (!c.principalLogin) throw new Error(`principalLogin missing in ${CONFIG}`);
  return { port: Number(c.port ?? 31338), servePort: Number(c.servePort ?? 8443) };
}

function plist(): string {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${x(BUN)}</string><string>run</string><string>bridge.ts</string></array>
  <key>WorkingDirectory</key><string>${x(HERE)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${x(HOME)}</string>
    <key>PATH</key><string>${x(HOME)}/.local/bin:${x(HOME)}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HERDR_BIN_PATH</key><string>${x(HERDR)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${x(LOGS)}/herdr-bridge-stdout.log</string>
  <key>StandardErrorPath</key><string>${x(LOGS)}/herdr-bridge-stderr.log</string>
</dict>
</plist>
`;
}

async function install() {
  const { port, servePort } = await config();
  if (!existsSync(join(HERE, "node_modules/@xterm/xterm"))) {
    const r = run([BUN, "install", "--cwd", HERE]);
    if (!r.ok) throw new Error(`bun install failed: ${r.out}`);
  }
  const hosts = await recordPublicHosts(servePort);
  const devices = await recordAllowedDevices();
  console.log(`allowed devices: ${devices.map(d => `${d.name} (${d.os})`).join(", ")}`);
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  await Bun.write(PLIST, plist());
  run(["launchctl", "bootout", `gui/${UID}/${LABEL}`]);
  // bootout returns before launchd lets go of the label; bootstrapping early fails with error 5.
  for (let i = 0; i < 50 && run(["launchctl", "print", `gui/${UID}/${LABEL}`]).ok; i++) await Bun.sleep(100);
  const boot = run(["launchctl", "bootstrap", `gui/${UID}`, PLIST]);
  if (!boot.ok) throw new Error(`launchctl bootstrap failed: ${boot.out}`);
  const serve = run([TS, "serve", "--bg", `--http=${servePort}`, `http://127.0.0.1:${port}`]);
  if (!serve.ok) throw new Error(`tailscale serve failed: ${serve.out}`);
  console.log(`installed ${LABEL}; tailnet http on :${servePort} -> 127.0.0.1:${port}; open http://${hosts[0]}/`);
}

async function uninstall() {
  const { servePort } = await config();
  run([TS, "serve", `--http=${servePort}`, "off"]);
  run(["launchctl", "bootout", `gui/${UID}/${LABEL}`]);
  rmSync(PLIST, { force: true });
  console.log(`removed ${LABEL} and its tailnet serve on :${servePort}`);
}

async function status() {
  const { port, servePort } = await config();
  const loaded = run(["launchctl", "print", `gui/${UID}/${LABEL}`]).ok;
  let healthy = false;
  try { healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* not listening */ }
  const served = run([TS, "serve", "status"]).out.includes(`127.0.0.1:${port}`);
  // Funnel would publish the port to the internet; the bridge is tailnet-only by design.
  let funneled = false;
  try {
    const sj = JSON.parse(run([TS, "serve", "status", "--json"]).out || "{}");
    funneled = Object.entries(sj.AllowFunnel ?? {}).some(([hp, on]) => on && hp.endsWith(`:${servePort}`));
  } catch { /* unreadable serve state: served=false already fails the check */ }
  console.log(JSON.stringify({ label: LABEL, loaded, healthy, servePort, served, funneled }));
  if (!(loaded && healthy && served) || funneled) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "uninstall") await uninstall();
else if (cmd === "status") await status();
else { console.error("usage: bun manage.ts install|uninstall|status"); process.exit(2); }
