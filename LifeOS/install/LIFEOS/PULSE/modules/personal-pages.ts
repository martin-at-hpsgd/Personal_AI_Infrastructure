// modules/personal-pages.ts — Personal pages: standalone HTML served from the USER tree.
//
//   GET /p          → an index of every personal page
//   GET /p/<slug>   → USER/PULSE/pages/<slug>.html, served as-is
//
// These are the principal's OWN pages — a home for a private project, a note, a dashboard
// that isn't a system surface. The content lives under LIFEOS/USER/PULSE/pages/ (the USER
// tree, excluded from the public release), so nothing here ships; this module is a generic,
// empty-by-default server. Drop an .html file in that directory and it appears at /p — no
// code change, no nav edit. Reachable over loopback and the private tailnet (so the phone
// can open it); it serves only static HTML and holds no secret.
//
// Not in the public nav manifest on purpose: personal pages are reached from /p, not the
// system nav. Static content only — no scripts are required and the files are the principal's.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

const PAGES_DIR = join(import.meta.dir, "..", "..", "USER", "PULSE", "pages")
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** Pull a human title out of a page: its <title>, else its first <h1>, else the slug. */
function titleOf(html: string, slug: string): string {
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
  if (t) return t
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim()
  return h1 || slug
}

export interface PageEntry { slug: string; title: string; updated: string }

/** Every personal page on disk, newest first. */
export function listPages(): PageEntry[] {
  if (!existsSync(PAGES_DIR)) return []
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => {
      const slug = f.slice(0, -5)
      const path = join(PAGES_DIR, f)
      let title = slug
      try { title = titleOf(readFileSync(path, "utf8"), slug) } catch {}
      return { slug, title, updated: statSync(path).mtime.toISOString() }
    })
    .filter((e) => SLUG.test(e.slug))
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

function indexHtml(): string {
  const rows = listPages()
  const items = rows.length
    ? rows.map((p) => `    <li><a href="/p/${esc(p.slug)}">${esc(p.title)}</a> <span class="when">${esc(p.updated.slice(0, 10))}</span></li>`).join("\n")
    : `    <li class="empty">No personal pages yet. Drop an .html file in <code>LIFEOS/USER/PULSE/pages/</code>.</li>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal pages</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #090c12; color: #e7edf5; font: 16px/1.6 -apple-system, system-ui, sans-serif; padding: 2rem 1.25rem; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.1rem; letter-spacing: .14em; text-transform: uppercase; color: #7cc5ff; margin: 0 0 1.25rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .85rem 1rem; background: #111722; border: 1px solid #1d2635; border-radius: 10px; margin-bottom: .6rem; display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
  a { color: #e7edf5; text-decoration: none; font-weight: 600; }
  a:hover { color: #7cc5ff; }
  .when { color: #6b7a90; font-size: .8rem; font-variant-numeric: tabular-nums; }
  .empty { color: #8a98ac; font-weight: 400; display: block; }
  code { background: #0c1119; padding: .1rem .35rem; border-radius: 4px; color: #f5b942; }
</style></head><body><main>
  <h1>Personal pages</h1>
  <ul>
${items}
  </ul>
</main></body></html>`
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "GET") return null
  if (pathname === "/p" || pathname === "/p/") {
    return new Response(indexHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
  }
  const m = pathname.match(/^\/p\/([^/]+)$/)
  if (!m) return null
  const slug = decodeURIComponent(m[1])
  if (!SLUG.test(slug)) return new Response("not found", { status: 404 })
  const path = join(PAGES_DIR, `${slug}.html`)
  if (!path.startsWith(PAGES_DIR) || !existsSync(path)) return new Response("not found", { status: 404 })
  return new Response(readFileSync(path, "utf8"), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
}
