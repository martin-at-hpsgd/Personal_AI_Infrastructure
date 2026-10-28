#!/usr/bin/env bun
import { PRIVATE_SKILL_NAMES } from "../../TOOLS/CodeDataBoundary.ts";
/**
 * House Poller — Script-type job
 *
 * Aggregates the reachable-today house devices into one cache the Pulse /house
 * page reads instantly. Shells out to the device CLIs that own each system —
 * hue.ts (lights, direct to the Hue bridge), roomba.ts (vacuums, local API) and
 * eightsleep.ts (the bed, vendor cloud) — so device logic lives in one place
 * and this stays a thin combiner.
 *
 * Reached-by-most-direct-path, never through the Homebridge box (a single point
 * of failure that was down at build time). New device classes (climate, garage,
 * cameras) slot in as new blocks here + a tile on the page.
 *
 * The cron entry lives in LIFEOS/USER/CONFIG/PULSE.user.toml (install-specific:
 * it only makes sense where the principal owns these devices).
 *
 * Output: NO_ACTION on success, or a one-line error.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { readHouseDevices } from "../lib/house-devices";
import { invariant } from "../../TOOLS/Invariant";

const HOME = process.env.HOME ?? homedir();
const SKILL = join(HOME, `.claude/skills/${PRIVATE_SKILL_NAMES.home}`);
const CACHE_DIR = join(HOME, ".claude/LIFEOS/MEMORY/_HOUSE");
const LATEST = join(CACHE_DIR, "latest.json");

/** Run a device CLI and parse its JSON stdout; returns null on any failure. */
async function readJson(tool: string, args: string[]): Promise<any | null> {
  try {
    const proc = Bun.spawn(["bun", join(SKILL, tool), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LIFEOS_HOUSE_NOKICK: "1" }, // read paths never re-kick the poller
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (proc.exitCode !== 0) return null;
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let previousCameras = [];
  try { previousCameras = JSON.parse(readFileSync(LATEST, "utf8")).cameras?.devices ?? []; } catch { /* first poll */ }
  const [lights, vacuums, bed, additions] = await Promise.all([
    readJson("hue.ts", ["state", "--json"]),
    readJson("roomba.ts", ["state", "--json"]),
    readJson("eightsleep.ts", ["status", "--json"]),
    readHouseDevices(previousCameras),
  ]);

  const payload = {
    fetchedAt: new Date().toISOString(),
    ...additions,
    lights: lights
      ? { ok: true, roomCount: lights.roomCount, lightCount: lights.lightCount, anyOn: lights.anyOn, rooms: lights.rooms }
      : { ok: false, error: "Hue bridge unreachable" },
    vacuums: vacuums
      ? { ok: true, count: vacuums.count, robots: vacuums.robots }
      : { ok: false, error: "Roomba API unreachable" },
    bed: bed
      ? {
          ok: true,
          model: bed.device?.modelString ?? null,
          online: bed.device?.online ?? null,
          hasWater: bed.device?.hasWater ?? null,
          needsPriming: bed.device?.needsPriming ?? null,
          priming: bed.device?.priming ?? null,
          lastHeard: bed.device?.lastHeard ?? null,
          sides: (bed.sides ?? []).map((s: any) => ({
            side: s.side, solo: s.solo === true, mine: s.mine === true, state: s.state ?? null,
            on: typeof s.state === "string" && s.state !== "off",
            targetC: s.target_c ?? null, currentC: s.current_c ?? null,
          })),
        }
      : { ok: false, error: "Eight Sleep unreachable (cloud API or credentials)" },
  };

  mkdirSync(CACHE_DIR, { recursive: true });
  invariant(Array.isArray(payload.cameras.devices) && typeof payload.climate.ok === "boolean", "house device state must be shaped before caching");
  const temporary = `${LATEST}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(temporary, LATEST);

  // A poll that reached nothing is a failure worth surfacing in the job log.
  if (!lights && !vacuums && !bed && !additions.climate.ok && !additions.cameras.ok) return void console.log("ERROR: no house devices reachable");
  console.log("NO_ACTION");
}

main().catch((e) => console.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`));
