#!/usr/bin/env bun
/**
 * Builds and ships the `wf-clock` Worker (WORKFLOWS ISA F27, ISC-316, ISC-318).
 *
 *   bun LIFEOS/WORKFLOWS/clock/deploy.ts build            bundle into clock/out/ (no network)
 *   bun LIFEOS/WORKFLOWS/clock/deploy.ts deploy           build, then `cf deploy --prebuilt` through CfEnv (its review gate runs)
 *   bun LIFEOS/WORKFLOWS/clock/deploy.ts secrets          set CLOCK_TOKEN (from the Keychain, created there once) and the Twilio keys
 *   bun LIFEOS/WORKFLOWS/clock/deploy.ts connect <url>    point this Mac's dispatcher at the deployed Worker
 *
 * The bundle is compiled from the engine source on disk with the same bundler as the runners (cloud/build.ts), so the
 * Worker's clock is the Mac's clock. The token lives in the login Keychain and reaches the Worker through CfEnv's stdin;
 * it is never an argument, a file or a log line.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bundleWorker } from "../cloud/build.ts";
import { CLAIMS_DATABASE } from "../cloud/claims.ts";
import { clockConfigPath, KEYCHAIN_SERVICE } from "../engine/cloud-clock.ts";
import { writeFileAtomic } from "../engine/ledger.ts";

const DIR = import.meta.dir;
const OUT = join(DIR, "out");
const CF_ENV = resolve(DIR, "..", "..", "TOOLS", "CfEnv.ts");
export const WORKER_NAME = "wf-clock";
const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_TO_NUMBER"];

export async function buildClock(out: string = OUT): Promise<{ dir: string; bytes: number }> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const entry = join(out, "entry.ts");
  writeFileSync(entry, [
    `import { createClock } from ${JSON.stringify(join(DIR, "worker.ts"))};`,
    "const clock = createClock();",
    "export default { fetch: (request, env) => clock.fetch(request, env), scheduled: async (controller, env) => { await clock.scheduled(controller, env); } };",
    "",
  ].join("\n"));
  let code: string;
  try {
    ({ code } = await bundleWorker(entry));
  } finally {
    rmSync(entry, { force: true });
  }
  const spec = join(out, ".cloudflare", "output", "v0");
  const workerDir = join(spec, "workers", "default");
  mkdirSync(join(workerDir, "bundle"), { recursive: true });
  writeFileSync(join(workerDir, "bundle", "worker.js"), code);
  writeFileSync(join(spec, "config.json"), `${JSON.stringify({ buildContext: { isPreview: false, mode: "production" } })}\n`);
  writeFileSync(join(workerDir, "worker.config.json"), `${JSON.stringify({
    name: WORKER_NAME,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    previewUrls: false,
    triggers: [{ type: "scheduled", schedule: "* * * * *" }],
    env: { CLAIMS: { type: "d1", name: CLAIMS_DATABASE } },
    manifest: { type: "partial", mainModule: "worker.js", modules: {} },
  }, null, 2)}\n`);
  return { dir: out, bytes: code.length };
}

function keychainToken(create: boolean): string | null {
  const read = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" });
  if (read.status === 0 && read.stdout.trim()) return read.stdout.trim();
  if (!create) return null;
  const token = randomBytes(32).toString("hex");
  // Through `security -i` on stdin, so the token is never an argument another process can read from ps.
  const add = spawnSync("security", ["-i"], { input: `add-generic-password -a lifeos -s ${KEYCHAIN_SERVICE} -w ${token} -U\n`, encoding: "utf8" });
  return add.status === 0 ? token : null;
}

function putSecret(name: string, stdin?: string): boolean {
  const args = [CF_ENV, "secret", "put", name, "--name", WORKER_NAME, ...(stdin === undefined ? ["--from-env"] : [])];
  const r = spawnSync("bun", args, { input: stdin, stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
  return r.status === 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv;
  switch (command) {
    case "build": {
      const r = await buildClock();
      console.log(`Built ${WORKER_NAME}: ${r.bytes} bytes in ${r.dir}`);
      return 0;
    }
    case "deploy": {
      const r = await buildClock();
      console.log(`Built ${WORKER_NAME}: ${r.bytes} bytes`);
      return spawnSync("bun", [CF_ENV, "deploy", "--prebuilt"], { cwd: r.dir, stdio: "inherit" }).status ?? 1;
    }
    case "secrets": {
      const token = keychainToken(true);
      if (!token) {
        console.error("could not read or create the clock token in the Keychain");
        return 1;
      }
      let ok = putSecret("CLOCK_TOKEN", token);
      for (const key of TWILIO_KEYS) ok = putSecret(key) && ok;
      return ok ? 0 : 1;
    }
    case "connect": {
      if (!arg || !/^https:\/\//.test(arg)) {
        console.error("usage: deploy.ts connect https://wf-clock.<subdomain>.workers.dev");
        return 2;
      }
      const path = clockConfigPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, `${JSON.stringify({ url: arg.replace(/\/$/, "") })}\n`);
      console.log(`Connected: ${path}`);
      return 0;
    }
    default:
      console.error("usage: deploy.ts build | deploy | secrets | connect <url>");
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
