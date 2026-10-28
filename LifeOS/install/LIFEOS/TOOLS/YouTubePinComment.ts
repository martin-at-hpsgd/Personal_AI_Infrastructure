#!/usr/bin/env bun
/**
 * YouTubePinComment.ts — post a comment on a YouTube video AS THE CHANNEL and pin it,
 * through the Interceptor test profile (signed in as the channel). Pinning has no
 * Data API endpoint, so this is the only deterministic path (2026-09-07).
 *
 * Usage:
 *   bun YouTubePinComment.ts --id <videoId> --text "<t>"          post + pin + verify
 *   bun YouTubePinComment.ts --id <videoId> --text "<t>" --pin-only  pin an existing
 *       channel comment whose textOriginal === <t> (no new post)
 *   bun YouTubePinComment.ts --id <videoId> --text "<t>" --pin-only --comment-id <id>
 *       pin that exact channel comment (when the channel has several with the same text)
 *   bun YouTubePinComment.ts --id <videoId> --check                  report the thread
 *
 * The expected channel is --channel <UC…> or YOUTUBE_CHANNEL_ID. Gates, in order, all before
 * anything is posted or pinned: EnsureTestProfile preflight; the video must belong to the
 * expected channel (Data API); the channel the browser session is ACTING AS must be the
 * expected channel (YouTube Studio redirects to /channel/<active UC id>; the page's own ytcfg
 * CHANNEL_ID, when present, must agree); the watch page must report ytcfg LOGGED_IN.
 * Read-back via the public commentThreads API requires author channel id === expected channel
 * and exact text, and in post mode a comment id that was not there before the post. The pin
 * step finds the thread whose top-level comment's own permalink (its published-time link,
 * never a link inside the comment text) carries this video id and that comment id, requires
 * that comment's author link to be the expected channel (/channel/<UC id> or its @handle),
 * re-checks the exact text, and finds the thread again by the same rules to read the pinned
 * badge (S119). Any API error, non-2xx status or malformed response is a failure (S120),
 * never an empty thread. Exit 0 ok · 1 gate/verify/API failure · 2 bad input.
 */
import { join } from "node:path";
import { getClaudeDir } from "./Paths";
import { invariant } from "./Invariant";

export type Comment = { id: string; authorChannelId: string; author: string; text: string };

const API = "https://www.googleapis.com/youtube/v3";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const COMMENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

class ApiError extends Error {}

async function apiGet(path: string, params: Record<string, string>, key: string): Promise<any> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ApiError(`${path}: request failed: ${(e as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body)?.error?.message ?? msg; } catch { /* keep raw */ }
    throw new ApiError(`${path}: HTTP ${res.status}: ${msg}`);
  }
  try { return JSON.parse(body); } catch { throw new ApiError(`${path}: unparseable response body`); }
}

/** Shape-check a commentThreads response. Throws on anything that is not a valid list. */
export function parseThreads(j: any): Comment[] {
  if (!j || typeof j !== "object" || !Array.isArray(j.items)) throw new ApiError("commentThreads: response has no items array");
  return j.items.map((t: any, i: number): Comment => {
    const s = t?.snippet?.topLevelComment?.snippet;
    const c = { id: t?.id, authorChannelId: s?.authorChannelId?.value, author: s?.authorDisplayName, text: s?.textOriginal };
    if (typeof c.id !== "string" || typeof c.authorChannelId !== "string" || typeof c.text !== "string") {
      throw new ApiError(`commentThreads: malformed item ${i}`);
    }
    return { ...c, author: typeof c.author === "string" ? c.author : "" };
  });
}

/** Shape-check a videos response and return the owning channel id. */
export function parseVideoOwner(j: any): string {
  if (!j || typeof j !== "object" || !Array.isArray(j.items)) throw new ApiError("videos: response has no items array");
  if (j.items.length === 0) throw new ApiError("videos: video not found");
  const ch = j.items[0]?.snippet?.channelId;
  if (typeof ch !== "string" || !ch) throw new ApiError("videos: malformed item (no snippet.channelId)");
  return ch;
}

/**
 * Pick the one comment to pin. Author channel id must equal the expected channel and the
 * text must be exact; in post mode the id must be new since the pre-post snapshot.
 * Returns the comment, or a reason string when there is no unambiguous match.
 */
export function pickComment(thread: Comment[], o: { channel: string; text: string; exclude?: Set<string>; commentId?: string }): Comment | string {
  const c = thread.filter((t) => t.authorChannelId === o.channel && t.text === o.text && !o.exclude?.has(t.id) && (!o.commentId || t.id === o.commentId));
  if (c.length === 1) return c[0];
  if (c.length === 0) return "no comment by the expected channel with the exact text";
  return `ambiguous: ${c.length} channel comments match (${c.map((t) => t.id).join(", ")}); pass --comment-id`;
}

/**
 * Page-side identity probe, run in a tab opened on https://studio.youtube.com/. Studio
 * redirects to /channel/<UC id> of the channel the session is acting as. It waits up to
 * about 10 s for that redirect, then reports where the tab is and the page's CHANNEL_ID.
 */
export const ACTIVE_CHANNEL_SCRIPT = `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<20&&!/^\\/channel\\/UC/.test(location.pathname);i++) await sleep(500);
  let c=null; try{c=window.ytcfg?.get?.("CHANNEL_ID")??null}catch{c=null}
  return JSON.stringify({host:location.host, path:location.pathname, ytcfgChannel: typeof c==="string"&&c?c:null}); })()`;

/**
 * Decide the acting channel from the identity probe: the UC id, or a reason to refuse.
 * Only the exact studio.youtube.com host with a /channel/<UC id> path counts; a page-side
 * CHANNEL_ID that is present and different is a refusal.
 */
export function parseActiveChannel(p: any): { channel: string } | { reason: string } {
  if (!p || typeof p !== "object") return { reason: "identity probe returned nothing" };
  if (p.host !== "studio.youtube.com") return { reason: `identity probe landed on ${JSON.stringify(p.host)}, not studio.youtube.com (signed out?)` };
  const m = typeof p.path === "string" ? /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(p.path) : null;
  if (!m) return { reason: `Studio did not open a channel page (path ${JSON.stringify(p.path)}); the session has no active channel` };
  if (p.ytcfgChannel !== null && p.ytcfgChannel !== undefined && p.ytcfgChannel !== m[1]) {
    return { reason: `Studio URL says ${m[1]} but the page reports ${JSON.stringify(p.ytcfgChannel)}` };
  }
  return { channel: m[1] };
}

export type PinTarget = { videoId: string; channelId: string; handle: string };

/**
 * The page-side pin script. A thread counts only when its top-level comment (the one #comment
 * outside #replies) has exactly one header permalink (#published-time-text) whose v= is the
 * video and lc= is the comment id; links inside the comment text never count. That comment's
 * author link must be /channel/<expected UC id> or /<expected @handle> on youtube.com, and its
 * text must be exact, before the menu is opened. After Pin the thread is found again by the
 * same rules (YouTube re-renders and recycles elements) and the badge is read there.
 */
export function pinScript(commentId: string, text: string, who: PinTarget): string {
  const j = JSON.stringify;
  return `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
  const ID=${j(commentId)}, VID=${j(who.videoId)}, CH=${j(who.channelId)}, HANDLE=${j(who.handle)}, MSG=${j(text)};
  const norm=s=>(s||"").replace(/\\s+/g," ").trim();
  const ytUrl=h=>{try{const u=new URL(h||"",location.href); return /^(www\\.|m\\.)?youtube\\.com$/.test(u.hostname)?u:null}catch{return null}};
  const inText=e=>!!e.closest("#content-text, #content, #expander");
  const topOf=th=>{const c=[...th.querySelectorAll("#comment")].filter(e=>!e.closest("#replies")); return c.length===1?c[0]:null};
  const lcOf=top=>{const as=[...top.querySelectorAll("#published-time-text a, .published-time-text a")].filter(a=>!inText(a)&&a.closest("#comment")===top);
    if(as.length!==1) return null; const u=ytUrl(as[0].getAttribute("href")); return u&&u.pathname==="/watch"&&u.searchParams.get("v")===VID?u.searchParams.get("lc"):null};
  const authorOf=top=>{const as=[...top.querySelectorAll("#author-text")].filter(a=>!inText(a)&&a.closest("#comment")===top); if(as.length!==1) return {ok:false,href:null};
    const u=ytUrl(as[0].getAttribute("href")); if(!u) return {ok:false,href:as[0].getAttribute("href")};
    let p; try{p=decodeURIComponent(u.pathname)}catch{return {ok:false,href:u.pathname}}
    return {ok: p==="/channel/"+CH || (HANDLE.startsWith("@")&&p.toLowerCase()==="/"+HANDLE.toLowerCase()), href:p}};
  const find=()=>{const hits=[]; for(const th of document.querySelectorAll("ytd-comment-thread-renderer")){const top=topOf(th); if(top&&lcOf(top)===ID) hits.push(top)} return hits};
  const badgeOf=()=>{const h=find(); if(h.length!==1||!authorOf(h[0]).ok) return null; return h[0].querySelector("ytd-pinned-comment-badge-renderer, #pinned-comment-badge")};
  document.querySelector("ytd-comments")?.scrollIntoView(); await sleep(1500);
  let hits=find();
  for(let i=0;i<5&&hits.length===0;i++){ window.scrollBy(0,1500); await sleep(1500); hits=find(); }
  if(hits.length!==1) return JSON.stringify({err:hits.length?"comment permalink matched several threads":"thread with this comment's own permalink not found", commentId:ID});
  const top=hits[0];
  const au=authorOf(top); if(!au.ok) return JSON.stringify({err:"comment author on the page is not the expected channel", author:au.href});
  const got=norm(top.querySelector("#content-text")?.textContent);
  if(got!==norm(MSG)) return JSON.stringify({err:"thread text is not the exact comment text", got});
  top.querySelector("#action-menu button, ytd-menu-renderer button")?.click(); await sleep(1500);
  const dd=[...document.querySelectorAll("tp-yt-iron-dropdown")].find(d=>d.getAttribute("aria-hidden")!=="true"&&vis(d)); if(!dd) return JSON.stringify({err:"menu did not open"});
  const items=[...dd.querySelectorAll("ytd-menu-service-item-renderer, yt-list-item-view-model, tp-yt-paper-item")].filter(vis);
  const pin=items.find(e=>e.innerText.trim()==="Pin");
  if(!pin && items.some(e=>e.innerText.trim()==="Unpin")){ document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); await sleep(500); const badge=badgeOf(); return JSON.stringify({ok: !!badge && vis(badge), already:true, badge: badge?.innerText?.trim()||null, author: au.href}); }
  if(!pin) return JSON.stringify({err:"no Pin item", items: items.map(e=>e.innerText.trim())});
  pin.click(); await sleep(2000);
  const d=[...document.querySelectorAll("tp-yt-paper-dialog, yt-confirm-dialog-renderer")].filter(vis)[0]; if(!d) return JSON.stringify({err:"no confirm dialog"});
  const b=[...d.querySelectorAll("button")].find(b=>b.innerText.trim()==="Pin"); if(!b) return JSON.stringify({err:"no Pin button"});
  b.click(); await sleep(3000);
  const badge=badgeOf();
  return JSON.stringify({ok: !!badge && vis(badge), badge: badge?.innerText?.trim()||null, author: au.href}); })()`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && !argv[i + 1]?.startsWith("--") ? argv[i + 1] : undefined; };
  const has = (k: string) => argv.includes(`--${k}`);
  const die = (m: string, c = 1): never => { console.error(`YouTubePinComment: ${m}`); process.exit(c); };
  const id = flag("id") ?? ""; const text = flag("text") ?? "";
  if (!id) die("--id required", 2);
  if (!VIDEO_ID.test(id)) die(`--id must be an 11-character YouTube video id, got ${JSON.stringify(id)}`, 2);
  if (!has("check") && !text) die("--text required", 2);
  const key = process.env.YOUTUBE_API_KEY ?? "";
  if (!key) die("YOUTUBE_API_KEY is not set; the read-back cannot run");

  const apiThread = async () => parseThreads(await apiGet("commentThreads", { part: "snippet", videoId: id, maxResults: "100", order: "time" }, key));
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) { if (e instanceof ApiError) return die(e.message); throw e; }
  };

  if (has("check")) { console.log(JSON.stringify(await guard(apiThread), null, 2)); process.exit(0); }

  const channel = flag("channel") ?? process.env.YOUTUBE_CHANNEL_ID ?? "";
  if (!CHANNEL_ID.test(channel)) die("expected channel unknown: pass --channel <UC…> or set YOUTUBE_CHANNEL_ID", 2);
  const commentId = flag("comment-id");
  if (commentId !== undefined && !COMMENT_ID.test(commentId)) die("--comment-id is not a comment id", 2);

  // 0. owner gate: the video must belong to the expected channel, before anything is posted
  const owner = await guard(async () => parseVideoOwner(await apiGet("videos", { part: "snippet", id }, key)));
  if (owner !== channel) die(`video ${id} belongs to ${owner}, not the expected channel ${channel}; refusing to post or pin`);

  const SKILL = join(getClaudeDir(), "skills", "Interceptor");
  const prefs = await Bun.file(join(SKILL, "preferences.env")).text();
  const CTX = /^\s*(?:export\s+)?INTERCEPTOR_TEST_CONTEXT_ID=(.+)$/m.exec(prefs)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!CTX) die("INTERCEPTOR_TEST_CONTEXT_ID missing from preferences.env");

  async function sh(cmd: string[], ok = true): Promise<string> {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    if (ok && code !== 0) die(`${cmd.slice(0, 3).join(" ")} → exit ${code}\n${err.slice(-400)}`);
    return out;
  }
  const evalMain = async (tab: string, js: string): Promise<any> => {
    const out = await sh(["interceptor", "eval", "--main", "--context", CTX!, "--tab", tab, js]);
    const last = out.trim().split("\n").pop() ?? "";
    try { return JSON.parse(last); } catch { return die(`interceptor eval returned non-JSON: ${last.slice(0, 200)}`); }
  };
  const openTab = async (url: string): Promise<string> => {
    const out = await sh(["interceptor", "open", url, "--context", CTX!, "--group", "ytpin", "--reuse", "--activate", "--text-only"]);
    return /Tab: (\d+)/.exec(out)?.[1] ?? die("could not resolve tab id from open output");
  };

  // 1. isolation gate
  await sh(["bash", join(SKILL, "Tools", "EnsureTestProfile.sh")]);

  // 2. acting-channel gate: ytcfg LOGGED_IN says a session exists, not which channel it acts
  //    as. Studio's redirect names the active channel; it must be the expected one.
  const who = parseActiveChannel(await evalMain(await openTab("https://studio.youtube.com/"), ACTIVE_CHANNEL_SCRIPT));
  if ("reason" in who) die(`cannot confirm which channel the test profile is acting as: ${who.reason}; refusing to post or pin`);
  const active = (who as { channel: string }).channel;
  if (active !== channel) die(`test profile is acting as ${active}, not the expected channel ${channel}; switch channel in the interceptor-test window. Refusing to post or pin`);

  // 3. open the watch page, active in the test window (comments load only in a visible tab)
  const tab = await openTab(`https://www.youtube.com/watch?v=${id}`);
  const state = await evalMain(tab, `JSON.stringify({vis:document.visibilityState, loggedIn: ytcfg?.get("LOGGED_IN")})`);
  if (!state.loggedIn) die("test profile is not signed into YouTube — sign in once in the interceptor-test window");
  if (state.vis !== "visible") die("watch tab is not visible; comments will not load");

  const msgJs = JSON.stringify(text);
  let mine: Comment;
  if (!has("pin-only")) {
    // 4. snapshot the thread, then post; only a comment id that is new after the post counts
    const before = new Set((await guard(apiThread)).map((t) => t.id));
    invariant(owner === channel && active === channel, "posting is reachable only after the owner and acting-channel gates passed");
    const posted = await evalMain(tab, `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      document.querySelector("ytd-comments")?.scrollIntoView(); await sleep(2500);
      const ph=document.querySelector("#simplebox-placeholder"); if(!ph) return JSON.stringify({err:"no comment box"});
      ph.click(); await sleep(1000);
      const ed=document.querySelector("ytd-comment-simplebox-renderer #contenteditable-root"); ed.focus();
      document.execCommand("selectAll",false,null); document.execCommand("delete",false,null);
      document.execCommand("insertText",false,${msgJs});
      if(ed.innerText!==${msgJs}) return JSON.stringify({err:"editor text mismatch", got: ed.innerText});
      const btn=document.querySelector("ytd-comment-simplebox-renderer #submit-button button"); if(!btn||btn.disabled) return JSON.stringify({err:"submit disabled"});
      btn.click(); await sleep(4000);
      return JSON.stringify({ok:true}); })()`);
    if (!posted.ok) die(`post failed: ${JSON.stringify(posted)}`);

    // 5. API read-back: a new comment, by the expected channel id, with the exact text
    let pick: Comment | string = "not read yet";
    let thread: Comment[] = [];
    for (let i = 0; i < 7; i++) {
      if (i > 0) await Bun.sleep(3000);
      thread = await guard(apiThread);
      pick = pickComment(thread, { channel, text, exclude: before });
      if (typeof pick !== "string" || pick.startsWith("ambiguous")) break;
    }
    if (typeof pick === "string") die(`posted comment not verified on read-back (${pick}); thread: ${JSON.stringify(thread)}`);
    mine = pick as Comment;
  } else {
    const pick = pickComment(await guard(apiThread), { channel, text, commentId });
    if (typeof pick === "string") die(`--pin-only: ${pick}`);
    mine = pick as Comment;
  }

  // 6. pin that exact comment, authored by the channel (iron-dropdown is position:fixed → use rect, not offsetParent)
  invariant(mine.authorChannelId === channel && active === channel, "the comment to pin is the expected channel's, pinned while acting as it");
  const pinned = await evalMain(tab, pinScript(mine.id, text, { videoId: id, channelId: channel, handle: mine.author.startsWith("@") ? mine.author : "" }));
  if (!pinned.ok) die(`pin failed: ${JSON.stringify(pinned)}`);

  console.log(JSON.stringify({ videoId: id, commentId: mine.id, channelId: mine.authorChannelId, author: mine.author, pageAuthor: pinned.author ?? null, text: mine.text, badge: pinned.badge, url: `https://www.youtube.com/watch?v=${id}&lc=${mine.id}` }, null, 2));
}

if (import.meta.main) await main();
