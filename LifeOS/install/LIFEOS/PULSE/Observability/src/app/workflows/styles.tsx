/**
 * Workflows page styles. Every selector carries the `wf-` prefix so nothing
 * here can reach another page; colours come from the Pulse tokens in
 * globals.css plus the runtime/executor palettes in shared.tsx (set inline).
 */

const CSS = `
.wf-section { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.wf-muted { color: var(--ink-3); }
.wf-center { display: flex; justify-content: center; padding-bottom: 20px; }
.wf-generated { font-size: 12px; font-family: 'triplicate-a-code', monospace; }
.wf-break { overflow-wrap: break-word; }
.wf-inline { display: inline-flex; align-items: center; gap: 7px; }
.wf-block { display: block; margin-top: 2px; }
/* Header actions stay on the right beside the title, as on other Pulse pages. */
.pulse-page-header.wf-header { flex-wrap: nowrap; align-items: flex-end; }
.pulse-page-header.wf-header > div:first-child { flex: 1 1 auto; }

/* Buttons that read as text */
.wf-linkbtn { background: none; border: 0; padding: 2px 4px; color: var(--accent-soft); cursor: pointer; font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.wf-linkbtn:hover { color: var(--ink-1); }
.wf-refresh { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex-shrink: 0; padding: 5px 12px; border-radius: 999px; font-size: 12px; cursor: pointer;
  color: var(--ink-2); background: rgba(37,139,255,0.10); border: 1px solid rgba(128,204,255,0.28); }
.wf-refresh:hover:not(:disabled) { color: var(--ink-1); border-color: var(--line-3); }
.wf-refresh:disabled { opacity: 0.6; cursor: default; }
.wf-spin { animation: wf-spin 1s linear infinite; }
@keyframes wf-spin { to { transform: rotate(360deg); } }
:where(.wf-refresh, .wf-linkbtn, .wf-row, .wf-chip, .wf-fold, .wf-legend-item, .wf-band-note, .wf-reclink, .wf-skill-tile, .wf-close, .wf-group-head, .wf-search-clear):focus-visible {
  outline: 2px solid var(--accent-blue); outline-offset: 2px; }

/* Notices: sample data, reload errors, collector errors */
.wf-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 12px; border-radius: 10px; font-size: 13px; color: var(--ink-2);
  border: 1px solid var(--line-1); background: rgba(255,255,255,0.02); }
.wf-notice[data-tone="err"] { border-color: rgba(248,113,113,0.45); background: rgba(248,113,113,0.07); }
.wf-notice[data-tone="warn"] { border-color: rgba(251,191,36,0.32); background: rgba(251,191,36,0.05); }
.wf-notice[data-tone="info"] { border-color: rgba(128,204,255,0.3); background: rgba(37,139,255,0.06); }
.wf-notice code, .wf-errors .mono { font-family: 'triplicate-a-code', monospace; font-size: 12px; }
.wf-notice > .wf-fold { padding: 0; }
.wf-errors { width: 100%; list-style: none; margin: 4px 0 0; padding: 0 0 0 22px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.wf-errors li { display: flex; gap: 10px; flex-wrap: wrap; }
.wf-errors li .mono { color: var(--warn); }

.wf-loading { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; font-size: 13px; }
.wf-skeleton { display: block; height: 12px; border-radius: 6px; background: linear-gradient(90deg, rgba(128,204,255,0.06), rgba(128,204,255,0.14), rgba(128,204,255,0.06));
  background-size: 200% 100%; animation: wf-shimmer 1.4s ease-in-out infinite; }
@keyframes wf-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* ── Overview ── */
.wf-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.wf-coverage { display: flex; flex-direction: column; gap: 6px; }
.wf-coverage-track { display: block; height: 4px; border-radius: 3px; background: var(--line-1); overflow: hidden; }
.wf-coverage-track > span { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-blue), var(--accent-soft)); border-radius: 3px; }
.wf-bands { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.wf-band { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wf-band-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 12px; }
.wf-eyebrow { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); font-family: 'concourse-c3', 'concourse-t3', sans-serif; }
.wf-stackbar { display: flex; gap: 2px; height: 10px; border-radius: 5px; overflow: hidden; background: var(--line-1); }
.wf-stackbar > span { display: block; min-width: 3px; height: 100%; }
.wf-stackbar-empty { flex: 1; }
.wf-legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 2px 14px; }
.wf-legend-item { display: grid; grid-template-columns: 12px auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; text-align: left;
  padding: 6px 8px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: var(--ink-1); font-size: 13px; cursor: pointer; }
.wf-legend-item[data-static="1"] { cursor: default; }
.wf-legend-item[data-zero="1"] { opacity: 0.5; }
.wf-band-note { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: auto; padding: 8px 8px 0; border: 0; border-top: 1px solid var(--line-1);
  background: transparent; color: var(--ink-3); font-size: 12.5px; text-align: left; cursor: pointer; }
.wf-band-note .mono { color: var(--ink-1); }
.wf-band-note:hover { color: var(--ink-1); }
.wf-band-note > span:last-child { margin-left: auto; }
.wf-legend-item:not([data-static="1"]):hover { background: rgba(255,255,255,0.035); border-color: var(--line-1); }
.wf-legend-item[data-active="1"] { background: rgba(37,139,255,0.10); border-color: rgba(128,204,255,0.35); }
.wf-legend-item .mono { justify-self: end; color: var(--ink-2); font-size: 12px; }
.wf-legend-swatch { width: 10px; height: 10px; border-radius: 2px; }
.wf-legend-label { font-weight: 500; }
.wf-legend-blurb { grid-column: 2 / -1; font-size: 11.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── Panels with rows run edge to edge ── */
.wf-panel-flush { padding: 0; overflow: hidden; }

/* ── Attention ── */
.wf-allclear { display: flex; align-items: center; gap: 10px; padding: 14px 18px; font-size: 14px; color: var(--ink-2); }
.wf-findings { list-style: none; margin: 0; padding: 0; }
.wf-finding { display: grid; grid-template-columns: 78px 108px minmax(0, 1fr) auto; align-items: center; gap: 6px 14px; padding: 11px 18px; font-size: 14px;
  border-top: 1px solid var(--line-1); }
.wf-findings > .wf-finding:first-child { border-top: 0; }
.wf-finding[data-quiet="1"] { opacity: 0.62; font-size: 13px; }
.wf-findings-card .wf-finding { grid-template-columns: 78px minmax(0, 1fr) auto; padding: 9px 0; }
.wf-sev { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-2); }
.wf-kind { font-size: 11.5px; color: var(--ink-3); white-space: nowrap; }
.wf-finding-text { color: var(--ink-1); line-height: 1.45; min-width: 0; }
.wf-finding-links { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: 440px; }
.wf-reclink { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; color: var(--ink-1);
  border: 1px solid var(--line-2); background: rgba(255,255,255,0.03); cursor: pointer; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.wf-reclink:hover { filter: brightness(1.25); }
.wf-reclink[data-missing="1"] { cursor: default; color: var(--ink-3); border-style: dashed; }
.wf-reclink .mono { font-size: 11px; }
.wf-reclink-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-reclink-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.wf-acked { border-top: 1px solid var(--line-1); }
.wf-fold { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; color: var(--ink-3); cursor: pointer;
  padding: 10px 18px; font-size: 13px; }
.wf-fold:hover { color: var(--ink-1); }
.wf-fold-lg { color: var(--ink-2); font-size: 14px; padding: 14px 18px; }
.wf-fold-lg strong { color: var(--ink-1); font-weight: 600; }

/* ── Catalog ── */
.wf-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 14px 18px; border-bottom: 1px solid var(--line-1); background: var(--surface-1); }
.wf-search { display: flex; align-items: center; gap: 8px; flex: 0 1 340px; min-width: 200px; padding: 6px 10px; border-radius: 8px; background: rgba(5,11,23,0.6);
  border: 1px solid var(--line-2); color: var(--ink-3); }
.wf-search:focus-within { border-color: var(--line-3); }
.wf-search input { flex: 1; min-width: 0; background: transparent; border: 0; outline: none; color: var(--ink-1); font-size: 13px; }
.wf-search input::placeholder { color: var(--ink-3); }
.wf-search input::-webkit-search-cancel-button { display: none; }
.wf-search-clear { background: none; border: 0; color: var(--ink-3); cursor: pointer; padding: 0; display: flex; }
.wf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wf-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: 12px; cursor: pointer; color: var(--ink-2);
  background: rgba(168,165,200,0.06); border: 1px solid rgba(168,165,200,0.18); }
.wf-chip .mono { font-size: 11px; opacity: 0.75; }
.wf-chip:hover { color: var(--ink-1); }
.wf-chip[data-active="1"] { color: var(--ink-1); background: rgba(37,139,255,0.14); border-color: rgba(128,204,255,0.5); }
.wf-chip-swatch { width: 8px; height: 8px; border-radius: 2px; }

/* Rows: status, title, the compact strip, last run, card slots. Heads use the same grid and cell classes. */
.wf-heads, .wf-row { display: grid; align-items: center; column-gap: 14px;
  grid-template-columns: 14px minmax(170px, 1fr) minmax(0, 3.4fr) 72px 88px;
  grid-template-areas: "dot title strip last card"; }
.wf-heads { padding: 7px 18px 6px 21px; border-bottom: 1px solid var(--line-1); background: rgba(5,11,23,0.28); }
.wf-heads > span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); font-weight: 600; }
.wf-rows { list-style: none; margin: 0; padding: 0; }
.wf-row { width: 100%; text-align: left; padding: 8px 18px; border: 0; border-left: 3px solid transparent; border-top: 1px solid rgba(27,48,77,0.55);
  background: transparent; color: var(--ink-1); cursor: pointer; font-size: 13.5px; transition: background-color 140ms ease-out; }
.wf-rows > li:first-child > .wf-row { border-top: 0; }
.wf-row:hover { background: rgba(37,139,255,0.06); }
.wf-row[data-health="off"] { opacity: 0.55; }
.wf-cell-dot { grid-area: dot; display: flex; align-items: center; justify-content: center; }
.wf-cell-title { grid-area: title; display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.wf-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-sub { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; }
.wf-sub > span { overflow: hidden; text-overflow: ellipsis; }
.wf-sub-group { flex: none; max-width: 45%; color: var(--ink-2); }
.wf-sub-purpose { flex: 1 1 auto; min-width: 0; }
.wf-tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3);
  border: 1px solid var(--line-2); flex: none; }
.wf-cell-strip { grid-area: strip; display: flex; min-width: 0; }
.wf-cell-last { grid-area: last; color: var(--ink-2); font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wf-cell-last[data-status="error"] { color: var(--err); }
.wf-cell-card { grid-area: card; display: flex; justify-content: flex-end; }

.wf-group-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 18px; border: 0; border-top: 1px solid var(--line-1);
  color: var(--ink-2); cursor: pointer; text-align: left; font-size: 13px; }
.wf-toolbar + .wf-group > .wf-group-head { border-top: 0; }
.wf-group-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; display: inline-block; }
.wf-group-name { color: var(--ink-1); font-weight: 600; font-size: 14px; }
.wf-group-blurb { color: var(--ink-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-group-counts { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 12px; }
.wf-count { display: inline-flex; align-items: center; gap: 5px; font-family: 'triplicate-a-code', monospace; }
.wf-empty-row { padding: 16px 18px; font-size: 13px; color: var(--ink-3); }

.wf-complete { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-2); }
.wf-complete-ticks { display: inline-flex; gap: 2px; }
.wf-complete-ticks > span { width: 5px; height: 12px; border-radius: 1.5px; background: transparent; border: 1px dashed rgba(130,157,187,0.5); }
.wf-complete-ticks > span[data-on="1"] { background: var(--accent-soft); border: 1px solid var(--accent-soft); opacity: 0.85; }
.wf-exec-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; font-size: 11.5px; color: var(--ink-2);
  background: rgba(255,255,255,0.03); border: 1px solid var(--line-1); white-space: nowrap; }

/* On demand */
.wf-ondemand { border-top: 1px solid var(--line-1); }
.wf-skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; padding: 14px 18px; border-bottom: 1px solid var(--line-1); }
.wf-skill-tile { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 11px; border-radius: 8px; cursor: pointer; font-size: 13px;
  color: var(--ink-2); background: rgba(148,163,184,0.05); border: 1px solid rgba(148,163,184,0.16); text-align: left; }
.wf-skill-tile:hover { color: var(--ink-1); border-color: rgba(148,163,184,0.4); }
.wf-skill-tile[data-active="1"] { color: var(--ink-1); background: rgba(148,163,184,0.14); border-color: rgba(148,163,184,0.6); }
.wf-skill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-skill-head { display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid var(--line-1);
  background: linear-gradient(90deg, rgba(148,163,184,0.10), transparent 60%); font-size: 12px; }

/* ── The card ── */
.wf-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(3,8,20,0.62); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); animation: wf-fade 180ms ease-out both; }
.wf-drawer { position: relative; width: min(1000px, 100%); max-height: calc(100dvh - 48px); overflow-y: auto; border-radius: 16px;
  animation: wf-rise 240ms cubic-bezier(0.16, 1, 0.3, 1) both; color: var(--ink-1); }
@keyframes wf-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes wf-rise { from { transform: translateY(12px) scale(0.985); opacity: 0; } to { transform: none; opacity: 1; } }
.wf-drawer-top { padding: 18px 28px 20px; border-bottom: 1px solid var(--line-1); }
.wf-drawer-eyebrow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
.wf-drawer-eyebrow .mono { font-size: 12px; color: var(--ink-3); overflow-wrap: break-word; }
.wf-sep { color: var(--line-3); opacity: 0.6; }
.wf-drawer-health { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; font-size: 12px; color: var(--ink-2); }
.wf-close { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; color: var(--ink-2);
  background: rgba(255,255,255,0.04); border: 1px solid var(--line-2); margin-left: 6px; }
.wf-close:hover { color: var(--ink-1); border-color: var(--line-3); }
.wf-sop { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-top: 14px; padding: 8px 12px; border-radius: 9px; font-size: 13px;
  color: var(--accent-soft); background: rgba(37,139,255,0.08); border: 1px solid rgba(128,204,255,0.28); }
.wf-sop[data-empty="1"] { color: var(--ink-3); background: transparent; border: 1.5px dashed rgba(130,157,187,0.4); }
.wf-sop-label { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; }
.wf-sop-value { display: inline-flex; flex-wrap: wrap; gap: 4px 10px; color: var(--ink-1); min-width: 0; overflow-wrap: break-word; }
.wf-sop-value .mono { font-size: 12px; }
.wf-sop[data-inferred="1"] .wf-sop-value, .wf-purpose-title[data-inferred="1"], .wf-box[data-inferred="1"] .wf-box-text, .wf-steps[data-inferred="1"] .wf-step-label { text-decoration: underline dotted; text-decoration-color: var(--ink-3); text-underline-offset: 3px; }
.wf-dashed-text { color: var(--ink-3) !important; font-style: italic; }
.wf-purpose { margin-top: 16px; }
.wf-purpose-kicker { font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); font-family: 'concourse-c3', 'concourse-t3', sans-serif; }
.wf-purpose-title { margin: 4px 0 0; text-transform: none; letter-spacing: -0.005em; font-size: 1.7rem; line-height: 1.22; color: var(--ink-1); }
.wf-purpose-title[data-empty="1"] { font-size: 1.15rem; color: var(--ink-3); font-style: italic; padding: 8px 12px; border: 1.5px dashed rgba(130,157,187,0.4);
  border-radius: 9px; display: inline-block; }
.wf-drawer-body { padding: 22px 28px 40px; display: flex; flex-direction: column; gap: 22px; }

/* Boxes size to their content and share one row height, so a short stage never
   stretches to the transforms list and no box is mostly empty space. */
.wf-strip { display: flex; align-items: flex-start; min-width: 0; }
.wf-stage-wrap { display: flex; flex: 1 1 0; min-width: 0; }
.wf-stage { display: flex; flex-direction: column; gap: 7px; flex: 1 1 0; min-width: 0; }
.wf-stage-label { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); padding-left: 2px; }
.wf-box { display: flex; flex-direction: column; justify-content: center; gap: 3px; min-height: 64px; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.4;
  background: var(--surface-1); border: 1px solid var(--line-2); box-shadow: inset 0 1px 0 var(--glass-edge); overflow-wrap: break-word; }
.wf-box[data-empty="1"] { align-items: center; text-align: center; color: var(--ink-3); font-style: italic; font-size: 12.5px; white-space: nowrap;
  border: 1.5px dashed rgba(130,157,187,0.42); box-shadow: none;
  background: repeating-linear-gradient(135deg, rgba(130,157,187,0.045) 0 6px, transparent 6px 12px); }
.wf-box-text { color: var(--ink-1); }
.wf-box-strong { font-size: 15px; font-weight: 600; color: var(--ink-1); }
.wf-box-meta { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); }
.wf-connector { flex: none; width: 30px; display: flex; align-items: center; height: 64px; margin-top: 22px; color: var(--line-3); }
.wf-connector svg { width: 100%; height: 12px; overflow: visible; }
.wf-flow { stroke: currentColor; stroke-width: 1.4; stroke-dasharray: 3 4; animation: wf-flow 1.4s linear infinite; }
@keyframes wf-flow { to { stroke-dashoffset: -14; } }
.wf-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.wf-step { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 8px; row-gap: 2px; padding: 7px 10px 7px 11px; border-radius: 8px; border: 1px solid; }
.wf-step-n { grid-row: 1 / 3; font-size: 11px; color: var(--ink-3); padding-top: 1px; }
.wf-step-label { font-size: 13px; color: var(--ink-1); line-height: 1.35; }
.wf-step-exec { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; }
.wf-strip-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; margin-top: -10px; font-size: 12px; }
.wf-legend-inline { display: flex; flex-wrap: wrap; gap: 6px; }

/* ── Compact strip: the same strip at one box height, inside a catalog row ── */
.wf-strip[data-compact="1"] { flex: 1 1 auto; align-items: stretch; }
.wf-strip[data-compact="1"] .wf-stage { gap: 0; }
.wf-strip[data-compact="1"] .wf-box { min-height: 0; height: 40px; padding: 4px 8px; gap: 1px; border-radius: 7px; font-size: 11.5px; line-height: 1.3;
  overflow: hidden; overflow-wrap: normal; }
.wf-strip[data-compact="1"] .wf-box-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.wf-strip[data-compact="1"] .wf-box-strong { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-strip[data-compact="1"] .wf-box-meta { font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-strip[data-compact="1"] .wf-box[data-empty="1"] { font-size: 11px; padding: 4px 6px; }
.wf-strip[data-compact="1"] .wf-box[data-empty="1"] > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.wf-strip[data-compact="1"] .wf-connector { width: 14px; height: 40px; margin-top: 0; }
.wf-strip[data-compact="1"] .wf-steps { flex-direction: row; gap: 3px; height: 40px; }
.wf-strip[data-compact="1"] .wf-step { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 3px 7px 3px 9px; border-radius: 7px; }
.wf-strip[data-compact="1"] .wf-step-icon { flex: none; }
.wf-strip[data-compact="1"] .wf-step-label { min-width: 0; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-strip[data-compact="1"] .wf-step-more { flex: none; justify-content: center; padding: 3px 8px; font-family: triplicate-a-code, monospace; font-size: 11.5px;
  color: var(--ink-2); border-color: var(--line-2); background: rgba(255,255,255,0.03); }
.wf-strip-heads[data-compact="1"] { align-items: center; }
.wf-strip-heads .wf-stage-wrap { display: block; padding-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-strip-heads[data-compact="1"] > .wf-connector-head { height: auto; align-items: center; justify-content: center; color: var(--line-3); letter-spacing: 0; }
.wf-exec-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-left: auto; font-size: 11.5px; color: var(--ink-2); }
.wf-exec-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.wf-exec-legend-swatch { width: 12px; height: 10px; border-radius: 3px; border: 1px solid; }

.wf-facts-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.wf-facts { margin: 0; padding: 14px 16px; border-radius: 10px; background: rgba(5,11,23,0.35); border: 1px solid var(--line-1); display: flex; flex-direction: column; gap: 8px; }
.wf-facts-title { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
.wf-fact { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; font-size: 13px; align-items: baseline; }
.wf-fact dt { color: var(--ink-3); font-size: 12px; }
.wf-fact dd { margin: 0; color: var(--ink-1); min-width: 0; overflow-wrap: break-word; }
.wf-fact .mono { font-size: 12px; }
.wf-card-section { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.wf-card-section .wf-finding-links { justify-content: flex-start; max-width: none; }

/* ── Narrow screens ── */
@media (max-width: 1100px) {
  .wf-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wf-heads, .wf-row { grid-template-columns: 14px minmax(0, 1fr) 72px 88px; grid-template-areas: "dot title last card" ". strip strip strip"; row-gap: 7px; }
  .wf-exec-legend { margin-left: 0; }
}
@media (max-width: 860px) {
  .wf-bands { grid-template-columns: minmax(0, 1fr); }
  .wf-strip[data-compact="0"] { flex-direction: column; }
  .wf-strip[data-compact="0"] > .wf-stage-wrap { flex: none !important; }
  .wf-strip[data-compact="0"] .wf-box { min-height: 44px; }
  .wf-strip[data-compact="0"] > .wf-connector { width: 100%; height: 26px; margin-top: 0; justify-content: center; }
  .wf-strip[data-compact="0"] > .wf-connector svg { width: 26px; transform: rotate(90deg); }
  .wf-facts-grid { grid-template-columns: minmax(0, 1fr); }
  .wf-finding { grid-template-columns: 78px minmax(0, 1fr); }
  .wf-finding .wf-kind { grid-column: 2; grid-row: 1; }
  .wf-finding .wf-finding-text { grid-column: 1 / -1; }
  .wf-finding .wf-finding-links { grid-column: 1 / -1; justify-content: flex-start; }
}
@media (max-width: 720px) {
  .pulse-page-header.wf-header { flex-wrap: wrap; }
  .wf-heads { display: none; }
  .wf-row { grid-template-columns: 14px minmax(0, 1fr) auto; grid-template-areas: "dot title last" ". strip card"; }
  .wf-strip[data-compact="1"] > .wf-connector, .wf-strip[data-compact="1"] > .wf-stage-wrap:not([data-stage="transforms"]) { display: none; }
  .wf-overlay { padding: 0; }
  .wf-drawer { border-radius: 0; max-height: 100dvh; height: 100dvh; }
  .wf-drawer-top, .wf-drawer-body { padding-left: 16px; padding-right: 16px; }
  .wf-toolbar, .wf-fold, .wf-row, .wf-group-head, .wf-finding, .wf-skill-grid { padding-left: 14px; padding-right: 14px; }
}
@media (max-width: 520px) {
  .wf-tiles { grid-template-columns: minmax(0, 1fr); }
  .wf-legend { grid-template-columns: minmax(0, 1fr); }
  .wf-group-blurb { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .wf-flow, .wf-spin, .wf-skeleton, .wf-overlay, .wf-drawer { animation: none !important; }
  .wf-row { transition: none; }
}
`;

export function WorkflowsStyles() {
  return <style>{CSS}</style>;
}
