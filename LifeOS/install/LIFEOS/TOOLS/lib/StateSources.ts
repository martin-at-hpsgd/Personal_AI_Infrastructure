/** Closed, bounded state readers. Discovery is evidence, never an executable shell draft. */
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { touchesSecret, normalizeCommand } from "../../../hooks/lib/texting-guard-core.ts";
import { redactForEngine } from "../../ASSAY/Engine.ts";
import { validateProducer, readOnlyRefusal, destinationRefusal, pinProducerArgv } from "./GlanceQuestion.ts";

export type SourceKind = "d1" | "http-json" | "test-json" | "log-tail" | "kv";
export type StateSource =
  | { kind: "d1"; binding: string; sql: string; database: string; id: string; config: string }
  | { kind: "http-json"; url: string }
  | { kind: "test-json"; path: string; name: string }
  | { kind: "log-tail"; file: string; lines: number }
  | { kind: "kv"; binding: string; key: string; namespaceId: string; config: string };
export interface SourceCatalog {
  config?: string;
  domain?: string;
  d1: { binding: string; database: string; id: string }[];
  kv: string[];
  kvIds: Record<string, string>;
  tables: { name: string; columns: string[]; file: string; binding?: string }[];
  routes: { path: string; file: string; fields: string[] }[];
  tests: { path: string; name: string }[];
  keys: { binding: string; key: string }[];
  logs: string[];
}
const fail = (message: string): never => { throw new Error(`producer denied: ${message}`); };
export const sourceKind = (s: string): SourceKind | undefined => /^(d1|http-json|test-json|log-tail|kv):/.exec(s.trim())?.[1] as SourceKind | undefined;
const denied = (s: string) => touchesSecret(s) || /(?:^|\/)LIFEOS\/USER(?:\/|$)/i.test(normalizeCommand(s));

/** Canonical paths: neither traversal nor symlinks may cross the ISA boundary. */
export function sourceFile(root: string, path: string): string {
  if (denied(path)) fail("guard secret zone or LIFEOS/USER");
  const base = realpathSync(root);
  const full = realpathSync(resolve(base, path));
  const rel = relative(base, full);
  if (denied(full)) fail("resolved guard secret zone or LIFEOS/USER");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !statSync(full).isFile()) fail("file must be inside ISA directory");
  return full;
}

/** cloudflare.config.ts with comments blanked, so a commented-out binding is never read as live. */
function cfConfigText(raw: string): string {
  return raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, s => s.startsWith('"') ? s : " ");
}

export function discoverStateSources(root: string): SourceCatalog {
  const catalog: SourceCatalog = { d1: [], kv: [], kvIds: {}, tables: [], routes: [], tests: [], keys: [], logs: [] };
  // The cf config is read as text: only literal bindings count, and evaluating repo code here
  // would execute it. A Wrangler file is no longer a source (LifeOS moved to cf, 2026-10-01).
  const config = "cloudflare.config.ts";
  if (existsSync(join(root, config))) {
    const text = cfConfigText(readFileSync(sourceFile(root, config), "utf8"));
    catalog.config = config;
    catalog.domain = /\bdomains:\s*\[\s*"([\w.-]+)"/.exec(text)?.[1];
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*):\s*bindings\.d1\(\{([^}]*)\}/g)) {
      const database = /\bname:\s*"([\w-]+)"/.exec(m[2]!)?.[1];
      const id = /\bid:\s*"([0-9a-f-]{36})"/.exec(m[2]!)?.[1];
      if (database && id) catalog.d1.push({ binding: m[1]!, database, id });
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*):\s*bindings\.kv\(\{([^}]*)\}/g)) {
      const id = /\bid:\s*"([0-9a-f]{32})"/.exec(m[2]!)?.[1];
      if (id) { catalog.kv.push(m[1]!); catalog.kvIds[m[1]!] = id; }
    }
  }
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || files.length > 2000) return;
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name.startsWith(".") || /^(node_modules|dist|build|vendor|coverage)(?: |$)/.test(e.name) || e.isSymbolicLink()) continue;
      const rel = join(dir, e.name);
      if (denied(rel)) continue;
      if (e.isDirectory()) walk(rel, depth + 1);
      else if (/\.(?:sql|[cm]?[jt]sx?|log|jsonl)$/.test(e.name)) files.push(rel);
    }
  };
  walk("", 0);
  for (const file of files.sort()) {
    const path = sourceFile(root, file);
    if (/\.(log|jsonl)$/.test(file)) { catalog.logs.push(file); continue; }
    if (statSync(path).size > 1024 * 1024) continue;
    const text = readFileSync(path, "utf8");
    if (file.endsWith(".sql")) {
      for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?\s*\(([\s\S]*?)\)\s*;/gi)) {
        const columns = [...m[2]!.matchAll(/(?:^|,)\s*["`]?([\w]+)["`]?\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC|BOOLEAN|DATETIME|VARCHAR)\b/gi)].map(c => c[1]!);
        // A binding is inferred only when unique, or when the schema directory names it.
        const match = catalog.d1.filter(d => file.toLowerCase().split(/[\/_.-]/).includes(d.binding.toLowerCase().replace(/_db$/, "")));
        catalog.tables.push({ name: m[1]!, columns, file, binding: match.length === 1 ? match[0]!.binding : catalog.d1.length === 1 ? catalog.d1[0]!.binding : undefined });
      }
      continue;
    }
    const isTest = /(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
    if (isTest) {
      if (/console\.log\(\s*JSON\.stringify\(/.test(text)) {
        for (const m of text.matchAll(/\b(?:test|it)\(\s*["']([^"'\n]+)["']/g)) catalog.tests.push({ path: file, name: m[1]! });
      }
      continue;
    }
    // Only GET registrations, never POST/PUT or path mentions in comments/tests.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/\.get\(\s*["'](\/[^"'\n]*)["']/g)) {
      const route = m[1]!;
      if (!/(?:^|\/)(?:api|status|health)(?:\/|$)/.test(route) || /[:*]/.test(route)) continue;
      const body = code.slice(m.index!, code.indexOf("\n});", m.index!) < 0 ? m.index! + 2000 : code.indexOf("\n});", m.index!) + 4);
      const fields = [...body.matchAll(/\b([A-Za-z_]\w*)\s*:/g)].map(f => f[1]!);
      catalog.routes.push({ path: route, file, fields });
    }
    for (const m of code.matchAll(/\b([A-Z][A-Z0-9_]*)\.get\(\s*["']([^"'\n]+)["']/g)) {
      if (catalog.kv.includes(m[1]!)) catalog.keys.push({ binding: m[1]!, key: m[2]! });
    }
  }
  // ALTER migrations add columns to the same table without inventing identifiers.
  for (const file of files.filter(f => f.endsWith(".sql"))) {
    const text = readFileSync(sourceFile(root, file), "utf8");
    for (const m of text.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+/gi)) {
      for (const table of catalog.tables.filter(t => t.name === m[1])) if (!table.columns.includes(m[2]!)) table.columns.push(m[2]!);
    }
  }
  return catalog;
}

/** Deliberately small SQL grammar: projections or COUNT, one table, optional LIMIT. */
export function selectOnly(sql: string): { table: string; columns: string[] } {
  const m = /^SELECT\s+(\*|COUNT\(\*\)(?:\s+AS\s+count)?|[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+FROM\s+([A-Za-z_]\w*)(?:\s+LIMIT\s+([1-9]\d{0,2}))?\s*$/i.exec(sql);
  if (!m || (m[3] && Number(m[3]) > 100)) fail("D1 requires a single SELECT projection or COUNT, with LIMIT at most 100; no statements, functions, joins or comments");
  return { table: m![2]!, columns: /^(\*|COUNT\()/i.test(m![1]!) ? [] : m![1]!.split(/\s*,\s*/) };
}

export function parseStateSource(command: string, root: string): StateSource {
  if (denied(command) || command.split(/\s+/).some(denied)) fail("guard secret zone or LIFEOS/USER");
  const kind = sourceKind(command);
  const body = command.trim().slice((kind?.length ?? 0) + 1);
  const catalog = discoverStateSources(root);
  if (kind === "d1") {
    const m = /^(\w+)\s+(.+)$/.exec(body);
    if (!m) fail("D1 expects binding and SELECT");
    const query = selectOnly(m![2]!);
    const db = catalog.d1.find(d => d.binding === m![1]);
    if (!db || !catalog.config) fail("D1 binding absent from cloudflare.config.ts");
    const table = catalog.tables.find(t => t.name === query.table && (!t.binding || t.binding === db!.binding));
    if (!table || query.columns.some(c => !table.columns.includes(c))) fail("D1 table or column absent from schema");
    const sql = /\bLIMIT\s+\d+$/i.test(m![2]!) || /COUNT\(/i.test(m![2]!) ? m![2]! : `${m![2]} LIMIT 100`;
    return { kind, binding: db!.binding, database: db!.database, id: db!.id, config: sourceFile(root, catalog.config!), sql };
  }
  if (kind === "http-json") {
    let url: URL;
    try { url = new URL(body); } catch { return fail("http-json requires a URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("http-json requires a plain HTTP(S) URL without credentials or query");
    // The domain comes from the repo's own config, so the repo cannot vouch for it: the destination must also be a
    // public internet host on its scheme's default port (S061). destinationRefusal is the shared outbound policy
    // (loopback, private, link-local and reserved literals, local names, single labels).
    const where = destinationRefusal(url.href);
    if (where) fail(`http-json destination is not a public host: ${where}`);
    if (url.port) fail(`http-json must use the default port for ${url.protocol.slice(0, -1)}, not ${url.port}`);
    if (url.hostname !== catalog.domain || !catalog.routes.some(r => r.path === url.pathname)) fail("http-json must name a GET route and domain declared by this repo");
    if (/(?:^|\/)(?:delete|write|send|deploy|publish|reset|logout|skill-download)(?:\/|$)/i.test(url.pathname)) fail("http-json route names a mutating action");
    return { kind, url: url.href };
  }
  if (kind === "test-json") {
    const m = /^(?:bun test )?(\S+)\s+(.+)$/.exec(body);
    if (!m) fail("test-json expects a test path and exact test name");
    const path = sourceFile(root, m![1]!);
    const rel = relative(realpathSync(root), path);
    const name = m![2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (!catalog.tests.some(t => t.path === rel && t.name === name)) fail("test-json requires a named test that prints JSON");
    return { kind, path, name };
  }
  if (kind === "log-tail") {
    const m = /^(.*?)\s+([1-9]\d{0,2})$/.exec(body);
    if (!m || Number(m[2]) > 100) fail("log-tail requires 1–100 lines (and at most five seconds)");
    // cf has no worker log stream (beta 5); a Worker's logs are not a bounded local source.
    if (/^(?:wrangler|cf)\s+tail\b/.test(m![1]!)) fail("log-tail reads a named log file; cf has no worker tail");
    const file = sourceFile(root, m![1]!);
    if (!/\.(log|jsonl)$/.test(file)) fail("log-tail requires a log or jsonl file");
    return { kind, file, lines: Number(m![2]) };
  }
  if (kind === "kv") {
    const m = /^(\w+)\s+([A-Za-z0-9_][A-Za-z0-9_.:/-]*)$/.exec(body);
    if (!m || !catalog.kv.includes(m[1]!) || !catalog.config) fail("KV requires a declared binding and literal key");
    return { kind, binding: m![1]!, key: m![2]!, namespaceId: catalog.kvIds[m![1]!]!, config: sourceFile(root, catalog.config!) };
  }
  return fail("unknown structured source kind");
}

/** System locations, never credentials: a UUID-named plugin dir on PATH reads as a secret shape and dropping PATH blinds every child. */
const LOCATION_VARS = new Set(["PATH", "HOME", "TMPDIR", "PWD", "SHELL", "USER", "LOGNAME", "LANG"]);

export function sourceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined &&
    !/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|BUN_OPTIONS|NODE_OPTIONS|PRELOAD/i.test(k) &&
    (LOCATION_VARS.has(k) || !redactForEngine(v!, v!.length).includes("[REDACTED]"))));
}

/** Redact leaf strings without corrupting JSON; refuse oversized structured state. */
export function structuredText(value: unknown): string {
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return redactForEngine(v, v.length);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactForEngine(k, k.length), /^(?:password|secret|token|api_key|authorization|cookie)$/i.test(k) ? "[REDACTED]" : clean(x)]));
    return v;
  };
  const text = JSON.stringify(clean(value), null, 2);
  if (!text || text.length > 8000) fail("structured output exceeds 8000 characters; narrow the query or source");
  return text;
}

/**
 * The curl argv for a validated http-json source, pinned. Validation checks only how the URL is spelled; the
 * name is the repo's own declaration and DNS decides where it really goes (S061 review: a declared
 * internal.example.com answering 127.0.0.1 or 169.254.169.254 reached curl). pinProducerArgv is the one
 * producer pin: it resolves the host once, refuses unless every answer is public, and returns curl with -q
 * first, --noproxy * and a --resolve pin, so curl never resolves the name again. Its pin options are kept and
 * this reader's fixed options follow; a refusal throws before anything is spawned.
 */
function pinnedHttpJsonArgv(url: string, resolveHost?: (host: string) => string[]): string[] {
  let pinned: string[];
  try { pinned = resolveHost ? pinProducerArgv(["curl", url], resolveHost) : pinProducerArgv(["curl", url]); }
  catch (e) { return fail(`http-json destination: ${(e as Error).message.replace(/^producer denied curl: /, "")}`); }
  // A name must carry its pin, and be spelled so the pin key is exactly the name curl looks up (no trailing dot).
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const plainName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);
  if (pinned[0] !== "curl" || pinned[pinned.length - 1] !== url || (!isIP(host) && (!plainName || !pinned.includes("--resolve")))) {
    fail("http-json destination could not be pinned");
  }
  return [...pinned.slice(0, -1), "--globoff", "--silent", "--show-error", "--max-time", "5", "--max-filesize", "1048576", "--proto", "=http,https", url];
}

/** Revalidate at execution; callers cannot construct a privileged argv by hand. `resolveHost` is the DNS seam for http-json (default: one system lookup). */
export function executeStateSource(command: string, root: string, env: NodeJS.ProcessEnv = process.env, spawn: typeof spawnSync = spawnSync, resolveHost?: (host: string) => string[]): string {
  const refusal = readOnlyRefusal(command, root);
  if (refusal) fail(refusal);
  const parsed = validateProducer(command, join(root, "ISA.md"));
  if (!("source" in parsed)) fail("expected a structured producer");
  const s = parsed.source;
  let argv: string[];
  if (s.kind === "d1") argv = ["cf", "d1", "query", s.id, "--sql", s.sql];
  else if (s.kind === "kv") argv = ["cf", "kv", "keys", "get", s.key, "--namespace-id", s.namespaceId, "--text"];
  else if (s.kind === "http-json") argv = pinnedHttpJsonArgv(s.url, resolveHost);
  else if (s.kind === "test-json") {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) fail("test-json needs the read-only OS sandbox (sandbox-exec)");
    // Deny writes/network globally and reads of user data/credentials, including imports.
    const literals: string[] = [];
    const collect = (directory: string, depth: number) => {
      if (depth > 12 || literals.length > 10000) fail("test-json read scope is too large to sandbox");
      for (const e of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, e.name);
        if (e.isSymbolicLink() || denied(path) || e.name.startsWith(".")) continue;
        if (e.isDirectory()) collect(path, depth + 1);
        else if (e.isFile()) literals.push(`(literal ${JSON.stringify(path)})`);
      }
    };
    collect(realpathSync(root), 0);
    const executable = JSON.stringify(realpathSync(process.execPath));
    const profile = `(version 1)(deny default)(deny file-write*)(deny network*)(allow process-exec (literal ${executable}))(allow sysctl-read)(allow file-read-metadata)(allow file-read* (subpath "/usr") (subpath "/System") (subpath "/dev") (literal ${executable}) ${literals.join(" ")})`;
    argv = ["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "test", s.path, "--test-name-pattern", `^${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`];
  } else argv = ["tail", "-n", String(s.lines), s.file];
  const childEnv = { ...sourceEnv(env), LIFEOS_INFERENCE_DISABLED: "1", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" };
  if (s.kind === "d1" || s.kind === "kv") {
    // The one sanctioned key passthrough: read-only cf subprocesses need these credentials, and the executor fixes argv.
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  const result = spawn(argv[0]!, argv.slice(1), { cwd: root, env: childEnv, encoding: "utf8", timeout: s.kind === "log-tail" ? 5000 : 15000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`source execution failed (${(result.error as NodeJS.ErrnoException)?.code ?? result.status})`);
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) fail("source returned no state");
  if (s.kind === "test-json" || s.kind === "log-tail") {
    const lines = stdout.trim().split(/\r?\n/);
    const values = lines.flatMap(line => { try { const v = JSON.parse(line); return v && typeof v === "object" ? [v] : []; } catch { return s.kind === "log-tail" ? [{ line }] : []; } });
    if (!values.length) fail("source returned no stdout JSON lines");
    return structuredText(s.kind === "log-tail" ? values.slice(-s.lines) : values);
  }
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { if (s.kind === "kv") value = stdout.trim(); else return fail("source did not return JSON"); }
  if (s.kind === "d1") {
    if (!Array.isArray(value) || value.some(v => v.success === false || !Array.isArray(v.results))) fail("D1 response has no successful result rows");
    value = value.flatMap(v => v.results);
  }
  if (s.kind === "kv") value = { [s.key]: value };
  return structuredText(value);
}

export function boundaryKind(text: string): SourceKind | undefined {
  if (/\b(?:KV|cache key|TTL)\b/i.test(text)) return "kv";
  if (/\bbun test\b|\btest name\b/i.test(text)) return "test-json";
  if (/\b(?:table|column|row|count|D1|SQL)\b/i.test(text)) return "d1";
  if (/\b(?:endpoint|status|health|JSON field)\b|\/api\//i.test(text)) return "http-json";
  if (/\b(?:log|logged|tail|event|emitted)\b/i.test(text)) return "log-tail";
  return undefined;
}

export function matchStateSource(text: string, c: SourceCatalog): { producer?: string; reason: string; kind?: SourceKind } {
  const contains = (term: string) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  const namedTest = c.tests.find(t => contains(t.name));
  const namedRoute = c.routes.find(r => new RegExp(`${r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`).test(text));
  const kind = namedTest ? "test-json" : namedRoute ? "http-json" : boundaryKind(text);
  if (kind === "d1") {
    const namedTables = c.tables.filter(t => contains(t.name));
    const tables = namedTables.length ? namedTables : c.tables.filter(t => t.columns.some(contains));
    if (tables.length === 1) {
      const t = tables[0]!;
      const binding = c.d1.find(d => contains(d.binding))?.binding ?? t.binding;
      const namedColumns = [...text.matchAll(/\bcolumn\s+`?([A-Za-z_]\w*)`?/gi)].map(m => m[1]!);
      if (namedColumns.some(col => !t.columns.includes(col))) return { kind, reason: "named column absent from schema" };
      const named = t.columns.filter(contains);
      const columns = named.length ? named : namedTables.length === 1 ? t.columns : [];
      if (binding && (columns.length || /\bcount\b/i.test(text))) return { kind, producer: `d1:${binding} SELECT ${/\bcount\b/i.test(text) ? "COUNT(*) AS count" : columns.join(", ")} FROM ${t.name}${/\bcount\b/i.test(text) ? "" : " LIMIT 20"}`, reason: `schema ${t.file}` };
    }
    return { kind, reason: "no unambiguous schema table, columns and D1 binding reach the criterion" };
  }
  if (kind === "http-json") {
    const routes = namedRoute ? [namedRoute] : c.routes.filter(r => r.fields.some(contains) || r.path.split("/").filter(p => p.length > 3 && !["health", "status"].includes(p)).some(contains));
    if (routes.length === 1 && c.domain) return { kind, producer: `http-json:https://${c.domain}${routes[0]!.path}`, reason: `GET route in ${routes[0]!.file}` };
    return { kind, reason: "no unambiguous declared GET JSON route reaches the criterion" };
  }
  if (kind === "test-json") {
    const tests = namedTest ? [namedTest] : c.tests.filter(t => text.includes(t.path));
    return tests.length === 1 ? { kind, producer: `test-json:${tests[0]!.path} ${tests[0]!.name}`, reason: "named test emits stdout JSON" } : { kind, reason: "no named test emits stdout JSON for this criterion" };
  }
  if (kind === "kv") {
    const keys = c.keys.filter(k => text.includes(k.key));
    return keys.length === 1 ? { kind, producer: `kv:${keys[0]!.binding} ${keys[0]!.key}`, reason: "literal KV read declared by repo" } : { kind, reason: "no literal KV key named by the criterion and repo" };
  }
  if (kind === "log-tail") {
    const logs = c.logs.filter(p => text.includes(p));
    if (logs.length === 1) return { kind, producer: `log-tail:${logs[0]} 20`, reason: "named log file" };
    return { kind, reason: "no named log file or worker stream reaches the criterion" };
  }
  return { reason: "criterion names no structured state boundary" };
}
