#!/usr/bin/env bun
/**
 * @version 1.1.0
 *
 * 1.1.0 (2026-10-13, LOSIntegrity security:2#2): the credential file is never written through a
 * symlink. A leaf symlink (dangling or not) or any non-regular file at <account>.json is refused,
 * --force included, and the write goes to an exclusively created 0600 temp file in the same
 * directory that is then renamed into place, so a symlink planted between check and write is
 * replaced, never followed.
 */
// Mint a Google OAuth refresh token for one mailbox and write it as a credential file
// that `gmail.ts --account <name>` reads unchanged.
//
//   GoogleMailboxAuth.ts --account <name> --login-hint user@example.com --client-from <name>
//                        [--scopes "<list>"] [--port 7892] [--force]
//
// --client-from names an existing credential file in the same dir whose OAuth client
// (client_id + client_secret) is reused. The tool never opens a browser. It prints
// `AUTH_URL: <url>` and waits up to 10 minutes for the loopback callback; the caller opens
// the URL wherever the right Google user is signed in. Before writing, the new token must
// read back a Gmail profile whose address equals --login-hint, so a consent by the wrong
// user writes nothing.
//
// Credential dir: {lifeosUserDir}/CONFIG/CREDENTIALS/google ($GOOGLE_MAILBOX_AUTH_DIR overrides).
// No secret, code, or token is ever printed.

import { closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, sep } from "node:path";
import { invariant } from "./Invariant";

export const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
export const DEFAULT_PORT = 7892;
const WAIT_MS = 10 * 60_000;

export type Args = {
  account: string;
  loginHint: string;
  clientFrom: string;
  scopes: string[];
  port: number;
  force: boolean;
};

export function validAccountName(name: string): boolean {
  return /^[A-Za-z0-9._@-]+$/.test(name) && !name.includes("..") && name !== "." && !name.startsWith("-");
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const account = (get("--account") ?? "").replace(/\.json$/, "");
  const loginHint = get("--login-hint") ?? "";
  const clientFrom = (get("--client-from") ?? "").replace(/\.json$/, "");
  const port = Number(get("--port") ?? DEFAULT_PORT);
  const scopes = (get("--scopes") ?? DEFAULT_SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean);
  if (!validAccountName(account)) throw new Error(`invalid --account: ${JSON.stringify(account)}`);
  if (!validAccountName(clientFrom)) throw new Error(`invalid --client-from: ${JSON.stringify(clientFrom)}`);
  if (!/^[^@\s]+@[^@\s]+$/.test(loginHint)) throw new Error("--login-hint must be an email address");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid --port: ${port}`);
  if (scopes.length === 0) throw new Error("--scopes is empty");
  return { account, loginHint, clientFrom, scopes, port, force: argv.includes("--force") };
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}/cb`;
}

export function buildAuthUrl(clientId: string, a: Pick<Args, "scopes" | "port" | "loginHint">, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(a.port),
    response_type: "code",
    scope: a.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    login_hint: a.loginHint,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** lstat that reports a missing path as null; any other error propagates. */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Throws unless `p` is absent or a regular file; a symlink at the leaf is never followed. */
function assertPlainLeaf(p: string): void {
  const st = lstatOrNull(p);
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${p}`);
  if (!st.isFile()) throw new Error(`refusing to write: ${p} is not a regular file`);
}

/**
 * Resolves <dir>/<account>.json, proves it stays inside the symlink-dereferenced dir, and refuses
 * a leaf that is a symlink or not a regular file (realpath on the dir alone cannot see the leaf).
 */
export function resolveOutputPath(dir: string, account: string): string {
  if (!validAccountName(account)) throw new Error(`invalid account name: ${JSON.stringify(account)}`);
  const realDir = realpathSync(dir);
  const out = join(realDir, `${account}.json`);
  invariant(out.startsWith(realDir + sep), `output path escapes credential dir: ${out}`);
  assertPlainLeaf(out);
  return out;
}

export type CallbackResult = { ok: true; code: string } | { ok: false; reason: string };

export function handleCallback(rawUrl: string, expectedState: string, port = DEFAULT_PORT): CallbackResult {
  const url = new URL(rawUrl, `http://localhost:${port}`);
  if (url.pathname !== "/cb") return { ok: false, reason: "not the callback path" };
  const err = url.searchParams.get("error");
  if (err) return { ok: false, reason: `provider error: ${err}` };
  if (url.searchParams.get("state") !== expectedState) return { ok: false, reason: "state mismatch" };
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, reason: "no code in callback" };
  return { ok: true, code };
}

/** Refuses a symlink or non-file at `out` always, and an existing credential file unless forced. */
export function assertWritable(out: string, force: boolean): void {
  assertPlainLeaf(out);
  if (lstatOrNull(out) && !force) throw new Error(`refusing to overwrite ${out} (pass --force)`);
}

/**
 * Writes `body` as <dir>/<account>.json with mode 0600 and returns the path. The bytes go to an
 * exclusively created (O_EXCL | O_NOFOLLOW) private temp file in the same directory, are synced,
 * then land atomically: rename(2) when forced, which replaces a leaf rather than following it, and
 * link(2) when not, which fails if anything appeared at the path since the check.
 */
export function writeCredentialFile(dir: string, account: string, body: string, force: boolean): string {
  const out = resolveOutputPath(dir, account);
  assertWritable(out, force);
  const tmp = join(dirname(out), `.${account}.json.${crypto.randomUUID()}.tmp`);
  invariant(dirname(tmp) === dirname(out), `temp file left the credential dir: ${tmp}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let landed = false;
  try {
    try {
      fchmodSync(fd, 0o600); // umask can only narrow the open() mode; pin it exactly
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Re-check right before landing: the narrow remaining race is closed by rename/link semantics.
    assertWritable(out, force);
    if (force) renameSync(tmp, out);
    else linkSync(tmp, out); // EEXIST if a file or symlink appeared since the check
    landed = true;
  } finally {
    // After rename the temp name is gone; after link (or any failure) it is a second name to drop.
    if (!landed || !force) {
      try {
        unlinkSync(tmp);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  return out;
}

function credentialDir(): string {
  if (process.env.GOOGLE_MAILBOX_AUTH_DIR) return process.env.GOOGLE_MAILBOX_AUTH_DIR;
  // Imported lazily so tests that set the env override never load the config stack.
  const { lifeosUserDir } = require("./LifeosConfig") as { lifeosUserDir: () => string };
  return join(lifeosUserDir(), "CONFIG/CREDENTIALS/google");
}

function waitForCode(state: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const r = handleCallback(req.url ?? "/", state, port);
      if (!r.ok && r.reason === "not the callback path") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/plain" });
      res.end(r.ok ? "Authorization captured. You can close this tab." : `Authorization failed: ${r.reason}`);
      clearTimeout(timer);
      server.close();
      if (r.ok) resolve(r.code);
      else reject(new Error(r.reason));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the callback"));
    }, WAIT_MS);
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const dir = credentialDir();
  const out = resolveOutputPath(dir, a.account);
  assertWritable(out, a.force);

  const client = JSON.parse(readFileSync(resolveOutputPath(dir, a.clientFrom), "utf8")) as {
    client_id?: string;
    client_secret?: string;
  };
  if (!client.client_id || !client.client_secret) throw new Error(`no client_id/client_secret in --client-from ${a.clientFrom}`);

  const state = crypto.randomUUID();
  const pending = waitForCode(state, a.port);
  console.log(`AUTH_URL: ${buildAuthUrl(client.client_id, a, state)}`);
  const code = await pending;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri(a.port),
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (tokens.error || !tokens.refresh_token || !tokens.access_token) {
    throw new Error(`token exchange failed: ${tokens.error ?? "no refresh_token"} ${tokens.error_description ?? ""}`.trim());
  }

  const profRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profRes.ok) throw new Error(`profile read failed ${profRes.status}`);
  const mailbox = ((await profRes.json()) as { emailAddress?: string }).emailAddress ?? "";
  if (mailbox.toLowerCase() !== a.loginHint.toLowerCase()) {
    throw new Error(`wrong Google user consented: got ${mailbox || "(none)"}, expected ${a.loginHint}; nothing written`);
  }

  invariant(client.client_id.length > 0 && client.client_secret.length > 0, "empty client credential");
  invariant(tokens.refresh_token.length > 0, "empty refresh_token");
  invariant(out === resolveOutputPath(dir, a.account), "output path changed between check and write");
  const written = writeCredentialFile(
    dir,
    a.account,
    JSON.stringify(
      {
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        captured_at: new Date().toISOString(),
        type: "authorized_user",
      },
      null,
      2,
    ),
    a.force,
  );
  console.log(`WROTE: ${written}`);
  console.log(`MAILBOX: ${mailbox}`);
  console.log(`SCOPE: ${tokens.scope ?? ""}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
