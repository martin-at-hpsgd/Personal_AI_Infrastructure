/**
 * Read-only deploy preflight (ISC-135, and the cloud half of ISC-33).
 *
 * Asks the Cloudflare API, with GET only, which Worker scripts exist in the
 * account and which secret NAMES the runner Worker holds. Every request passes
 * through a guard that refuses any method but GET before it is sent. The
 * verdict carries names only: the secrets endpoint returns names and types,
 * never values, and nothing here reads a value.
 */
const API = "https://api.cloudflare.com/client/v4";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PreflightInput {
  accountId: string;
  token: string;
  /** The runner Worker's script name. */
  runner: string;
  /** Action Worker scripts the runner binds. */
  actionScripts: string[];
  /** Secret names the runner needs (RUNNER_TOKEN and any action needs). */
  secrets: string[];
  fetch?: FetchLike;
}

export interface PreflightVerdict {
  ok: boolean;
  missingWorkers: string[];
  missingSecrets: string[];
  runnerExists: boolean;
}

const SCRIPT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

async function getJson(fetcher: FetchLike, token: string, path: string): Promise<unknown[]> {
  const init: RequestInit = { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) };
  if (init.method !== "GET") throw new Error("Preflight is read-only");
  const res = await fetcher(`${API}${path}`, init);
  if (!res.ok) throw new Error(`Cloudflare API GET ${path.replace(/\/accounts\/[^/]+/, "/accounts/<id>")} returned HTTP ${res.status}`);
  const body = await res.json() as { success?: unknown; result?: unknown };
  if (body === null || typeof body !== "object" || body.success !== true || !Array.isArray(body.result)) throw new Error(`Cloudflare API GET returned an unexpected shape`);
  return body.result;
}

export async function preflight(input: PreflightInput): Promise<PreflightVerdict> {
  if (!input.accountId || !input.token) throw new Error("Preflight needs an account id and an API token");
  for (const name of [input.runner, ...input.actionScripts]) if (!SCRIPT_RE.test(name)) throw new Error(`Not a Worker script name: ${name}`);
  const fetcher = input.fetch ?? fetch;
  const account = encodeURIComponent(input.accountId);
  const scripts = await getJson(fetcher, input.token, `/accounts/${account}/workers/scripts`);
  const deployed = new Set(scripts.flatMap(s => (s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string" ? [(s as { id: string }).id] : [])));
  const missingWorkers = input.actionScripts.filter(s => !deployed.has(s));
  const runnerExists = deployed.has(input.runner);
  let missingSecrets = [...input.secrets];
  if (runnerExists) {
    const held = await getJson(fetcher, input.token, `/accounts/${account}/workers/scripts/${encodeURIComponent(input.runner)}/secrets`);
    const names = new Set(held.flatMap(s => (s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string" ? [(s as { name: string }).name] : [])));
    missingSecrets = input.secrets.filter(n => !names.has(n));
  }
  return { ok: missingWorkers.length === 0 && missingSecrets.length === 0, missingWorkers, missingSecrets, runnerExists };
}

/** True when a D1 database with this exact name exists. GET only. */
export async function d1DatabaseExists(input: { accountId: string; token: string; name: string; fetch?: FetchLike }): Promise<boolean> {
  if (!input.accountId || !input.token) throw new Error("Preflight needs an account id and an API token");
  const rows = await getJson(input.fetch ?? fetch, input.token, `/accounts/${encodeURIComponent(input.accountId)}/d1/database?name=${encodeURIComponent(input.name)}&per_page=100`);
  return rows.some(row => row !== null && typeof row === "object" && (row as { name?: unknown }).name === input.name);
}

/** The id of the KV namespace with this exact title, or null. GET only; the id is an identifier, not a secret. */
export async function findKvNamespace(input: { accountId: string; token: string; title: string; fetch?: FetchLike }): Promise<string | null> {
  if (!input.accountId || !input.token) throw new Error("Preflight needs an account id and an API token");
  const rows = await getJson(input.fetch ?? fetch, input.token, `/accounts/${encodeURIComponent(input.accountId)}/storage/kv/namespaces?per_page=100`);
  for (const row of rows) {
    if (row && typeof row === "object" && (row as { title?: unknown }).title === input.title && typeof (row as { id?: unknown }).id === "string") return (row as { id: string }).id;
  }
  return null;
}
