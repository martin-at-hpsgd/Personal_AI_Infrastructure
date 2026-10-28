/**
 * ReviewPage — the one HTML page a Calibrate session serves.
 *
 * Each item gets a 0–10 slider and a notes box. The page carries indices, each
 * item's kind and caption (an image's post title, a text output's prompt), the
 * target title and question, and the session token. No paths and no judge
 * scores reach the page, so nothing can anchor a score.
 */
export interface PageItem { kind: 'image' | 'text'; context?: string }
export interface PageInput { sessionId: string; title: string; question: string; count: number; token: string; items?: PageItem[] }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderPage(input: PageInput): string {
  const items = input.items ?? Array.from({ length: input.count }, () => ({ kind: 'image' as const }));
  const data = JSON.stringify({ session: input.sessionId, count: input.count, token: input.token, items }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calibrate · ${esc(input.title)}</title>
<style>
:root { --bg:#f4f3ef; --card:#ffffff; --ink:#1d1d1f; --muted:#6b6b70; --line:#dcdad3; --focus:#3b82f6; --well:#eae9df; --done:#1f8a4c; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141416; --card:#1e1e21; --ink:#f2f2f4; --muted:#9a9aa2; --line:#303036; --well:#2a2a2e; } }
:root[data-theme="dark"] { --bg:#141416; --card:#1e1e21; --ink:#f2f2f4; --muted:#9a9aa2; --line:#303036; --well:#2a2a2e; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
header { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line); padding:14px 16px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
header h1 { font-size:17px; margin:0; font-weight:650; }
header p { margin:2px 0 0; color:var(--muted); }
header .grow { flex:1 1 320px; min-width:0; }
.progress { font-variant-numeric: tabular-nums; color:var(--muted); white-space:nowrap; }
button { font:inherit; cursor:pointer; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:8px 14px; }
button:disabled { opacity:.45; cursor:default; }
#submit { background:var(--focus); border-color:var(--focus); color:#fff; font-weight:600; }
.keys { color:var(--muted); font-size:13px; padding:10px 16px 0; }
.keys kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 5px; font:12px ui-monospace, monospace; background:var(--card); }
main { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap:16px; padding:16px; }
.card { background:var(--card); border:2px solid var(--line); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; outline:none; }
.card.current { border-color:var(--focus); }
.card.rated:not(.current) { border-color:color-mix(in srgb, var(--done) 55%, var(--line)); }
.well { background:var(--well); aspect-ratio: 16 / 10; cursor:zoom-in; position:relative; }
.well img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:block; }
.num { z-index:1; position:absolute; top:8px; left:8px; background:rgba(0,0,0,.6); color:#fff; font-size:12px; font-weight:600; border-radius:6px; padding:2px 7px; }
.caption { padding:10px 14px 0; font-weight:600; font-size:14px; }
.text { padding:14px 16px; max-height:460px; overflow:auto; white-space:pre-wrap; font:14px/1.55 ui-sans-serif, -apple-system, sans-serif; border-bottom:1px solid var(--line); }
details.ctx { padding:10px 16px 0; color:var(--muted); font-size:13px; }
details.ctx pre { white-space:pre-wrap; font:12.5px/1.5 ui-monospace, monospace; max-height:220px; overflow:auto; background:var(--bg); padding:8px 10px; border-radius:8px; }
.num-inline { align-self:flex-start; display:inline-block; margin:12px 16px 0; background:var(--well); border-radius:6px; padding:2px 7px; font-size:12px; font-weight:600; }
.score { display:flex; align-items:center; gap:12px; padding:12px 14px 0; }
.score input[type=range] { flex:1; accent-color:var(--focus); height:28px; }
.score.unset input[type=range] { opacity:.45; }
.score output { width:92px; flex:none; text-align:right; font-variant-numeric:tabular-nums; font-size:22px; font-weight:700; }
.score.unset output { color:var(--muted); font-size:15px; font-weight:500; }
.ticks { display:flex; justify-content:space-between; padding:0 calc(14px + 92px + 12px + 6px) 0 20px; color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; }
textarea { font:inherit; width:100%; resize:vertical; min-height:58px; border:1px solid var(--line); border-radius:8px; padding:8px 10px; background:var(--bg); color:var(--ink); }
.card textarea { margin:10px 14px 14px; width:calc(100% - 28px); }
footer { padding:0 16px 40px; max-width:900px; }
footer label { display:block; font-weight:600; margin:0 0 6px; }
#lightbox { position:fixed; inset:0; background:rgba(0,0,0,.88); display:none; align-items:center; justify-content:center; z-index:10; cursor:zoom-out; }
#lightbox.open { display:flex; }
#lightbox img { max-width:96vw; max-height:94vh; object-fit:contain; }
.done { max-width:560px; margin:18vh auto; padding:0 16px; text-align:center; }
.done h1 { font-size:22px; }
</style>
</head>
<body>
<header>
  <div class="grow">
    <h1>${esc(input.title)}</h1>
    <p>${esc(input.question)}</p>
  </div>
  <span class="progress" id="progress"></span>
  <button id="submit" disabled>Submit</button>
</header>
<div class="keys">Drag the slider, or: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>0</kbd>–<kbd>9</kbd> score · <kbd>t</kbd> 10 · <kbd>c</kbd> notes · <kbd>Esc</kbd> leave notes · <kbd>z</kbd> zoom. Notes are optional; say why when it matters.</div>
<main id="grid"></main>
<footer>
  <label for="overall">Anything about the whole set? (optional)</label>
  <textarea id="overall" rows="3" placeholder="Patterns you noticed across these"></textarea>
</footer>
<div id="lightbox"><img alt=""></div>
<script>
const S = ${data};
const key = 'calibrate-draft-' + S.session;
let state = { v: {}, n: {}, overall: '' };
try { const d = JSON.parse(localStorage.getItem(key) || 'null'); if (d && d.v && d.n) state = d; } catch {}
const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch {} };
const grid = document.getElementById('grid');
let current = 0;
const ticks = '<div class="ticks">' + Array.from({ length: 11 }, (_, n) => '<span>' + n + '</span>').join('') + '</div>';
for (let i = 0; i < S.count; i++) {
  const it = S.items[i] || { kind: 'image' };
  const c = document.createElement('section');
  c.className = 'card'; c.tabIndex = -1; c.dataset.i = i;
  const head = it.kind === 'text'
    ? '<span class="num-inline">' + (i + 1) + '</span>' + (it.context ? '<details class="ctx"><summary>Prompt</summary><pre></pre></details>' : '') + '<div class="text">Loading…</div>'
    : '<div class="well"><span class="num">' + (i + 1) + '</span><img decoding="async" alt="Item ' + (i + 1) + '" src="/item/' + i + '?t=' + S.token + '"></div>' + (it.context ? '<div class="caption"></div>' : '');
  c.innerHTML = head
    + '<div class="score unset"><input type="range" min="0" max="10" step="1" value="5" aria-label="Score for item ' + (i + 1) + '"><output>not scored</output></div>' + ticks
    + '<textarea placeholder="Why? (optional)"></textarea>';
  if (it.kind === 'text') {
    if (it.context) c.querySelector('.ctx pre').textContent = it.context;
    fetch('/item/' + i + '?t=' + S.token).then(r => r.text()).then(t => { c.querySelector('.text').textContent = t; });
  } else {
    if (it.context) c.querySelector('.caption').textContent = it.context;
    c.querySelector('.well').onclick = () => zoom(i);
  }
  const range = c.querySelector('input[type=range]');
  range.oninput = () => setScore(i, Number(range.value));
  range.onfocus = () => focusCard(i, false);
  const ta = c.querySelector('textarea');
  ta.value = state.n[i] || '';
  ta.oninput = () => { state.n[i] = ta.value; save(); };
  ta.onfocus = () => focusCard(i, false);
  c.onclick = (e) => { if (e.target === c) focusCard(i, false); };
  grid.appendChild(c);
}
const overall = document.getElementById('overall');
overall.value = state.overall || '';
overall.oninput = () => { state.overall = overall.value; save(); };
const cards = [...grid.children];
function paint() {
  let rated = 0;
  cards.forEach((c, i) => {
    const v = state.v[i], has = typeof v === 'number';
    if (has) rated++;
    c.classList.toggle('rated', has);
    c.classList.toggle('current', i === current);
    const box = c.querySelector('.score');
    box.classList.toggle('unset', !has);
    if (has) c.querySelector('input[type=range]').value = String(v);
    c.querySelector('output').textContent = has ? String(v) : 'not scored';
  });
  document.getElementById('progress').textContent = rated + ' / ' + S.count + ' scored';
  const b = document.getElementById('submit');
  b.disabled = rated === 0;
  b.textContent = rated === S.count ? 'Submit' : 'Submit ' + rated + ' of ' + S.count;
}
function setScore(i, v) { state.v[i] = v; current = i; save(); paint(); }
function focusCard(i, scroll = true) { current = Math.max(0, Math.min(S.count - 1, i)); paint(); if (scroll) cards[current].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
function zoom(i) { if ((S.items[i] || {}).kind === 'text') return; const lb = document.getElementById('lightbox'); lb.querySelector('img').src = '/item/' + i + '?t=' + S.token; lb.classList.add('open'); }
document.getElementById('lightbox').onclick = () => document.getElementById('lightbox').classList.remove('open');
document.addEventListener('keydown', (e) => {
  const inText = e.target instanceof HTMLTextAreaElement;
  if (e.key === 'Escape') { document.getElementById('lightbox').classList.remove('open'); if (inText) e.target.blur(); return; }
  if (inText || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (/^[0-9]$/.test(k)) { e.preventDefault(); setScore(current, Number(k)); }
  else if (k === 't') { setScore(current, 10); }
  else if (k === 'j' || k === 'arrowdown') { e.preventDefault(); focusCard(current + 1); }
  else if (k === 'k' || k === 'arrowup') { e.preventDefault(); focusCard(current - 1); }
  else if (k === 'c' || k === 'enter') { e.preventDefault(); cards[current].querySelector('textarea').focus(); }
  else if (k === 'z' || k === ' ') { e.preventDefault(); zoom(current); }
});
document.getElementById('submit').onclick = async () => {
  const labels = [];
  for (let i = 0; i < S.count; i++) if (typeof state.v[i] === 'number') labels.push({ i, score: state.v[i], note: (state.n[i] || '').trim() });
  if (labels.length < S.count && !confirm('Submit ' + labels.length + ' of ' + S.count + '? Unscored items are skipped.')) return;
  const b = document.getElementById('submit'); b.disabled = true; b.textContent = 'Saving…';
  try {
    const r = await fetch('/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-calibrate-token': S.token }, body: JSON.stringify({ labels, overall: (state.overall || '').trim() }) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || r.statusText);
    try { localStorage.removeItem(key); } catch {}
    document.body.innerHTML = '<div class="done"><h1>Saved ' + out.saved + ' scores.</h1><p>Your scores and notes are recorded. You can close this tab.</p></div>';
  } catch (err) { alert('Could not save: ' + err.message); paint(); }
};
paint();
</script>
</body>
</html>`;
}
