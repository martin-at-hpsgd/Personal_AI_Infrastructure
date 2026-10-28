#!/usr/bin/env bun
/**
 * Connects a Linq account to Tex (Relay ISA F28), once LINQ_API_KEY is in .env:
 *
 *   bun LIFEOS/RELAY/worker/LinqSetup.ts events     update the existing subscription to EVENTS in place (Relay F33); the
 *                                                   signing secret, line and URL stay as they are
 *   bun LIFEOS/RELAY/worker/LinqSetup.ts            find our Linq line, subscribe the Worker to its webhooks, store the
 *                                                   signing secret, push the Worker's secrets, and point the bridge config
 *                                                   at the inbox (the transport itself is not switched here)
 *
 * No secret is printed: the API key is read from .env in code, the signing secret goes to Secrets.ts on stdin, and the
 * Worker's copies go through deploy.ts → CfEnv on stdin.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvPath, lifeosPath } from "../../TOOLS/Paths.ts";
import { invariant } from "../../TOOLS/Invariant.ts";
import { KEPT_EVENTS, RECORDED_EVENTS } from "./src/classify.ts";

const DIR = import.meta.dir;
// The Worker's URL names the Cloudflare account, so it lives in USER: { "url": "https://lifeos-tex.<subdomain>.workers.dev" }.
const WORKER_URL: string = JSON.parse(readFileSync(lifeosPath("USER", "RELAY", "tex-worker.json"), "utf8")).url;
invariant(/^https:\/\/[\w.-]+$/.test(WORKER_URL), "USER/RELAY/tex-worker.json names the Worker's https URL");
const API = "https://api.linqapp.com/api/partner/v3";
// One list with the Worker's filter (src/classify.ts), so a subscribed event is never dropped and a kept one never missing.
const EVENTS = [...KEPT_EVENTS, ...RECORDED_EVENTS];

function envValue(key: string): string | undefined {
  for (const line of readFileSync(getEnvPath(), "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m?.[1] === key) return m[2]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

async function linq(key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Linq ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function main(): Promise<number> {
  const key = envValue("LINQ_API_KEY");
  if (!key) { console.error("LINQ_API_KEY is not in ~/.claude/.env yet"); return 1; }

  if (process.argv[2] === "events") {
    const target = `${WORKER_URL}/linq/webhook`;
    const existing = await linq(key, "GET", "/webhook-subscriptions");
    const subs: { id: string; target_url: string }[] = existing.subscriptions ?? existing.data ?? existing.webhook_subscriptions ?? [];
    const ours = subs.filter(s => s.target_url === target);
    if (ours.length !== 1) { console.error(`expected one subscription to the Worker, found ${ours.length}; run the full setup`); return 1; }
    const r = await linq(key, "PUT", `/webhook-subscriptions/${ours[0]!.id}`, { subscribed_events: EVENTS });
    const now: string[] = r.subscribed_events ?? r.subscription?.subscribed_events ?? [];
    invariant(EVENTS.every(e => now.includes(e)), "Linq now sends every event the Worker keeps");
    console.log(`webhook subscription ${ours[0]!.id.slice(0, 8)} now sends: ${now.join(", ")}`);
    return 0;
  }
  const numbers = await linq(key, "GET", "/phone_numbers");
  const list: { phone_number?: string; id?: string }[] = numbers.phone_numbers ?? numbers.data ?? numbers;
  invariant(Array.isArray(list) && list.length > 0, "the Linq account has at least one line");
  const line = list[0]!.phone_number!;
  console.log(`Linq line: ${line}${list.length > 1 ? ` (first of ${list.length})` : ""}`);

  const target = `${WORKER_URL}/linq/webhook`;
  const existing = await linq(key, "GET", "/webhook-subscriptions");
  const subs: { id: string; target_url: string }[] = existing.subscriptions ?? existing.data ?? existing.webhook_subscriptions ?? [];
  for (const s of subs.filter(s => s.target_url === target)) {
    await linq(key, "DELETE", `/webhook-subscriptions/${s.id}`);
    console.log(`removed an older subscription to the same URL (${s.id.slice(0, 8)})`);
  }
  const sub = await linq(key, "POST", "/webhook-subscriptions", { target_url: target, subscribed_events: EVENTS, phone_numbers: [line] });
  invariant(typeof sub.signing_secret === "string" && sub.signing_secret.length > 0, "Linq returned a signing secret");
  console.log(`webhook subscription ${String(sub.id).slice(0, 8)} → ${target} (${EVENTS.join(", ")})`);

  const set = spawnSync("bun", [join(DIR, "../../TOOLS/Secrets.ts"), "set", "LINQ_WEBHOOK_SECRET"], { input: sub.signing_secret, stdio: ["pipe", "inherit", "inherit"] });
  if (set.status !== 0) { console.error("could not store LINQ_WEBHOOK_SECRET"); return 1; }

  const push = spawnSync("bun", [join(DIR, "deploy.ts"), "secrets"], { cwd: DIR, stdio: "inherit" });
  if (push.status !== 0) { console.error("could not push the Worker's secrets"); return 1; }

  const cfgPath = lifeosPath("USER", "RELAY", "state", "bridge-config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.linq = { inboxUrl: `${WORKER_URL.replace(/^https/, "wss")}/bridge`, line };
  const tmp = `${cfgPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, cfgPath);
  console.log(`bridge config: linq.inboxUrl and linq.line set; transport is still "${cfg.transport ?? "photon"}"`);
  return 0;
}

if (import.meta.main) process.exit(await main());
