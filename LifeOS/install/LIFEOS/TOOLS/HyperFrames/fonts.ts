/**
 * Local licensed fonts embedded into a composition as @font-face data URIs, with a load gate.
 *
 * Why data URIs: the composition stays self-contained (nested compositions and the probe's
 * file:// view resolve them the same way) and the licensed files are never copied around.
 * Why a gate: `document.fonts.ready` only covers faces already used in layout, so a face first
 * needed at 0:42 could render in the fallback. The gate loads every declared face up front and
 * the timeline registers only after it resolves (HyperFrames waits for registration before it
 * captures frame 0). A face that fails to load sets `window.__hfFontsError`, the timeline never
 * registers, and the probe reports the font by name.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { invariant } from "../Invariant";
import { getClaudeDir } from "../Paths";
import { HYPERFRAMES_VERSION, seamCacheDir } from "./constants";

export interface FontFaceSpec { family: string; path: string; weight?: number | string; style?: "normal" | "italic" }
export interface EmbeddedFonts { css: string; script: string; families: string[] }

export class FontEmbedError extends Error {
  constructor(public readonly problems: string[]) {
    super(`font embed failed:\n- ${problems.join("\n- ")}`);
    this.name = "FontEmbedError";
  }
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/** Font container from its first bytes; undefined when the file is not a font. */
export function sniffFontFormat(bytes: Uint8Array): { mime: string; format: string } | undefined {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOF2") return { mime: "font/woff2", format: "woff2" };
  if (tag === "wOFF") return { mime: "font/woff", format: "woff" };
  if (tag === "OTTO") return { mime: "font/otf", format: "opentype" };
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return { mime: "font/ttf", format: "truetype" };
  if (tag === "ttcf") return { mime: "font/collection", format: "collection" };
  return undefined;
}

/** Optional Video CardFonts.json shape (NOT in the public release payload): `{ families: { House: { "400": "~/Library/Fonts/x.otf" } } }`. */
export function facesFromFamilies(config: { families?: Record<string, Record<string, string>> }): FontFaceSpec[] {
  if (!config.families || typeof config.families !== "object") throw new FontEmbedError(["font config has no `families` object"]);
  return Object.entries(config.families).flatMap(([family, weights]) => Object.entries(weights).map(([weight, path]) => ({ family, path, weight })));
}

/** `{ display: path, text: path, mono: path }` (the VideoEssay Config.json `fonts` shape), one family per role. */
export function facesFromRoles(fonts: Record<string, string>, familyFor: (role: string) => string): FontFaceSpec[] {
  return Object.entries(fonts).map(([role, path]) => ({ family: familyFor(role), path, weight: 400 }));
}

/** One type role ready to embed: the family to name first, the case it is set in, and its faces. */
export interface RoleType { role: string; family: string; textTransform: "uppercase" | "capitalize" | "none"; faces: FontFaceSpec[]; source: "house" | "bundled" }
export interface RoleOptions { file?: string; fontsDir?: string; cacheDir?: string; cliPath?: string }

/** The install's house type roles (the principal's TypeRoles.json); absent on an install that has none. */
export function typeRolesPath(): string {
  return join(getClaudeDir(), "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "HyperFrames", "TypeRoles.json");
}

const CASE: Record<string, RoleType["textTransform"]> = { upper: "uppercase", title: "capitalize", sentence: "none" };

/**
 * The faces for a type role. The house roles in TypeRoles.json win when the install has them (a configured face whose
 * file is missing throws, never falls back silently). Without them, the pinned compiler's own bundled OFL face is used:
 * JetBrains Mono for `code`, Inter for every other role, extracted from the package on disk to the seam cache. Every
 * composition names this family first, because a generic-first stack renders as Inter on the MP4 only (preflight
 * `font-generic-primary`).
 */
export function roleFaces(role: string, opts: RoleOptions = {}): RoleType {
  const file = opts.file ?? typeRolesPath();
  if (existsSync(file)) {
    const roles = JSON.parse(readFileSync(file, "utf8")) as Record<string, { case?: string; faces?: Array<{ family: string; file: string; weight?: number; style?: "normal" | "italic" }> }> | null;
    if (typeof roles !== "object" || roles === null) throw new FontEmbedError([`${file}: must hold a JSON object of type roles`]);
    const r = Object.hasOwn(roles, role) ? roles[role] : undefined;
    if (r !== undefined) {
      if (!Array.isArray(r?.faces) || !r.faces.length || !r.faces.every((f) => f?.family && f?.file)) throw new FontEmbedError([`${file}: role "${role}" needs faces: [{ family, file }]`]);
      if (r.case !== undefined && !(r.case in CASE)) throw new FontEmbedError([`${file}: role "${role}" has unknown case "${r.case}" (${Object.keys(CASE).join(", ")})`]);
      const dir = opts.fontsDir ?? join(homedir(), "Library", "Fonts");
      const faces = r.faces.map((f) => ({ family: f.family, path: isAbsolute(f.file) ? f.file : join(dir, f.file), weight: f.weight ?? 400, style: f.style ?? "normal" }));
      const missing = faces.filter((f) => !existsSync(f.path)).map((f) => `${role}: ${f.family} ${f.weight}: file not found: ${f.path}`);
      if (missing.length) throw new FontEmbedError(missing);
      return { role, family: faces[0]!.family, textTransform: CASE[r.case ?? ""] ?? "none", faces, source: "house" };
    }
  }
  const pkg = role === "code" ? "jetbrains-mono" : "inter";
  const family = role === "code" ? "JetBrains Mono" : "Inter";
  return { role, family, textTransform: "none", faces: bundledFaces(pkg, family, [400, 700], opts), source: "bundled" };
}

/** The pinned HyperFrames CLI bundle on disk (bun's install cache), which carries its fonts as embedded woff2 data. */
export function pinnedCliPath(): string {
  const cache = process.env.BUN_INSTALL_CACHE_DIR ?? join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "cache");
  const dir = existsSync(cache) ? readdirSync(cache).find((d) => d.startsWith(`hyperframes@${HYPERFRAMES_VERSION}@@@`)) : undefined;
  const cli = dir ? join(cache, dir, "dist", "cli.js") : "";
  if (!cli || !existsSync(cli)) throw new FontEmbedError([`the pinned hyperframes@${HYPERFRAMES_VERSION} package is not in ${cache}; run any seam command once to install it`]);
  return cli;
}

/** Extract `@fontsource/<pkg>` faces from the pinned CLI's EMBEDDED_FONT_DATA into the seam cache, once per version. */
export function bundledFaces(pkg: string, family: string, weights: readonly number[], opts: RoleOptions = {}): FontFaceSpec[] {
  const dir = join(opts.cacheDir ?? seamCacheDir(), "fonts", HYPERFRAMES_VERSION);
  const want = weights.map((w) => ({ w, path: join(dir, `${pkg}-${w}.woff2`) }));
  const todo = want.filter((x) => !existsSync(x.path));
  if (todo.length) {
    const src = readFileSync(opts.cliPath ?? pinnedCliPath(), "utf8");
    mkdirSync(dir, { recursive: true });
    for (const x of todo) {
      const m = new RegExp(`\\["@fontsource/${pkg}:${x.w}:normal",\\s*"data:font/woff2;base64,([A-Za-z0-9+/=]+)"\\]`).exec(src);
      if (!m) throw new FontEmbedError([`@fontsource/${pkg} ${x.w} is not embedded in ${opts.cliPath ?? "the pinned CLI"}`]);
      const bytes = Buffer.from(m[1]!, "base64");
      invariant(sniffFontFormat(bytes)?.format === "woff2", `bundled ${pkg} ${x.w} decoded to something other than woff2`);
      const tmp = `${x.path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, x.path); // atomic: a killed write never leaves a truncated face that later runs trust
    }
  }
  return want.map((x) => ({ family, path: x.path, weight: x.w }));
}

/** Validate every face and build the CSS and gate script. Throws FontEmbedError naming every missing or broken face. */
export function embedFonts(faces: readonly FontFaceSpec[]): EmbeddedFonts {
  if (faces.length === 0) throw new FontEmbedError(["no font faces given"]);
  const problems: string[] = [];
  const rules: string[] = [];
  const gate: Array<{ family: string; weight: string; style: string }> = [];
  for (const face of faces) {
    const where = `${face.family} ${face.weight ?? 400}${face.style === "italic" ? " italic" : ""}`;
    if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(face.family)) { problems.push(`${where}: family name must be letters, digits, space, _ or -`); continue; }
    const weight = String(face.weight ?? 400);
    if (!/^[1-9]00$/.test(weight)) { problems.push(`${where}: weight must be 100..900`); continue; }
    const path = expandHome(face.path);
    if (!existsSync(path)) { problems.push(`${where}: file not found: ${path}`); continue; }
    if (!statSync(path).isFile() || statSync(path).size === 0) { problems.push(`${where}: not a readable non-empty file: ${path}`); continue; }
    const bytes = readFileSync(path);
    const kind = sniffFontFormat(bytes);
    if (!kind) { problems.push(`${where}: ${path} is not a font (${extname(path)} with unknown signature)`); continue; }
    const style = face.style ?? "normal";
    rules.push(`@font-face {\n  font-family: "${face.family}";\n  src: url("data:${kind.mime};base64,${bytes.toString("base64")}") format("${kind.format}");\n  font-weight: ${weight};\n  font-style: ${style};\n  font-display: block;\n}`);
    gate.push({ family: face.family, weight, style });
  }
  if (problems.length) throw new FontEmbedError(problems);
  const script = `(function () {
  var faces = ${JSON.stringify(gate)};
  window.__hfFontsReady = Promise.all(faces.map(function (f) {
    var spec = f.style + " " + f.weight + " 32px \\"" + f.family + "\\"";
    return document.fonts.load(spec).then(function (list) {
      var ok = list.some(function (ff) { return ff.status === "loaded"; });
      if (!ok) throw new Error("font face did not load: " + f.family + " " + f.weight + " " + f.style);
    });
  })).catch(function (e) {
    window.__hfFontsError = String((e && e.message) || e);
    console.error("[fonts] " + window.__hfFontsError);
    return new Promise(function () {});
  });
})();`;
  return { css: rules.join("\n"), script, families: [...new Set(faces.map((f) => f.family))] };
}

/** Insert the fonts' <style> and gate <script> at the end of <head>. */
export function injectFonts(html: string, fonts: EmbeddedFonts): string {
  const at = html.search(/<\/head>/i);
  if (at < 0) throw new FontEmbedError(["composition HTML has no </head> to inject fonts into"]);
  return `${html.slice(0, at)}<style data-lifeos-fonts>\n${fonts.css}\n</style>\n<script data-lifeos-fonts>\n${fonts.script}\n</script>\n${html.slice(at)}`;
}

/**
 * The registration line a font-using composition ends its timeline script with: the timeline
 * registers after every face has loaded, never before, and never when one failed.
 */
export function registerAfterFonts(compositionId: string, timelineVar: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(timelineVar)) throw new Error(`registerAfterFonts: invalid variable name "${timelineVar}"`);
  return `window.__hfFontsReady.then(function () { window.__timelines = window.__timelines || {}; window.__timelines[${JSON.stringify(compositionId)}] = ${timelineVar}; });`;
}
