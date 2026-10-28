#!/usr/bin/env bun
/**
 * BuildFictionCorpus.ts — turn public-domain story collections into a per-story
 * corpus plus the manifest BuildVoiceProfile.ts reads.
 *
 * The corpus is the positive model for fiction prose: what human short fiction
 * measures like, so a draft can be compared against real writing rather than
 * against a ban list. Sources are Project Gutenberg plain-text books (one file per
 * collection); each story becomes `<slug>.md` with a small frontmatter, and
 * `Corpus.md` lists every story in the format the local manifest parser expects
 * (`corpus_root:` + a table with `| n | \`slug\` |` rows).
 *
 * Usage:
 *   bun BuildFictionCorpus.ts --config <Corpus.json> [--fetch]
 *
 * Corpus.json:
 *   { "root": "<dir>", "books": [ { "id": 2814, "author": "James Joyce", "title": "Dubliners",
 *       "skip": ["Introduction"], "anchor": false } ] , "anchor": "<slug>" }
 *
 * `--fetch` downloads `pg<id>.txt` into `<root>/raw/` when absent. Stories under
 * 900 words are dropped (the long-form register is the one being modeled).
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";

type Book = { id: number; author: string; title: string; skip?: string[]; anchorStory?: string };
type Config = { root: string; books: Book[]; anchor?: string };

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? "");

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Reserve a slug that no earlier story in this build took: a repeated heading (a multi-part story whose part numbers headingOf strips) gets -2, -3, … so no file overwrites another. */
export function uniqueSlug(slug: string, used: Set<string>): string {
  let out = slug;
  for (let n = 2; used.has(out); n++) out = `${slug}-${n}`;
  used.add(out);
  return out;
}

/** Strip the Gutenberg header/footer and normalise line endings. */
export function body(raw: string): string {
  const t = raw.replace(/\r/g, "");
  const s = t.search(/^\*\*\* START OF .*\*\*\*$/m);
  const e = t.search(/^\*\*\* END OF .*\*\*\*$/m);
  const inner = t.slice(s >= 0 ? t.indexOf("\n", s) + 1 : 0, e >= 0 ? e : undefined);
  return inner;
}

/** Titles from the Contents block: the non-blank lines after a `Contents` line until a blank gap of 2+. */
export function contents(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*contents\s*$/i.test(l));
  if (start < 0) throw new Error("no Contents line");
  const out: string[] = [];
  let blanks = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { blanks++; if (out.length && blanks >= 2) break; continue; }
    blanks = 0;
    out.push(l);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"’']/g, "").replace(/\s+/g, " ").replace(/\.$/, "").trim();

/** Winesburg lists `HANDS, concerning Wing Biddlebaum`; the heading in the body is `HANDS`. */
const headingOf = (title: string) => title.replace(/[,”"]*\s*concerning .*$/i, "").replace(/^[“"]+/, "").replace(/\s*\(Parts? [IVX]+\)\s*/i, " ").trim();

export function split(text: string, titles: string[]): { title: string; text: string }[] {
  const lines = text.split("\n");
  const contentsIdx = lines.findIndex((l) => /^\s*contents\s*$/i.test(l));
  const afterContents = contentsIdx + titles.length + 1;
  const marks: { title: string; line: number }[] = [];
  let from = afterContents;
  for (const title of titles) {
    const want = norm(headingOf(title));
    let found = -1;
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]) === want) { found = i; break; }
    }
    if (found < 0) { console.error(`  heading not found: ${title}`); continue; }
    marks.push({ title, line: found });
    from = found + 1;
  }
  return marks.map((m, i) => ({
    title: m.title,
    text: lines.slice(m.line + 1, marks[i + 1]?.line ?? lines.length).join("\n").trim(),
  }));
}

/** Gutenberg wraps at ~70 columns; join wrapped lines back into paragraphs. */
export function unwrap(t: string): string {
  return t.split(/\n{2,}/).map((p) => p.split("\n").map((l) => l.trim()).join(" ").trim()).filter(Boolean).join("\n\n");
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

if (import.meta.main) {
  const cfgPath = arg("--config");
  if (!cfgPath) { console.error("usage: BuildFictionCorpus.ts --config <Corpus.json> [--fetch]"); process.exit(2); }
  const cfg: Config = JSON.parse(readFileSync(expand(cfgPath), "utf8"));
  const root = expand(cfg.root);
  mkdirSync(`${root}/raw`, { recursive: true });
  const rows: { slug: string; title: string; author: string; book: string; words: number }[] = [];
  const usedSlugs = new Set<string>();
  for (const b of cfg.books) {
    const rawPath = `${root}/raw/${b.id}.txt`;
    if (!existsSync(rawPath)) {
      if (!process.argv.includes("--fetch")) throw new Error(`missing ${rawPath} (pass --fetch)`);
      const r = await fetch(`https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.txt`);
      if (!r.ok) throw new Error(`fetch ${b.id}: ${r.status}`);
      writeFileSync(rawPath, await r.text());
    }
    const text = body(readFileSync(rawPath, "utf8"));
    const titles = contents(text).filter((t) => !(b.skip ?? []).some((s) => norm(t).startsWith(norm(s))));
    console.error(`${b.title}: ${titles.length} titles`);
    for (const s of split(text, titles)) {
      const prose = unwrap(s.text);
      const n = words(prose);
      if (n < 900) { console.error(`  drop (${n}w): ${s.title}`); continue; }
      const slug = uniqueSlug(slugify(headingOf(s.title)), usedSlugs);
      const fm = `---\ntitle: "${headingOf(s.title).replace(/"/g, "'")}"\nauthor: "${b.author}"\nbook: "${b.title}"\ngutenberg: ${b.id}\nwords: ${n}\n---\n\n`;
      writeFileSync(`${root}/${slug}.md`, fm + prose + "\n");
      rows.push({ slug, title: headingOf(s.title), author: b.author, book: b.title, words: n });
    }
  }
  const manifest = [
    "---", "version: 1.0.0", `corpus_root: ${root}`, ...(cfg.anchor ? [`anchor: ${cfg.anchor}`] : []),
    `generated: ${new Date().toISOString()}`, "---", "",
    "# Fiction Voice Corpus", "",
    "Public-domain short fiction by human authors, the positive model for story prose.",
    "Built by `skills/WriteStory/Tools/BuildFictionCorpus.ts` from `Corpus.json`; bands in",
    "`VoiceProfile.json` via `WriteStory/Tools/BuildVoiceProfile.ts --manifest` on this file.", "",
    "| # | Slug | Title | Author | Book | Words |", "|---|---|---|---|---|---|",
    ...rows.map((r, i) => `| ${i + 1} | \`${r.slug}\` | ${r.title} | ${r.author} | ${r.book} | ${r.words} |`), "",
  ].join("\n");
  writeFileSync(`${root}/Corpus.md`, manifest);
  console.error(`${rows.length} stories, ${rows.reduce((a, r) => a + r.words, 0)} words → ${root}/Corpus.md`);
}
