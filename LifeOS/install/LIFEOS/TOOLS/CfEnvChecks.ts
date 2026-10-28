/**
 * CfEnvChecks.ts — the pure checks CfEnv.ts runs around a deploy, kept here so they can be tested
 * (CfEnv.ts acts on import: it reads argv, spawns cf and exits).
 *
 * - `configCode` drops comments from cloudflare.config.ts before any declaration is read. cf compiles
 *   the config, so a commented-out `API_KEY: bindings.secret()` declares nothing and cf deploy deletes
 *   that live secret; the secrets gate must not count it (review finding, 2026-10-12).
 * - `maskConfig` also hides string contents from those reads: `NOTE: bindings.var("API_KEY:
 *   bindings.secret()")` declares nothing either, and a worker name may be single- or double-quoted
 *   (review round 3, 2026-10-12).
 * - `probeOutcome` names the result of the post-deploy ISA probe run. A run that did not finish
 *   (timeout, crash, signal) is not a pass, so it fails the deploy command like a failing probe does.
 */

/**
 * cloudflare.config.ts split into code and literals: every `//` and `/* … *\/` comment is removed, and
 * every string or template literal is replaced in `code` by an opaque placeholder `\u0000<n>\u0000`
 * whose full source text (quotes included) is `literals[n]`. Declarations are read from `code`, so
 * text inside a string (`bindings.var("API_KEY: bindings.secret()")`) can never count as one.
 */
export interface MaskedConfig {
  code: string;
  literals: string[];
}

const PLACEHOLDER = /\u0000(\d+)\u0000/g;

export function maskConfig(src: string): MaskedConfig {
  let code = "";
  const literals: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      // An unclosed block comment runs to the end of the file, as it does for the compiler.
      i = end === -1 ? src.length : end + 2;
      code += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        else if (ch !== "`" && src[j] === "\n") break; // an unterminated quote ends at the line, as in TS
        j++;
      }
      literals.push(src.slice(i, j + 1));
      code += `\u0000${literals.length - 1}\u0000`;
      i = j + 1;
      continue;
    }
    // A raw NUL is not valid TypeScript source; dropping it keeps placeholders unforgeable.
    if (ch !== "\u0000") code += ch;
    i++;
  }
  return { code, literals };
}

/** cloudflare.config.ts with every comment removed; string and template literals are kept whole. */
export function configCode(src: string): string {
  const { code, literals } = maskConfig(src);
  return code.replace(PLACEHOLDER, (_m, n: string) => literals[Number(n)]!);
}

/**
 * The plain value of a quoted literal, or undefined when it is not a closed single- or double-quoted
 * string free of escapes. A template literal, an escape or an unterminated quote is not read: the
 * caller treats undefined as "no literal value", which refuses rather than guesses.
 */
function plainLiteral(literal: string | undefined): string | undefined {
  if (!literal || literal.length < 2) return undefined;
  const quote = literal[0]!;
  if ((quote !== '"' && quote !== "'") || literal[literal.length - 1] !== quote) return undefined;
  const body = literal.slice(1, -1);
  if (body.includes("\\") || body.includes(quote) || body.includes("\n")) return undefined;
  return body;
}

/** Index just past the bracket that closes the one opened at `open`, over masked code; undefined if it never closes. */
function closeOf(code: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) return i + 1; }
  }
  return undefined;
}

/** Depth (over `{ ( [`) of every index in masked code, so a match can be held to the top level of an object body. */
function depths(code: string): number[] {
  const out: number[] = new Array(code.length);
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "}" || c === ")" || c === "]") d--;
    out[i] = d;
    if (c === "{" || c === "(" || c === "[") d++;
  }
  return out;
}

/**
 * The body of the object cf compiles: the literal passed to `export default defineConfig({ … })` or
 * `export default { … }`. A source with no `export default` at all is read as a bare object body (the
 * fragment form). An `export default` whose object cannot be read (a variable, a call result, an unclosed
 * brace) is undefined: the effective configuration cannot be determined, so nothing is read from it.
 */
function effectiveBody(code: string): string | undefined {
  if (!/\bexport\s+default\b/.test(code)) return code;
  const m = /\bexport\s+default\s+(?:defineConfig\s*\(\s*)?\{/.exec(code);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  const end = closeOf(code, open);
  return end === undefined ? undefined : code.slice(open + 1, end - 1);
}

/**
 * The inner body of the object at top-level key `key` in `body`. Exactly one top-level occurrence is
 * required: none, a duplicate (the runtime keeps the last, a reader could pick either), or a value that is
 * not an object literal is undefined.
 */
function topLevelObject(body: string, key: string, literals: string[]): string | undefined {
  const d = depths(body);
  const hits: number[] = [];
  const re = /(?:(?<![\w$])([A-Za-z_$][\w$]*)|\u0000(\d+)\u0000)\s*:\s*/g;
  for (const m of body.matchAll(re)) {
    if (d[m.index!] !== 0) continue;
    const name = m[1] ?? plainLiteral(literals[Number(m[2])]);
    if (name !== key) continue;
    hits.push(m.index! + m[0].length);
  }
  if (hits.length !== 1 || body[hits[0]!] !== "{") return undefined;
  const end = closeOf(body, hits[0]!);
  return end === undefined ? undefined : body.slice(hits[0]! + 1, end - 1);
}

/**
 * The worker name the effective config declares (`worker: { … name: "<worker>" }`, single- or double-quoted),
 * read from the default-exported object's top-level `worker` key only, or undefined.
 */
export function configWorkerName(config: string): string | undefined {
  const { code, literals } = maskConfig(config);
  const body = effectiveBody(code);
  const worker = body === undefined ? undefined : topLevelObject(body, "worker", literals);
  if (worker === undefined) return undefined;
  const d = depths(worker);
  const names = [...worker.matchAll(/(?<![\w$])name\s*:\s*\u0000(\d+)\u0000/g)].filter((m) => d[m.index!] === 0);
  if (names.length !== 1) return undefined;
  return plainLiteral(literals[Number(names[0]![1])]) || undefined;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The secret names the effective config declares as `NAME: bindings.secret()` (or `"NAME": bindings.secret()`)
 * at the top level of the default-exported object's `env`, read from code only: a declaration in a string literal,
 * in an unused object, or nested deeper is not one. An env that cannot be read safely yields
 * no names, so every live secret counts as undeclared and the gate refuses rather than over-counts.
 */
export function declaredSecretNames(config: string): string[] {
  const { code, literals } = maskConfig(config);
  const body = effectiveBody(code);
  if (body === undefined) return [];
  // cf's config puts env at the top level or inside worker; both are read.
  const worker = topLevelObject(body, "worker", literals);
  const names: string[] = [];
  for (const env of [topLevelObject(body, "env", literals), worker === undefined ? undefined : topLevelObject(worker, "env", literals)]) {
    if (env !== undefined) names.push(...secretsIn(env, literals));
  }
  return names;
}

function secretsIn(env: string, literals: string[]): string[] {
  const d = depths(env);
  const names: string[] = [];
  for (const m of env.matchAll(/(?:(?<![\w$])([A-Z][A-Z0-9_]*)|\u0000(\d+)\u0000)\s*:\s*bindings\.secret\(\)/g)) {
    if (d[m.index!] !== 0) continue;
    const name = m[1] ?? plainLiteral(literals[Number(m[2])]);
    if (name && SECRET_NAME.test(name)) names.push(name);
  }
  return names;
}

/**
 * The post-deploy ISA probe result from Bunker's exit: only 0 passes. 2 (manual or gated rows awaiting
 * evidence) is unresolved, never a pass: it is `fail: probes unresolved (…)` until the evidence is complete
 *. 1 is `fail (<n>)`, and anything else (a timeout's null status, a crash, a signal)
 * is `fail: probes did not finish (…)`. Every non-pass starts with "fail", which is what the
 * deploy command's final gate reads.
 */
export function probeOutcome(status: number | null, signal: string | null, failing: number): string {
  if (status === 0) return "pass";
  if (status === 2) return "fail: probes unresolved (manual or gated rows await evidence; complete them and rerun)";
  if (status === 1) return `fail (${failing})`;
  return `fail: probes did not finish (${status !== null ? `exit ${status}` : signal ? `signal ${signal}` : "timeout"})`;
}

/**
 * CfEnv's exit code when the upload went live but a check after it failed (secrets lost, ISA probes, social
 * card). It differs from 2, which every refusal before the upload uses, so a deploy script can still run its
 * post-deploy steps for the version that is already live, such as a cache purge, and then fail. Origin:
 * a failing probe on a site skipped the purge that keeps browsers from caching blank pages.
 */
export const DEPLOYED_BUT_CHECK_FAILED = 10;

/** CfEnv's own exit for cf's exit `code`: a cf failure that happens to be 10 reads as 1, so 10 always means "live". */
export function cfExitForCaller(code: number): number {
  return code === DEPLOYED_BUT_CHECK_FAILED ? 1 : code;
}

/**
 * The result of the post-deploy SocialCard run, as the deploy ledger and the final gate read it.
 * Every non-pass starts with "fail" except the two honest "nothing to check" outcomes, so the gate still
 * blocks. Exit 4 is a run that finished: a skipped target was not declared, so it names that, not a crash.
 */
export function socialCardOutcome(status: number | null, signal: string | null): string {
  if (status === 0) return "pass";
  if (status === 1) return "fail";
  if (status === 3) return "no shareable page (every page skipped)";
  if (status === 4) return "fail: skipped target not declared (add socialCardSkip or --allow-skip)";
  return `fail: check did not finish (${status !== null ? `exit ${status}` : signal ? `signal ${signal}` : "timeout"})`;
}

/** Cloudflare throttled the account (code 971 or HTTP 429). */
export const THROTTLED = /\[971\]|429 Too Many Requests/;
/** The connection to Cloudflare dropped or an edge answered with a gateway error: a blip, not a bad build. */
const NETWORK_DROP = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|UND_ERR_[A-Z_]+|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out/;

/**
 * Why a failed cf run is worth running again, or null when it is not. A throttle retries any verb.
 * A dropped connection retries only a deploy: a deploy re-uploads the same build and at worst makes one
 * more version, while a write verb (d1 execute, kv put, secret put) may have landed before the drop and
 * must never run twice (a deploy can die on `fetch failed` mid-upload).
 */
export function retryReason(output: string, isDeploy: boolean): "throttled" | "network" | null {
  if (THROTTLED.test(output)) return "throttled";
  if (isDeploy && NETWORK_DROP.test(output)) return "network";
  return null;
}
