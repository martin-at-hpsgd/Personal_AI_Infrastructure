/**
 * Detector for the /ic lane `trust-roots-committed`.
 *
 * The auto-approver's workspace roots (LIFEOS_TRUSTED_ROOTS) and the no-new-.py
 * project trees (LIFEOS_PROJECT_ROOTS) are install config in the settings env
 * block. The live settings.json is DA-writable, so without this check the model
 * could widen what it may touch unprompted by editing one JSON string. The rule:
 * the value in force must equal the value COMMITTED at HEAD in the USER repo's
 * CONFIG/settings.user.json. Widening trust then takes a visible, committed change.
 *
 * Sources compared against HEAD: the live settings.json (and settings.local.json
 * when present, since the harness merges its env too) and the working-tree
 * settings.user.json overlay. A key absent everywhere is equal; a key absent at
 * HEAD but set live is drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";

export const TRUST_ROOT_KEYS = ["LIFEOS_TRUSTED_ROOTS", "LIFEOS_PROJECT_ROOTS"] as const;
export type TrustRootKey = (typeof TRUST_ROOT_KEYS)[number];
export type TrustRootValues = Record<TrustRootKey, string | undefined>;

export interface TrustRootSource {
  /** Human label for the report, e.g. "settings.json". */
  label: string;
  values: TrustRootValues;
  /** An override layer (settings.local.json): only the keys it sets are compared,
   *  because a key it leaves out does not change the value in force. */
  overrideOnly?: boolean;
}

export interface LiveSettingsFile {
  label: string;
  path: string;
  overrideOnly?: boolean;
}

export interface TrustRootDrift {
  key: TrustRootKey;
  source: string;
  value: string | undefined;
  committed: string | undefined;
}

export type TrustRootsState =
  | { kind: "skip"; reason: string }
  | { kind: "checked"; drift: TrustRootDrift[]; errors: string[]; sources: string[] };

/** The two trust keys from a parsed settings object's env block. A non-string
 *  value is kept as its JSON text so it can never compare equal to a string. */
export function trustRootValues(settings: unknown): TrustRootValues {
  const env =
    settings && typeof settings === "object" && "env" in settings
      ? (settings as { env?: unknown }).env
      : undefined;
  const out = {} as TrustRootValues;
  for (const key of TRUST_ROOT_KEYS) {
    const v = env && typeof env === "object" ? (env as Record<string, unknown>)[key] : undefined;
    out[key] = v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** Every (source, key) whose value differs from the committed one. Exact string
 *  comparison: any edit, even whitespace, needs the commit. */
export function trustRootDrift(committed: TrustRootValues, sources: TrustRootSource[]): TrustRootDrift[] {
  const drift: TrustRootDrift[] = [];
  for (const source of sources) {
    for (const key of TRUST_ROOT_KEYS) {
      if (source.overrideOnly && source.values[key] === undefined) continue;
      if (source.values[key] !== committed[key]) {
        drift.push({ key, source: source.label, value: source.values[key], committed: committed[key] });
      }
    }
  }
  return drift;
}

const OVERLAY_REL = "CONFIG/settings.user.json";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Parse a settings file on disk. Missing → no values (absent keys). Unreadable or
 *  malformed → error string, never a silent pass. */
function readSettingsFile(path: string): TrustRootValues | string {
  if (!existsSync(path)) return trustRootValues({});
  try {
    return trustRootValues(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return `${path}: unreadable or not JSON (${String((e as Error).message).slice(0, 120)})`;
  }
}

/**
 * Compare the live settings and the working-tree overlay against HEAD.
 * `userDir` is the LIFEOS/USER directory (symlinks are resolved here).
 * `liveSettings` lists the live settings files; an absent override file is skipped.
 */
export function checkTrustRootsCommitted(userDir: string, liveSettings: LiveSettingsFile[]): TrustRootsState {
  // Skip ONLY for an install that explicitly has no USER checkout: the directory is absent
  // (ENOENT / ENOTDIR) or git itself says it is not a repository. Any other failure to look
  // (permissions, a symlink loop, git missing or timing out) means the live trust values could
  // not be verified, and that is a blocking error, never a skip.
  const inspectionFailed = (what: string): TrustRootsState => ({ kind: "checked", drift: [], errors: [what], sources: [] });
  // A skip is honest only when nothing is in force: live trust values with no committed baseline to verify them
  // against are blocking drift, and a live file that cannot be read is an error.
  const skipUnlessLive = (reason: string): TrustRootsState => {
    const errors: string[] = [];
    const sources: TrustRootSource[] = [];
    for (const file of liveSettings) {
      if (file.overrideOnly && !existsSync(file.path)) continue;
      const values = readSettingsFile(file.path);
      if (typeof values === "string") errors.push(values);
      else sources.push({ label: file.label, values, overrideOnly: file.overrideOnly });
    }
    const live = sources.flatMap((src) => TRUST_ROOT_KEYS.filter((k) => src.values[k] !== undefined)
      .map((key) => ({ key, source: `${src.label} (no committed baseline: ${reason})`, value: src.values[key], committed: undefined })));
    if (live.length === 0 && errors.length === 0) return { kind: "skip", reason };
    return { kind: "checked", drift: live, errors, sources: sources.map((x) => x.label) };
  };
  let resolvedUser: string;
  try {
    resolvedUser = realpathSync(userDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return skipUnlessLive(`skipped: ${userDir} does not exist`);
    return inspectionFailed(`${userDir} could not be resolved (${code ?? String((e as Error).message).slice(0, 120)}) — trust roots unverified`);
  }
  try {
    if (git(resolvedUser, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
      return skipUnlessLive(`skipped: ${resolvedUser} is not a git checkout`);
    }
  } catch (e) {
    const err = e as { code?: string; stderr?: unknown; message?: string };
    const stderr = String(err.stderr ?? "");
    if (/not a git repository/i.test(stderr)) return skipUnlessLive(`skipped: ${resolvedUser} is not a git checkout`);
    return inspectionFailed(`git could not inspect ${resolvedUser} (${err.code ?? (stderr.trim().slice(0, 120) || String(err.message).slice(0, 120))}) — trust roots unverified`);
  }

  const errors: string[] = [];
  let committed: TrustRootValues;
  try {
    // "./" makes the path relative to -C, so USER may sit anywhere inside its repo.
    committed = trustRootValues(JSON.parse(git(resolvedUser, ["show", `HEAD:./${OVERLAY_REL}`])));
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? (e as Error).message);
    if (/does not exist|exists on disk, but not in|invalid object name|bad revision|unknown revision/i.test(stderr)) {
      // Nothing committed (no file at HEAD, or no commits yet): every live value is drift.
      committed = trustRootValues({});
    } else {
      return {
        kind: "checked",
        drift: [],
        errors: [`HEAD:${OVERLAY_REL} could not be read (${stderr.trim().slice(0, 160)})`],
        sources: [],
      };
    }
  }

  const sources: TrustRootSource[] = [];
  const files: LiveSettingsFile[] = [
    ...liveSettings,
    { label: `working-tree ${OVERLAY_REL}`, path: `${resolvedUser}/${OVERLAY_REL}` },
  ];
  for (const file of files) {
    if (file.overrideOnly && !existsSync(file.path)) continue;
    const values = readSettingsFile(file.path);
    if (typeof values === "string") errors.push(values);
    else sources.push({ label: file.label, values, overrideOnly: file.overrideOnly });
  }
  return { kind: "checked", drift: trustRootDrift(committed, sources), errors, sources: sources.map((s) => s.label) };
}
