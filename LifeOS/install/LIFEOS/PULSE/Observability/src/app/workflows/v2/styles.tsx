/**
 * Workflows V2 styles. Every selector carries the `wf2-` prefix (plus scoped
 * overrides of React Flow's own classes under `.wf2-canvas`), so nothing here
 * reaches V1 or any other page. Colours are Pulse tokens from globals.css; the
 * runtime and executor palettes come from ../shared and are set inline.
 * The canvas loads React Flow's structural base.css only; every visible
 * surface (controls, minimap, handles) is painted dark here.
 */

const CSS = `
.wf2 .wf2-badge { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-family: var(--mono); letter-spacing: 0.04em;
  color: var(--accent-soft); background: rgba(37,139,255,0.12); border: 1px solid rgba(128,204,255,0.35); vertical-align: middle; }
.wf2-muted { color: var(--ink-2); }
.wf2-block { display: block; margin-top: 2px; }
.wf2-pad { padding: 4px 2px 8px; font-size: 13px; }
.wf2-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.wf2-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; }
.wf2-chip { display: inline-block; padding: 0 8px; border-radius: 6px; font-size: 12px; color: var(--ink-2); border: 1px solid var(--line-2); background: rgba(5,11,23,0.4); }
.wf2-spin { animation: wf2-spin 1s linear infinite; }
@keyframes wf2-spin { to { transform: rotate(360deg); } }

/* ── Tab row, search, runtime chips ── */
.wf2-state-title { display: block; font-size: 16px; line-height: 1.35; white-space: nowrap; }
.wf2-state-hint { display: block; line-height: 1.6; margin-top: 4px; }
.wf2-bar { display: flex; flex-direction: column; gap: 10px; margin-top: -6px; }
.wf2-search { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; min-width: 240px;
  background: rgba(5,11,23,0.55); border: 1px solid var(--line-2); color: var(--ink-2); }
.wf2-search:focus-within { border-color: var(--line-3); }
.wf2-search input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--ink-1); font-size: 13px; }
.wf2-search input::-webkit-search-cancel-button { display: none; }
.wf2-search button { background: none; border: 0; padding: 0; color: var(--ink-2); cursor: pointer; display: inline-flex; }
.wf2-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; }
.wf2-chips::before { content: "Sources"; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-right: 8px; }
.wf2-chips .wf2-legend-item { padding: 3px 8px; height: 24px; font-size: 12px; font-weight: 500; color: #94a3b8; border-color: transparent; background: transparent; }
.wf2-chips .wf2-legend-item:hover { color: var(--ink-1); border-color: var(--line-2); }
.wf2-chips .wf2-legend-item[aria-pressed="true"] { color: var(--ink-1); border-color: rgba(128,204,255,0.6); background: rgba(37,139,255,0.14); }
.wf2-chips .wf2-dot { width: 7px; height: 7px; }
.wf2-legend-item { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px; font-size: 13px; cursor: pointer;
  color: var(--ink-1); background: rgba(10,21,40,0.7); border: 1px solid var(--line-1); white-space: nowrap; }
.wf2-legend-item:hover { border-color: var(--line-2); }
.wf2-legend-item[aria-pressed="true"] { border-color: rgba(128,204,255,0.6); background: rgba(37,139,255,0.14); }
.wf2-legend-item[data-dim="1"] { opacity: 0.45; }
.wf2-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
  color: var(--ink-1); background: rgba(10,21,40,0.85); border: 1px solid var(--line-2); white-space: nowrap; }
.wf2-toggle:hover { border-color: var(--line-3); }
.wf2-switch { position: relative; width: 26px; height: 14px; border-radius: 999px; background: var(--line-2); flex: none; transition: background 120ms; }
.wf2-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--ink-2); transition: transform 120ms; }
.wf2-switch[data-on="1"] { background: var(--accent-blue); }
.wf2-switch[data-on="1"]::after { transform: translateX(12px); background: var(--ink-1); }

/* ── Buttons ── */
.wf2-act { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 7px; font-size: 12.5px; cursor: pointer; white-space: nowrap;
  color: var(--ink-2); background: transparent; border: 1px solid transparent; }
.wf2-act:hover:not(:disabled) { color: var(--ink-1); border-color: var(--line-2); background: rgba(255,255,255,0.03); }
.wf2-act[data-tone="go"] { color: var(--ok); }
.wf2-act[data-tone="view"] { color: var(--accent-soft); }
.wf2-act:disabled { color: var(--ink-2); opacity: 0.5; cursor: not-allowed; }
.wf2-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; cursor: pointer;
  color: var(--ink-2); background: transparent; border: 1px solid transparent; }
.wf2-icon:hover { color: var(--ink-1); border-color: var(--line-2); }
.wf2-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 9px; font-size: 13px; cursor: pointer;
  color: var(--ink-1); background: rgba(10,21,40,0.9); border: 1px solid var(--line-2); }
.wf2-btn:hover { border-color: var(--line-3); }
.wf2-btn[data-tone="go"] { background: rgba(74,222,128,0.14); border-color: rgba(74,222,128,0.5); color: #bbf7d0; }
.wf2-btn[data-tone="go"]:hover { background: rgba(74,222,128,0.22); }
:where(.wf2-act, .wf2-icon, .wf2-btn, .wf2-toggle, .wf2-legend-item, .wf2-name, .wf2-log-line, .wf2-skill-list button, .wf2-search button):focus-visible {
  outline: 2px solid var(--accent-blue); outline-offset: 2px; }
.wf2-run { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.wf2-run-result { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; max-width: 260px; min-width: 0; }
.wf2-run-result span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-run-result[data-tone="ok"] { color: var(--ok); }
.wf2-run-result[data-tone="error"] { color: var(--err); }

/* ── Confirm dialog ── */
.wf2-modal-back { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(2,6,14,0.72); backdrop-filter: blur(3px); }
.wf2-confirm { width: min(520px, 100%); padding: 22px 24px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--line-2);
  box-shadow: 0 20px 60px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 12px; }
.wf2-confirm-eyebrow { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
.wf2-confirm-title { margin: 0; font-size: 18px; color: var(--ink-1); line-height: 1.35; }
.wf2-confirm-body { margin: 0; font-size: 13.5px; color: var(--ink-2); line-height: 1.55; }
.wf2-confirm-body code { font-family: var(--mono); font-size: 12.5px; color: var(--ink-1); }
.wf2-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

/* ── Dashboard ── */
.wf2-dash { display: flex; flex-direction: column; gap: 14px; }
.wf2-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.wf2-section-title { font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent-soft); margin-top: 6px; }
.wf2-section-title .mono { letter-spacing: 0; margin-left: 6px; }
.wf2-flat { margin-top: 0; }
.wf2-table { display: flex; flex-direction: column; border-top: 1px solid var(--line-1); }
.wf2-tr { display: grid; grid-template-columns: 22px minmax(220px, 2.1fr) minmax(150px, 1.1fr) minmax(110px, 0.9fr) 124px 56px minmax(200px, auto);
  align-items: center; gap: 12px; padding: 8px 6px; border-bottom: 1px solid var(--line-1); font-size: 13.5px; color: var(--ink-1); }
.wf2-tr:not(.wf2-th):hover { background: rgba(37,139,255,0.045); }
.wf2-th { font-size: 12.5px; color: var(--ink-2); padding-top: 6px; padding-bottom: 6px; }
.wf2-tr[data-health="fail"] { box-shadow: inset 2px 0 0 var(--err); }
.wf2-tr[data-health="warn"] { box-shadow: inset 2px 0 0 var(--warn); }
.wf2-td-name { display: flex; flex-direction: column; min-width: 0; }
.wf2-name { background: none; border: 0; padding: 0; text-align: left; color: var(--ink-1); font-size: 13.5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-name:hover { color: var(--accent-soft); }
.wf2-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wf2-name-row .wf2-name { min-width: 0; }
.wf2-sub { font-size: 12px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-td-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-2); min-width: 0; }
.wf2-td-status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-td-trigger { font-size: 13px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-td-last { font-size: 12.5px; white-space: nowrap; }
.wf2-num { text-align: right; font-size: 12.5px; }
.wf2-row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
.wf2-iconact { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; flex: none;
  color: var(--ink-2); background: transparent; border: 1px solid var(--line-1); }
.wf2-iconact:hover { color: var(--ink-1); border-color: var(--line-3); background: rgba(37,139,255,0.08); }
.wf2-iconact:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 2px; }
.wf2-active { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.wf2-active li { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border-bottom: 1px solid var(--line-1); font-size: 13px; }
.wf2-active li .mono { font-size: 12px; }
.wf2-active li .wf2-act { margin-left: auto; }

/* ── Status mark ── */
.wf2-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.wf2-status-dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid; flex: none; }

/* \u2500\u2500 Canvas \u2500\u2500 */
/* Fills the viewport below the tab bar (the page scrolls the bar to the top on this tab). */
.wf2-canvas-wrap { height: max(720px, calc(100dvh - 88px)); display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
  border: 1px solid var(--line-1); background: var(--ground); }
.wf2-canvas-bar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 8px 12px;
  border-bottom: 1px solid var(--line-1); background: var(--surface-1); }
.wf2-legend { display: flex; flex-wrap: wrap; gap: 6px; }
.wf2-where { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; border: 1px solid var(--line-2); background: rgba(5,11,23,0.6); }
.wf2-where-tab { display: inline-flex; align-items: center; gap: 7px; padding: 5px 14px; border-radius: 7px; border: 0; background: transparent;
  color: var(--ink-2); font-size: 13.5px; font-weight: 600; cursor: pointer; }
.wf2-where-tab:hover { color: var(--ink-1); }
.wf2-where-tab[aria-selected="true"] { color: var(--ink-1); background: rgba(37,139,255,0.18); box-shadow: inset 0 0 0 1px rgba(128,204,255,0.55); }
.wf2-where-tab:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 1px; }
.wf2-bar-hint { margin-left: auto; font-size: 12.5px; color: var(--ink-2); }
.wf2-credit { font-size: 12px; color: var(--ink-2); text-decoration: none; opacity: 0.75; }
.wf2-credit:hover { opacity: 1; text-decoration: underline; }
.wf2-stage { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.wf2-canvas { position: relative; flex: 1; min-height: 0; }
.wf2-canvas .react-flow { background: var(--ground); --xy-background-color: var(--ground); }
.wf2-canvas .react-flow__node { cursor: pointer; }
.wf2-canvas .react-flow__node-frame { cursor: default; pointer-events: none; }
.wf2-canvas .react-flow__node:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 3px; border-radius: 10px; }
.wf2-canvas .react-flow__controls { display: flex; flex-direction: column; border-radius: 9px; overflow: hidden; border: 1px solid var(--line-2);
  background: rgba(10,21,40,0.95); box-shadow: 0 6px 18px rgba(0,0,0,0.35); }
.wf2-canvas .react-flow__controls-button { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;
  background: transparent; border: 0; border-bottom: 1px solid var(--line-1); color: var(--ink-1); }
.wf2-canvas .react-flow__controls-button:last-child { border-bottom: 0; }
.wf2-canvas .react-flow__controls-button:hover { background: rgba(37,139,255,0.14); }
.wf2-canvas .react-flow__controls-button svg { width: 14px; height: 14px; max-width: 14px; max-height: 14px; }
.wf2-canvas .react-flow__controls-button svg:not([class*="lucide"]) { fill: currentColor; }
.wf2-canvas .react-flow__minimap { margin: 16px; border-radius: 9px; overflow: hidden; border: 1px solid var(--line-2); box-shadow: 0 6px 18px rgba(0,0,0,0.35);
  opacity: 0.7; transition: opacity 120ms; }
.wf2-canvas .react-flow__minimap:hover, .wf2-canvas .react-flow__minimap:focus-within { opacity: 1; }
.wf2-canvas .react-flow__minimap-mask { stroke: rgba(128,204,255,0.5); stroke-width: 2; }
.wf2-canvas-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--ink-2); font-size: 14px; pointer-events: none; }

/* Frames */
.wf2-frame { width: 100%; height: 100%; border-radius: 12px; border: 1px dashed; position: relative; }
.wf2-frame-label { position: absolute; top: 13px; left: 16px; padding: 3px 10px; border-radius: 5px; border: 1px solid; font-family: var(--mono);
  font-size: 15px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap;
  }
/* Zoomed out, the in-frame label and count give way to screen-space labels (.wf2-flabel). */
.wf2-canvas[data-far="1"] .wf2-frame-label, .wf2-canvas[data-far="1"] .wf2-frame-sub { visibility: hidden; }
/* Zoomed out, glows cost a full-canvas repaint for nothing visible: drop them. */
.wf2-canvas[data-far="1"] .wf2-pill, .wf2-canvas[data-far="1"] .wf2-node { box-shadow: none !important; }
.wf2-canvas > .react-flow { isolation: isolate; }
.wf2-flabels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 6; }
.wf2-flabel { position: absolute; transform: translate(5px, 5px); padding: 2px 7px; border-radius: 4px; border: 1px solid;
  font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf2-frame-sub { position: absolute; top: 17px; right: 16px; font-size: 13px; color: var(--ink-2); white-space: nowrap; }

/* Trigger pill */
.wf2-pill { position: relative; width: 288px; height: 62px; display: flex; align-items: center; gap: 0; border-radius: 999px; border: 2px solid;
  outline: 0 solid transparent; outline-offset: 3px; overflow: visible; color: var(--ink-1); }
.wf2-pill[data-ring] { outline-width: 2px; outline-style: solid; }
.wf2-pill[data-ring="low"] { outline-style: dotted; }
.wf2-pill[data-health="fail"] { box-shadow: 0 0 0 1px rgba(248,113,113,0.35), 0 0 18px rgba(248,113,113,0.28); }
.wf2-pill[data-selected="1"] { box-shadow: 0 0 0 2px var(--accent-soft), 0 0 22px rgba(128,204,255,0.3); }
.wf2-pill-cap { width: 38px; height: 100%; border-radius: 999px 0 0 999px; display: flex; align-items: center; justify-content: center; color: rgba(5,11,23,0.85); flex: none; }
.wf2-pill-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; padding: 0 6px 0 11px; }
.wf2-pill-title { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 600; min-width: 0; }
.wf2-pill-title .wf2-pill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wf2-apps { display: inline-flex; align-items: center; gap: 4px; flex: none; vertical-align: middle; }
.wf2-app-icon { display: block; border-radius: 3px; object-fit: contain; flex: none; }
.wf2-pill-sub { font-size: 12px; color: var(--ink-2); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-pill-run { flex: none; padding-right: 10px; }
.wf2-pill-run .wf2-act { padding: 5px; }
.wf2-pill-run .wf2-run-result { display: none; }

/* Step / destination nodes */
.wf2-node { position: relative; width: 224px; height: 62px; display: flex; align-items: stretch; border-radius: 8px; overflow: visible;
  background: #0b1626; border: 2px solid rgba(130,157,187,0.22); color: var(--ink-1); }
.wf2-node[data-kind="dest"] { width: 264px; }
.wf2-node[data-empty="1"] { background: transparent; border: 1.5px dashed rgba(176,196,221,0.45); }
.wf2-node[data-empty="1"] .wf2-node-title { color: var(--ink-2); font-style: italic; font-weight: 400; }
.wf2-node[data-selected="1"] { border-color: var(--accent-soft); box-shadow: 0 0 14px rgba(128,204,255,0.22); }
.wf2-node-bar { width: 28px; border-radius: 6px 0 0 6px; flex: none; display: flex; align-items: center; justify-content: center; color: rgba(5,11,23,0.8); }
.wf2-node-body { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; padding: 0 11px; flex: 1; }
.wf2-node-title { display: flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-node-sub { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-canvas .wf2-handle { width: 14px; height: 14px; border-radius: 50%; border: 3px solid #07101d; z-index: 3; }
.wf2-canvas .react-flow__handle-left.wf2-handle { left: -8px; }
.wf2-canvas .react-flow__handle-right.wf2-handle { right: -8px; }

/* Floating pipeline legend (Cue's): top-centre over the canvas. */
.wf2-plegend { position: absolute; top: 12px; left: 0; right: 0; margin: 0 auto; width: fit-content; z-index: 7; max-width: min(96%, 1480px);
  display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 4px; padding: 8px 10px; border-radius: 10px;
  background: rgba(8,17,31,0.96); border: 1px solid var(--line-2); box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
.wf2-plegend-item { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 6px; border: 1px solid transparent;
  background: transparent; color: var(--ink-1); font-family: var(--mono); font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.wf2-plegend-item:hover { background: rgba(255,255,255,0.05); }
.wf2-plegend-item[aria-pressed="true"] { border-color: rgba(128,204,255,0.55); background: rgba(37,139,255,0.14); }
.wf2-plegend-item[data-all="1"] { font-weight: 700; }
.wf2-plegend-item:focus-visible { outline: 2px solid var(--accent-soft); outline-offset: 1px; }
.wf2-plegend-fail { color: var(--err); font-weight: 700; }

/* Skill tiles */
.wf2-skill { width: 236px; height: 52px; display: flex; align-items: center; gap: 9px; padding: 0 14px; border-radius: 999px;
  background: rgba(148,163,184,0.08); border: 1px solid rgba(148,163,184,0.4); color: var(--ink-1); }
.wf2-skill[data-selected="1"] { border-color: var(--accent-soft); box-shadow: 0 0 14px rgba(128,204,255,0.25); }
.wf2-skill-title { flex: 1; min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-skill-count { font-size: 12.5px; color: var(--ink-2); }

/* \u2500\u2500 Drawer (below the canvas, never over it) \u2500\u2500 */
.wf2-drawer { flex: none; height: 42%; display: flex; flex-direction: column; min-height: 0;
  background: #08111f; border-top: 2px solid var(--line-2); animation: wf2-rise 160ms ease-out; }
.wf2-drawer[data-collapsed="1"] { height: auto; }
@keyframes wf2-rise { from { opacity: 0; } to { opacity: 1; } }
.wf2-drawer-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 10px 16px; border-top: 2px solid transparent; margin-top: -2px;
  border-bottom: 1px solid var(--line-1); font-size: 13px; }
.wf2-drawer-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--ink-1); }
.wf2-health { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.wf2-drawer-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.wf2-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.wf2-slots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.wf2-slot { padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line-1); background: rgba(5,11,23,0.6); min-width: 0; }
.wf2-slot[data-empty="1"] { border-style: dashed; background: transparent; }
.wf2-slot[data-empty="1"] .wf2-slot-value { color: var(--ink-2); font-style: italic; }
.wf2-slot-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); margin-bottom: 5px; }
.wf2-slot-flag { font-size: 12px; letter-spacing: 0.02em; text-transform: none; font-weight: 500; color: var(--warn); }
.wf2-slot-value { font-size: 13.5px; line-height: 1.45; color: var(--ink-1); overflow-wrap: break-word; }
.wf2-slot-value.mono, .wf2 .mono { font-family: var(--mono); }
.wf2-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.wf2-steps li { display: flex; align-items: center; gap: 7px; font-size: 13px; min-width: 0; }
.wf2-steps li .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-drawer-cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.wf2-facts { margin: 0; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line-1); background: rgba(5,11,23,0.6); display: flex; flex-direction: column; gap: 6px; font-size: 13px; min-width: 0; }
.wf2-facts-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
.wf2-facts > div:not(.wf2-facts-title) { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; }
.wf2-facts dt { color: var(--ink-2); font-size: 12.5px; }
.wf2-facts dd { margin: 0; color: var(--ink-1); overflow-wrap: anywhere; }
.wf2-findings, .wf2-mini-runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wf2-findings li { display: flex; gap: 8px; align-items: baseline; line-height: 1.4; }
.wf2-findings li[data-quiet="1"] { opacity: 0.6; }
.wf2-mini-runs li { display: flex; align-items: center; gap: 10px; }
.wf2-skill-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.wf2-skill-list button { width: 100%; display: grid; grid-template-columns: 12px minmax(0, 0.8fr) minmax(0, 1.6fr); align-items: center; gap: 8px; text-align: left;
  padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line-1); background: rgba(5,11,23,0.45); color: var(--ink-1); font-size: 12.5px; cursor: pointer; }
.wf2-skill-list button:hover { border-color: var(--line-3); }
.wf2-skill-list button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf2-skill-list .wf2-skill-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wf2-skill-cell .wf2-skill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wf2-skill-name { font-weight: 600; }

/* ── Activity log ── */
.wf2-log { display: flex; flex-direction: column; gap: 10px; }
.wf2-log-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; font-size: 12.5px; }
.wf2-log-tools { display: flex; align-items: center; gap: 8px; padding-left: 12px; border-left: 1px solid var(--line-2); }
.wf2-log-head { padding-bottom: 8px; border-bottom: 1px solid var(--line-1); }
.wf2-log-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line-1); }
.wf2-log-day { padding: 12px 6px 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); font-family: var(--mono); }
.wf2-log-row { border-bottom: 1px solid var(--line-1); }
.wf2-log-row[data-status="error"] { box-shadow: inset 2px 0 0 var(--err); }
.wf2-log-stages { display: inline-flex; align-items: center; justify-self: start; font-style: normal; line-height: 1; }
.wf2-log-stages i { font-style: normal; font-size: 11px; width: 12px; text-align: center; color: #cbd5e1; }
.wf2-log-stages i[data-x="trigger"] { color: #60a5fa; }
.wf2-log-stages i[data-x="model"] { color: #c084fc; }
.wf2-log-stages i[data-x="judgment"] { color: #fbbf24; }
.wf2-log-stages i[data-x="human"] { color: #f472b6; }
.wf2-log-stages i[data-x="output"], .wf2-log-stages i[data-x="unknown"] { color: #94a3b8; }
.wf2-log-stages span { display: inline-flex; align-items: center; }
.wf2-log-stages b { display: inline-block; width: 10px; border-top: 1px solid #475569; margin: 0 2px; }
.wf2-log-line { width: 100%; display: grid; grid-template-columns: 14px 46px 10px minmax(0, max-content) minmax(0, 1fr) 150px 118px 64px; align-items: center; gap: 10px;
  padding: 6px 6px; background: none; border: 0; text-align: left; color: var(--ink-1); font-size: 13px; cursor: pointer; font-family: var(--mono); }
.wf2-log-line:hover { background: rgba(37,139,255,0.045); }
.wf2-log-time { color: var(--ink-2); font-size: 12.5px; }
.wf2-log-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.wf2-log-titlecell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wf2-log-titlecell .wf2-log-title { min-width: 0; }
.wf2-log-trigger { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.wf2-log-dur { text-align: right; font-size: 12px; }
.wf2-log-detail { margin: 0 6px 10px 30px; padding: 10px 14px; border-radius: 9px; border: 1px solid var(--line-1); background: rgba(5,11,23,0.5); display: flex; flex-direction: column; gap: 10px; }
.wf2-log-detail dl { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 24px; font-size: 12.5px; }
.wf2-log-detail dl > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 8px; }
.wf2-log-detail dt { color: var(--accent-soft); }
.wf2-log-detail dd { margin: 0; color: var(--ink-1); overflow-wrap: anywhere; }
.wf2-log-note { font-family: var(--mono); font-size: 12px; }
.wf2-log-actions { display: flex; gap: 4px; }

@media (max-width: 1100px) {
  .wf2-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wf2-tr { grid-template-columns: 22px minmax(0, 1fr) minmax(0, 0.8fr) 110px; }
  .wf2-tr > :nth-child(4), .wf2-tr > :nth-child(6) { display: none; }
  .wf2-row-actions { grid-column: 2 / -1; justify-content: flex-start; }
  .wf2-slots, .wf2-drawer-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wf2-drawer { height: 55%; }
}
@media (max-width: 640px) {
  .wf2-search { min-width: 0; width: 100%; }
  .wf2-log-line { grid-template-columns: 14px 44px 10px minmax(0, 1fr) auto; }
  .wf2-log-trigger, .wf2-log-dur, .wf2-log-stages { display: none; }
  .wf2-slots, .wf2-drawer-cols, .wf2-skill-list, .wf2-log-detail dl { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .wf2-spin, .wf2-drawer { animation: none !important; }
  .wf2-canvas .react-flow__minimap { transition: none; }
  .wf2-switch, .wf2-switch::after { transition: none; }
}
`;

export function V2Styles() {
  return <style>{CSS}</style>;
}
