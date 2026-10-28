#!/usr/bin/env bun
/**
 * OmnyPublish.ts — Publish an audio file as a podcast episode on Omny Studio.
 *
 * Every episode gets the same settings: every configured playlist, Visibility Public,
 * PublishState Published, the configured EpisodeType and AudioOptions (defaults: Full,
 * IncludeIntroOutro true, AutoLevelAudio false), no clip image, so the program-default
 * artwork shows. Set them once in Config.md to match your program's existing episodes.
 *
 * API mechanics (live-probed; the Management API has no public docs):
 *   create : POST /v1/programs/{programId}/clips  { Title }        (other fields ignored at create)
 *   upload : PUT  /v1/clips/{clipId}/audio        multipart file    (202, async processing)
 *   poll   : GET  /v1/clips/{clipId}              until State=Ready
 *   update : PATCH /v1/clips/{clipId}             { DescriptionHtml, PlaylistIds, EpisodeType, AudioOptions }
 *            (Description is derived from DescriptionHtml; plain "Description" is ignored)
 *   publish: PATCH /v1/clips/{clipId}             { PublishState: "Published", Visibility: "Public" }
 *            MUST be one PATCH — PublishState alone is silently ignored. → transitional "Publishing".
 *   delete : DELETE /v1/clips/{clipId}
 *   rate   : 429s carry X-RateLimit-Reset seconds; retry with backoff.
 *
 * --youtube runs only where the install provides that lane beside this file (a lane that is not in the public release);
 * elsewhere it exits 1 saying it is not available in this install, and the episode comes from --audio.
 *
 * Usage:
 *   bun OmnyPublish.ts --audio <file.mp3> --title "T" --description "D"
 *   Flags: --dry-run (preview, creates nothing) · --draft (land as Draft for a manual review before publishing)
 *
 * Env: OMNYSTUDIO_API_KEY (from ~/.claude/.env)
 * Program/playlist ids and episode settings: the skill's USER Config.md (src/skill-config.ts; Setup.md).
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import { formatBlocked, gatedTransmit, type GateDeps } from "../../../LIFEOS/TOOLS/lib/SendGate.ts";
import { readSkillConfig, readSkillConfigBool, SKILL_CONFIG_PATH } from "../src/skill-config";

const BASE = "https://api.omnystudio.com/v1";
const PROGRAM_ID = readSkillConfig("omny_program_id");
const PLAYLIST_IDS = (readSkillConfig("omny_playlist_ids") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const KEY = process.env.OMNYSTUDIO_API_KEY;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Api = (path: string, init?: RequestInit) => Promise<any>;

async function api(path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${KEY}`,
        Accept: "application/json",
        ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...((init.headers as Record<string, string>) || {}),
      },
    });
    if (res.status === 429) {
      const reset = Number(res.headers.get("X-RateLimit-Reset")) || 30;
      console.log(`  rate-limited; waiting ${reset}s`);
      await sleep((reset + 1) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`${path}: still rate-limited after 5 attempts`);
}

async function findByTitle(title: string, programId: string, call: Api): Promise<any | null> {
  // Bounded scan of the newest 300 clips — backfill/duplicate windows are always recent.
  for (let page = 1; page <= 6; page++) {
    const d = await call(`/programs/${programId}/clips?pageSize=50&page=${page}`);
    const items = d.Items || [];
    const hit = items.find((c: any) => c.Title.trim().toLowerCase() === title.trim().toLowerCase());
    if (hit) return hit;
    if (!d.HasNext || items.length === 0) break;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** What the optional YouTube lane (not in the public release) provides when an install carries it. */
interface YoutubeLane {
  fromYouTube(idOrUrl: string, metadataOnly: boolean): Promise<{ audio: string; title: string; description: string }>;
}
const YOUTUBE_LANE = join(import.meta.dir, "OmnyYoutube.ts"); // optional lane, not in the public release
/** The --youtube lane, or null when this install does not carry it. A present file that fails to load throws. */
async function youtubeLane(): Promise<YoutubeLane | null> {
  return existsSync(YOUTUBE_LANE) ? ((await import(YOUTUBE_LANE)) as YoutubeLane) : null;
}

async function main() {
  let audio = arg("audio");
  let title = arg("title");
  let description = arg("description");
  const youtube = arg("youtube");
  const dryRun = flag("dry-run");
  const draft = flag("draft");

  if (!KEY) {
    console.error("OMNYSTUDIO_API_KEY not set");
    process.exit(1);
  }

  if (!PROGRAM_ID || PLAYLIST_IDS.length === 0) {
    console.error(
      `Omny program/playlist IDs not set — add omny_program_id and omny_playlist_ids to ${SKILL_CONFIG_PATH} (see the skill's Setup.md)`
    );
    process.exit(1);
  }

  if (youtube) {
    const lane = await youtubeLane();
    if (!lane) {
      console.error("--youtube is not available in this install: export the episode audio (your editor's export of your own recording) and pass --audio <file> with --title and --description");
      process.exit(1);
    }
    const yt = await lane.fromYouTube(youtube, dryRun);
    audio = audio ?? yt.audio;
    title = title ?? yt.title;
    description = description ?? yt.description;
    console.log(`  title: ${title}`);
    console.log(`  description: ${description}`);
  }

  if (!title || !description || (!audio && !dryRun)) {
    console.error("Usage: bun OmnyPublish.ts --audio <file> --title <t> --description <d> [--dry-run] [--draft]");
    process.exit(1);
  }

  const episode = episodeSettingsFromConfig();
  const outcome = await publishEpisode({ audio, title, description, draft, dryRun, programId: PROGRAM_ID, playlistIds: PLAYLIST_IDS, episode });
  if (outcome.status === "duplicate") process.exit(2);
  if (outcome.status === "blocked") process.exit(4);
  if (outcome.status === "mismatch") process.exit(3);
}

/** Test seams: injected Omny API, sleep and SendGate dirs. Production passes none. */
export interface PublishDeps { api?: Api; sleep?: (ms: number) => Promise<void>; gate?: GateDeps }
/** Per-program episode settings, applied to every episode and verified after publish. */
export interface EpisodeSettings { episodeType: "Full" | "Trailer" | "Bonus"; includeIntroOutro: boolean; autoLevelAudio: boolean }
export const DEFAULT_EPISODE_SETTINGS: EpisodeSettings = { episodeType: "Full", includeIntroOutro: true, autoLevelAudio: false };

/** Episode settings from Config.md; an absent key keeps its default, a malformed one throws naming the key. */
export function episodeSettingsFromConfig(): EpisodeSettings {
  const type = readSkillConfig("omny_episode_type") ?? DEFAULT_EPISODE_SETTINGS.episodeType;
  if (type !== "Full" && type !== "Trailer" && type !== "Bonus") {
    throw new Error(`${SKILL_CONFIG_PATH}: omny_episode_type must be Full, Trailer or Bonus (got ${JSON.stringify(type)})`);
  }
  return {
    episodeType: type,
    includeIntroOutro: readSkillConfigBool("omny_include_intro_outro", DEFAULT_EPISODE_SETTINGS.includeIntroOutro),
    autoLevelAudio: readSkillConfigBool("omny_auto_level_audio", DEFAULT_EPISODE_SETTINGS.autoLevelAudio),
  };
}

export interface PublishOptions { audio?: string; title: string; description: string; draft: boolean; dryRun: boolean; programId: string; playlistIds: string[]; episode?: EpisodeSettings }
export type PublishOutcome = { status: "dry-run" | "duplicate" | "blocked" | "mismatch" | "draft" | "published" };

/**
 * The send path. The exact audio file and the title and description text are proofed at the publish boundary, here,
 * before the first Omny write (clip create, audio upload, settings, publish); a fail sends nothing.
 */
export async function publishEpisode(o: PublishOptions, deps: PublishDeps = {}): Promise<PublishOutcome> {
  const { audio, title, description, draft, dryRun, programId, playlistIds } = o;
  const episode = o.episode ?? DEFAULT_EPISODE_SETTINGS;
  const call: Api = deps.api ?? api;
  const wait = deps.sleep ?? sleep;
  let mismatch = false;
  // Anti-duplicate gate: never create a second clip with an existing title.
  const existing = await findByTitle(title, programId, call);
  if (existing) {
    console.error(`DUPLICATE: "${title}" already exists as clip ${existing.Id} (state: ${existing.PublishState})`);
    return { status: "duplicate" };
  }

  const settingsPatch = {
    DescriptionHtml: `<p>${escapeHtml(description)}</p>`,
    PlaylistIds: playlistIds,
    EpisodeType: episode.episodeType,
    AudioOptions: { IncludeIntroOutro: episode.includeIntroOutro, AutoLevelAudio: episode.autoLevelAudio },
  };

  if (dryRun) {
    console.log("DRY RUN — no clip created. Sequence:");
    console.log(`  1. POST /programs/${programId}/clips ${JSON.stringify({ Title: title })}`);
    console.log(`  2. PUT /clips/{id}/audio ← ${audio ?? "<file>"}`);
    console.log(`  3. poll State=Ready`);
    console.log(`  4. PATCH /clips/{id} ${JSON.stringify(settingsPatch)}`);
    console.log(`  5. PATCH /clips/{id} {"PublishState":"${draft ? "Draft" : "Published"}","Visibility":"Public"} (must be one PATCH) → verify`);
    return { status: "dry-run" };
  }
  if (!audio) throw new Error("audio file required to publish");

  const sent = await gatedTransmit(
    { channel: "omny", destination: "publish", body: `${title}\n\n${description}`, recipientClass: "omny", attachments: [resolve(audio)] },
    async (g) => {
      console.log(`Creating clip: ${title}`);
      const clip = await call(`/programs/${programId}/clips`, { method: "POST", body: JSON.stringify({ Title: title }) });
      const clipId = clip.Id;
      console.log(`  clip id: ${clipId}`);

      console.log(`Uploading audio: ${audio}`);
      // Upload the proofed copy: byte-for-byte what the gate checked, not a second read of the path.
      const proofed = g.items.find((i) => i.role === "attachment");
      const file = Bun.file(proofed ? proofed.file : audio);
      const form = new FormData();
      form.append("file", new Blob([await file.arrayBuffer()], { type: "audio/mpeg" }), `${title}.mp3`);
      await call(`/clips/${clipId}/audio`, { method: "PUT", body: form });

      let state = "";
      for (let i = 0; i < 120; i++) {
        await wait(5000);
        const c = await call(`/clips/${clipId}`);
        state = c.State;
        if (state === "Ready") break;
        if (i % 6 === 0) console.log(`  state: ${state} (waiting)`);
      }
      if (state !== "Ready") throw new Error(`Clip never reached Ready (last state: ${state})`);
      console.log("  audio processed: Ready");

      await call(`/clips/${clipId}`, { method: "PATCH", body: JSON.stringify(settingsPatch) });
      console.log("  settings applied (playlists, description, intro/outro)");

      if (!draft) {
        // PublishState is silently ignored unless Visibility is PATCHed in the same request.
        await call(`/clips/${clipId}`, { method: "PATCH", body: JSON.stringify({ PublishState: "Published", Visibility: "Public" }) });
        console.log("  publish triggered");

        // Publishing (intro/outro insertion) is async; wait for Published, then ensure Public.
        let final: any = null;
        for (let i = 0; i < 120; i++) {
          await wait(5000);
          final = await call(`/clips/${clipId}`);
          if (final.PublishState === "Published") break;
          if (i % 6 === 0) console.log(`  publish state: ${final.PublishState} (waiting)`);
        }
        if (final?.PublishState === "Published" && final?.Visibility !== "Public") {
          await call(`/clips/${clipId}`, { method: "PATCH", body: JSON.stringify({ Visibility: "Public" }) });
          final = await call(`/clips/${clipId}`);
        }

        const checks: Record<string, boolean> = {
          playlists: JSON.stringify((final.PlaylistIds || []).slice().sort()) === JSON.stringify([...playlistIds].sort()),
          visibility: final.Visibility === "Public",
          publishState: final.PublishState === "Published",
          episodeType: final.EpisodeType === episode.episodeType,
          introOutro: final.AudioOptions?.IncludeIntroOutro === episode.includeIntroOutro,
          autoLevel: final.AudioOptions?.AutoLevelAudio === episode.autoLevelAudio,
          description: (final.Description || "").length > 0,
        };
        console.log(JSON.stringify({ clipId, publishState: final.PublishState, visibility: final.Visibility, durationSeconds: final.DurationSeconds, publishedDurationSeconds: final.PublishedDurationSeconds, showPage: final.Urls?.ShowPageUrl, checks }, null, 2));
        if (Object.values(checks).some((v) => !v)) {
          console.error("SETTINGS MISMATCH — see checks above");
          mismatch = true;
          return;
        }
        console.log(`✅ Published: ${title}`);
      } else {
        console.log(`✅ Draft ready: ${title} (${clipId})`);
      }
    },
    deps.gate,
    { skill: "Broadcast" },
  );
  if (!sent.ok) {
    console.error(formatBlocked(sent, "omny"));
    return { status: "blocked" };
  }
  for (const fl of sent.gate.flags) console.error(`unearned flag, not blocking: ${fl.check}: ${String(fl.message).replace(/\s+/g, " ").slice(0, 160)}`);
  return { status: mismatch ? "mismatch" : draft ? "draft" : "published" };
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
