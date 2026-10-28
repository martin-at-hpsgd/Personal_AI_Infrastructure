#!/usr/bin/env bun
/**
 * Setup.ts — one-time (idempotent) preparation of the essay composition (rendered on HyperFrames).
 *
 *   bun Setup.ts [--check]
 *
 * Installs the Tools dependencies (shiki), checks that every configured face is on disk, and provisions the pinned
 * HyperFrames CLI and its headless browser through the shared seam (LIFEOS/TOOLS/HyperFrames). Fonts and the avatar
 * come from the user zone via CUSTOMIZATIONS/SKILLS/VideoEssay/Config.json:
 *   { "fonts": { "<face id>": "<path.otf>", … one per Theme FACES id }, "avatar": "<path.png>",
 *     "presenter": { "avatar": "<path.png>", "label": "<NAME>", "badge": "a".."e" | "d-dark" }, "possessive": "his" | "her" | "their",
 *     "narrators": { "da": { "avatar": "<path.png>", "label": "<NAME>", "reader": "<DA NAME>", "badge": "...", "seed": 1, "takes": 3 } },
 *     "colors": { "accent": "#rrggbb", … Theme Palette keys }, "badge": { "header": "…", "andNot": "…", "struck": "…", "wordsLine": "{LABEL}'S …" } }
 * Font files are never copied: Compose embeds each one straight from its configured path as a data URI, so no font file
 * lands in either git repo. A missing face is an error, never a fallback. `presenter` is voice mode's
 * corner: the author's portrait and label in place of the DA's. `narrators.da` is the corner and the take
 * settings of a run the DA reads aloud (run.json narrator "da"); every field is optional.
 */
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadLifeosConfig, lifeosUserDir, PRINCIPAL_VOICE_DEFAULT_TAKES, PRINCIPAL_VOICE_MAX_TAKES } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { ensureInstalled } from "../../../LIFEOS/TOOLS/HyperFrames/HyperFrames.ts";
import { compositionDir, configuredFaces, hasFlag, loadBadgeCopy, loadPalette, loadSkillConfig, publicDir, resolveConfigPath, skipParagraphPatterns, type SkillConfig } from "./Lib.ts";
import { BADGE_VARIANTS, DEFAULT_BADGE, isBadgeVariant, normalizePossessive, type BadgeVariant } from "./Theme.ts";

export const loadConfig = loadSkillConfig;

/** The user-zone directory that holds Config.json; relative paths in the config resolve against it. */
export function skillConfigDir(): string {
  return join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "VideoEssay");
}

export function avatarPath(cfg: SkillConfig = loadConfig()): string {
  return cfg.avatar ? configPath(cfg.avatar) : join(lifeosUserDir(), "DIGITAL_ASSISTANT", "DA_IDENTITY_AVATAR.png");
}

/** The channel mark drawn bottom-left on every video (Config.json cornerLogo), or undefined when none is configured. */
export function cornerLogoPath(cfg: SkillConfig = loadConfig()): string | undefined {
  return cfg.cornerLogo ? configPath(cfg.cornerLogo) : undefined;
}

/** A config path as written, through the one resolver the fonts use: "~/" expands, absolute kept, relative resolved against the config dir. */
function configPath(p: string): string {
  return resolveConfigPath(p, skillConfigDir());
}

/** The first word of the user's name (LIFEOS_CONFIG `principal.name`), uppercased: the label when none is configured. */
const firstNameLabel = (name: string): string => name.trim().split(/\s+/)[0].toUpperCase();

/** Voice mode's corner: who is reading, and which badge design the author wears. */
export interface Presenter { avatar: string; label: string; badge: BadgeVariant }
type PresenterConfig = SkillConfig & { presenter?: { avatar?: string; label?: string; badge?: unknown } };

/**
 * The author's portrait and label, from Config.json `presenter`. The avatar path may be relative to the
 * config dir. The label falls back to the first name of LIFEOS_CONFIG `principal.name`, uppercased; the skill
 * tree never carries a name. Undefined when no portrait is configured.
 */
export function presenterConfig(cfg: PresenterConfig = loadConfig(), principalName: () => string = () => loadLifeosConfig().principal.name): Presenter | undefined {
  const avatar = cfg.presenter?.avatar;
  if (!avatar) return undefined;
  const label = cfg.presenter?.label?.trim() || firstNameLabel(principalName());
  if (!label) throw new Error("presenter label resolved empty: set Config.json presenter.label or LIFEOS_CONFIG principal.name");
  const badge = cfg.presenter?.badge ?? DEFAULT_BADGE;
  if (!isBadgeVariant(badge)) throw new Error(`Config.json presenter.badge must be one of ${BADGE_VARIANTS.join(", ")}, got ${JSON.stringify(badge)}`);
  return { avatar: configPath(avatar), label, badge };
}

/**
 * A run the DA reads aloud (run.json narrator "da"): its corner and its take settings. `label` is still the author,
 * because the words are the author's; `reader` is the DA, named on the badge's read-by line, with `possessive`
 * (Config.json `possessive`, default "their") saying whose AI it is; `seed` and `takes` drive the
 * best-of-N read, because the DA's presenter voice profile carries no seed of its own.
 */
export interface DaNarrator extends Presenter { reader: string; possessive: string; seed: number; takes: number }
/** The base seed of a DA read when Config.json narrators.da.seed is unset; take i reads on seed + i. */
export const DA_NARRATOR_DEFAULT_SEED = 1;
type DaNarratorConfig = PresenterConfig & { narrators?: { da?: { avatar?: string; label?: string; reader?: string; badge?: unknown; seed?: unknown; takes?: unknown } } };
export interface Identity { principalName: string; daName: string }
const liveIdentity = (): Identity => { const c = loadLifeosConfig(); return { principalName: c.principal.name, daName: c.da.displayName ?? c.da.name }; };

/**
 * Config.json `narrators.da`, every field optional: the portrait falls back to the DA avatar (Config `avatar`, then
 * the identity default), the author label to `presenter.label` and then the first word of `principal.name`, the reader to the
 * DA's display name from LIFEOS_CONFIG, the badge to `presenter.badge`, the seed to DA_NARRATOR_DEFAULT_SEED and the
 * take count to the clone's default, the possessive to Config.json `possessive` (default "their"). Names come from config, never from the skill tree. Throws on an unknown badge,
 * a seed outside the voice synthesizer's range, or a take count outside [1, max].
 */
export function daNarratorConfig(cfg: DaNarratorConfig = loadConfig(), identity: () => Identity = liveIdentity): DaNarrator {
  const da = cfg.narrators?.da ?? {};
  const avatar = da.avatar ? configPath(da.avatar) : avatarPath(cfg);
  const configuredLabel = da.label?.trim() || cfg.presenter?.label?.trim();
  const configuredReader = da.reader?.trim();
  const who = configuredLabel && configuredReader ? undefined : identity();
  const label = configuredLabel || firstNameLabel(who!.principalName);
  const reader = (configuredReader || who!.daName.trim()).toUpperCase();
  if (!label || !reader) throw new Error("DA narrator label or reader resolved empty: set Config.json narrators.da.label/reader or LIFEOS_CONFIG principal.name / da.name");
  const badge = da.badge ?? cfg.presenter?.badge ?? DEFAULT_BADGE;
  if (!isBadgeVariant(badge)) throw new Error(`Config.json narrators.da.badge must be one of ${BADGE_VARIANTS.join(", ")}, got ${JSON.stringify(badge)}`);
  // Badge C is the stamp that reads "100% HUMAN" on a real recording (a clone run reads "AI CLONE"); a DA-read run is refused the design.
  if (badge === "c") throw new Error(`badge "c" prints 100% HUMAN and cannot be used for DA narration: set Config.json narrators.da.badge (or presenter.badge) to one of ${BADGE_VARIANTS.filter((v) => v !== "c").join(", ")}`);
  const seed = da.seed ?? DA_NARRATOR_DEFAULT_SEED;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error(`Config.json narrators.da.seed must be an integer in [0, 4294967295], got ${JSON.stringify(seed)}`);
  const takes = da.takes ?? PRINCIPAL_VOICE_DEFAULT_TAKES;
  if (typeof takes !== "number" || !Number.isInteger(takes) || takes < 1 || takes > PRINCIPAL_VOICE_MAX_TAKES) throw new Error(`Config.json narrators.da.takes must be an integer in [1, ${PRINCIPAL_VOICE_MAX_TAKES}], got ${JSON.stringify(takes)}`);
  return { avatar, label, reader, possessive: normalizePossessive(cfg.possessive), badge, seed, takes };
}

async function sh(cmd: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code})`);
}

/** A cut-out of the avatar for the thumbnail (cached in the gitignored public/). Opaque avatars go through rembg once. */
export async function ensureAvatarCut(): Promise<string> {
  const src = avatarPath();
  const out = join(publicDir(), "avatar-cut.png");
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return out;
  const opaque = (await new Response(Bun.spawn(["magick", src, "-format", "%[opaque]", "info:"], { stdout: "pipe" }).stdout).text()).trim() === "True";
  if (!opaque) { copyFileSync(src, out); return out; }
  await removeBackground(src, out);
  return out;
}

/**
 * Cuts the background out of `src` into `out` with the optional rembg tool. A missing tool (Bun.spawn throws ENOENT
 * before any exit code exists) or a failed run falls back to a copy of the opaque image, so the thumbnail still renders.
 * Returns true when a real cut-out was written. `bin` is injectable so tests can name a tool that is not installed.
 */
export async function removeBackground(src: string, out: string, bin = "rembg"): Promise<boolean> {
  let code = 1;
  try {
    const p = Bun.spawn([bin, "i", src, out], { stdout: "ignore", stderr: "pipe" });
    code = await p.exited;
  } catch {
    code = -1;
  }
  if (code === 0 && existsSync(out)) return true;
  console.warn(`${bin} unavailable or failed; thumbnail uses the opaque avatar`);
  copyFileSync(src, out);
  return false;
}

export async function setup(opts: { check?: boolean } = {}): Promise<{ fonts: string[] }> {
  const comp = compositionDir();
  // Throws naming every missing face or file: there is no system fallback to degrade to.
  const cfg = loadConfig();
  const faces = configuredFaces(cfg);
  // Throw on a malformed colour, badge line or skip pattern before anything installs or renders.
  loadPalette(cfg);
  loadBadgeCopy(cfg);
  skipParagraphPatterns(cfg);
  if (!existsSync(join(comp, "node_modules", "shiki"))) {
    if (opts.check) console.log("✗ Tools dependencies not installed"); else await sh(["bun", "install"], comp);
  }
  if (!opts.check) await ensureInstalled();
  if (!opts.check) await ensureAvatarCut();
  const presenter = presenterConfig();
  const presenterState = !presenter ? "not configured (voice mode unavailable)" : existsSync(presenter.avatar) ? `${presenter.label}` : `MISSING ${presenter.avatar}`;
  const daNarrator = daNarratorConfig();
  const daState = existsSync(daNarrator.avatar) ? `${daNarrator.reader} reads ${daNarrator.label}'s words` : `MISSING ${daNarrator.avatar}`;
  console.log(`✓ composition ready · fonts: ${faces.length} faces · avatar: ${existsSync(avatarPath()) ? "found" : "MISSING"} · presenter: ${presenterState} · DA narrator: ${daState}`);
  return { fonts: faces.map((f) => f.id) };
}

if (import.meta.main) await setup({ check: hasFlag(process.argv.slice(2), "--check") });
