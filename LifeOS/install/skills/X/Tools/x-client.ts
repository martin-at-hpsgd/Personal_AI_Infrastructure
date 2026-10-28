#!/usr/bin/env bun

/**
 * X API Client — centralized credential loading and auth for all X tools.
 *
 * Credentials come from the LifeOS env file (`~/.claude/.env`, or
 * `$LIFEOS_CONFIG_DIR/.env`). Where the OAuth 2.0 user grant lives is chosen in
 * the skill config, `<LIFEOS>/USER/CUSTOMIZATIONS/SKILLS/X/Config.md`:
 *
 *   token_store: local          tokens in a 0600 file on this machine; this
 *                               client refreshes them itself, serialized by a
 *                               lock file
 *   token_store: cloudflare-kv  tokens in a Cloudflare KV namespace that some
 *                               other process (for example a scheduled Worker)
 *                               refreshes; this client only reads them
 *
 * Setup and field reference: skills/X/Setup.md.
 */

import { createHmac, randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { getClaudeDir, getEnvPath, lifeosPath } from "../../../LIFEOS/TOOLS/Paths.ts";

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();  // USERPROFILE covers Windows, where HOME is unset
const ENV_PATH = process.env.LIFEOS_CONFIG_DIR
  ? resolve(process.env.LIFEOS_CONFIG_DIR, ".env")
  : getEnvPath();
/** Relative paths inside Config.md resolve against the install root (~/.claude by default). */
export const CONFIG_ROOT = getClaudeDir();
export const SKILL_CONFIG_PATH = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "X", "Config.md");
const SETUP_HINT = "See skills/X/Setup.md.";

// --- Load .env ---

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // A missing env file is not fatal here: every credential consumer below
  // validates the keys it needs and names them, with the Setup.md pointer.
  if (!existsSync(ENV_PATH)) return env;
  const content = readFileSync(ENV_PATH, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();

// --- Credential exports ---

export const credentials = {
  apiKey: env.TWITTER_API_KEY,
  apiKeySecret: env.TWITTER_API_KEY_SECRET,
  accessToken: env.X_ACCESS_TOKEN,
  accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  bearerToken: env.X_BEARER_TOKEN,
  clientId: env.TWITTER_CLIENT_ID,
  clientSecret: env.TWITTER_CLIENT_SECRET,
};

export function validateOAuth1(): void {
  if (!credentials.apiKey || !credentials.apiKeySecret || !credentials.accessToken || !credentials.accessTokenSecret) {
    console.error(`Missing OAuth 1.0a credentials in ${ENV_PATH}`);
    console.error("Required: TWITTER_API_KEY, TWITTER_API_KEY_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET");
    console.error(`Or configure an OAuth 2.0 token store in ${SKILL_CONFIG_PATH}. ${SETUP_HINT}`);
    process.exit(1);
  }
}

export function validateOAuth2(): void {
  if (!credentials.clientId || !credentials.clientSecret) {
    console.error(`Missing OAuth 2.0 credentials in ${ENV_PATH}`);
    console.error(`Required: TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET. ${SETUP_HINT}`);
    process.exit(1);
  }
}

// --- OAuth 1.0a ---
//
// Signed natively (RFC 5849 § 3.4, HMAC-SHA1) with node:crypto. The npm package oauth-1.0a was
// never declared in a shipped manifest, so a fresh install could not import any X tool (N004).
// The signature base covers the OAuth protocol params, the URL query, and any form params passed
// in `params`; a JSON body is never part of an OAuth 1.0a signature.

export interface OAuth1Keys { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string }
export interface OAuth1Request { method: string; url: string; params?: Record<string, string> }

/** RFC 3986 percent-encoding, as OAuth 1.0a requires (encodeURIComponent leaves !*'() bare). */
function oauthEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The query's name/value pairs, form-decoded as RFC 5849 § 3.4.1.3.1 requires ('+' is a space).
 * Strict where URLSearchParams is lenient: a malformed percent-escape in a name or a value
 * (`%`, `%FF`, a truncated UTF-8 sequence) throws URIError, so nothing is signed or sent for a
 * URL whose bytes the signer and the server could read differently.
 */
function strictQueryPairs(search: string): [string, string][] {
  const out: [string, string][] = [];
  const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
  for (const seg of search.replace(/^\?/, "").split("&")) {
    if (seg === "") continue;
    const eq = seg.indexOf("=");
    out.push(eq === -1 ? [decode(seg), ""] : [decode(seg.slice(0, eq)), decode(seg.slice(eq + 1))]);
  }
  return out;
}

const NONCE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function oauthNonce(length = 32): string {
  let out = "";
  for (const b of randomBytes(length)) out += NONCE_ALPHABET[b % NONCE_ALPHABET.length];
  return out;
}

/**
 * The Authorization header value for one request. `fixed` pins the nonce and timestamp,
 * for reproducing a published signing example; production calls leave it unset.
 */
export function oauth1Authorization(req: OAuth1Request, keys: OAuth1Keys, fixed: { nonce?: string; timestamp?: number } = {}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: fixed.nonce ?? oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(fixed.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: keys.token,
    oauth_version: "1.0",
  };
  // Check the raw text first: new URL() strips tabs and newlines, replaces lone surrogates and drops the
  // fragment, which would hide an escape the old oauth-1.0a signer refused before any request.
  encodeURIComponent(req.url); // URIError on a lone surrogate anywhere in the URL
  const q = req.url.indexOf("?");
  if (q !== -1) strictQueryPairs(req.url.slice(q + 1)); // query and fragment, as written
  const u = new URL(req.url);
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(oauth)) pairs.push([oauthEncode(k), oauthEncode(v)]);
  for (const [k, v] of strictQueryPairs(u.search)) pairs.push([oauthEncode(k), oauthEncode(v)]);
  for (const [k, v] of Object.entries(req.params ?? {})) pairs.push([oauthEncode(k), oauthEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [req.method.toUpperCase(), oauthEncode(baseUrl), oauthEncode(pairs.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const signingKey = `${oauthEncode(keys.consumerSecret)}&${oauthEncode(keys.tokenSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");
  return "OAuth " + Object.keys(oauth).sort().map((k) => `${oauthEncode(k)}="${oauthEncode(oauth[k])}"`).join(", ");
}

/** The validated OAuth 1.0a keys from the env file; exits with the Setup pointer when any is missing. */
export function createOAuth1(): OAuth1Keys {
  validateOAuth1();
  return {
    consumerKey: credentials.apiKey!,
    consumerSecret: credentials.apiKeySecret!,
    token: credentials.accessToken!,
    tokenSecret: credentials.accessTokenSecret!,
  };
}

export async function oauth1Fetch(url: string, method: string, body?: any): Promise<any> {
  const keys = createOAuth1();
  const res = await fetch(url, {
    method,
    headers: { Authorization: oauth1Authorization({ url, method }, keys), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X API error (${res.status}): ${err}`);
  }
  return res.json();
}

// --- OAuth 2.0 token store ---
//
// X rotates the refresh token on every refresh and treats reuse of a consumed
// refresh token as theft: it revokes the whole grant, and only a human re-auth
// brings it back. So exactly ONE party may refresh a grant.
//   local          → this client is that party. Refreshes are serialized behind
//                    `<token_file>.lock`; a waiter re-reads the file instead of
//                    replaying a consumed token, and writes are tmp+rename.
//   cloudflare-kv  → an external process owns the refresh chain. This client
//                    reads and never refreshes; an expired token means the
//                    external refresher is down, and refreshing here would
//                    start a second chain.

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id?: string;
}

export class XConfigError extends Error {
  constructor(message: string) {
    super(`${message} ${SETUP_HINT}`);
    this.name = "XConfigError";
  }
}

export type TokenStoreConfig =
  | { kind: "local"; tokenFile: string }
  | { kind: "cloudflare-kv"; accountId: string; apiToken: string; namespaceId: string };

export interface TokenStore {
  readonly kind: TokenStoreConfig["kind"];
  /** True when this process owns the refresh chain. */
  readonly selfRefresh: boolean;
  /** Human-readable location, for error messages. */
  readonly where: string;
  load(): Promise<TokenData | null>;
  save(data: TokenData): Promise<void>;
  /** Run `fn` while holding the store's refresh lock (local stores only). */
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

const DEFAULT_LOCAL_OAUTH_STATE_FILE = "~/.local/state/lifeos/x/oauth2-tokens.json";
const NETWORK_TIMEOUT_MS = 30_000;
/** Refresh this long before expiry, so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 200;
/** A lock older than this is from a crashed refresher and is broken. */
const LOCK_STALE_MS = 60_000;
const KV_ID_PATTERN = /^[0-9a-f]{32}$/;
// Both Worker config shapes: cf's `X_TOKENS: bindings.kv({ id: "…" })` and the
// legacy wrangler.jsonc binding object.
const KV_BINDING_PATTERNS: Record<string, RegExp> = {
  "cloudflare.config.ts": /\bX_TOKENS\s*:\s*bindings\.kv\(\s*\{\s*id\s*:\s*["'`]([0-9a-f]{32})["'`]/,
  "wrangler.jsonc": /"binding"\s*:\s*"X_TOKENS"\s*,\s*"id"\s*:\s*"([0-9a-f]{32})"/,
};

function expandHome(path: string): string {
  return path.replace(/^~(?=$|\/)/, HOME);
}

function resolveConfigPath(path: string, root: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(root, expanded);
}

/** Pull the first fenced ```yaml block out of a Config.md. */
export function extractYamlBlock(markdown: string): string | null {
  const m = /```ya?ml\s*\n([\s\S]*?)```/.exec(markdown);
  return m ? m[1] : null;
}

/** Find the X_TOKENS KV id declared by any Worker config one level under `dir`. */
export function discoverKvNamespace(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new XConfigError(`kv_discover_dir ${dir} is not a readable directory.`);
  }
  for (const name of names) {
    for (const file of Object.keys(KV_BINDING_PATTERNS)) {
      let text: string;
      try {
        text = readFileSync(resolve(dir, name, file), "utf-8");
      } catch {
        continue;
      }
      const m = KV_BINDING_PATTERNS[file].exec(text);
      if (m) return m[1];
    }
  }
  throw new XConfigError(`No Worker under ${dir} declares an X_TOKENS KV binding.`);
}

/**
 * Turn Config.md text into a store config. Pure apart from `kv_discover_dir`,
 * which reads Worker config files. Throws XConfigError on anything missing or
 * malformed; it never guesses a store.
 */
export function parseTokenStoreConfig(
  markdown: string,
  envVars: Record<string, string | undefined>,
  root: string,
  source: string = SKILL_CONFIG_PATH,
): TokenStoreConfig {
  const block = extractYamlBlock(markdown);
  if (block === null) throw new XConfigError(`${source} has no fenced yaml block.`);
  let raw: unknown;
  try {
    raw = parseYaml(block);
  } catch (err) {
    throw new XConfigError(`${source}: yaml block does not parse (${(err as Error).message}).`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new XConfigError(`${source}: yaml block must be a mapping.`);
  }
  const cfg = raw as Record<string, unknown>;
  const kind = cfg.token_store;

  if (kind === "local") {
    const file = cfg.token_file ?? DEFAULT_LOCAL_OAUTH_STATE_FILE;
    if (typeof file !== "string" || !file.trim()) throw new XConfigError(`${source}: token_file must be a path.`);
    return { kind: "local", tokenFile: resolveConfigPath(file.trim(), root) };
  }

  if (kind === "cloudflare-kv") {
    const accountId = envVars.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = envVars.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
      throw new XConfigError(`token_store cloudflare-kv needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in ${ENV_PATH}.`);
    }
    let namespaceId = envVars.X_TOKENS_KV_NAMESPACE ?? "";
    if (!namespaceId && typeof cfg.kv_namespace === "string") namespaceId = cfg.kv_namespace.trim();
    if (!namespaceId && typeof cfg.kv_discover_dir === "string") {
      namespaceId = discoverKvNamespace(resolveConfigPath(cfg.kv_discover_dir.trim(), root));
    }
    if (!namespaceId) {
      throw new XConfigError(
        `token_store cloudflare-kv needs a namespace: X_TOKENS_KV_NAMESPACE in the env file, kv_namespace, or kv_discover_dir in ${source}.`,
      );
    }
    if (!KV_ID_PATTERN.test(namespaceId)) throw new XConfigError(`KV namespace id "${namespaceId}" is not a 32-hex id.`);
    return { kind: "cloudflare-kv", accountId, apiToken, namespaceId };
  }

  throw new XConfigError(`${source}: token_store must be "local" or "cloudflare-kv" (got ${JSON.stringify(kind)}).`);
}

/** The configured store, or null when Config.md does not exist. A present but broken Config.md throws. */
export function readTokenStoreConfig(): TokenStoreConfig | null {
  if (!existsSync(SKILL_CONFIG_PATH)) return null;
  return parseTokenStoreConfig(readFileSync(SKILL_CONFIG_PATH, "utf-8"), env, CONFIG_ROOT);
}

function isTokenData(v: unknown): v is TokenData {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.access_token === "string" && t.access_token.length > 0 &&
    typeof t.refresh_token === "string" && t.refresh_token.length > 0 &&
    typeof t.expires_at === "number" && Number.isFinite(t.expires_at) &&
    (typeof t.user_id === "string" || t.user_id === void 0)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createLocalStore(tokenFile: string): TokenStore {
  const lockFile = `${tokenFile}.lock`;
  return {
    kind: "local",
    selfRefresh: true,
    where: tokenFile,
    async load() {
      if (!existsSync(tokenFile)) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(tokenFile, "utf-8"));
      } catch {
        throw new Error(`X token file ${tokenFile} is not valid JSON. Re-run: bun ~/.claude/skills/X/Tools/bookmarks.ts authorize`);
      }
      if (!isTokenData(parsed)) {
        throw new Error(`X token file ${tokenFile} is missing access_token/refresh_token/expires_at. Re-run authorize.`);
      }
      return parsed;
    },
    async save(data) {
      invariant(isTokenData(data), "X token save called with a malformed TokenData");
      mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
      const tmp = `${tokenFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, tokenFile);
    },
    async withRefreshLock(fn) {
      mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          closeSync(openSync(lockFile, "wx", 0o600));
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          let age = 0;
          try {
            age = Date.now() - statSync(lockFile).mtimeMs;
          } catch {
            continue; // released between our open and stat; retry at once
          }
          if (age > LOCK_STALE_MS) {
            try { unlinkSync(lockFile); } catch { /* another waiter broke it first */ }
            continue;
          }
          if (Date.now() > deadline) throw new Error(`Timed out after ${LOCK_WAIT_MS / 1000}s waiting for ${lockFile}`);
          await sleep(LOCK_POLL_MS);
        }
      }
      try {
        return await fn();
      } finally {
        try { unlinkSync(lockFile); } catch { /* already gone */ }
      }
    },
  };
}

export function createKvStore(cfg: Extract<TokenStoreConfig, { kind: "cloudflare-kv" }>, fetchImpl: typeof fetch = fetch): TokenStore {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.namespaceId}/values/oauth2`;
  const auth = { Authorization: `Bearer ${cfg.apiToken}` };
  return {
    kind: "cloudflare-kv",
    selfRefresh: false,
    where: "the Cloudflare KV token store",
    async load() {
      const res = await fetchImpl(url, { headers: auth, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`X token KV read failed (${res.status}): ${await res.text()}`);
      const parsed: unknown = await res.json();
      if (!isTokenData(parsed)) throw new Error("X token KV value is missing access_token/refresh_token/expires_at.");
      return parsed;
    },
    /** Only the authorize flow writes here: writing mid-lifecycle could clobber
     *  a refresh token the external refresher just rotated. */
    async save(data) {
      invariant(isTokenData(data), "X token save called with a malformed TokenData");
      const res = await fetchImpl(url, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`X token KV write failed (${res.status}): ${await res.text()}`);
    },
    async withRefreshLock() {
      throw new Error("The cloudflare-kv token store is refreshed by its external owner; this client never refreshes it.");
    },
  };
}

export function createTokenStore(cfg: TokenStoreConfig): TokenStore {
  if (cfg.kind === "local") return createLocalStore(cfg.tokenFile);
  return createKvStore(cfg);
}

export interface RefreshDeps {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Exchange a refresh token for a new grant. Callers must hold the store's refresh lock. */
export async function refreshGrant(current: TokenData, deps: RefreshDeps): Promise<TokenData> {
  const { clientId, clientSecret } = deps;
  if (!clientId || !clientSecret) {
    throw new XConfigError(`Refreshing the X grant needs TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET in ${ENV_PATH}.`);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const res = await fetchImpl(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh_token, client_id: clientId }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (res.status === 400 || res.status === 401) {
    throw new Error(
      `X rejected the refresh token (${res.status}): ${await res.text()}\n` +
        "The grant is revoked. Re-run: bun ~/.claude/skills/X/Tools/bookmarks.ts authorize",
    );
  }
  if (!res.ok) throw new Error(`X token refresh failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number") {
    throw new Error("X token refresh returned an unexpected shape (need access_token, refresh_token, expires_in).");
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: now() + body.expires_in * 1000,
    ...(current.user_id ? { user_id: current.user_id } : {}),
  };
}

/** A usable access token from `store`, refreshing it when this process owns the chain. */
export async function getValidTokensFrom(store: TokenStore, deps: RefreshDeps = {}): Promise<TokenData> {
  const now = deps.now ?? Date.now;
  const tokens = await store.load();
  if (!tokens) throw new Error(`No X OAuth2 grant in ${store.where}. Run: bun ~/.claude/skills/X/Tools/bookmarks.ts authorize`);
  if (tokens.expires_at - REFRESH_MARGIN_MS > now()) return tokens;

  if (!store.selfRefresh) {
    if (now() < tokens.expires_at) return tokens;
    throw new Error(
      `The X token in ${store.where} is expired, so its external refresher is not running. ` +
        "Fix that refresher; do not refresh from this client, which would start a second refresh chain and get the grant revoked.",
    );
  }

  return store.withRefreshLock(async () => {
    // Another process may have refreshed while we waited for the lock. Its
    // write consumed the refresh token we read above, so re-read, never replay.
    const latest = await store.load();
    if (!latest) throw new Error(`The X grant in ${store.where} disappeared during refresh. Re-run authorize.`);
    if (latest.expires_at - REFRESH_MARGIN_MS > now()) return latest;
    const next = await refreshGrant(latest, deps);
    await store.save(next);
    return next;
  });
}

// --- Module-level wrappers over the configured store ---

let cachedStore: TokenStore | null | undefined;

function configuredStore(): TokenStore | null {
  if (cachedStore === undefined) {
    const cfg = readTokenStoreConfig();
    cachedStore = cfg ? createTokenStore(cfg) : null;
  }
  return cachedStore;
}

function requireStore(): TokenStore {
  const store = configuredStore();
  if (!store) throw new XConfigError(`No X OAuth2 token store configured: create ${SKILL_CONFIG_PATH}.`);
  return store;
}

/** True when an OAuth2 token store is configured. A Config.md that exists but is broken throws. */
export function hasOAuth2Store(): boolean {
  return configuredStore() !== null;
}

/** True when this client refreshes its own grant (local store). */
export function tokenStoreRefreshesItself(): boolean {
  return requireStore().selfRefresh;
}

/** Where the grant lives, for status output. kind is null when Config.md is absent. */
export function tokenStoreSummary(): { configPath: string; kind: TokenStoreConfig["kind"] | null; where: string | null } {
  const store = configuredStore();
  return { configPath: SKILL_CONFIG_PATH, kind: store?.kind ?? null, where: store?.where ?? null };
}

/** Which credential env keys are set (names only, never values). */
export function credentialPresence(): Record<string, boolean> {
  const keys = [
    "TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET", "X_BEARER_TOKEN",
    "TWITTER_API_KEY", "TWITTER_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET",
  ];
  return Object.fromEntries(keys.map((k) => [k, Boolean(env[k])]));
}

/** Fail before any browser flow when no store is configured. */
export function assertTokenStoreConfigured(): void {
  requireStore();
}

/** The stored grant, or null when no store is configured or it holds no grant. */
export async function loadTokens(): Promise<TokenData | null> {
  const store = configuredStore();
  return store ? store.load() : null;
}

/** Write a NEW grant. Only the authorize flow calls this. */
export async function saveTokens(data: TokenData): Promise<void> {
  await requireStore().save(data);
}

export async function getValidTokens(): Promise<TokenData> {
  return getValidTokensFrom(requireStore(), {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
}

export async function oauth2Fetch(url: string, method: string = "GET", body?: any): Promise<any> {
  const tokens = await getValidTokens();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X API error (${res.status}): ${err}`);
  }
  return res.json();
}

// --- Bearer token fetch (app-only) ---

export async function bearerFetch(url: string): Promise<any> {
  if (!credentials.bearerToken) {
    throw new XConfigError(`Missing X_BEARER_TOKEN in ${ENV_PATH}.`);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${credentials.bearerToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`X API error (${res.status}): ${err}`);
  }
  return res.json();
}

// --- API base URL ---

export const API_BASE = "https://api.twitter.com/2";
