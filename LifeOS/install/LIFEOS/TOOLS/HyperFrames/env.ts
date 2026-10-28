/**
 * The environment and argument rules for every HyperFrames child process.
 *
 * The env is built from an allowlist, never by copying process.env. That keeps every API key
 * in the parent (GEMINI_API_KEY above all: `snapshot` runs Gemini vision on every frame by
 * default when that key is present) and pins the switches that stop HyperFrames phoning home.
 */
import { ALLOWED_SUBCOMMANDS } from "./constants";

/** Parent variables a child may inherit. Nothing credential-shaped is on this list. */
const INHERITED = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/** Always set on every invocation. */
export const FIXED_ENV: Readonly<Record<string, string>> = {
  HYPERFRAMES_NO_TELEMETRY: "1", // no PostHog events
  DO_NOT_TRACK: "1", // the cross-tool opt-out HyperFrames also honours
  HYPERFRAMES_SKIP_SKILLS: "1", // no GitHub skills-registry check
  HYPERFRAMES_NO_UPDATE_CHECK: "1", // no npm version check, no self-update
  HYPERFRAMES_NO_AUTO_INSTALL: "1", // no background install of optional packages (@google/genai, onnxruntime)
  CI: "1", // no post-render feedback prompt
  NO_COLOR: "1", // plain logs
};

/**
 * Build the child env. `extra` may add HyperFrames/producer tuning switches only; a key that
 * looks like a credential is refused rather than silently dropped.
 */
export function buildEnv(extra: Record<string, string> = {}, parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!/^(HF_|PRODUCER_|HYPERFRAMES_(EXTRACT_CACHE_DIR|FFMPEG_PATH|FFPROBE_PATH|BROWSER_PATH|FONT_CACHE_DIR))/.test(key)) {
      throw new Error(`buildEnv: refusing extra env key "${key}"; only HF_*/PRODUCER_* tuning and path overrides are allowed`);
    }
    env[key] = value;
  }
  Object.assign(env, FIXED_ENV);
  return env;
}

/** Flags that reach a third party or a container registry. */
const FORBIDDEN_FLAG = /^--(describe|docker|skill)(=|$)/;

/**
 * Refuse any argument list that could send data off the machine. The seam adds its own
 * `--describe false` to snapshot after this check, so callers can never pass the flag at all.
 */
export function assertSafeArgs(args: readonly string[]): void {
  if (args.length === 0) throw new Error("hyperframes: empty argument list");
  const sub = args[0]!;
  if (!ALLOWED_SUBCOMMANDS.has(sub)) throw new Error(`hyperframes: subcommand "${sub}" is not allowed through the seam`);
  if (sub === "browser" && args[1] !== "path" && args[1] !== "ensure") throw new Error(`hyperframes: "browser ${args[1] ?? ""}" is not allowed`);
  for (const arg of args) {
    if (FORBIDDEN_FLAG.test(arg)) throw new Error(`hyperframes: flag "${arg}" is not allowed (it reaches a third party)`);
  }
}
