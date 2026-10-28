import { PRIVATE_SKILL_NAMES } from "../../TOOLS/CodeDataBoundary.ts";
// The UniFi client is a private skill (network skill). Only its TYPE is imported statically (erased at
// runtime); the implementation loads dynamically behind an existsSync guard so a public install,
// which has no such file, gets an empty camera inventory instead of a dead module.
/** The subset of the UniFi client record this module reads, declared here so the shipped file
 *  carries no import specifier into the private skill (a type import is erased at runtime, but the
 *  emit gate reads every specifier). Structurally compatible with UnifiClient's NormalizedClient. */
export type NormalizedClient = { mac: string; hostname?: string; type: "WIRED" | "WIRELESS" | "UNKNOWN" };
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../../TOOLS/Paths";

export interface CameraState { id: string; name: string; connection: string; present: boolean }

// Network presence is distinct from video health.
export function cameraInventory(clients: NormalizedClient[], previous: CameraState[] = []): CameraState[] {
  const cameras = new Map(previous.map(c => [c.id, { ...c, present: false }]));
  for (const c of clients) {
    if (!cameras.has(c.mac) && !/camera|doorbell/i.test(c.hostname ?? "")) continue;
    cameras.set(c.mac, { id: c.mac, name: c.hostname || cameras.get(c.mac)!.name, connection: c.type.toLowerCase(), present: true });
  }
  return [...cameras.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseThermostats(raw: string) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data.thermostats) || data.thermostats.length === 0) throw new Error("No thermostat readings returned");
  const ids = new Set<string>();
  return data.thermostats.map((t: any) => {
    if (typeof t.id !== "string" || !t.id || ids.has(t.id) || typeof t.name !== "string") throw new Error("Invalid thermostat identity");
    ids.add(t.id);
    const temperature = (v: unknown) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "number" || !Number.isFinite(v) || v < -40 || v > 60) throw new Error("Invalid Celsius reading");
      return v;
    };
    return { id: t.id, name: t.name, currentC: temperature(t.currentC), targetC: temperature(t.targetC), mode: typeof t.mode === "string" ? t.mode : null };
  });
}

async function readThermostats() {
  let prefix = process.env.HOME_SHORTCUT_PREFIX || "Home";
  try {
    const config = readFileSync(lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", PRIVATE_SKILL_NAMES.home, "Config.md"), "utf8");
    prefix = process.env.HOME_SHORTCUT_PREFIX || config.match(/^thermostat_shortcut_prefix:\s*(.+?)\s*$/m)?.[1] || prefix;
  } catch { /* fresh install uses the standard prefix */ }
  const proc = Bun.spawn(["/usr/bin/shortcuts", "run", `${prefix} Thermostat Status`], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 12000);
  try {
    const [out, , status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status !== 0) return { ok: false, error: "Apple Home readings unavailable. The thermostat status Shortcut needs setup or permission.", thermostats: [] };
    return { ok: true, thermostats: parseThermostats(out) };
  } catch {
    return { ok: false, error: "The thermostat Shortcut did not return valid Celsius readings.", thermostats: [] };
  } finally { clearTimeout(timer); }
}

export async function readHouseDevices(previous: CameraState[] = []) {
  const [climate, cameras] = await Promise.all([
    readThermostats(),
    readCameraClients().then(clients => ({ ok: true, devices: cameraInventory(clients, previous), source: "UniFi network presence" }))
      .catch(() => ({ ok: false, devices: previous, error: "Camera network status unavailable" })),
  ]);
  return { climate, cameras };
}

// Isolate the existing client's retry loop so a router failure cannot stall the poller.
async function readCameraClients(): Promise<NormalizedClient[]> {
  const proc = Bun.spawn([process.execPath, import.meta.path, "--camera-clients"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 10000);
  try {
    const [out, , status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status !== 0) throw new Error("Camera inventory unavailable");
    const clients = JSON.parse(out);
    if (!Array.isArray(clients)) throw new Error("Invalid camera inventory");
    return clients;
  } finally { clearTimeout(timer); }
}

if (import.meta.main && process.argv.includes("--camera-clients")) {
  const unifi = join(import.meta.dir, "..", "..", "..", "skills", PRIVATE_SKILL_NAMES.network, "Tools", "UnifiClient.ts");
  if (!existsSync(unifi)) { console.log("[]"); process.exit(0); }
  const { listClients } = await import(unifi);
  console.log(JSON.stringify(await listClients()));
}
