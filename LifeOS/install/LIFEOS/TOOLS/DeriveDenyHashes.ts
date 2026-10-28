#!/usr/bin/env bun
// release-allow: profanity (stopword vocabulary: common words excluded from fingerprint hashing)
/**
 * @version 1.3.0 (2026-10-14: passphrase values hashed through the guard's shared normalization; denyHashInputs() is the dependency list DerivedSync watches)
 * DeriveDenyHashes.ts — turn the principal's PRIVATE corpus into a SALTED-HASH
 * leak filter, so the guard can block private data appearing in shipping code
 * WITHOUT the filter ever containing that data in the clear.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/DeriveDenyHashes.ts            # regenerate DENY_HASHES.json
 *   bun ~/.claude/LIFEOS/TOOLS/DeriveDenyHashes.ts --dry-run  # counts only, write nothing
 *   bun ~/.claude/LIFEOS/TOOLS/DeriveDenyHashes.ts --show-tokens  # LOCAL review: print derived
 *                                                                  # plaintext tokens (never persisted)
 *
 * WHY THIS EXISTS: the hand-maintained DENY_LIST.txt is a BLOCKLIST — it only
 * catches strings someone remembered to add, and it holds them in plaintext.
 * This derives the filter from the private data itself (identity, contacts, gear,
 * TELOS, network topology), so a NEW device / contact / place is auto-forbidden in
 * code the moment it lands in the corpus — and stores only SALTED HASHES, so the
 * filter is opaque even if it leaked. Public LifeOS ships this tool + the guard;
 * each user runs it against their own corpus. No principal data in any shipped file.
 *
 * OUTPUT: LIFEOS/USER/SECURITY/DENY_HASHES.json (USER tree -> excluded from release):
 *   { version, algo, ngramSizes, count, hashes: ["<hex>", ...] }   <- hashes only, no plaintext.
 * SALT: ~/.claude/.env `DENYLIST_SALT` (generated once; never ships). The guard reads
 *   the same salt to reproduce hashes at scan time.
 *
 * FALSE-POSITIVE CONTROL is entirely on THIS side: only distinctive proper-noun-ish
 * tokens are hashed (capitalized, length >= MIN_LEN, not a common word, not on the
 * generic-term allowlist). A content token matches only if it EQUALS a derived
 * token, so filtering here keeps the scan precise. Tune ALLOWLIST/STOPWORDS with
 * --show-tokens.
 */
import { readFileSync, existsSync, appendFileSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteContent } from "./MemoryWriter";
// ONE normalization and ONE hash for producer and consumer: a value
// this tool hashes is, by construction, a token the guard scan generates.
import { hashPhraseToken, saltedTokenHash } from "../../hooks/lib/system-file-guard-core";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { exciseRegions } from "./TelosRegions";

const HOME = process.env.HOME || homedir();
const CLAUDE = getClaudeDir();
const ENV_PATH = join(CLAUDE, ".env");
// USER/SECURITY, not a private maintenance-skill directory: doing that created the
// dev-tree marker on public installs, disabling seven installer tools (public
// issue #1689, @christauff). Reader: hooks/lib/system-file-guard-core.ts.
const OUT_PATH = join(CLAUDE, "LIFEOS", "USER", "SECURITY", "DENY_HASHES.json");
const MIN_LEN = 4;          // single tokens shorter than this are too FP-prone
const HASH_HEX_LEN = 24;    // truncated sha256 — collision-safe at this corpus size, smaller file
const NGRAM_SIZES = [1, 2]; // 1-grams (surnames, hostnames) + 2-grams (multi-word names/places)

// Private source corpus. Paths resolve through the USER/MEMORY symlinks. A file
// that doesn't exist on a given install is simply skipped.
const CORPUS_REL = [
  "LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md",
  "LIFEOS/USER/PRINCIPAL/PRINCIPAL_PRIVATE.md",
  "LIFEOS/USER/PRINCIPAL/RESUME.md",
  "LIFEOS/USER/CONTACTS.md",
  "LIFEOS/USER/GEAR.md",
  "LIFEOS/USER/TELOS/TELOS.md",
  "LIFEOS/MEMORY/Network/assets.json",
];
// Finance records name what the principal holds. Prose extraction misses single-word companies and
// tickers, so these are read as structured sources by holdingTokens() (holdings-leak-filter ISA, 2026-10-22).
const HOLDINGS_REL = [
  "LIFEOS/USER/FINANCES/carta.json",
  "LIFEOS/USER/FINANCES/INVESTMENTS.md",
];
const NETWORK_DIR = join(CLAUDE, "LIFEOS/MEMORY/Network");
const TOPOLOGY_SNAPSHOT_RE = /^topology-snapshot-.*\.md$/;

function corpusFiles(): string[] {
  const rel = CORPUS_REL.map((r) => join(CLAUDE, r));
  try {
    const snap = readdirSync(NETWORK_DIR).filter((f) => TOPOLOGY_SNAPSHOT_RE.test(f)).sort().pop();
    if (snap) rel.push(join(NETWORK_DIR, snap));
  } catch { /* none */ }
  return rel.filter(existsSync);
}

/**
 * THE dependency list of the derived filter: every existing file
 * whose content changes DENY_HASHES.json — the corpus, the .env passphrase-class values, and the
 * operator allowlist. DerivedSync watches exactly these, so no input can change while the filter
 * stays stale. Paths only; nothing here reads a file's content.
 */
export function denyHashInputs(): string[] {
  return [...corpusFiles(), ...holdingFiles(), ...[ENV_PATH, OPERATOR_ALLOWLIST_PATH].filter(existsSync)];
}

function holdingFiles(): string[] {
  return HOLDINGS_REL.map((r) => join(CLAUDE, r)).filter(existsSync);
}

/** Is `path` an input of the derived filter, existing or not (the same list as denyHashInputs)? */
export function isDenyHashInput(path: string): boolean {
  if (path === ENV_PATH || path === OPERATOR_ALLOWLIST_PATH) return true;
  if ([...CORPUS_REL, ...HOLDINGS_REL].some((r) => join(CLAUDE, r) === path)) return true;
  return dirname(path) === NETWORK_DIR && TOPOLOGY_SNAPSHOT_RE.test(basename(path));
}

// Common words + generic tech terms that must never be hashed (they appear in code).
const STOPWORDS = new Set<string>([
  "the","and","for","with","this","that","from","have","will","your","you","are","was","were","been","they","them","their","what","when","where","which","while","would","could","should","about","into","over","under","then","than","also","some","most","more","much","many","such","only","other","these","those","here","there","after","before","being","because","between","through","during","above","below","again","once","each","both","very","just","like","make","made","time","work","home","user","name","role","note","kind","item","list","data","code","file","path","true","false","null","type","value","model","details","primary","secondary","sample","example","default",
  // generic gear/tech nouns that legitimately appear in code/docs
  "computer","laptop","monitor","display","camera","cameras","router","switch","switches","server","network","device","devices","system","software","language","framework","infrastructure","workstation","headphones","microphone","thermostat","garage","lighting","internet","studio","office","audio","music","coffee","health","sleep","house","stack","brand",
  // modern-common words the classic /usr/share/dict/words list omits, so they read
  // as the "distinctive" half of Title-Case phrases and got hashed as false private
  // fingerprints (2026-07-08 fix; words ordered so no two form a currently-hashed pair).
  "online","lifecycle","credentials","technologies","minis","wifi","division","mobile","live","fucking",
]);

// Tokens that legitimately appear in SHIPPING/public files — LifeOS system
// terms and widely used vendor/platform names. Operator terms belong in USER config.
const ALLOWLIST = new Set<string>([
  "lifeos","github","claude","anthropic","opus","sonnet","haiku","fable","cloudflare","typescript","react","astro","vitepress","hono","wrangler","stripe","google","apple","openai","gemini","descript","elevenlabs",
  // Shared platforms and LifeOS system terms shipped publicly.
  "homebridge","homekit","fabric","telos","arbol","pulse","interceptor",
  // generic security/tech abbreviations (not in the dictionary, but appear in code/docs)
  "auth","oauth","appsec","vulnmgmt","cpus","saas","chatgpt","xhtml","itops","secops","devops","kubernetes","webhook","webhooks","jsonl",
  // public social/platform names + shared email-provider LABELS (the domain check
  // tests domain.split(".")[0] against this set, so a bare label suffices). All are
  // public, never private fingerprints — like github/google above (2026-07-08 fix).
  "linkedin","youtube","twitter","instagram","facebook","tiktok","bluesky","mastodon","threads","discord","reddit","medium","substack","patreon","twitch","spotify",
  "gmail","googlemail","icloud","outlook","hotmail","yahoo","aol","proton","protonmail","mac",
  // generic OS/tool/vendor names — non-dictionary but universally public
  "kali","owasp","linux","microsoft","sdlc","nvidia","ubuntu","debian","macos","android","windows","intel",
  // public hosting/platform domain labels (the domain check keys on the first label;
  // "workers.dev" is Cloudflare's shared suffix, not a private fingerprint — 2026-09-11)
  "workers","pages","cloudflare","vercel","netlify","fly","render","github","googleapis",
]);

// OPERATOR-SPECIFIC allowlist extension (Astra audit, 2026-07-30): tokens tied to
// one operator's life — surname, former employers, gear brands, music taste —
// were hard-coded here, and although each is individually public, composed in
// one shipped file they form an identity fingerprint (and are permanently
// exempted from the leak filter on every install). Identity lives in USER
// config, never source (the D-58 pattern): one lowercase token per line,
// `#` comments allowed, absent file = empty set. USER/ never ships.
const OPERATOR_ALLOWLIST_PATH = join(CLAUDE, "LIFEOS/USER/CONFIG/denyhash-allowlist.txt");
function loadOperatorAllowlist(): void {
  try {
    for (const line of readFileSync(OPERATOR_ALLOWLIST_PATH, "utf8").split("\n")) {
      const t = line.trim().toLowerCase();
      if (t && !t.startsWith("#")) ALLOWLIST.add(t);
    }
  } catch { /* no operator extension — generic set only */ }
}
loadOperatorAllowlist();

// Real English words are dropped — what survives is proper nouns (surnames,
// brands, hostnames, place names), which ARE the private fingerprint. This is the
// main false-positive control: "build"/"content"/"design" are dictionary words and
// never hashed, so they can't block legitimate code.
function loadDict(): Set<string> {
  for (const p of ["/usr/share/dict/words", "/usr/dict/words"]) {
    try {
      return new Set(readFileSync(p, "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean));
    } catch { /* try next */ }
  }
  return new Set();
}
// Loaded on first use: DerivedSync imports this module for denyHashInputs() and never needs the dictionary.
let dictCache: Set<string> | null = null;
const DICT = { has: (w: string): boolean => (dictCache ??= loadDict()).has(w) };

// True if the word — OR its de-inflected stem — is a real dictionary word. The
// dict only holds base forms, so plurals/inflections ("books","clients","created",
// "avoiding") need stemming or they'd survive as false "distinctive" tokens.
function dictish(lw: string): boolean {
  if (DICT.has(lw)) return true;
  const tries: string[] = [];
  if (lw.endsWith("ies")) tries.push(lw.slice(0, -3) + "y");
  // Silent-e / y restoration: "updated"→"update", "modified"→"modify",
  // "updating"→"update". Without these the participle half of "Last Updated"
  // read as distinctive and the 2-gram became a permanent write-blocking hash
  // (fails CLOSED on SYSTEM writes). public issue #2000, @jlacour-git
  if (lw.endsWith("ied")) tries.push(lw.slice(0, -3) + "y");
  if (lw.endsWith("ed")) tries.push(lw.slice(0, -1));
  if (lw.endsWith("ing")) tries.push(lw.slice(0, -3) + "e");
  for (const suf of ["s", "es", "ed", "ing", "'s", "’s", "ly", "er", "ers"]) {
    if (lw.endsWith(suf)) tries.push(lw.slice(0, -suf.length));
  }
  return tries.some((s) => s.length >= 3 && DICT.has(s));
}

function loadSalt(): string {
  const env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const m = /^DENYLIST_SALT=(.+)$/m.exec(env);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  const salt = randomBytes(32).toString("hex");
  appendFileSync(ENV_PATH, `${env.endsWith("\n") || env === "" ? "" : "\n"}DENYLIST_SALT=${salt}\n`);
  console.log(`[DeriveDenyHashes] generated DENYLIST_SALT in ${ENV_PATH}`);
  return salt;
}

export function hashToken(token: string, salt: string): string {
  return saltedTokenHash(token, salt, HASH_HEX_LEN);
}

/**
 * Extract HIGH-CONFIDENCE private tokens only. Lone single words are the main
 * false-positive source (a spelling dictionary omits much common jargon), so we
 * derive by TYPE: two-word capitalized name sequences, email local parts,
 * email/standalone domains, and — only from network sources (opts.singles) — lone
 * host/device identifiers. A pair is kept only if at least one word is a
 * non-dictionary token; all-dictionary/allowlisted pairs are dropped.
 */
export function extractTokens(text: string, opts: { singles?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  const distinctive = (w: string) => {
    const lw = w.toLowerCase();
    if (/['’]/.test(lw)) return false; // contraction/possessive ("I've", "that's") — not a name
    return lw.length >= MIN_LEN && !STOPWORDS.has(lw) && !ALLOWLIST.has(lw) && !dictish(lw);
  };
  const pairRe = /\b([A-Z][a-zA-Z0-9'’]+)\s+([A-Z][a-zA-Z0-9'’]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(text))) {
    if (distinctive(m[1]) || distinctive(m[2])) out.add(`${m[1]} ${m[2]}`.toLowerCase());
  }
  for (const em of text.matchAll(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g)) {
    const local = em[1].toLowerCase();
    if (local.length >= MIN_LEN && !ALLOWLIST.has(local) && !dictish(local)) out.add(local);
    const domain = em[2].toLowerCase();
    if (!ALLOWLIST.has(domain.split(".")[0])) out.add(domain);
  }
  for (const dm of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|co|app|lan|edu|gov)\b/gi)) {
    const d = dm[0].toLowerCase();
    if (!ALLOWLIST.has(d.split(".")[0])) out.add(d);
  }
  if (opts.singles) {
    for (const w of text.match(/[A-Za-z][A-Za-z0-9'’-]+/g) ?? []) if (distinctive(w)) out.add(w.toLowerCase());
  }
  return out;
}

// Spoken/typed second factors are dictionary words by design, so the
// prose corpus can never hash them and the dictionary filter would drop them if it
// did. The VALUES of passphrase-class .env keys are hashed as exact tokens with no
// filter at all, so a passphrase pasted into a code comment trips the same guard
// as a surname. Values never leave this
// function unhashed; the key NAMES stay generic here on purpose.
//
// Each value is normalized by the guard's own hashPhraseToken: its words joined
// by one space, so "Three Word Phrase", "dotted.value-7!" and "a, b; c" hash the n-gram the scan
// builds from content. Its word count joins the filter's ngramSizes so the scan generates that size.
const SECRET_VALUE_KEY_RE = /(PASSPHRASE|PASSWORD|_PIN\b|COUNTERSIGN|_SECRET_PHRASE)/i;
export function secretValueTokens(envText: string): { tokens: Set<string>; sizes: Set<number>; unmatchable: number } {
  const tokens = new Set<string>();
  const sizes = new Set<number>();
  let unmatchable = 0;
  for (const line of envText.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || !SECRET_VALUE_KEY_RE.test(m[1]!)) continue;
    const v = m[2]!.replace(/^["']|["']$/g, "").trim();
    if (!v) continue;
    const phrase = hashPhraseToken(v);
    // A lone word shorter than MIN_LEN is never a scan token (1-grams need MIN_LEN), so it cannot be guarded.
    if (!phrase || (phrase.words === 1 && phrase.token.length < MIN_LEN)) { unmatchable++; continue; }
    tokens.add(phrase.token);
    sizes.add(phrase.words);
  }
  return { tokens, sizes, unmatchable };
}

/**
 * Holding identifiers as exact phrase tokens (holdings-leak-filter ISA C1). Sources: every company, issuer,
 * ticker or symbol value anywhere in a JSON file, and every identifier column (ticker, symbol, company,
 * fund, name, holding, issuer) of a markdown table that has one. A cell is cleaned of markdown links,
 * emphasis and footnote marks; a parenthesized ticker is hashed on its own; a legal suffix ("Inc.",
 * "Holdings, LLC") is also stripped, and a distinctive first word is hashed too, so the bare name a writer
 * would actually type is guarded. Ticker cells skip the dictionary filter (COST is a ticker); other single
 * words that are dictionary words, and summary rows (Total, Cash), are skipped and counted.
 */
const ID_HEAD = /^(ticker|ticker symbol|symbol|company|fund|fund name|name|holding|issuer)$/i;
const TICKER_HEAD = /^(ticker|ticker symbol|symbol)$/i;
const ID_KEY = /^(company|issuer|ticker|symbol)$/i;
const SUMMARY_ROW = /^(grand\s+|sub)?totals?\b|^cash\b|^n\/?a$/i;
const LEGAL_SUFFIX = /[,\s]+(inc|incorporated|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|pbc|gmbh|ag|sa|holdings?|group)\.?$/i;
export function holdingTokens(files: Array<{ path: string; text: string }>): { tokens: Set<string>; sizes: Set<number>; skipped: number; empty: string[] } {
  const tokens = new Set<string>();
  const sizes = new Set<number>();
  let skipped = 0;
  const empty: string[] = [];
  const put = (v: string, ticker: boolean): boolean => {
    const phrase = hashPhraseToken(v);
    // The operator allowlist (USER/CONFIG/denyhash-allowlist.txt) exempts a holding that is also a public name shipping docs cite.
    if (!phrase || ALLOWLIST.has(phrase.token)) return false;
    if (phrase.words === 1 && (phrase.token.length < MIN_LEN || (!ticker && (STOPWORDS.has(phrase.token) || dictish(phrase.token))))) return false;
    tokens.add(phrase.token);
    sizes.add(phrase.words);
    return true;
  };
  const add = (raw: string, ticker = false): void => {
    let v = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[\d+\]|\^\d+|[*_`†‡]/g, "").trim();
    if (!v || SUMMARY_ROW.test(v) || /^[\d\s.,$%€£¥()+–—-]*$/.test(v)) return;
    for (const inner of v.matchAll(/\(([A-Z][A-Z0-9.]{1,7})\)/g)) put(inner[1]!, true);
    v = v.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    let bare = v;
    while (LEGAL_SUFFIX.test(bare)) bare = bare.replace(LEGAL_SUFFIX, "").trim();
    const bareToken = hashPhraseToken(bare)?.token;
    if (bareToken && ALLOWLIST.has(bareToken)) { skipped++; return; } // exempting the bare name exempts every form of it
    let any = put(v, ticker);
    if (bare && bare !== v) any = put(bare, ticker) || any;
    const first = bare.split(" ")[0] ?? "";
    if (first && first !== bare) any = put(first, false) || any;
    if (!any) skipped++;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (!node || typeof node !== "object") return;
    for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
      if (typeof val === "string" && ID_KEY.test(k)) add(val, /^(ticker|symbol)$/i.test(k));
      else walk(val);
    }
  };
  for (const { path, text } of files) {
    const before = tokens.size;
    if (path.endsWith(".json")) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error(`holdings source is not valid JSON: ${path}`); }
      walk(parsed);
    } else {
      let cols: string[] | null = null; // the current table's header cells; [] for a table with no identifier column, null outside a table
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("|")) { cols = null; continue; }
        const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cols === null) { const head = cells.map((c) => c.replace(/[*_`]/g, "").trim()); cols = head.some((c) => ID_HEAD.test(c)) ? head : []; continue; }
        if (cols.length === 0 || cells.every((c) => /^:?-+:?$/.test(c))) continue;
        if (SUMMARY_ROW.test((cells[0] ?? "").replace(/[*_`]/g, "").trim())) continue;
        cols.forEach((h, i) => { if (ID_HEAD.test(h) && cells[i]) add(cells[i]!, TICKER_HEAD.test(h)); });
      }
    }
    if (tokens.size === before) empty.push(path);
  }
  return { tokens, sizes, skipped, empty };
}

/** The n-gram sizes the scan must generate: the prose 1- and 2-grams plus every hashed phrase's word count. */
export function ngramSizesFor(...extra: Array<Set<number>>): number[] {
  return [...new Set([...NGRAM_SIZES, ...extra.flatMap((s) => [...s])])].sort((a, b) => a - b);
}

/**
 * Tokens one corpus file contributes. Text inside TELOS's machine-owned
 * AUTOMATED regions is excised first: it is a rendered projection that churns
 * daily, so hashing it would churn the filter, and the hand-written corpus is
 * the source of truth for what counts as private. A file with no fences is
 * read whole, as before.
 */
export function corpusTokens(raw: string): Set<string> {
  return extractTokens(exciseRegions(raw));
}

/**
 * Read every expected corpus file. A file that exists but cannot be read is
 * reported, never skipped: persisting hashes from a partial corpus would
 * replace the leak filter with an incomplete one.
 */
export function readCorpusTokens(
  files: string[],
  read: (f: string) => string = (f) => readFileSync(f, "utf8"),
): { tokens: Set<string>; unreadable: string[] } {
  const tokens = new Set<string>();
  const unreadable: string[] = [];
  for (const f of files) {
    // Single-token extraction stays OFF: even network sources are prose-heavy and
    // yield generic tech words that false-positive. Name 2-grams + emails + domains
    // are the precise core; bare hostnames remain covered by the hand deny-list.
    let text: string;
    try { text = read(f); } catch { unreadable.push(f); continue; }
    for (const t of corpusTokens(text)) tokens.add(t);
  }
  return { tokens, unreadable };
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const showTokens = process.argv.includes("--show-tokens");
  const files = corpusFiles();
  const secret = secretValueTokens(existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "");
  const secretValues = secret.tokens;
  if (secret.unmatchable > 0) {
    console.error(`[DeriveDenyHashes] WARNING: ${secret.unmatchable} passphrase-class value(s) have no scannable word of ${MIN_LEN}+ characters and cannot be guarded`);
  }
  const { tokens, unreadable } = readCorpusTokens(files);
  if (unreadable.length) {
    // Abort before any write: the previous DENY_HASHES.json stays in force.
    console.error(`[DeriveDenyHashes] ABORT: ${unreadable.length} corpus file(s) unreadable, previous filter kept: ${unreadable.join(", ")}`);
    process.exit(1);
  }
  for (const t of secretValues) tokens.add(t);
  // Holdings: a file that exists but cannot be read or parsed aborts like a corpus file, keeping the previous filter.
  let holdings: ReturnType<typeof holdingTokens>;
  try { holdings = holdingTokens(holdingFiles().map((f) => ({ path: f, text: readFileSync(f, "utf8") }))); } catch (error) {
    console.error(`[DeriveDenyHashes] ABORT: holdings source unreadable, previous filter kept: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  for (const t of holdings.tokens) tokens.add(t);
  console.log(`[DeriveDenyHashes] ${files.length} corpus files + ${secretValues.size} passphrase-class value(s) + ${holdings.tokens.size} holding name(s) -> ${tokens.size} distinctive tokens`);
  // A holdings file that exists but names nothing, or a source that went missing, is said loudly: the filter is weaker than last time.
  for (const f of holdings.empty) console.error(`[DeriveDenyHashes] WARNING: ${f} yielded no holding names; its holdings are not guarded`);
  for (const r of HOLDINGS_REL) if (!existsSync(join(CLAUDE, r))) console.error(`[DeriveDenyHashes] WARNING: holdings source missing: ${r}; its holdings are not guarded`);
  if (holdings.skipped > 0) console.log(`[DeriveDenyHashes] ${holdings.skipped} holding cell(s) skipped: a dictionary word or too short for the scan to match`);
  if (showTokens) {
    console.log("[DeriveDenyHashes] --show-tokens (LOCAL review, NOT written to disk):");
    console.log([...tokens].filter((t) => !secretValues.has(t) && !holdings.tokens.has(t)).sort().join(", ") + (secretValues.size ? `, +${secretValues.size} passphrase-class value(s) (not shown)` : "") + (holdings.tokens.size ? `, +${holdings.tokens.size} holding name(s) (not shown)` : ""));
  }
  if (dryRun) { console.log("[DeriveDenyHashes] --dry-run: nothing written"); return; }

  // NEVER guard this write on maintenance skill being present (public issue #1902, @pybe): OUT_PATH
  // is under LIFEOS/USER/SECURITY, so such a guard makes the write unreachable on a public
  // install and the hash half of the leak filter dies silently, exit 0 and a plausible skip
  // message. mkdirSync below is the only real precondition.
  const salt = loadSalt();
  const hashes = [...tokens].map((t) => hashToken(t, salt)).sort();
  const payload = {
    version: 1,
    algo: `sha256-salted-trunc${HASH_HEX_LEN}`,
    // The scan generates every size listed: the corpus's 1/2-grams plus each passphrase's word count.
    ngramSizes: ngramSizesFor(secret.sizes, holdings.sizes),
    minLen: MIN_LEN,
    count: hashes.length,
    generated: "DeriveDenyHashes.ts",
    note: "Salted hashes of distinctive private tokens. No plaintext. Salt in .env (never ships).",
    hashes,
  };
  // Create the output dir first — absent on fresh installs, and a throw here
  // aborts the whole DerivedSync pass (public PR #1652, @elhoim).
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  // tmp + fsync + rename: a crash mid-write must never leave a truncated
  // DENY_HASHES.json, because the consumer (system-file-guard-core) fails OPEN on
  // an unparseable file — atomicity is part of the control. Shared implementation,
  // O_EXCL tmp included. public issue #2017 + PR #1964, @0bsolescence
  const written = atomicWriteContent(OUT_PATH, JSON.stringify(payload, null, 0) + "\n");
  if (written !== true) {
    console.error(`[DeriveDenyHashes] write FAILED: ${written.message}`);
    process.exit(1);
  }
  console.log(`[DeriveDenyHashes] wrote ${hashes.length} salted hashes -> ${OUT_PATH} (no plaintext)`);
}

if (import.meta.main) main();
