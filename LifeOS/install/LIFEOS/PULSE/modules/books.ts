/**
 * Books Pulse module — read-only surface over USER/BOOKS.md (the principal's favorite books).
 * Holds ZERO data: parses the USER file on each request and serves it. The dashboard
 * page renders whatever this returns.
 *
 * Route: GET /api/books → { count, lastUpdated, groups: [{ category, books:[…] }] }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODULE_NAME = "books";
const USER_DIR = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "LIFEOS", "USER");
// USER/BOOKS.md is the pseudo-YAML store; the install scaffold ships only
// USER/TELOS/BOOKS.md, so that is the fallback. (public issue #1960, @hjbrandt)
const BOOKS_PATHS = [join(USER_DIR, "BOOKS.md"), join(USER_DIR, "TELOS", "BOOKS.md")];
const state = { running: false };

interface Book {
  title: string;
  author?: string;
  year?: number;
  rating?: number;
  themes?: string[];
  canonical?: boolean;
}
interface Group { category: string; books: Book[] }

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** Parse the pseudo-YAML BOOKS.md into category groups. Tolerant; ignores prose sections. */
export function parseBooks(md: string): { groups: Group[]; lastUpdated: string | null } {
  const groups = new Map<string, Book[]>();
  let category = "Uncategorized";
  let cur: Book | null = null;
  // A file with no `- title:` rows (the TELOS/BOOKS.md scaffold) is plain
  // bullets: each `- Title — note` bullet is a title, H2/H3 the category.
  // A file with any `- title:` row keeps the strict parse. (public issue #1960, @hjbrandt)
  const plain = !/^-\s+title:/m.test(md);
  const flush = () => {
    if (cur && cur.title) {
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(cur);
    }
    cur = null;
  };
  let lastUpdated: string | null = null;

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const lu = line.match(/^last_updated:\s*(.+)$/);
    if (lu) lastUpdated = unquote(lu[1]);
    const h = line.match(plain ? /^#{2,3}\s+(.+)/ : /^##\s+(.+)/);
    if (h) { flush(); category = h[1].trim(); continue; }
    const t = line.match(plain ? /^-\s+(.+?)(?:\s+[—–-]\s.*)?$/ : /^-\s+title:\s*(.+)$/);
    if (t) { flush(); cur = { title: unquote(t[1]) }; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s+(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    const v = vRaw.trim();
    if (k === "author") cur.author = unquote(v);
    else if (k === "year") cur.year = parseInt(v, 10) || undefined;
    else if (k === "rating") cur.rating = parseInt(v, 10) || undefined;
    else if (k === "themes") cur.themes = v.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s)).filter(Boolean);
    else if (k === "canonical") cur.canonical = v === "true";
  }
  flush();

  // Keep only groups that actually hold books (drops Daemon/Cross-reference prose).
  const out: Group[] = [...groups.entries()].filter(([, b]) => b.length > 0).map(([c, b]) => ({ category: c, books: b }));
  return { groups: out, lastUpdated };
}

function read(): { count: number; lastUpdated: string | null; groups: Group[] } {
  const path = BOOKS_PATHS.find((p) => existsSync(p));
  if (!path) return { count: 0, lastUpdated: null, groups: [] };
  const { groups, lastUpdated } = parseBooks(readFileSync(path, "utf8"));
  return { count: groups.reduce((n, g) => n + g.books.length, 0), lastUpdated, groups };
}

export async function start(): Promise<void> {
  state.running = true;
  console.log(`[${MODULE_NAME}] started`);
}
export async function stop(): Promise<void> {
  state.running = false;
}
export function health(): { status: string; details?: Record<string, unknown> } {
  let count = 0;
  try { count = read().count; } catch { /* ignore */ }
  return { status: state.running ? "healthy" : "stopped", details: { books: count } };
}
export async function handleRequest(_req: Request, pathname: string): Promise<Response | null> {
  const sub = pathname.replace(/^\/api\/books/, "") || "/";
  if (sub === "/" || sub === "/list") return Response.json(read());
  if (sub === "/status" || sub === "/health") return Response.json(health());
  return null;
}
