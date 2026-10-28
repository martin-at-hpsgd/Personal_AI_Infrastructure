/**
 * BooksSync.ts — regenerate the PUBLIC favorite-books file from Cortex, safely.
 *
 * Cortex Books notes are private (AI-generated bodies, inferred quality bands,
 * internal ids, the related-edge graph). USER/BOOKS.md is `classification: public`
 * and feeds the daemon site, Pulse /books, and the Telos skill. This tool is the
 * ONLY bridge between the two, and it is deliberately narrow:
 *
 *   - Reads note FRONTMATTER only. Never a note body, never a quote, never a take.
 *   - Selects a note only when the principal endorsed the book on the record: a
 *     provenance tag listed in USER/CONFIG/books-sync.json `endorsing_tags`, or a
 *     stated rating (`rating_key`) at or above `rating_floor`. A review alone, a
 *     "read that year" list, or a top-1000 rank is NOT an endorsement.
 *   - Emits an allowlisted field set per book: title, author, year, rating (only
 *     when the principal stated it), lists. Nothing else can reach the file.
 *   - Every emitted string passes a deny-pattern sanitizer (paths, ids, urls,
 *     emails, markup, credential shapes); an `invariant()` failure aborts the write.
 *   - Hand-curated entries above the generated block are preserved verbatim.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/BooksSync.ts --check                  # report what would change, write nothing
 *   bun LIFEOS/TOOLS/BooksSync.ts --apply                  # rewrite USER/BOOKS.md
 *   bun LIFEOS/TOOLS/BooksSync.ts --daemon <daemon-data.json> [--apply]
 *       # project the PUBLIC file (never Cortex) into the daemon's favorite_books
 */
import fs from "fs";
import path from "path";
import { parseNote, type FmField } from "./KnowledgeSchema";
import { invariant } from "./Invariant";
import { getLifeosDir } from "./Paths";
import { lifeosUserDir } from "./LifeosConfig";
import { bumpMemoryGeneration } from "./MemoryRetriever";

const LIFEOS_DIR = getLifeosDir();
const USER_DIR = lifeosUserDir();
const BOOKS_DIR = path.join(LIFEOS_DIR, "MEMORY", "KNOWLEDGE", "Books");
const BOOKS_MD = path.join(USER_DIR, "BOOKS.md");
const CONFIG_PATH = path.join(USER_DIR, "CONFIG", "books-sync.json");

interface Config { endorsing_tags: Record<string, string>; rating_key: string; rating_floor: number; rating_group_label: string }
let cfgCache: Config | undefined;
/** Read on first use, so the sanitizer below can be imported (and tested) without a USER config. */
function cfg(): Config {
  if (cfgCache) return cfgCache;
  const c: Config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  invariant(c.endorsing_tags && typeof c.rating_key === "string" && Number.isFinite(c.rating_floor) && !!c.rating_group_label, "books-sync.json incomplete");
  cfgCache = c;
  return c;
}

/**
 * Credential shapes. A vendor prefix may be followed by any number of segments
 * (sk-<org>-<kind>-<body>, github_pat_<a>_<b>, xoxb-<n>-<n>-<body>), so the prefix rule
 * takes every hyphen/underscore segment after it rather than one separator and one body.
 * The opaque-token rule catches unprefixed keys: a whitespace-free run of 20+ key
 * characters holding both a letter and a digit, which no book title or author name is.
 * (a segmented provider prefix passed the old single-separator rule.)
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk|gh[pousr]|github_pat|glpat|xox[abprs])(?=[-_A-Za-z0-9]{10,})(?:[-_][A-Za-z0-9]+)+/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{20,}/,
];

/** Deny patterns — anything private-shaped that must never reach a public file. */
const DENY: Array<[RegExp, string]> = [
  [/\/Users\/|~\/|\.claude|LIFEOS\//, "path"],
  [/\bkb_[a-z0-9_]+/i, "note id"],
  [/https?:\/\/|www\./i, "url"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "email"],
  [/[<>{}`$\\]/, "markup"],
  [/\b\d{6,}\b/, "long number"],
  ...CREDENTIAL_SHAPES.map((re): [RegExp, string] => [re, "credential shape"]),
];

/**
 * Refuse a credential shape anywhere in text bound for a public file. The message names
 * where and what kind, never the value.
 */
export function assertNoCredential(text: string, where: string): void {
  for (const re of CREDENTIAL_SHAPES) invariant(!re.test(text), `${where}: credential shape pattern`);
}
const ALLOWED_KEYS = new Set(["title", "author", "year", "rating", "lists"]);

export interface Book { title: string; author: string; year?: number; rating?: number; lists: string[] }

function field(fields: FmField[], key: string): string | undefined {
  const f = fields.find((x) => x.key === key);
  if (!f) return undefined;
  if (f.scalar !== undefined) return f.scalar.trim().replace(/^["']|["']$/g, "");
  return f.raw;
}
function tagsOf(fields: FmField[]): string[] {
  const raw = field(fields, "tags") ?? "";
  return raw.replace(/^tags:\s*/, "").replace(/^\[|\]$/g, "").split(/[,\n]/)
    .map((s) => s.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * Sanitize one string for the public file. A rejection names the field and the pattern
 * class only: the rejected value is the private thing, so it never enters the message
 * (the old message quoted the first 60 characters).
 */
export function clean(s: string, where: string): string {
  const v = s.replace(/\s+/g, " ").trim();
  for (const [re, why] of DENY) invariant(!re.test(v), `${where}: ${why} pattern`);
  invariant(v.length > 0 && v.length <= 160, `${where}: length ${v.length}`);
  return v;
}

function collect(): { books: Book[]; skipped: Record<string, number> } {
  const books: Book[] = [];
  const skipped: Record<string, number> = {};
  for (const f of fs.readdirSync(BOOKS_DIR).sort()) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const { fields, hadFrontmatter } = parseNote(fs.readFileSync(path.join(BOOKS_DIR, f), "utf8"));
    if (!hadFrontmatter) continue;
    const tags = tagsOf(fields);
    const CFG = cfg();
    const rating = Number.parseInt(field(fields, CFG.rating_key) ?? "", 10);
    const lists = Object.keys(CFG.endorsing_tags).filter((t) => tags.includes(t)).map((t) => clean(CFG.endorsing_tags[t], `${f} list`));
    const endorsed = lists.length > 0 || (Number.isFinite(rating) && rating >= CFG.rating_floor);
    if (!endorsed) {
      const why = tags.includes("greatest-books-top-1000") ? "top-1000 only" : tags.some((t) => t.endsWith("-reviewed")) ? "reviewed, not endorsed" : "other list only";
      skipped[why] = (skipped[why] ?? 0) + 1;
      continue;
    }
    const rawTitle = field(fields, "title") ?? "";
    const dash = rawTitle.lastIndexOf(" — ");
    const title = clean(dash > 0 ? rawTitle.slice(0, dash) : rawTitle, `${f} title`);
    const author = clean(field(fields, "source_author") ?? (dash > 0 ? rawTitle.slice(dash + 3) : "Unknown"), `${f} author`);
    const year = Number.parseInt(field(fields, "year") ?? "", 10);
    const book: Book = { title, author, lists };
    if (Number.isFinite(year)) book.year = year;
    if (Number.isFinite(rating)) book.rating = rating; // only ever a rating the principal stated
    for (const k of Object.keys(book)) invariant(ALLOWED_KEYS.has(k), `disallowed key ${k}`);
    books.push(book);
  }
  return { books, skipped };
}

const norm = (t: string) => t.toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

const BEGIN = "<!-- cortex:begin — generated by LIFEOS/TOOLS/BooksSync.ts from Cortex Books frontmatter; edit the hand-curated sections above, not this block -->";
const END = "<!-- cortex:end -->";

export function render(existing: string, books: Book[], today: string): { out: string; handTitles: Set<string>; added: number } {
  // Every string the generated block emits passes the sanitizer here, whatever produced the Book.
  for (const bk of books) {
    clean(bk.title, "render title");
    clean(bk.author, "render author");
    for (const l of bk.lists) clean(l, "render list");
  }
  const CFG = cfg();
  // Split: frontmatter | hand-curated head | (old generated block) | tail (Daemon / Cross-reference prose)
  const fm = existing.match(/^---\n[\s\S]*?\n---\n/);
  invariant(!!fm, "BOOKS.md has no frontmatter");
  const body = existing.slice(fm![0].length);
  const b = body.indexOf(BEGIN), e = body.indexOf(END);
  let head = b >= 0 ? body.slice(0, b) : body;
  let tail = e >= 0 ? body.slice(e + END.length) : "";
  if (b < 0) {
    // First run: the tail is everything from "## Daemon" on; the interview seed block is retired.
    const d = head.indexOf("\n## Daemon");
    if (d >= 0) { tail = head.slice(d); head = head.slice(0, d); }
    head = head.replace(/\n## Seed during interview[\s\S]*$/, "\n");
  }
  head = head.replace(/_\(massive expansion pending[^)]*\)_\n?/g, "");
  const handTitles = new Set([...head.matchAll(/^-\s+title:\s*"?([^"\n]+)"?/gm)].map((m) => norm(m[1])));

  const groups = new Map<string, Book[]>();
  const label = (bk: Book) => bk.lists[0] ?? CFG.rating_group_label;
  for (const bk of books) {
    if (handTitles.has(norm(bk.title))) continue;
    groups.set(label(bk), [...(groups.get(label(bk)) ?? []), bk]);
  }
  const order = [...Object.values(CFG.endorsing_tags), CFG.rating_group_label];
  const lines: string[] = [BEGIN, ""];
  let added = 0;
  for (const g of order) {
    const bs = groups.get(g);
    if (!bs?.length) continue;
    lines.push(`## ${g}`, "");
    for (const bk of bs.sort((x, y) => x.title.localeCompare(y.title))) {
      lines.push(`- title: "${bk.title.replace(/"/g, "'")}"`, `  author: "${bk.author.replace(/"/g, "'")}"`);
      if (bk.year !== undefined) lines.push(`  year: ${bk.year}`);
      if (bk.rating !== undefined) lines.push(`  rating: ${bk.rating}`);
      if (bk.lists.length > 1) lines.push(`  lists: [${bk.lists.map((l) => `"${l}"`).join(", ")}]`);
      lines.push("");
      added++;
    }
  }
  lines.push(END);
  const newTail = tail
    .replace(/- Reader: .*$/m, "- Reader: `DaemonAggregator.readBooks()` — parses the `- title:` rows of this file (public boundary; Cortex never feeds the daemon directly)")
    .replace(/- Surfaces title \+ author.*$/m, "- Surfaces title + author to the daemon site\n- Regenerate the Cortex block: `bun LIFEOS/TOOLS/BooksSync.ts --apply` (frontmatter-only, endorsement-tag allowlist in `CONFIG/books-sync.json`, deny-pattern sanitizer)");
  const newFm = fm![0]
    .replace(/^last_updated: .*$/m, `last_updated: ${today}`)
    .replace(/^version: (\d+)\.(\d+)\.(\d+)$/m, (_m, a, b2) => `version: ${a}.${Number(b2) + 1}.0`);
  const withGen = /^generated_block:/m.test(newFm) ? newFm : newFm.replace(/\n---\n$/, "\ngenerated_block: LIFEOS/TOOLS/BooksSync.ts\n---\n");
  const out = withGen + head.replace(/\n+$/, "\n") + "\n" + lines.join("\n") + "\n" + newTail.replace(/^\n*/, "\n");
  // The hand-curated head and the tail are kept verbatim, so the whole public file is checked once more.
  assertNoCredential(out, "rendered BOOKS.md");
  return { out, handTitles, added };
}

// ── daemon projection: PUBLIC file → daemon-data.json favorite_books (never Cortex) ──
export function publicBooks(md: string): string[] {
  const out: string[] = [];
  let cur: { title?: string; author?: string } | null = null;
  const flush = () => { if (cur?.title) out.push(cur.author ? `"${cur.title}" by ${cur.author}` : `"${cur.title}"`); };
  for (const line of md.split("\n")) {
    const t = line.match(/^-\s+title:\s*"?(.+?)"?\s*$/);
    if (t) { flush(); cur = { title: t[1] }; continue; }
    const a = cur && line.match(/^\s+author:\s*"?(.+?)"?\s*$/);
    if (a) cur!.author = a[1];
  }
  flush();
  return out;
}

// The CLI runs only when invoked directly, so the sanitizer is importable by its test.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const today = new Date().toISOString().slice(0, 10);

  if (args.includes("--daemon")) {
    const dataPath = args[args.indexOf("--daemon") + 1];
    invariant(!!dataPath && fs.existsSync(dataPath), "--daemon needs an existing daemon-data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    const fromFile = publicBooks(fs.readFileSync(BOOKS_MD, "utf8")).map((s) => clean(s, "daemon"));
    const existing: string[] = Array.isArray(data.favorite_books) ? data.favorite_books : [];
    const seen = new Set<string>();
    const key = (s: string) => norm(s.replace(/^"(.+?)".*$/, "$1"));
    for (const s of existing) assertNoCredential(s, "daemon favorite_books");
    const merged = [...fromFile, ...existing].filter((s) => (seen.has(key(s)) ? false : (seen.add(key(s)), true)));
    const kept = existing.filter((s) => !fromFile.some((f) => key(f) === key(s)));
    console.log(`daemon favorite_books: ${existing.length} → ${merged.length} (${fromFile.length} from BOOKS.md, ${kept.length} pre-existing hand entries kept)`);
    for (const s of kept) console.log(`  kept (not in BOOKS.md): ${s}`);
    if (apply) {
      data.favorite_books = merged;
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n");
      console.log(`wrote favorite_books to ${dataPath} (no other key touched)`);
    } else console.log("dry run — pass --apply to write");
    process.exit(0);
  }

  const { books, skipped } = collect();
  const existing = fs.readFileSync(BOOKS_MD, "utf8");
  const { out, handTitles, added } = render(existing, books, today);
  const byList: Record<string, number> = {};
  for (const bk of books) for (const l of bk.lists.length ? bk.lists : ["rating-only"]) byList[l] = (byList[l] ?? 0) + 1;
  console.log(`endorsed in Cortex: ${books.length} (${JSON.stringify(byList)}); skipped ${JSON.stringify(skipped)}`);
  console.log(`hand-curated kept: ${handTitles.size}; generated rows: ${added}; ${out.length} bytes (was ${existing.length})`);
  if (apply) {
    invariant(publicBooks(out).length === handTitles.size + added, "row count mismatch after render");
    fs.writeFileSync(BOOKS_MD, out);
    bumpMemoryGeneration();
    console.log(`wrote ${BOOKS_MD}`);
  } else {
    console.log("dry run — pass --apply to write. Preview of generated block:");
    console.log(out.slice(out.indexOf(BEGIN), out.indexOf(END) + END.length));
  }
}
