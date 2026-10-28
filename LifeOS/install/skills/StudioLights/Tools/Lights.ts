#!/usr/bin/env bun
// Lights.ts — control studio lights via the amaran Desktop local WebSocket API.
// Protocol: JSON over ws://127.0.0.1:33782/ws (amaran Desktop OpenAPI v2, the local API the Companion module uses).
//
// Every write is checked: a missing reply (timeout) or a non-zero device code fails the command, the light is
// read back, and the output reports the state the light says it is in (not the request). Any failure or
// mismatch exits non-zero.
//
// Usage:
//   bun Lights.ts devices [--json]        # discover node IDs and groups; needs no devices.json, changes nothing
//   bun Lights.ts status [--json]
//   bun Lights.ts set <light|all> [--intensity <0-100>] [--cct <kelvin>]
//   bun Lights.ts wake <light|all> | sleep <light|all>
//   bun Lights.ts scene <name>            # apply a scene from scenes.json
//   bun Lights.ts scene save <name>       # snapshot current state into scenes.json
//   bun Lights.ts scenes                  # list scenes

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Test hooks: LIFEOS_LIGHTS_WS_URL points the client at a fake server (and disables the app launch),
// LIFEOS_LIGHTS_USER_DIR swaps the device registry, LIFEOS_LIGHTS_TIMEOUT_MS shortens the reply timeout.
const WS_OVERRIDDEN = Boolean(process.env.LIFEOS_LIGHTS_WS_URL);
const WS_URL = process.env.LIFEOS_LIGHTS_WS_URL ?? "ws://127.0.0.1:33782/ws";
const REPLY_TIMEOUT_MS = Number(process.env.LIFEOS_LIGHTS_TIMEOUT_MS) || 5000;
const APP_NAME = "amaran Desktop";

// Per-install hardware config lives in the USER tree (fixture node IDs, models, the "all"-group id, and saved scenes),
// in LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<this skill's folder name>/. First-time setup is in the skill's Setup.md.
// devices.json shape: { allGroup?: string, devices: { <name>: { node_id, model, supportsCct } } }.
// supportsCct:false marks daylight-only fixtures that report cct=0. allGroup is optional: with it, "wake all" and
// "sleep all" send one group write; without it they write each light in turn. "devices" prints both kinds of ID.
const USER_DIR = process.env.LIFEOS_LIGHTS_USER_DIR
  ?? path.join(import.meta.dir, "../../../LIFEOS/USER/CUSTOMIZATIONS/SKILLS", path.basename(path.join(import.meta.dir, "..")));
const DEVICES_PATH = path.join(USER_DIR, "devices.json");
const SCENES_PATH = path.join(USER_DIR, "scenes.json");

const USAGE = `Usage:
  bun Lights.ts devices [--json]        # list node IDs and groups from amaran Desktop (needs no devices.json; changes nothing)
  bun Lights.ts status [--json]
  bun Lights.ts set <light|all> [--intensity <0-100>] [--cct <kelvin>]
  bun Lights.ts wake <light|all> | sleep <light|all>
  bun Lights.ts scene <name>            # apply a scene from scenes.json
  bun Lights.ts scene save <name>       # snapshot current state into scenes.json
  bun Lights.ts scenes                  # list scenes (reads scenes.json only; never touches a light)`;

// Help needs no device registry, so it answers before the registry loads.
{
  const first = process.argv[2];
  if (!first || first === "--help" || first === "-h" || first === "help") {
    console.log(USAGE);
    process.exit(0);
  }
}

type Device = { node_id: string; model: string; supportsCct: boolean };

function loadDeviceConfig(): { allGroup?: string; devices: Record<string, Device> } {
  if (!existsSync(DEVICES_PATH)) {
    console.error(`ERROR: device registry not found at ${DEVICES_PATH}.\nRun "bun Lights.ts devices" to list your lights, then create it as described in the skill's Setup.md — { "devices": { "key": { "node_id": "...", "model": "...", "supportsCct": false }, ... } }.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(DEVICES_PATH, "utf8"));
}

// "devices" is how a new user finds the IDs that go into devices.json, so it runs before that file exists.
const DISCOVERY = process.argv[2] === "devices";
const { allGroup: ALL_GROUP, devices: DEVICES } = DISCOVERY ? { allGroup: undefined, devices: {} as Record<string, Device> } : loadDeviceConfig();

const RATE_LIMIT_MS = 220; // API device rate limit is 200ms; stay above it

type SceneEntry = { intensity?: number; cct?: number; sleep?: boolean };
type Scenes = Record<string, Record<string, SceneEntry>>;

// ---------- WebSocket client ----------

class Amaran {
  private ws!: WebSocket;
  private clientId = `lifeos-lights-${Date.now()}`;
  private n = 0;
  private pending = new Map<string, (msg: any) => void>();

  private token(): string {
    // The request token, in the same format the official Bitfocus Companion module sends.
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    let enc = c.update(String(Math.floor(Date.now() / 1000)), "utf8", "hex");
    enc += c.final("hex");
    return Buffer.concat([iv, c.getAuthTag(), Buffer.from(enc, "hex")]).toString("base64");
  }

  async connect(timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      try {
        this.ws = new WebSocket(WS_URL);
        this.ws.onopen = () => { clearTimeout(t); resolve(true); };
        this.ws.onerror = () => { clearTimeout(t); resolve(false); };
        this.ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.type !== "response") return;
          const key = `${m.action}:${m.node_id ?? ""}`;
          const cb = this.pending.get(key);
          if (cb) { this.pending.delete(key); cb(m); }
        };
      } catch { clearTimeout(t); resolve(false); }
    });
  }

  async request(action: string, node_id?: string, args: Record<string, unknown> = {}, timeoutMs = REPLY_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve) => {
      const key = `${action}:${node_id ?? ""}`;
      const t = setTimeout(() => { this.pending.delete(key); resolve(null); }, timeoutMs);
      this.pending.set(key, (m) => { clearTimeout(t); resolve(m); });
      this.ws.send(JSON.stringify({
        version: 2, type: "request", client_id: this.clientId,
        request_id: `req-${++this.n}`, node_id, action, args, token: this.token(),
      }));
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class LightError extends Error {}

/** A write or read that must succeed: no reply within the timeout, or a non-zero device code, throws. */
async function must(client: Amaran, action: string, node_id?: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await client.request(action, node_id, args);
  if (r === null) throw new LightError(`${action} ${node_id ?? ""}: no reply from amaran Desktop within ${REPLY_TIMEOUT_MS}ms`);
  if (r.code !== 0) throw new LightError(`${action} ${node_id ?? ""}: device returned code ${r.code}`);
  return r;
}

async function ensureApp(): Promise<Amaran> {
  const client = new Amaran();
  if (await client.connect(1500)) return client;
  // App not running (or WS not up) — launch and poll
  if (WS_OVERRIDDEN) {
    console.error(`ERROR: ${WS_URL} not reachable (override set; not launching ${APP_NAME}).`);
    process.exit(2);
  }
  console.error(`${APP_NAME} not reachable — launching...`);
  Bun.spawnSync(["open", "-a", APP_NAME]);
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const retry = new Amaran();
    if (await retry.connect(1500)) return retry;
  }
  console.error(`ERROR: ${APP_NAME} did not come up on ${WS_URL} within 30s. Is it installed and signed in?`);
  process.exit(2);
}

function resolveLight(name: string): { key: string; node_id: string; supportsCct: boolean } | "all" | null {
  const q = name.toLowerCase().trim();
  if (q === "all") return "all";
  if (DEVICES[q]) return { key: q, ...DEVICES[q] };
  const hit = Object.keys(DEVICES).find((k) => k.includes(q) || q.includes(k));
  return hit ? { key: hit, ...DEVICES[hit] } : null;
}

async function loadScenes(): Promise<Scenes> {
  if (!existsSync(SCENES_PATH)) return {};
  return JSON.parse(await Bun.file(SCENES_PATH).text());
}

async function saveScenes(s: Scenes) {
  await Bun.write(SCENES_PATH, JSON.stringify(s, null, 2) + "\n");
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// ---------- commands ----------

type LightState = { intensity: number; cct: number | null; sleeping: boolean; ok: boolean; error?: string };

/**
 * Read one light. A failed read (timeout, non-zero code, or a code-0 ack with no usable data)
 * sets ok=false; it never invents a value. An ack with no data used to read back as NaN, which
 * no tolerance compare can fail, so a write "confirmed" against nothing.
 */
async function readLight(client: Amaran, d: Device): Promise<LightState> {
  try {
    const i = await must(client, "get_intensity", d.node_id);
    if (typeof i.data !== "number" || !Number.isFinite(i.data)) throw new LightError(`get_intensity ${d.node_id}: code 0 but no numeric intensity (${JSON.stringify(i.data)})`);
    let cct: number | null = null;
    if (d.supportsCct) {
      const c = await must(client, "get_cct", d.node_id);
      const v = c.data && typeof c.data === "object" ? (c.data as { cct?: unknown }).cct : undefined;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new LightError(`get_cct ${d.node_id}: code 0 but no numeric cct (${JSON.stringify(c.data)})`);
      cct = v;
    }
    const sl = await must(client, "get_sleep", d.node_id);
    if (typeof sl.data !== "boolean" && sl.data !== 0 && sl.data !== 1) throw new LightError(`get_sleep ${d.node_id}: code 0 but no sleep state (${JSON.stringify(sl.data)})`);
    return {
      intensity: i.data / 10,
      cct,
      sleeping: Boolean(sl.data),
      ok: true,
    };
  } catch (e) {
    return { intensity: -1, cct: null, sleeping: false, ok: false, error: (e as Error).message };
  }
}

async function readState(client: Amaran): Promise<Record<string, LightState>> {
  const out: Record<string, LightState> = {};
  for (const [name, d] of Object.entries(DEVICES)) {
    out[name] = await readLight(client, d);
    await sleep(RATE_LIMIT_MS);
  }
  return out;
}

const INTENSITY_TOLERANCE = 1; // percent; the device reports tenths
const CCT_TOLERANCE = 100; // kelvin

async function applyToLight(client: Amaran, node_id: string, supportsCct: boolean, e: SceneEntry) {
  if (e.sleep === true) {
    await must(client, "set_sleep", node_id, { sleep: true });
    await sleep(RATE_LIMIT_MS);
    return;
  }
  if (e.sleep === false || e.intensity !== undefined) {
    await must(client, "set_sleep", node_id, { sleep: false });
    await sleep(RATE_LIMIT_MS);
  }
  if (e.cct !== undefined && supportsCct) {
    await must(client, "set_cct", node_id, { cct: e.cct });
    await sleep(RATE_LIMIT_MS);
  }
  if (e.intensity !== undefined) {
    await must(client, "set_intensity", node_id, { intensity: Math.round(e.intensity * 10) });
    await sleep(RATE_LIMIT_MS);
  }
}

/** Compare what the light reports against what was asked. Returns the mismatches (empty = confirmed). */
function mismatches(st: LightState, supportsCct: boolean, e: SceneEntry): string[] {
  if (!st.ok) return [st.error ?? "light unreadable after write"];
  if (!Number.isFinite(st.intensity)) return [`light reports a non-numeric intensity (${st.intensity})`];
  const bad: string[] = [];
  if (e.sleep === true && !st.sleeping) bad.push("asked to sleep, light reports awake");
  if (e.sleep !== true && (e.sleep === false || e.intensity !== undefined) && st.sleeping) bad.push("asked to wake, light reports sleeping");
  if (e.sleep !== true && e.intensity !== undefined && Math.abs(st.intensity - e.intensity) > INTENSITY_TOLERANCE) {
    bad.push(`asked ${e.intensity}%, light reports ${st.intensity}%`);
  }
  if (e.sleep !== true && e.cct !== undefined && supportsCct && (st.cct === null || !Number.isFinite(st.cct) || Math.abs(st.cct - e.cct) > CCT_TOLERANCE)) {
    bad.push(`asked ${e.cct}K, light reports ${st.cct ?? "no cct"}K`);
  }
  if (e.sleep !== true && e.cct !== undefined && !supportsCct) bad.push(`asked ${e.cct}K, but this light has no CCT control; the cct was not applied`);
  return bad;
}

function describeState(st: LightState): string {
  if (!st.ok) return "UNREADABLE";
  return st.sleeping ? "sleeping" : `${st.intensity}%${st.cct ? ` ${st.cct}K` : ""}`;
}

let failures = 0;

/** Apply one entry to one light, read it back, print what the light reports, count any failure. */
async function applyAndConfirm(client: Amaran, key: string, d: Device, e: SceneEntry): Promise<void> {
  try {
    await applyToLight(client, d.node_id, d.supportsCct, e);
  } catch (err) {
    failures++;
    console.error(`FAILED ${key}: ${(err as Error).message}`);
    return;
  }
  const st = await readLight(client, d);
  const bad = mismatches(st, d.supportsCct, e);
  if (bad.length > 0) {
    failures++;
    console.error(`MISMATCH ${key}: ${bad.join("; ")}`);
    return;
  }
  console.log(`${key}: ${describeState(st)} (reported by light)`);
}

type Listed = { node_id?: unknown; name?: unknown };

/**
 * Read-only discovery for first-time setup: lists the lights amaran Desktop knows (get_device_list) and its
 * groups (get_scene_list, the app's own scenes; a group's node ID can serve as allGroup), checks each light's
 * color temperature to guess supportsCct, and prints a devices.json to start from. Sends no set_* action.
 */
async function discover(client: Amaran) {
  let list: any;
  try {
    list = await must(client, "get_device_list");
  } catch (err) {
    failures++;
    console.error(`FAILED ${(err as Error).message}`);
    return;
  }
  if (!Array.isArray(list.data)) {
    failures++;
    console.error(`get_device_list: code 0 but no device list (${JSON.stringify(list.data)})`);
    return;
  }
  const lights = (list.data as Listed[]).filter((d) => typeof d.node_id === "string" && d.node_id !== "");
  if (lights.length === 0) {
    failures++;
    console.error("amaran Desktop reports no lights. Sign in to the app once and check the lights appear in its window.");
    return;
  }

  let groups: Listed[] = [];
  try {
    const g = await must(client, "get_scene_list");
    if (Array.isArray(g.data)) groups = (g.data as Listed[]).filter((d) => typeof d.node_id === "string" && d.node_id !== "");
  } catch (err) {
    console.error(`(groups unavailable: ${(err as Error).message}; allGroup is optional, so devices.json still works without it)`);
  }

  // A daylight-only light reports cct 0; anything else that answers is bi-color or full color.
  const cct: Record<string, boolean | null> = {};
  for (const d of lights) {
    const r = await client.request("get_cct", d.node_id as string);
    const v = r?.code === 0 && r.data && typeof r.data === "object" ? (r.data as { cct?: unknown }).cct : undefined;
    cct[d.node_id as string] = typeof v === "number" ? v > 0 : null;
    await sleep(RATE_LIMIT_MS);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ lights: list.data, groups, supportsCct: cct }, null, 2));
    return;
  }

  console.log("Lights:");
  for (const d of lights) {
    const c = cct[d.node_id as string];
    console.log(`  ${String(d.node_id).padEnd(24)} ${String(d.name ?? "(no name)").padEnd(24)} ${c === null ? "cct unknown" : c ? "has cct" : "daylight-only"}`);
  }
  console.log("Groups (a group holding every light can be allGroup):");
  if (groups.length === 0) console.log("  (none)");
  for (const g of groups) console.log(`  ${String(g.node_id).padEnd(34)} ${String(g.name ?? "(no name)")}`);

  // Keys are what you will say, so they start from each light's app name; rename them to taste.
  const used = new Set<string>();
  const devices: Record<string, Device> = {};
  for (const [i, d] of lights.entries()) {
    const base = String(d.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || `light ${i + 1}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base} ${n}`;
    used.add(key);
    const c = cct[d.node_id as string];
    devices[key] = { node_id: d.node_id as string, model: String(d.name ?? ""), supportsCct: c ?? true };
  }
  console.log(`\nA devices.json to start from (rename each key to the name you will say; ${groups.length === 1 ? "allGroup is the one group above" : "add \"allGroup\" by hand if one group above holds every light"}):`);
  // One light per line, so the keys are easy to rename by hand.
  const rows = Object.entries(devices).map(([k, d]) =>
    `    ${JSON.stringify(k)}: { "node_id": ${JSON.stringify(d.node_id)}, "model": ${JSON.stringify(d.model)}, "supportsCct": ${d.supportsCct} }`);
  console.log([
    "{",
    ...(groups.length === 1 ? [`  "allGroup": ${JSON.stringify(groups[0].node_id)},`] : []),
    `  "devices": {`,
    rows.join(",\n"),
    "  }",
    "}",
  ].join("\n"));
  console.log(`Write it to ${DEVICES_PATH}`);
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  // Listing scenes reads only scenes.json, so it never launches amaran Desktop or touches a light.
  if (cmd === "scenes") {
    const scenes = await loadScenes();
    if (Object.keys(scenes).length === 0) console.log(`(no scenes yet; save one with "scene save <name>" — ${SCENES_PATH})`);
    for (const [name, entries] of Object.entries(scenes)) {
      console.log(`${name}: ${Object.entries(entries).map(([l, e]) => `${l}=${e.sleep ? "off" : `${e.intensity}%`}`).join(", ")}`);
    }
    process.exit(0);
  }

  const client = await ensureApp();

  if (DISCOVERY) {
    await discover(client);
    client.close();
    process.exit(failures > 0 ? 1 : 0);
  }

  switch (cmd) {
    case "status": case "list": {
      const state = await readState(client);
      for (const [name, st] of Object.entries(state)) if (!st.ok) { failures++; console.error(`UNREADABLE ${name}: ${st.error}`); }
      if (process.argv.includes("--json")) {
        console.log(JSON.stringify(state, null, 2));
      } else {
        for (const [name, st] of Object.entries(state)) {
          const d = DEVICES[name];
          console.log(
            `${name.padEnd(13)} ${d.model.padEnd(20)} ${!st.ok ? "UNREADABLE" : st.sleeping ? "SLEEPING" : `${st.intensity}%`.padEnd(8)}` +
            (st.ok && st.cct ? ` ${st.cct}K` : "")
          );
        }
      }
      break;
    }

    case "set": {
      const target = resolveLight(arg1 ?? "");
      if (!target) { console.error(`Unknown light "${arg1}". Lights: ${Object.keys(DEVICES).join(", ")}, all`); process.exit(1); }
      const intensity = flag("intensity") ? Number(flag("intensity")) : undefined;
      const cct = flag("cct") ? Number(flag("cct")) : undefined;
      if (intensity === undefined && cct === undefined) { console.error("Nothing to set — pass --intensity and/or --cct"); process.exit(1); }
      const targets = target === "all"
        ? Object.entries(DEVICES).map(([k, d]) => ({ key: k, ...d }))
        : [target];
      for (const t of targets) {
        // "set all --cct" sends the cct only to the lights that have it, and says so; naming a
        // daylight-only light with --cct fails in the read-back instead of exiting 0.
        if (target === "all" && cct !== undefined && !t.supportsCct) {
          console.error(`${t.key}: no CCT control, --cct not sent`);
          if (intensity === undefined) continue;
          await applyAndConfirm(client, t.key, t, { intensity });
          continue;
        }
        await applyAndConfirm(client, t.key, t, { intensity, cct });
      }
      break;
    }

    case "wake": case "sleep": {
      const wantSleep = cmd === "sleep";
      const target = resolveLight(arg1 ?? "all");
      if (!target) { console.error(`Unknown light "${arg1}"`); process.exit(1); }
      const entries = target === "all"
        ? Object.entries(DEVICES)
        : [[target.key, DEVICES[target.key]] as [string, Device]];
      // "all" is one group write when devices.json names allGroup, otherwise one write per light.
      const writes: [string, string][] = target !== "all"
        ? [[target.key, target.node_id]]
        : ALL_GROUP ? [["all", ALL_GROUP]] : entries.map(([key, d]) => [key, d.node_id]);
      const failedWrites = new Set<string>();
      for (const [label, node] of writes) {
        try {
          await must(client, "set_sleep", node, { sleep: wantSleep });
        } catch (err) {
          failures++;
          failedWrites.add(label);
          console.error(`FAILED ${cmd} ${label}: ${(err as Error).message}`);
        }
        await sleep(RATE_LIMIT_MS);
      }
      if (failedWrites.has("all")) break;
      for (const [key, d] of entries) {
        if (failedWrites.has(key)) continue;
        const st = await readLight(client, d);
        if (!st.ok || st.sleeping !== wantSleep) {
          failures++;
          console.error(`MISMATCH ${key}: asked ${wantSleep ? "sleep" : "wake"}, light ${st.ok ? `reports ${st.sleeping ? "sleeping" : "awake"}` : "is unreadable"}`);
        } else {
          console.log(`${cmd}: ${key} (${st.sleeping ? "sleeping" : "awake"}, reported by light)`);
        }
        await sleep(RATE_LIMIT_MS);
      }
      break;
    }

    case "scene": {
      const scenes = await loadScenes();
      if (arg1 === "save") {
        if (!arg2) { console.error("scene save <name>"); process.exit(1); }
        const state = await readState(client);
        const unreadable = Object.entries(state).filter(([, st]) => !st.ok);
        if (unreadable.length > 0) {
          for (const [name, st] of unreadable) console.error(`UNREADABLE ${name}: ${st.error}`);
          console.error("Refusing to save a scene from a partial read.");
          process.exit(1);
        }
        scenes[arg2] = Object.fromEntries(
          Object.entries(state).map(([name, s]) => [
            name,
            s.sleeping ? { sleep: true } : { intensity: s.intensity, ...(s.cct ? { cct: s.cct } : {}), sleep: false },
          ])
        );
        await saveScenes(scenes);
        console.log(`Saved current state as scene "${arg2}" (${SCENES_PATH})`);
        break;
      }
      const scene = scenes[arg1 ?? ""];
      if (!scene) { console.error(`Unknown scene "${arg1}". Scenes: ${Object.keys(scenes).join(", ") || "(none)"}`); process.exit(1); }
      for (const [name, entry] of Object.entries(scene)) {
        const d = DEVICES[name];
        if (!d) { console.error(`UNKNOWN light "${name}" in scene: not applied.`); failures++; continue; }
        await applyAndConfirm(client, name, d, entry);
      }
      if (failures > 0) console.error(`Scene "${arg1}" NOT fully applied: ${failures} light(s) failed or mismatched.`);
      else console.log(`Scene "${arg1}" applied and confirmed by every light.`);
      break;
    }

    default:
      console.error(`Unknown command "${cmd}"`);
      process.exit(1);
  }

  client.close();
  process.exit(failures > 0 ? 1 : 0);
}

main();
