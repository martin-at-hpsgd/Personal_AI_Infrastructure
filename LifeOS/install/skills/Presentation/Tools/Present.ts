#!/usr/bin/env bun
/**
 * Present.ts — serve a template deck locally for presenting and editing.
 *
 * Usage:  bun Present.ts --dir <deck-directory> [--port 7345] [--deck deck.html]
 * Then:   open the printed URL. F = fullscreen (external display),
 *         S = speaker view (notes, next slide, timer on the laptop),
 *         E = edit mode (Keynote-style in-place editing; Done/⌘S saves).
 *
 * POST /save writes edited sections back into the deck file between the
 * <!-- SLIDES:START --> / <!-- SLIDES:END --> markers (atomic tmp+rename).
 * Binds 127.0.0.1 only — never exposes the editor on venue wifi — and /save
 * refuses cross-origin writes (JSON content type, loopback Host and Origin).
 * Serving over HTTP (not file://) keeps the speaker-view popup and
 * cross-window sync reliable in Chrome.
 */
import { resolve } from "path";
import { renameSync } from "fs";

const args = Bun.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const port = Number(flag("port", "7345"));
const deck = flag("deck", "deck.html");
const root = resolve(flag("dir", process.cwd()));

const types: Record<string, string> = {
  html: "text/html", css: "text/css", js: "text/javascript",
  png: "image/png", webp: "image/webp", svg: "image/svg+xml",
  woff: "font/woff", woff2: "font/woff2", json: "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/save") {
      // Loopback binding alone does not stop a web page in the same browser
      // from POSTing here. Require a JSON content type (a cross-site request
      // must then pass a CORS preflight this server never grants) and a
      // loopback Host and Origin (blocks DNS rebinding).
      const local = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      const origin = req.headers.get("origin");
      const ctype = req.headers.get("content-type") ?? "";
      if (
        !local.has(req.headers.get("host") ?? "") ||
        (origin !== null && !local.has(origin.replace(/^http:\/\//, ""))) ||
        !ctype.toLowerCase().startsWith("application/json")
      ) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
      try {
        const { html } = (await req.json()) as { html?: unknown };
        if (typeof html !== "string" || !html.includes("<section")) {
          return json({ ok: false, error: "bad payload" }, 400);
        }
        const deckPath = `${root}/${deck}`;
        const cur = await Bun.file(deckPath).text();
        const START = "<!-- SLIDES:START -->";
        const END = "<!-- SLIDES:END -->";
        const s = cur.indexOf(START);
        const e = cur.lastIndexOf(END);
        if (s === -1 || e === -1 || e < s) {
          return json({ ok: false, error: "SLIDES markers missing in deck file" }, 500);
        }
        const next = cur.slice(0, s + START.length) + "\n\n    " + html + "\n\n    " + cur.slice(e);
        const tmp = `${deckPath}.tmp`;
        await Bun.write(tmp, next);
        renameSync(tmp, deckPath);
        return json({ ok: true, bytes: next.length });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    let path = decodeURIComponent(url.pathname);
    if (path.includes("..")) return new Response("bad path", { status: 400 });
    if (path === "/") path = `/${deck}`;
    const file = Bun.file(`${root}${path}`);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const ext = path.split(".").pop() ?? "";
    return new Response(file, {
      headers: {
        "content-type": types[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  },
});

console.log(`Deck: http://localhost:${port}/  (F = fullscreen, S = speaker view, E = edit)`);
console.log(`Serving: ${root}`);
