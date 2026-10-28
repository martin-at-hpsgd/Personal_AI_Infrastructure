/**
 * LifeOS Pulse - Wiki Module
 *
 * Backend API for the Documentation, Knowledge, Skills, Hooks, and
 * Workflows views in Pulse.
 *
 * Route prefixes handled:
 *   GET /api/wiki
 *   GET /api/wiki/doc/:slug
 *   GET /api/wiki/knowledge/:domain/:slug
 *   GET /api/wiki/search?q=query
 *   GET /api/wiki/backlinks/:slug
 *   GET /api/wiki/graph
 *   GET /api/wiki/skills
 *   GET /api/wiki/skills/:name
 *   PUT /api/wiki/skills/:name
 *   GET /api/wiki/hooks
 *   GET /api/wiki/hooks/:name
 *   GET /api/wiki/workers
 *   GET /api/wiki/workers/:name
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path"
import {
  Dirent,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
  type Stats,
} from "fs"
import MiniSearch from "minisearch"
import { homedir } from "node:os";
import { invariant } from "../../TOOLS/Invariant.ts"

// Path Construction

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
const LIFEOS_DIR = join(HOME, ".claude", "LIFEOS")
const DOCUMENTATION_DIR = join(LIFEOS_DIR, "DOCUMENTATION")
const KNOWLEDGE_DIR = join(LIFEOS_DIR, "MEMORY", "KNOWLEDGE")
const ALGORITHM_DIR = join(LIFEOS_DIR, "ALGORITHM")
const SKILLS_DIR = join(HOME, ".claude", "skills")
const HOOKS_DIR = join(HOME, ".claude", "hooks")
const SETTINGS_PATH = join(HOME, ".claude", "settings.json")
const WORKERS_DIR = join(LIFEOS_DIR, "USER", "CUSTOMIZATIONS", "WORKFLOWS", "Workers")

const SYSTEM_PROMPT_PATH = join(LIFEOS_DIR, "LIFEOS_SYSTEM_PROMPT.md")
const KNOWLEDGE_DOMAINS = ["People", "Companies", "Ideas", "Blogs", "Books", "Research"] as const
type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number]

// Memory silos beyond KNOWLEDGE/ — indexed as first-class, searchable object
// types (2026-07-19 directive: the wiki is the whole memory system, not just
// the knowledge archive). FAILURES/ raw context dumps and REFLECTIONS jsonl
// stay out — their distilled essence already lands in the learning files.
const WORK_DIR = join(LIFEOS_DIR, "MEMORY", "WORK")
const LEARNING_DIR = join(LIFEOS_DIR, "MEMORY", "LEARNING")
const LEARNING_SUBDIRS = ["SYSTEM", "ALGORITHM", "SYNTHESIS"] as const
const WISDOM_DIR = join(LIFEOS_DIR, "MEMORY", "WISDOM")
const WISDOM_SUBDIRS = ["FRAMES", "PRINCIPLES", "META"] as const
const RESEARCH_DIR = join(LIFEOS_DIR, "MEMORY", "RESEARCH")

// Types

interface WikiPage {
  slug: string
  title: string
  category: string
  tags: string[]
  quality: number | null
  qualityInferred: boolean
  rating?: number
  lastModified: string
  wordCount: number
  wikilinks: string[]
  filePath: string
  group?: string
  related?: string[]
  author?: string
  source?: string
  sourceUrl?: string
  postDate?: string
}

interface TreeNode {
  label: string
  slug?: string
  category?: string
  children?: TreeNode[]
  count?: number
}

interface BacklinkEntry {
  slug: string
  title: string
  category: string
}

interface IndexOptions {
  category: string
  slug?: string
  group?: string
}

// State

const pageIndex: Map<string, WikiPage> = new Map()
const backlinkIndex: Map<string, BacklinkEntry[]> = new Map()
let searchIndex: MiniSearch<SearchDocument> | null = null
let moduleStartedAt: string | null = null
let lastIndexedAt: string | null = null

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

// Filesystem Helpers

function isMarkdownFile(name: string): boolean {
  return name.endsWith(".md") && !name.startsWith(".")
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, "")
}

function pathParts(pathValue: string): string[] {
  return pathValue.split(/[\\/]+/).filter(Boolean)
}

// GHSA-5f2j-98hm-rrcg, @elhoim: resolve URL segments and symlinks before serving files.
function containedPath(baseDir: string, ...segments: string[]): string | null {
  function realPathWithMissingTail(path: string): string {
    let current = path
    const tail: string[] = []
    while (true) {
      try {
        return resolve(realpathSync(current), ...tail)
      } catch {
        const parent = dirname(current)
        if (parent === current) return current
        tail.unshift(basename(current))
        current = parent
      }
    }
  }

  function inside(base: string, target: string): boolean {
    const rel = relative(base, target)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  const decoded: string[] = []
  for (const segment of segments) {
    if (!segment || segment.includes("\0")) return null
    let value = segment
    try {
      while (value.includes("%")) {
        const next = decodeURIComponent(value)
        if (next === value) break
        value = next
      }
    } catch {
      return null
    }
    if (!value || value.includes("\0") || isAbsolute(value)) return null
    decoded.push(value)
  }

  const base = resolve(baseDir)
  const target = resolve(base, ...decoded)
  if (!inside(base, target)) return null
  if (!inside(realPathWithMissingTail(base), realPathWithMissingTail(target))) return null
  return target
}

function walkMarkdown(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    // Underscore prefix = metadata/queue/scope-private by LifeOS convention
    // (KNOWLEDGE/_archive, WISDOM/FRAMES/_hypotheses) — never indexed.
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(entryPath))
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      files.push(entryPath)
    }
  }

  return files.sort((a, b) => naturalCollator.compare(a, b))
}

function systemDocMetadata(filePath: string): { slug: string; group: string } | null {
  if (filePath === SYSTEM_PROMPT_PATH) {
    return { slug: "LIFEOS_SYSTEM_PROMPT", group: "Overview" }
  }

  if (filePath.startsWith(DOCUMENTATION_DIR)) {
    const rel = relative(DOCUMENTATION_DIR, filePath)
    if (rel.startsWith("..")) return null

    const relParts = pathParts(rel)
    const filename = relParts[relParts.length - 1]
    const bareSlug = stripMarkdownExtension(filename)

    if (relParts.length === 1) {
      return { slug: bareSlug, group: "Overview" }
    }

    const group = relParts[relParts.length - 2]
    return { slug: `${group}__${bareSlug}`, group }
  }

  if (filePath.startsWith(ALGORITHM_DIR)) {
    const filename = basename(filePath)
    return {
      slug: `Algorithm__${stripMarkdownExtension(filename)}`,
      group: "Algorithm",
    }
  }

  return null
}

// Frontmatter Parser

function parseFrontmatter(
  content: string
): Record<string, string | string[] | number> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const result: Record<string, string | string[] | number> = {}
  const lines = match[1].split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const idx = line.indexOf(":")
    if (idx === -1) continue

    const key = line.substring(0, idx).trim()
    let value = line.substring(idx + 1).trim()
    if (line.startsWith(" ") || line.startsWith("\t") || !key) continue

    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
      continue
    }

    // Block sequence: key:\n  - slug: foo\n    type: bar
    if (value === "" && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      const arr: string[] = []
      let j = i + 1
      while (j < lines.length && /^\s+/.test(lines[j])) {
        const m = lines[j].match(/^\s+-\s+slug:\s*(.+)$/)
        if (m) arr.push(m[1].trim().replace(/^["']|["']$/g, ""))
        j++
      }
      if (arr.length > 0) {
        result[key] = arr
        i = j - 1
        continue
      }
    }

    if (key === "quality") {
      const num = parseInt(value, 10)
      if (!Number.isNaN(num)) {
        result[key] = num
        continue
      }
    }

    value = value.replace(/^["']|["']$/g, "")
    result[key] = value
  }

  return result
}

// Content Extraction

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

function extractTitle(
  content: string,
  fm: Record<string, unknown>,
  filename: string
): string {
  if (fm.title) return String(fm.title)
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()
  return stripMarkdownExtension(filename)
}

function normalizeWikilink(raw: string): string {
  const [target] = raw.split("|")
  const [slug] = target.split("#")
  return slug.trim()
}

function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  const links: string[] = []

  for (const match of matches) {
    const slug = normalizeWikilink(match[1])
    if (slug) links.push(slug)
  }

  return [...new Set(links)]
}

function countWords(content: string): number {
  const body = stripFrontmatter(content)
  return body.split(/\s+/).filter(Boolean).length
}

function stringArrayFromFrontmatter(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

// Index a Single File

interface IndexedFile {
  page: WikiPage
  // Search text from the same read that built the page, so a file is read once
  // per index pass. Held only until the pass hands it to MiniSearch.
  searchContent: string
}

function searchContentOf(raw: string): string {
  return stripFrontmatter(raw).slice(0, 5000)
}

function readSearchContent(filePath: string): string {
  try {
    return searchContentOf(readFileSync(filePath, "utf-8"))
  } catch {
    return ""
  }
}

function indexFile(filePath: string, options: IndexOptions, mtime: Date): IndexedFile | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const fm = parseFrontmatter(raw)
    const filename = basename(filePath)
    const slug = options.slug ?? stripMarkdownExtension(filename)

    const page: WikiPage = {
      slug,
      title: extractTitle(raw, fm, filename),
      category: options.category,
      tags: stringArrayFromFrontmatter(fm.tags),
      quality: typeof fm.quality === "number" ? fm.quality : null,
      qualityInferred: fm.quality_inferred === true || fm.quality_inferred === "true",
      rating: Number.isFinite(parseInt(String(fm.principal_rating ?? ""), 10)) ? parseInt(String(fm.principal_rating), 10) : undefined,
      lastModified: mtime.toISOString(),
      wordCount: countWords(raw),
      wikilinks: extractWikilinks(raw),
      filePath,
      group: options.group,
      related: stringArrayFromFrontmatter(fm.related),
      author: typeof fm.source_author === "string" ? fm.source_author : (typeof fm.author === "string" ? fm.author : undefined),
      source: typeof fm.source_name === "string" ? fm.source_name : (typeof fm.source === "string" ? fm.source : undefined),
      sourceUrl: typeof fm.source_url === "string" ? fm.source_url : undefined,
      postDate: typeof fm.source_date === "string" ? fm.source_date : (typeof fm.post_date === "string" ? fm.post_date : undefined),
    }
    return { page, searchContent: searchContentOf(raw) }
  } catch {
    return null
  }
}

// Index Manifest
//
// Every file the wiki covers, in the order a full build visits it. The order
// is load-bearing: when two files map to one slug the later file wins, and the
// page map keeps each slug at its first sighting, which fixes backlink, graph
// and equal-recency order. Listing needs readdir only; no file is opened.

interface IndexEntry {
  filePath: string
  options: IndexOptions
}

function relSlug(baseDir: string, filePath: string): string {
  return stripMarkdownExtension(relative(baseDir, filePath)).replace(/[\\/]+/g, "--")
}

function listSystemDocEntries(entries: IndexEntry[]): void {
  const add = (filePath: string): void => {
    const metadata = systemDocMetadata(filePath)
    if (!metadata) return
    entries.push({
      filePath,
      options: { category: "system-doc", slug: metadata.slug, group: metadata.group },
    })
  }

  add(SYSTEM_PROMPT_PATH)

  for (const filePath of walkMarkdown(DOCUMENTATION_DIR)) add(filePath)

  if (!existsSync(ALGORITHM_DIR)) return

  try {
    const algorithmFiles = readdirSync(ALGORITHM_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isMarkdownFile(entry.name))
      .map((entry) => join(ALGORITHM_DIR, entry.name))
      .sort((a, b) => naturalCollator.compare(a, b))

    for (const filePath of algorithmFiles) add(filePath)
  } catch {
    // Algorithm docs are optional when LifeOS is partially installed.
  }
}

function listKnowledgeEntries(entries: IndexEntry[]): void {
  const domainToCategory: Record<KnowledgeDomain, string> = {
    People: "person",
    Companies: "company",
    Ideas: "idea",
    Blogs: "blog",
    Books: "book",
    Research: "research",
  }

  for (const domain of KNOWLEDGE_DOMAINS) {
    const domainDir = join(KNOWLEDGE_DIR, domain)
    if (!existsSync(domainDir)) continue

    try {
      const files = readdirSync(domainDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")
        )
        .map((entry) => join(domainDir, entry.name))
        .sort((a, b) => naturalCollator.compare(a, b))

      for (const filePath of files) {
        entries.push({ filePath, options: { category: domainToCategory[domain] } })
      }
    } catch {
      // Skip unreadable knowledge domains.
    }
  }
}

// Memory silos beyond KNOWLEDGE/: WORK ISAs, LEARNING lessons, WISDOM, RESEARCH.
function listMemorySiloEntries(entries: IndexEntry[]): void {
  if (existsSync(WORK_DIR)) {
    try {
      for (const entry of readdirSync(WORK_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue
        entries.push({
          filePath: join(WORK_DIR, entry.name, "ISA.md"),
          options: { category: "isa", slug: entry.name },
        })
      }
    } catch {
      // Skip an unreadable WORK directory.
    }
  }

  for (const sub of LEARNING_SUBDIRS) {
    const dir = join(LEARNING_DIR, sub)
    for (const filePath of walkMarkdown(dir)) {
      entries.push({
        filePath,
        options: {
          category: "lesson",
          slug: `${sub}--${relSlug(dir, filePath)}`,
          group: sub.charAt(0) + sub.slice(1).toLowerCase(),
        },
      })
    }
  }

  for (const sub of WISDOM_SUBDIRS) {
    const dir = join(WISDOM_DIR, sub)
    for (const filePath of walkMarkdown(dir)) {
      entries.push({
        filePath,
        options: {
          category: "wisdom",
          slug: `${sub}--${relSlug(dir, filePath)}`,
          group: sub.charAt(0) + sub.slice(1).toLowerCase(),
        },
      })
    }
  }

  for (const filePath of walkMarkdown(RESEARCH_DIR)) {
    entries.push({
      filePath,
      options: { category: "research", slug: relSlug(RESEARCH_DIR, filePath) },
    })
  }
}

function listIndexEntries(): IndexEntry[] {
  const entries: IndexEntry[] = []
  listSystemDocEntries(entries)
  listKnowledgeEntries(entries)
  listMemorySiloEntries(entries)
  return entries
}

// Index Scan
//
// One pass over the manifest. Each file is stat'ed; a file whose mtime and size
// match the cache reuses its cached page object, anything else is read and
// re-indexed. Reused pages keep their object identity, which is how the
// incremental path tells which search documents changed.

interface CachedFile {
  page: WikiPage
  mtimeMs: number
  ctimeMs: number
  ino: number
  size: number
}

// Keyed by file path. A path's index options are derived from the path alone,
// so a matching stat means the cached page is still the page. mtime and size
// alone are not enough: cp -p, rsync -t, touch -r and restores keep the mtime,
// and a same-length rewrite keeps the size (Astra review, 2026-10-09). ctime
// cannot be set from user space and a replaced file gets a new inode.
let fileCache: Map<string, CachedFile> = new Map()
let lastScanStartedAtMs = 0

interface IndexScan {
  pages: Map<string, WikiPage>
  freshContent: Map<string, string>
  cache: Map<string, CachedFile>
  filesListed: number
  filesRead: number
}

function scanIndex(reuseCache: boolean): IndexScan {
  const pages: Map<string, WikiPage> = new Map()
  const freshContent: Map<string, string> = new Map()
  const cache: Map<string, CachedFile> = new Map()
  const entries = listIndexEntries()
  let filesRead = 0

  for (const { filePath, options } of entries) {
    let stat: Stats | undefined
    try {
      stat = statSync(filePath, { throwIfNoEntry: false })
    } catch {
      continue // Unreadable path (permissions): absent, as in a full build.
    }
    if (!stat) continue

    const cached = reuseCache ? fileCache.get(filePath) : undefined
    let page: WikiPage
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino && cached.size === stat.size) {
      page = cached.page
    } else {
      const indexed = indexFile(filePath, options, stat.mtime)
      filesRead++
      if (!indexed) continue
      page = indexed.page
      freshContent.set(filePath, indexed.searchContent)
    }

    cache.set(filePath, { page, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, size: stat.size })
    pages.set(page.slug, page)
  }

  return { pages, freshContent, cache, filesListed: entries.length, filesRead }
}

// Same slugs, same order, same page objects.
function samePages(a: Map<string, WikiPage>, b: Map<string, WikiPage>): boolean {
  if (a.size !== b.size) return false
  const bEntries = b.entries()
  for (const [slug, page] of a) {
    const next = bEntries.next()
    if (next.done || next.value[0] !== slug || next.value[1] !== page) return false
  }
  return true
}

function commitScan(scan: IndexScan, startedAtMs: number, pagesChanged: boolean): void {
  if (pagesChanged) {
    pageIndex.clear()
    for (const [slug, page] of scan.pages) pageIndex.set(slug, page)
    rebuildBacklinks()
  }
  invariant(searchIndex !== null, "wiki search index missing after an index pass")
  invariant(
    searchIndex.documentCount === pageIndex.size,
    `wiki search index holds ${searchIndex.documentCount} documents for ${pageIndex.size} pages`
  )
  fileCache = scan.cache
  lastScanStartedAtMs = startedAtMs
  lastIndexedAt = new Date().toISOString()
}

// Full Index Build (boot and /api/wiki/reindex)

function buildFullIndex(): IndexScan {
  const startedAtMs = Date.now()
  const scan = scanIndex(false)
  const docs: SearchDocument[] = []
  for (const page of scan.pages.values()) {
    const content = scan.freshContent.get(page.filePath)
    invariant(content !== undefined, `full wiki build has no search text for ${page.filePath}`)
    docs.push(searchDocument(page, content))
  }
  const index = createSearchIndex()
  index.addAll(docs)
  searchIndex = index
  commitScan(scan, startedAtMs, true)
  return scan
}

// Incremental Reconcile (file watcher and safety tick)
//
// A full build re-reads all ~20K pages and builds a second MiniSearch index
// beside the live one: ~1 GB of heap per run, which the allocator keeps mapped,
// so every markdown write ratcheted Pulse's RSS. Reconcile stats every file and
// reads only the ones that changed, then patches the live search index in
// place. The result matches a full build page for page.

export interface ReconcileResult {
  filesListed: number
  filesRead: number
  added: number
  replaced: number
  removed: number
  ms: number
  // Settles when the search index has dropped every posting left by a replaced
  // or removed page. Until then a term's document frequency still counts the
  // stale postings, so scores drift slightly from a full build's.
  searchCompaction: Promise<void>
}

// MiniSearch's replace and discard hide the old document at once but leave its
// postings in place; the vacuum walks the term index in small batches between
// event-loop turns, so search scoring returns to exactly a full build's.
function compactSearchIndex(index: MiniSearch<SearchDocument>): Promise<void> {
  if (index.dirtCount === 0) return Promise.resolve()
  return index.vacuum({ batchSize: 1000, batchWait: 10 }).catch((err: unknown) => {
    console.warn(`[wiki] search index vacuum failed (results stay correct, scores drift until the next full build): ${String(err)}`)
  })
}

export function reconcileIndex(): ReconcileResult {
  const startedAtMs = Date.now()
  if (!searchIndex) {
    const scan = buildFullIndex()
    return {
      filesListed: scan.filesListed,
      filesRead: scan.filesRead,
      added: pageIndex.size,
      replaced: 0,
      removed: 0,
      ms: Date.now() - startedAtMs,
      searchCompaction: Promise.resolve(),
    }
  }

  const scan = scanIndex(true)
  const index = searchIndex

  const gone: string[] = []
  for (const slug of pageIndex.keys()) {
    if (!scan.pages.has(slug)) gone.push(slug)
  }
  if (gone.length > 0) index.discardAll(gone)

  let added = 0
  let replaced = 0
  for (const [slug, page] of scan.pages) {
    const previous = pageIndex.get(slug)
    if (previous === page) continue
    // A slug can change hands to a file that was not re-read this pass (the
    // file that used to win a slug collision was deleted); read it here.
    const content = scan.freshContent.get(page.filePath) ?? readSearchContent(page.filePath)
    const doc = searchDocument(page, content)
    if (previous) {
      index.replace(doc)
      replaced++
    } else {
      index.add(doc)
      added++
    }
  }

  commitScan(scan, startedAtMs, !samePages(pageIndex, scan.pages))

  return {
    filesListed: scan.filesListed,
    filesRead: scan.filesRead,
    added,
    replaced,
    removed: gone.length,
    ms: Date.now() - startedAtMs,
    searchCompaction: compactSearchIndex(index),
  }
}

// Backlink Computation

function rebuildBacklinks(): void {
  backlinkIndex.clear()

  for (const page of pageIndex.values()) {
    for (const targetSlug of page.wikilinks) {
      if (!backlinkIndex.has(targetSlug)) {
        backlinkIndex.set(targetSlug, [])
      }

      backlinkIndex.get(targetSlug)!.push({
        slug: page.slug,
        title: page.title,
        category: page.category,
      })
    }
  }
}

// Search Index

interface SearchDocument {
  id: string
  title: string
  content: string
  tagsText: string
  category: string
  slug: string
  author?: string
  source?: string
  sourceUrl?: string
  postDate?: string
}

function createSearchIndex(): MiniSearch<SearchDocument> {
  return new MiniSearch<SearchDocument>({
    fields: ["title", "content", "tagsText", "author"],
    storeFields: ["title", "category", "slug", "author", "source", "sourceUrl", "postDate"],
    searchOptions: {
      boost: { title: 3, tagsText: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  })
}

function searchDocument(page: WikiPage, content: string): SearchDocument {
  return {
    id: page.slug,
    title: page.title,
    content,
    tagsText: page.tags.join(" "),
    category: page.category,
    slug: page.slug,
    author: page.author,
    source: page.source,
    sourceUrl: page.sourceUrl,
    postDate: page.postDate,
  }
}

// File Watcher

let watchers: ReturnType<typeof watch>[] = []
let reindexTimer: ReturnType<typeof setTimeout> | null = null

function startWatchers(): void {
  stopWatchers()

  // Watch only what buildPages actually reads. Watching all of LIFEOS_DIR was
  // both too broad and pointless: MEMORY/ is the busiest subtree in an install
  // (constant .jsonl appends) and the one place non-regular files appear —
  // sockets and FIFOs a recursive walk cannot open — while skills/ and hooks/
  // live outside LIFEOS/ and were never covered anyway. The system prompt is a
  // direct child of LIFEOS_DIR, so it gets a NON-recursive watch: it stays live
  // without the walk descending into MEMORY/. public PR #1683, @lmbagley
  const watchPaths: Array<{ path: string; recursive: boolean }> = [
    { path: DOCUMENTATION_DIR, recursive: true },
    { path: KNOWLEDGE_DIR, recursive: true },
    { path: ALGORITHM_DIR, recursive: true },
    { path: LIFEOS_DIR, recursive: false },
  ]

  for (const { path: watchPath, recursive } of watchPaths) {
    if (!existsSync(watchPath)) continue

    try {
      const watcher = watch(watchPath, { recursive }, (_event, filename) => {
        if (!filename) return
        const filenameText = String(filename)
        if (filenameText.endsWith(".md")) scheduleReindex()
      })

      // A recursive watch that meets a broken symlink or ELOOP under the tree
      // emits an ASYNC 'error' event the surrounding try/catch cannot reach —
      // unhandled, it crashes all of Pulse at boot (public issues #1186 and
      // #1568, @christauff).
      watcher.on("error", (err) => {
        console.warn(`[wiki] watch error on ${watchPath} (continuing, best-effort): ${String(err)}`)
      })

      watchers.push(watcher)
    } catch {
      // File watching is best-effort; manual refresh still rebuilds on restart.
    }
  }
}

function stopWatchers(): void {
  for (const watcher of watchers) {
    try {
      watcher.close()
    } catch {
      // Ignore close failures.
    }
  }

  watchers = []
}

let safetyTimer: ReturnType<typeof setInterval> | null = null
const SAFETY_INTERVAL_MS = 60_000

// Safety net for the recursive fs.watch above, which silently misses events on
// macOS and leaves a freshly written KNOWLEDGE note absent from the in-memory
// index until a full restart. This cheap tick reconciles ONLY when a KNOWLEDGE
// .md file is newer than the start of the last index pass, so a missed watcher
// event self-heals within a minute at near-zero idle cost.
function knowledgeMaxMtimeMs(): number {
  let max = 0
  for (const domain of KNOWLEDGE_DOMAINS) {
    const dir = join(KNOWLEDGE_DIR, domain)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        try {
          max = Math.max(max, statSync(join(dir, entry.name)).mtimeMs)
        } catch {
          // Skip unreadable entry.
        }
      }
    } catch {
      // Skip unreadable domain.
    }
  }
  return max
}

// Timer entry point. A throw from a timer callback would end the Pulse process, and a
// patch that failed halfway leaves the search index ahead of pageIndex, so every later
// pass would throw too. On any failure, log it loudly and rebuild both indexes from
// scratch, which restores a consistent state (Astra review, 2026-10-09).
function reconcileFromTimer(): void {
  try {
    reconcileIndex()
  } catch (err) {
    console.error(`[wiki] incremental reconcile failed, running a full rebuild: ${String(err)}`)
    try {
      buildFullIndex()
    } catch (fullErr) {
      console.error(`[wiki] full rebuild after a failed reconcile also failed: ${String(fullErr)}`)
    }
  }
}

function startSafetyRebuild(): void {
  stopSafetyRebuild()
  safetyTimer = setInterval(() => {
    if (knowledgeMaxMtimeMs() > lastScanStartedAtMs) reconcileFromTimer()
  }, SAFETY_INTERVAL_MS)
}

function stopSafetyRebuild(): void {
  if (safetyTimer) {
    clearInterval(safetyTimer)
    safetyTimer = null
  }
}

// The changed path is not trusted to be the only change (macOS drops watch
// events), so the debounced pass reconciles every indexed file by mtime.
// Continuous writes would keep resetting a plain debounce and postpone the pass forever,
// so a burst waits at most RECONCILE_MAX_WAIT_MS after its first event.
const RECONCILE_MAX_WAIT_MS = 5000
let firstPendingEventAt = 0

function scheduleReindex(): void {
  const now = Date.now()
  if (reindexTimer) {
    if (now - firstPendingEventAt >= RECONCILE_MAX_WAIT_MS) return // let the pending pass fire
    clearTimeout(reindexTimer)
  } else {
    firstPendingEventAt = now
  }
  const delay = Math.min(500, Math.max(0, firstPendingEventAt + RECONCILE_MAX_WAIT_MS - now))
  reindexTimer = setTimeout(() => {
    reindexTimer = null
    reconcileFromTimer()
  }, delay)
}

// Tree Builder

function treeLeaf(page: WikiPage): TreeNode {
  return {
    label: page.title,
    slug: page.slug,
    category: page.category,
  }
}

function sortedPages(pages: WikiPage[]): WikiPage[] {
  return [...pages].sort((a, b) => {
    const titleCompare = naturalCollator.compare(a.title, b.title)
    if (titleCompare !== 0) return titleCompare
    return naturalCollator.compare(a.slug, b.slug)
  })
}

function sortedGroupNames(groups: Record<string, WikiPage[]>): string[] {
  return Object.keys(groups).sort((a, b) => {
    if (a === "Overview") return -1
    if (b === "Overview") return 1
    return naturalCollator.compare(a, b)
  })
}

function buildTree(): TreeNode[] {
  const tree: TreeNode[] = []

  const systemDocs = [...pageIndex.values()].filter(
    (page) => page.category === "system-doc"
  )

  const systemNode: TreeNode = {
    label: "Documentation",
    children: [],
    count: systemDocs.length,
  }

  const groups: Record<string, WikiPage[]> = {}
  for (const page of systemDocs) {
    const group = page.group ?? "Other"
    if (!groups[group]) groups[group] = []
    groups[group].push(page)
  }

  for (const groupName of sortedGroupNames(groups)) {
    const pages = groups[groupName]
    systemNode.children!.push({
      label: groupName,
      count: pages.length,
      children: sortedPages(pages).map(treeLeaf),
    })
  }

  tree.push(systemNode)

  // recency: true sections (work + learning) sort newest-first — recency is
  // the natural browse order for time-stamped memory, not the alphabet.
  const domainMap: Array<{ category: string; label: string; recency?: boolean }> = [
    { category: "person", label: "People" },
    { category: "company", label: "Companies" },
    { category: "idea", label: "Ideas" },
    { category: "blog", label: "Blogs" },
    { category: "book", label: "Books" },
    { category: "research", label: "Research", recency: true },
    { category: "isa", label: "ISAs", recency: true },
    { category: "lesson", label: "Lessons", recency: true },
    { category: "wisdom", label: "Wisdom" },
  ]

  for (const { category, label, recency } of domainMap) {
    const pages = [...pageIndex.values()].filter((page) => page.category === category)
    const ordered = recency
      ? [...pages].sort(
          (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
        )
      : sortedPages(pages)
    tree.push({
      label,
      count: pages.length,
      children: ordered.map(treeLeaf),
    })
  }

  return tree
}

// Recent Changes

function getRecentChanges(limit = 20): WikiPage[] {
  return [...pageIndex.values()]
    .sort(
      (a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
    )
    .slice(0, limit)
}

// Stats

function getStats(): Record<string, number> {
  const pages = [...pageIndex.values()]
  return {
    totalPages: pages.length,
    totalSystem: pages.filter((page) => page.category === "system-doc").length,
    totalPeople: pages.filter((page) => page.category === "person").length,
    totalCompanies: pages.filter((page) => page.category === "company").length,
    totalIdeas: pages.filter((page) => page.category === "idea").length,
    totalBlogs: pages.filter((page) => page.category === "blog").length,
    totalBooks: pages.filter((page) => page.category === "book").length,
    totalResearch: pages.filter((page) => page.category === "research").length,
    totalIsas: pages.filter((page) => page.category === "isa").length,
    totalLessons: pages.filter((page) => page.category === "lesson").length,
    totalWisdom: pages.filter((page) => page.category === "wisdom").length,
  }
}

// Route Helpers

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function notFound(message: string): Response {
  return jsonResponse({ error: message }, 404)
}

function readPageContent(page: WikiPage): string {
  try {
    return readFileSync(page.filePath, "utf-8")
  } catch {
    return ""
  }
}

// Wiki Routes

function handleIndex(): Response {
  return jsonResponse({
    tree: buildTree(),
    recentChanges: getRecentChanges(),
    stats: getStats(),
    lastIndexedAt,
  })
}

function handleDoc(slug: string): Response {
  if (!containedPath(LIFEOS_DIR, slug)) return notFound(`Wiki page "${slug}" not found`)
  const page = pageIndex.get(slug)
  if (!page) {
    return notFound(`Wiki page "${slug}" not found`)
  }

  // Knowledge categories (person/company/idea/blog) get the full knowledge
  // shape — including related, tags, source — so MarkdownRenderer wikilinks
  // landing here render identically to the dedicated knowledge route.
  const knowledgeCategories = new Set([
    "person", "company", "idea", "blog", "book", "research", "isa", "lesson", "wisdom",
  ])
  if (knowledgeCategories.has(page.category)) {
    const related = (page.related ?? [])
      .map((relSlug) => {
        const target = pageIndex.get(relSlug)
        if (!target) return null
        return { slug: relSlug, title: target.title, category: target.category }
      })
      .filter((x): x is { slug: string; title: string; category: string } => x !== null)

    return jsonResponse({
      slug: page.slug,
      title: page.title,
      category: page.category,
      content: readPageContent(page),
      wordCount: page.wordCount,
      lastModified: page.lastModified,
      tags: page.tags,
      quality: page.quality,
      qualityInferred: page.qualityInferred,
      rating: page.rating,
      type: page.category,
      author: page.author,
      source: page.source,
      sourceUrl: page.sourceUrl,
      postDate: page.postDate,
      related,
      backlinks: backlinkIndex.get(slug) ?? [],
      wikilinks: page.wikilinks,
    })
  }

  return jsonResponse({
    slug: page.slug,
    title: page.title,
    category: page.category,
    content: readPageContent(page),
    wordCount: page.wordCount,
    lastModified: page.lastModified,
    group: page.group,
    backlinks: backlinkIndex.get(slug) ?? [],
    wikilinks: page.wikilinks,
  })
}

function handleKnowledgeNote(domain: string, slug: string): Response {
  if (!containedPath(KNOWLEDGE_DIR, domain, slug)) {
    return notFound(`Knowledge note "${domain}/${slug}" not found`)
  }
  const validDomains: Record<string, string> = {
    people: "person",
    companies: "company",
    ideas: "idea",
    blogs: "blog",
    books: "book",
    person: "person",
    company: "company",
    idea: "idea",
    blog: "blog",
    book: "book",
    research: "research",
    isa: "isa",
    isas: "isa",
    lesson: "lesson",
    lessons: "lesson",
    wisdom: "wisdom",
  }

  const category = validDomains[domain.toLowerCase()]
  if (!category) return notFound(`Invalid knowledge domain "${domain}"`)

  const page = pageIndex.get(slug)
  if (!page || page.category !== category) {
    return notFound(`Knowledge note "${domain}/${slug}" not found`)
  }

  // Resolve related slugs to {slug, title, category} where the target exists
  const related = (page.related ?? [])
    .map((relSlug) => {
      const target = pageIndex.get(relSlug)
      if (!target) return null
      return { slug: relSlug, title: target.title, category: target.category }
    })
    .filter((x): x is { slug: string; title: string; category: string } => x !== null)

  return jsonResponse({
    slug: page.slug,
    title: page.title,
    category: page.category,
    content: readPageContent(page),
    wordCount: page.wordCount,
    lastModified: page.lastModified,
    tags: page.tags,
    quality: page.quality,
    qualityInferred: page.qualityInferred,
    rating: page.rating,
    type: page.category,
    author: page.author,
    source: page.source,
    sourceUrl: page.sourceUrl,
    postDate: page.postDate,
    related,
    backlinks: backlinkIndex.get(slug) ?? [],
    wikilinks: page.wikilinks,
  })
}

function buildExcerpt(page: WikiPage, query: string): string {
  let body = ""

  try {
    body = stripFrontmatter(readFileSync(page.filePath, "utf-8"))
  } catch {
    body = ""
  }

  if (!body) return ""

  const lowerBody = body.toLowerCase()
  const lowerQuery = query.toLowerCase().split(/\s+/)[0] ?? ""
  const idx = lowerQuery ? lowerBody.indexOf(lowerQuery) : -1

  if (idx >= 0) {
    const start = Math.max(0, idx - 60)
    const end = Math.min(body.length, idx + 140)
    return (
      (start > 0 ? "..." : "") +
      body.slice(start, end).replace(/\n/g, " ").trim() +
      (end < body.length ? "..." : "")
    )
  }

  const excerpt = body.slice(0, 200).replace(/\n/g, " ").trim()
  return body.length > 200 ? `${excerpt}...` : excerpt
}

function handleSearch(query: string, limit = 20): Response {
  if (!searchIndex || !query.trim()) {
    return jsonResponse({ results: [] })
  }

  // Equal scores tie-break by slug. MiniSearch returns ties in posting order,
  // which depends on the order pages were added, so without this a reconciled
  // index and a fresh full build could rank the same tie differently. Scores
  // compare at 9 significant digits: an incrementally maintained index can
  // differ from a full build in the last float bits of a field-length average.
  const rankScore = (score: number): number => Number(score.toPrecision(9))
  const results = searchIndex
    .search(query)
    .sort((a, b) => rankScore(b.score) - rankScore(a.score) || naturalCollator.compare(String(a.id), String(b.id)))
    .slice(0, Math.max(1, Math.min(200, limit)))

  return jsonResponse({
    results: results.map((result) => {
      const page = pageIndex.get(String(result.id))
      return {
        slug: String(result.id),
        title: page?.title ?? String((result as any).title ?? result.id),
        category: page?.category ?? String((result as any).category ?? "unknown"),
        excerpt: page ? buildExcerpt(page, query) : "",
        score: result.score,
        author: page?.author,
        source: page?.source,
        sourceUrl: page?.sourceUrl,
        postDate: page?.postDate,
      }
    }),
  })
}

function handleBacklinks(slug: string): Response {
  if (!containedPath(LIFEOS_DIR, slug)) return notFound(`Wiki page "${slug}" not found`)
  return jsonResponse({ backlinks: backlinkIndex.get(slug) ?? [] })
}

function handleGraph(): Response {
  const nodes: Array<{
    id: string
    title: string
    category: string
    quality?: number | null
    backlinkCount: number
  }> = []

  const edgeSet: Set<string> = new Set()
  const edges: Array<{ source: string; target: string }> = []

  for (const [slug, page] of pageIndex) {
    nodes.push({
      id: slug,
      title: page.title,
      category: page.category,
      quality: page.quality,
      backlinkCount: backlinkIndex.get(slug)?.length ?? 0,
    })

    for (const target of page.wikilinks) {
      if (!pageIndex.has(target)) continue
      const key = `${slug}->${target}`
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push({ source: slug, target })
    }

    for (const target of page.related ?? []) {
      if (!pageIndex.has(target)) continue
      const key = `${slug}->${target}`
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push({ source: slug, target })
    }
  }

  return jsonResponse({ nodes, edges })
}

// Lifecycle

export function startWiki(): void {
  moduleStartedAt = new Date().toISOString()
  buildFullIndex()
  startWatchers()
  startSafetyRebuild()
}

export function stopWiki(): void {
  stopWatchers()
  stopSafetyRebuild()
  if (reindexTimer) {
    clearTimeout(reindexTimer)
    reindexTimer = null
  }
}

export function wikiHealth(): Record<string, unknown> {
  return {
    module: "wiki",
    startedAt: moduleStartedAt,
    lastIndexedAt,
    totalPages: pageIndex.size,
    watchersActive: watchers.length,
  }
}

// Skills Handlers

interface SkillMeta {
  name: string
  dir: string
  description: string
  effort: string
  hasIntents: boolean
  lastModified: string
}

function handleSkillsList(): Response {
  const skills: SkillMeta[] = []
  if (!existsSync(SKILLS_DIR)) return Response.json({ skills: [], total: 0 })

  for (const name of readdirSync(SKILLS_DIR).sort(naturalCollator.compare)) {
    const skillDir = join(SKILLS_DIR, name)
    const skillMd = join(skillDir, "SKILL.md")

    try {
      if (!statSync(skillDir).isDirectory()) continue
      if (!existsSync(skillMd)) continue

      const content = readFileSync(skillMd, "utf-8")
      const fm = parseFrontmatter(content)

      skills.push({
        name: String(fm.title || fm.name || name),
        dir: name,
        description: String(fm.description || ""),
        effort: String(fm.effort || "standard"),
        hasIntents: existsSync(join(skillDir, "Intents")),
        lastModified: statSync(skillMd).mtime.toISOString(),
      })
    } catch {
      continue
    }
  }

  skills.sort((a, b) => naturalCollator.compare(a.name, b.name))
  return Response.json({ skills, total: skills.length })
}

function handleSkillDetail(name: string): Response {
  const skillMd = containedPath(SKILLS_DIR, name, "SKILL.md")
  if (!skillMd || !existsSync(skillMd)) {
    return Response.json({ error: "Skill not found" }, { status: 404 })
  }

  const content = readFileSync(skillMd, "utf-8")
  const fm = parseFrontmatter(content)
  const stat = statSync(skillMd)

  return Response.json({
    name: String(fm.title || fm.name || name),
    description: String(fm.description || ""),
    effort: String(fm.effort || "standard"),
    content,
    filePath: skillMd,
    lastModified: stat.mtime.toISOString(),
    wordCount: countWords(content),
  })
}

async function handleSkillUpdate(name: string, req: Request): Promise<Response> {
  const skillMd = containedPath(SKILLS_DIR, name, "SKILL.md")
  if (!skillMd || !existsSync(skillMd)) {
    return Response.json({ error: "Skill not found" }, { status: 404 })
  }

  const body = (await req.json()) as { content?: unknown }
  if (typeof body.content !== "string" || !body.content) {
    return Response.json({ error: "Missing content field" }, { status: 400 })
  }

  writeFileSync(skillMd, body.content, "utf-8")
  return Response.json({ ok: true, updated: new Date().toISOString() })
}

// Hooks Handlers

interface HookEntry {
  event: string
  matcher: string
  type: string
  command: string
  fileName: string
}

function handleHooksList(): Response {
  const hooks: HookEntry[] = []
  if (!existsSync(SETTINGS_PATH)) {
    return Response.json({ hooks: [], total: 0, events: [] })
  }

  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"))
    const hookConfig = settings.hooks || {}

    for (const [event, handlers] of Object.entries(hookConfig)) {
      if (!Array.isArray(handlers)) continue

      for (const handler of handlers as Array<{
        matcher?: string
        hooks?: Array<{ type: string; command?: string; url?: string }>
      }>) {
        const matcher = handler.matcher || "*"
        if (!handler.hooks) continue

        for (const hook of handler.hooks) {
          const command = hook.command || hook.url || ""
          const fileName = command.split("/").pop() || command
          hooks.push({ event, matcher, type: hook.type, command, fileName })
        }
      }
    }
  } catch {
    return Response.json({ hooks: [], total: 0, events: [] })
  }

  const events = [...new Set(hooks.map((hook) => hook.event))].sort(
    naturalCollator.compare
  )
  return Response.json({ hooks, total: hooks.length, events })
}

function handleHookDetail(name: string): Response {
  let hookPath = containedPath(HOOKS_DIR, name)
  if (!hookPath || !existsSync(hookPath)) hookPath = containedPath(HOOKS_DIR, `${name}.hook.ts`)

  if (!hookPath || !existsSync(hookPath)) {
    return Response.json({ error: "Hook not found" }, { status: 404 })
  }

  const content = readFileSync(hookPath, "utf-8")
  const stat = statSync(hookPath)

  return Response.json({
    name: basename(hookPath),
    content,
    filePath: hookPath,
    lastModified: stat.mtime.toISOString(),
    size: stat.size,
  })
}

// Workflows Handlers

interface CloudWorker {
  name: string
  type: "action" | "pipeline" | "flow"
  cfName: string | null
  lastModified: string
}

function getWorkerType(name: string): "action" | "pipeline" | "flow" {
  if (name.startsWith("_A_")) return "action"
  if (name.startsWith("_P_")) return "pipeline"
  return "flow"
}

function handleWorkerList(): Response {
  const workers: CloudWorker[] = []
  if (!existsSync(WORKERS_DIR)) {
    return Response.json({
      workers: [],
      total: 0,
      actions: 0,
      pipelines: 0,
      flows: 0,
    })
  }

  for (const name of readdirSync(WORKERS_DIR).sort(naturalCollator.compare)) {
    const workerDir = join(WORKERS_DIR, name)

    try {
      if (!statSync(workerDir).isDirectory()) continue

      const configPath = ["cloudflare.config.ts", "wrangler.jsonc"].map((f) => join(workerDir, f)).find((p) => existsSync(p))
      let cfName: string | null = null

      if (configPath) {
        const raw = readFileSync(configPath, "utf-8")
        const nameMatch = raw.match(/\bname\s*:\s*["']([^"']+)["']/) ?? raw.match(/"name"\s*:\s*"([^"]+)"/)
        if (nameMatch) cfName = nameMatch[1]
      }

      workers.push({
        name,
        type: getWorkerType(name),
        cfName,
        lastModified: statSync(workerDir).mtime.toISOString(),
      })
    } catch {
      continue
    }
  }

  workers.sort((a, b) => naturalCollator.compare(a.name, b.name))

  return Response.json({
    workers,
    total: workers.length,
    actions: workers.filter((worker) => worker.type === "action").length,
    pipelines: workers.filter((worker) => worker.type === "pipeline").length,
    flows: workers.filter((worker) => worker.type === "flow").length,
  })
}

function handleWorkerDetail(name: string): Response {
  const workerDir = containedPath(WORKERS_DIR, name)
  if (!workerDir || !existsSync(workerDir)) {
    return Response.json({ error: "Worker not found" }, { status: 404 })
  }

  const wranglerPath =
    [containedPath(WORKERS_DIR, name, "cloudflare.config.ts"), containedPath(WORKERS_DIR, name, "wrangler.jsonc")].find(
      (p): p is string => !!p && existsSync(p),
    ) ?? null
  const srcPath = containedPath(WORKERS_DIR, name, "src", "index.ts")

  let wranglerContent: string | null = null
  let srcContent: string | null = null

  if (wranglerPath && existsSync(wranglerPath)) {
    wranglerContent = readFileSync(wranglerPath, "utf-8")
  }
  if (srcPath && existsSync(srcPath)) {
    srcContent = readFileSync(srcPath, "utf-8")
  }

  if (!wranglerContent && !srcContent) {
    return Response.json({ error: "No readable files in worker" }, { status: 404 })
  }

  return Response.json({
    name,
    type: getWorkerType(name),
    wrangler: wranglerContent,
    source: srcContent,
    lastModified: statSync(workerDir).mtime.toISOString(),
  })
}

// Request Router

export async function handleWikiRequest(
  req: Request,
  pathname: string
): Promise<Response | null> {
  if (pathname === "/api/wiki/reindex") {
    buildFullIndex()
    return jsonResponse({ ok: true, pages: pageIndex.size, indexedAt: lastIndexedAt })
  }

  if (req.method !== "GET" && req.method !== "PUT") return null

  if (pathname === "/api/wiki") {
    return handleIndex()
  }

  if (pathname === "/api/wiki/skills") {
    return handleSkillsList()
  }

  const skillMatch = pathname.match(/^\/api\/wiki\/skills\/(.+)$/)
  if (skillMatch) {
    const skillName = decodeURIComponent(skillMatch[1])
    if (req.method === "PUT") return handleSkillUpdate(skillName, req)
    return handleSkillDetail(skillName)
  }

  if (pathname === "/api/wiki/hooks") {
    return handleHooksList()
  }

  const hookMatch = pathname.match(/^\/api\/wiki\/hooks\/(.+)$/)
  if (hookMatch) {
    return handleHookDetail(decodeURIComponent(hookMatch[1]))
  }

  if (pathname === "/api/wiki/workers") {
    return handleWorkerList()
  }

  const workerMatch = pathname.match(/^\/api\/wiki\/workers\/(.+)$/)
  if (workerMatch) {
    return handleWorkerDetail(decodeURIComponent(workerMatch[1]))
  }

  if (pathname === "/api/wiki/search") {
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10) || 20
    return handleSearch(url.searchParams.get("q") ?? "", limit)
  }

  if (pathname === "/api/wiki/graph") {
    return handleGraph()
  }

  const backlinksMatch = pathname.match(/^\/api\/wiki\/backlinks\/(.+)$/)
  if (backlinksMatch) {
    return handleBacklinks(decodeURIComponent(backlinksMatch[1]))
  }

  const knowledgeMatch = pathname.match(
    /^\/api\/wiki\/knowledge\/([^/]+)\/(.+)$/
  )
  if (knowledgeMatch) {
    return handleKnowledgeNote(
      decodeURIComponent(knowledgeMatch[1]),
      decodeURIComponent(knowledgeMatch[2])
    )
  }

  const docMatch = pathname.match(/^\/api\/wiki\/doc\/(.+)$/)
  if (docMatch) {
    return handleDoc(decodeURIComponent(docMatch[1]))
  }

  return null
}
