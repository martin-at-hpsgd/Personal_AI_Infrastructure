#!/usr/bin/env bun
/**
 * Spotify.ts — deterministic CLI for the Spotify Web API.
 *
 * Auth: env-based (SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN),
 * loaded from ~/.claude/.env. `auth` runs the one-time OAuth flow and persists the
 * refresh token. Every other command refreshes an access token per invocation —
 * no daemon, no session state, no MCP.
 *
 * Exit codes: 0 success · 1 user error · 2 API/system error.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { applyEnvUpdates } from "./EnvText.ts";
import { getEnvPath } from "../../../LIFEOS/TOOLS/Paths.ts";

const ENV_PATH = getEnvPath();
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-library-read",
  "user-library-modify",
].join(" ");

// ---------- env ----------

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const k of ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

/** Append or replace KEY=value lines in ~/.claude/.env (never clobbers other lines). */
function persistEnv(updates: Record<string, string>): void {
  const text = applyEnvUpdates(existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "", updates);
  writeFileSync(ENV_PATH, text);
}

// ---------- args ----------

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}
const asJson = flags.json === true;

function fail(msg: string, code: 1 | 2 = 1): never {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

// ---------- tokens ----------

async function tokenRequest(body: URLSearchParams, id: string, secret: string): Promise<any> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body,
  });
  if (!res.ok) fail(`token request failed: ${res.status} ${await res.text()}`, 2);
  return res.json();
}

async function getAccessToken(env: Record<string, string>, allowClientCreds = false): Promise<string> {
  const id = env.SPOTIFY_CLIENT_ID ?? fail("SPOTIFY_CLIENT_ID missing — set it up first: see skills/Spotify/Setup.md");
  const secret = env.SPOTIFY_CLIENT_SECRET ?? fail("SPOTIFY_CLIENT_SECRET missing — see skills/Spotify/Setup.md");
  if (env.SPOTIFY_REFRESH_TOKEN) {
    const data = await tokenRequest(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.SPOTIFY_REFRESH_TOKEN }),
      id, secret,
    );
    if (data.refresh_token && data.refresh_token !== env.SPOTIFY_REFRESH_TOKEN) {
      persistEnv({ SPOTIFY_REFRESH_TOKEN: data.refresh_token });
    }
    return data.access_token;
  }
  if (allowClientCreds) {
    const data = await tokenRequest(new URLSearchParams({ grant_type: "client_credentials" }), id, secret);
    return data.access_token;
  }
  fail("SPOTIFY_REFRESH_TOKEN missing — this command needs user authorization; run `auth` (see skills/Spotify/Setup.md)");
}

// ---------- api ----------

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.error?.message ?? text ?? String(res.status);
    if (res.status === 401) fail(`unauthorized (${msg}) — refresh token may be dead; re-run \`auth\``, 2);
    if (res.status === 403) fail(`forbidden (${msg}) — playback control needs Spotify Premium and an active device`, 2);
    if (res.status === 404 && path.startsWith("/me/player")) fail("no active device — open Spotify somewhere first (`devices` lists them)", 2);
    fail(`API ${res.status}: ${msg}`, 2);
  }
  return data;
}

function out(data: unknown, human: () => void): void {
  if (asJson) console.log(JSON.stringify(data, null, 2));
  else human();
}

const fmtTrack = (t: any) => `${t.name} — ${t.artists?.map((a: any) => a.name).join(", ")} · ${t.album?.name ?? ""} · ${t.uri}`;

// ---------- commands ----------

const HELP = `Spotify.ts — deterministic Spotify CLI (auth via ~/.claude/.env)

USAGE: bun Spotify.ts <command> [flags]   (--json on any command for raw output)

  auth                                     One-time OAuth: opens browser, persists refresh token
  search --query <q> [--type track|album|playlist|artist] [--limit N]
  now-playing                              Current track
  recent [--limit N]                       Recently played
  queue                                    Current queue
  devices                                  Available playback devices
  playlists [--limit N]                    My playlists (name + ID)
  playlist-tracks --id <playlistId> [--limit N]
  create-playlist --name <name> [--description <d>] [--public]
  add-tracks --id <playlistId> --uris <uri,uri,...>
  follow-playlist --id <playlistId>        "Add someone's playlist to my library"
  saved-tracks [--limit N]                 My liked songs
  play [--uri <trackUri>] [--context <contextUri>] [--device <id>]
  pause · next · prev
  add-to-queue --uri <trackUri>
  volume --percent <0-100>

Playback commands need Spotify Premium and an active device.
IDs/URIs come from search/playlists — everything keys off IDs, never names.`;

async function main() {
  const env = loadEnv();

  switch (cmd) {
    case undefined:
    case "--help":
    case "help": {
      console.log(HELP);
      return;
    }

    case "auth": {
      const id = (flags["client-id"] as string) ?? env.SPOTIFY_CLIENT_ID ?? fail("no client id — pass --client-id or set SPOTIFY_CLIENT_ID");
      const secret = (flags["client-secret"] as string) ?? env.SPOTIFY_CLIENT_SECRET ?? fail("no client secret — pass --client-secret or set SPOTIFY_CLIENT_SECRET");
      const state = crypto.randomUUID();
      const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
        response_type: "code", client_id: id, scope: SCOPES, redirect_uri: REDIRECT_URI, state,
      })}`;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const code = await new Promise<string>((resolve, reject) => {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 8888,
          fetch(req) {
            const url = new URL(req.url);
            if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
            if (url.searchParams.get("state") !== state) { reject(new Error("state mismatch")); return new Response("State mismatch", { status: 400 }); }
            const err = url.searchParams.get("error");
            if (err) { reject(new Error(err)); return new Response(`Authorization failed: ${err}`, { status: 400 }); }
            const c = url.searchParams.get("code");
            if (!c) { reject(new Error("no code")); return new Response("No code", { status: 400 }); }
            setTimeout(() => server.stop(true), 100);
            resolve(c);
            return new Response("Spotify authorized. You can close this tab.", { headers: { "Content-Type": "text/plain" } });
          },
        });
        console.log("Opening browser for Spotify consent (waiting up to 5 minutes)...");
        console.log(`If it doesn't open: ${authUrl}`);
        Bun.spawn(["open", authUrl]);
        timeout = setTimeout(() => { server.stop(true); reject(new Error("timed out waiting for callback")); }, 300_000);
      }).finally(() => clearTimeout(timeout))
        .catch((e) => fail(`authorization failed: ${e.message}`, 2));

      const data = await tokenRequest(
        new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
        id, secret,
      );
      persistEnv({ SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REFRESH_TOKEN: data.refresh_token });
      const me = await api(data.access_token, "GET", "/me");
      console.log(`Authorized as ${me.display_name ?? me.id} (${me.product ?? "unknown tier"}). Refresh token saved to ${ENV_PATH}.`);
      return;
    }

    case "search": {
      const q = (flags.query as string) ?? positional.join(" ") ?? fail("--query required");
      if (!q) fail("--query required");
      const type = (flags.type as string) ?? "track";
      const limit = (flags.limit as string) ?? "10";
      const token = await getAccessToken(env, true);
      const data = await api(token, "GET", `/search?${new URLSearchParams({ q, type, limit })}`);
      const items = data[`${type}s`]?.items?.filter(Boolean) ?? [];
      out(items, () => {
        for (const it of items) {
          if (type === "track") console.log(fmtTrack(it));
          else console.log(`${it.name}${it.owner ? ` — ${it.owner.display_name}` : ""}${it.artists ? ` — ${it.artists.map((a: any) => a.name).join(", ")}` : ""} · ${it.uri}`);
        }
        if (!items.length) console.log("(no results)");
      });
      return;
    }

    case "now-playing": {
      const token = await getAccessToken(env);
      const data = await api(token, "GET", "/me/player/currently-playing");
      out(data, () => console.log(data?.item ? `${data.is_playing ? "▶" : "⏸"} ${fmtTrack(data.item)}` : "Nothing playing."));
      return;
    }

    case "recent": {
      const limit = (flags.limit as string) ?? "20";
      const token = await getAccessToken(env);
      const data = await api(token, "GET", `/me/player/recently-played?limit=${limit}`);
      out(data.items, () => data.items.forEach((i: any) => console.log(`${i.played_at}  ${fmtTrack(i.track)}`)));
      return;
    }

    case "queue": {
      const token = await getAccessToken(env);
      const data = await api(token, "GET", "/me/player/queue");
      out(data, () => {
        if (data.currently_playing) console.log(`▶ ${fmtTrack(data.currently_playing)}`);
        data.queue?.forEach((t: any, i: number) => console.log(`${i + 1}. ${fmtTrack(t)}`));
      });
      return;
    }

    case "devices": {
      const token = await getAccessToken(env);
      const data = await api(token, "GET", "/me/player/devices");
      out(data.devices, () => {
        for (const d of data.devices) console.log(`${d.is_active ? "●" : "○"} ${d.name} (${d.type}) vol=${d.volume_percent} id=${d.id}`);
        if (!data.devices.length) console.log("(no devices — open Spotify somewhere)");
      });
      return;
    }

    case "playlists": {
      const limit = (flags.limit as string) ?? "50";
      const token = await getAccessToken(env);
      const data = await api(token, "GET", `/me/playlists?limit=${limit}`);
      const items = (data.items ?? []).filter(Boolean);
      out(items, () => items.forEach((p: any) => console.log(`${p.name}${p.tracks?.total != null ? ` · ${p.tracks.total} tracks` : ""} · ${p.id}`)));
      return;
    }

    case "playlist-tracks": {
      const id = (flags.id as string) ?? fail("--id required (playlist ID)");
      const limit = (flags.limit as string) ?? "100";
      const token = await getAccessToken(env);
      const data = await api(token, "GET", `/playlists/${id}/tracks?limit=${limit}`);
      out(data.items, () => data.items.forEach((i: any) => i.track && console.log(fmtTrack(i.track))));
      return;
    }

    case "create-playlist": {
      const name = (flags.name as string) ?? fail("--name required");
      const token = await getAccessToken(env);
      const me = await api(token, "GET", "/me");
      const data = await api(token, "POST", `/users/${me.id}/playlists`, {
        name, description: (flags.description as string) ?? "", public: flags.public === true,
      });
      out(data, () => console.log(`Created "${data.name}" · id=${data.id} · ${data.external_urls?.spotify ?? ""}`));
      return;
    }

    case "add-tracks": {
      const id = (flags.id as string) ?? fail("--id required (playlist ID)");
      const uris = ((flags.uris as string) ?? fail("--uris required (comma-separated spotify:track:... URIs)")).split(",").map((s) => s.trim()).filter(Boolean);
      const token = await getAccessToken(env);
      for (let i = 0; i < uris.length; i += 100) {
        await api(token, "POST", `/playlists/${id}/tracks`, { uris: uris.slice(i, i + 100) });
      }
      console.log(`Added ${uris.length} track(s) to ${id}.`);
      return;
    }

    case "follow-playlist": {
      const id = (flags.id as string) ?? fail("--id required (playlist ID)");
      const token = await getAccessToken(env);
      await api(token, "PUT", `/playlists/${id}/followers`, { public: false });
      console.log(`Following playlist ${id} (now in your library).`);
      return;
    }

    case "saved-tracks": {
      const limit = (flags.limit as string) ?? "50";
      const token = await getAccessToken(env);
      const data = await api(token, "GET", `/me/tracks?limit=${limit}`);
      out(data.items, () => data.items.forEach((i: any) => console.log(fmtTrack(i.track))));
      return;
    }

    case "play": {
      const token = await getAccessToken(env);
      const device = flags.device ? `?device_id=${flags.device}` : "";
      const body = flags.uri ? { uris: [flags.uri as string] } : flags.context ? { context_uri: flags.context as string } : undefined;
      await api(token, "PUT", `/me/player/play${device}`, body);
      console.log("Playing.");
      return;
    }

    case "pause": {
      await api(await getAccessToken(env), "PUT", "/me/player/pause");
      console.log("Paused.");
      return;
    }

    case "next": {
      await api(await getAccessToken(env), "POST", "/me/player/next");
      console.log("Skipped.");
      return;
    }

    case "prev": {
      await api(await getAccessToken(env), "POST", "/me/player/previous");
      console.log("Previous.");
      return;
    }

    case "add-to-queue": {
      const uri = (flags.uri as string) ?? fail("--uri required (spotify:track:...)");
      await api(await getAccessToken(env), "POST", `/me/player/queue?uri=${encodeURIComponent(uri)}`);
      console.log("Queued.");
      return;
    }

    case "volume": {
      const pct = (flags.percent as string) ?? fail("--percent required (0-100)");
      await api(await getAccessToken(env), "PUT", `/me/player/volume?volume_percent=${pct}`);
      console.log(`Volume ${pct}%.`);
      return;
    }

    default:
      fail(`unknown command "${cmd}" — run with --help`);
  }
}

main();
