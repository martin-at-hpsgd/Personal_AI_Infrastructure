"use client";

// Canvas editor (ISA F17): the page half of editing a typed workflow. Every
// change posts to a Pulse route that calls the engine's one validated writer
// with the hash this page read, so a refused edit writes nothing and an edit
// against a stale copy overwrites nothing. The server's sentence is shown
// verbatim. Each success can be undone by putting the previous text back.

import { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus2, FileCode2, Plus, Trash2, Undo2, X } from "lucide-react";
import { getJson } from "./api";
import { postAction } from "./controls-model";
import {
  ADD_REQUIRES,
  NAME_RE,
  PAGE_ADD_KINDS,
  STEP_ID_RE,
  deployLabel,
  fieldsFor,
  newStepFields,
  parseEditorDoc,
  pushUndo,
  refusalText,
  stepPatch,
  toFormText,
  undoRequest,
  type EditorDoc,
  type StepKind,
  type UndoEntry,
} from "./editor-model";
import type { Definition } from "./defs-model";

export type EditMsg = { kind: "ok" | "err"; text: string } | null;

const CLI = "bun LIFEOS/WORKFLOWS/workflow.ts";

export interface Editor {
  doc: EditorDoc | null;
  loadError: string | null;
  busy: boolean;
  msg: EditMsg;
  setMsg: (m: EditMsg) => void;
  undo: UndoEntry[];
  /** Posts one edit of the loaded workflow with its base hash; true when it saved. */
  edit: (route: string, body: Record<string, unknown>, label: string) => Promise<boolean>;
  undoLast: () => Promise<void>;
  createNew: (name: string, template: string, after?: string) => Promise<boolean>;
  reload: () => Promise<void>;
}

/** One editor per canvas: the selected workflow's text and hash, plus a page-wide Undo stack. */
/** A launchd problem after a landed save, from the route's answer (the save itself stands). */
const launchdProblem = (b: Record<string, unknown>): string | null => {
  const l = b.launchd as { error?: unknown } | undefined;
  return l && typeof l.error === "string" ? l.error : null;
};

export function useEditor(name: string | null, onChanged: () => void, onOpen: (name: string | null) => void, graphHash?: string | null): Editor {
  const [doc, setDoc] = useState<EditorDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<EditMsg>(null);
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const current = useRef<string | null>(name);
  current.current = name;
  // Set when this editor itself opens another workflow (New, Undo of New): its message survives until that workflow is open.
  const keepFor = useRef<{ target: string | null } | null>(null);
  const openKeeping = useCallback((n: string | null) => { keepFor.current = { target: n }; onOpen(n); }, [onOpen]);

  const reload = useCallback(async () => {
    const want = current.current;
    if (!want) { setDoc(null); return; }
    try {
      const parsed = parseEditorDoc(await getJson(`/api/workflows/definition?name=${encodeURIComponent(want)}`));
      if (current.current !== want) return;
      if (!parsed.ok) { setDoc(null); setLoadError(`Editing is unavailable: ${parsed.reason}.`); return; }
      setDoc(parsed.value);
      setLoadError(null);
    } catch (e) {
      if (current.current === want) { setDoc(null); setLoadError(`Editing is unavailable: ${e instanceof Error ? e.message : String(e)}.`); }
    }
  }, []);

  useEffect(() => {
    if (keepFor.current) { if (name === keepFor.current.target) keepFor.current = null; }
    else setMsg(null);
    void reload();
  }, [name, reload]);

  // Another control on this page (link, schedule, pause) or a peer changed the file: read it again before the next edit.
  // Fires only when the graphs report a new hash, never on this editor's own reloads.
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    const d = docRef.current;
    if (graphHash && d && d.name === current.current && graphHash !== d.hash) void reload();
  }, [graphHash, reload]);

  const edit = useCallback(async (route: string, body: Record<string, unknown>, label: string) => {
    if (!doc) return false;
    setBusy(true);
    const r = await postAction(route, { ...body, name: doc.name, base_hash: doc.hash });
    if (!r.ok) {
      if (r.body?.refused === "stale") {
        setMsg({ kind: "err", text: `${doc.name} changed after this page read it (another tab, the terminal, or another control here), so nothing was written. The current version is loaded; anything you were typing is kept, so check it and save again.` });
        await reload();
        onChanged();
      } else setMsg({ kind: "err", text: refusalText(r.body, r.reason) });
      setBusy(false);
      return false;
    }
    const b = r.body;
    if (typeof b.previous === "string" && typeof b.hash === "string") {
      setUndo((s) => pushUndo(s, { kind: "put", name: doc.name, text: b.previous as string, hash: b.hash as string, label }));
    }
    const deploy = b.deploy as { state?: string; message?: string } | undefined;
    const warn = Array.isArray(b.warnings) && b.warnings.length ? ` Warnings: ${b.warnings.map((w) => (typeof w === "string" ? w : (w as { message?: string }).message ?? "")).join("; ")}` : "";
    const launchd = launchdProblem(b);
    setMsg({ kind: launchd ? "err" : "ok", text: `${label}: saved.${deploy?.state === "awaiting-approval" && deploy.message ? ` ${deploy.message}` : ""}${warn}${launchd ? ` ${launchd}` : ""}` });
    await reload();
    setBusy(false);
    onChanged();
    return true;
  }, [doc, reload, onChanged]);

  const undoLast = useCallback(async () => {
    const e = undo.at(-1);
    if (!e) return;
    setBusy(true);
    const req = undoRequest(e);
    const r = await postAction(req.route, req.body);
    if (!r.ok) {
      setBusy(false);
      setMsg({ kind: "err", text: r.body?.refused === "stale"
        ? `Undo of "${e.label}" was refused: ${e.name} changed after that edit, so nothing was overwritten.`
        : `Undo of "${e.label}" was refused: ${refusalText(r.body, r.reason)}` });
      return;
    }
    setUndo((s) => s.slice(0, -1));
    const launchd = launchdProblem(r.body);
    setMsg({ kind: launchd ? "err" : "ok", text: `${e.kind === "new" ? `Undid "${e.label}": ${e.name} is removed.` : `Undid "${e.label}" on ${e.name}.`}${launchd ? ` ${launchd}` : ""}` });
    if (e.kind === "new" && current.current === e.name) openKeeping(null);
    await reload();
    setBusy(false);
    onChanged();
  }, [undo, reload, onChanged, openKeeping]);

  const createNew = useCallback(async (newName: string, template: string, after?: string) => {
    setBusy(true);
    const r = await postAction("/api/workflows/new", { name: newName, template, ...(after ? { after } : {}) });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: "err", text: refusalText(r.body, r.reason) }); return false; }
    if (typeof r.body.hash === "string") setUndo((s) => pushUndo(s, { kind: "new", name: newName, hash: r.body.hash as string, label: `New ${newName}` }));
    setMsg({ kind: "ok", text: `Created ${newName} from the ${template} template.` });
    onChanged();
    openKeeping(newName);
    return true;
  }, [onChanged, openKeeping]);

  return { doc, loadError, busy, msg, setMsg, undo, edit, undoLast, createNew, reload };
}

function Note({ msg, onClose }: { msg: EditMsg; onClose?: () => void }) {
  if (!msg) return null;
  return (
    <p className={`wfe-note wfe-${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>
      <span>{msg.text}</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Dismiss"><X size={12} aria-hidden /></button>}
    </p>
  );
}

/* ── The bar above the canvas: New, Undo, and for the selected workflow Add step and Edit YAML ── */

export function EditBar({ ed, defs, selected, yamlOpen, setYamlOpen, selectedStep }: {
  ed: Editor;
  defs: Definition[];
  selected: string | null;
  yamlOpen: boolean;
  setYamlOpen: (v: boolean) => void;
  selectedStep: string | null;
}) {
  const [panel, setPanel] = useState<"new" | "add" | null>(null);
  const last = ed.undo.at(-1);
  const drift = deployLabel(ed.doc?.deploy);
  useEffect(() => { setPanel((p) => (p === "add" && !selected ? null : p)); }, [selected]);
  return (
    <div className="wfe-bar-wrap">
      <div className="wfe-bar" role="toolbar" aria-label="Edit workflows">
        <button type="button" className="wfe-btn" aria-expanded={panel === "new"} onClick={() => setPanel(panel === "new" ? null : "new")}><FilePlus2 size={13} aria-hidden /> New workflow</button>
        {selected && (
          <>
            <span className="wfe-editing">Editing <strong>{selected}</strong>{ed.doc?.runsOn === "cloud" ? " · runs on Cloudflare" : ""}</span>
            {drift && <span className="wfe-drift" data-tone={drift.tone}>{drift.text}</span>}
            <button type="button" className="wfe-btn" aria-expanded={panel === "add"} disabled={!ed.doc} onClick={() => setPanel(panel === "add" ? null : "add")}><Plus size={13} aria-hidden /> Add step</button>
            <button type="button" className="wfe-btn" aria-pressed={yamlOpen} disabled={!ed.doc} onClick={() => setYamlOpen(!yamlOpen)}><FileCode2 size={13} aria-hidden /> {yamlOpen ? "Close YAML" : "Edit YAML"}</button>
          </>
        )}
        <span className="wfe-spacer" />
        {!selected && <span className="wfe-hint">Select a workflow to edit it. Drag from a step&rsquo;s right dot to another step to connect them.</span>}
        <button type="button" className="wfe-btn" disabled={!last || ed.busy} onClick={() => void ed.undoLast()} title={last ? `Undo ${last.label} (${last.name})` : "Nothing to undo yet"}><Undo2 size={13} aria-hidden /> Undo{last ? `: ${last.label}` : ""}</button>
      </div>
      {ed.loadError && selected && <Note msg={{ kind: "err", text: ed.loadError }} />}
      <Note msg={ed.msg} onClose={() => ed.setMsg(null)} />
      {panel === "new" && <NewWorkflowForm ed={ed} defs={defs} onDone={() => setPanel(null)} />}
      {panel === "add" && ed.doc && <AddStepForm ed={ed} after={selectedStep} onDone={() => setPanel(null)} />}
    </div>
  );
}

function NewWorkflowForm({ ed, defs, onDone }: { ed: Editor; defs: Definition[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("scheduled");
  const [after, setAfter] = useState("");
  const templates = ed.doc?.options.templates.length ? ed.doc.options.templates : FALLBACK_TEMPLATES;
  const tpl = templates.find((t) => t.kind === template);
  const taken = defs.some((d) => d.name === name);
  const nameOk = NAME_RE.test(name) && !taken;
  const needsAfter = template === "after-chain";
  const ok = nameOk && (!needsAfter || !!after);
  return (
    <form className="wfe-panel" aria-label="New workflow" onSubmit={async (e) => { e.preventDefault(); if (ok && await ed.createNew(name, template, needsAfter ? after : undefined)) onDone(); }}>
      <label className="wfe-field"><span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="my-workflow" aria-invalid={!!name && !nameOk} autoFocus />
        {name && !nameOk && <em className="wfe-err">{taken ? `${name} is already a workflow.` : "Lowercase letters, digits and dashes, starting with a letter or digit."}</em>}
      </label>
      <label className="wfe-field"><span>Template</span>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((t) => <option key={t.kind} value={t.kind}>{t.kind}</option>)}
        </select>
        {tpl && <em>{tpl.summary}</em>}
      </label>
      {needsAfter && (
        <label className="wfe-field"><span>Runs after</span>
          <select value={after} onChange={(e) => setAfter(e.target.value)}>
            <option value="">choose a workflow</option>
            {defs.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </label>
      )}
      <div className="wfe-actions">
        <button type="submit" className="wfe-btn wfe-primary" disabled={!ok || ed.busy}>{ed.busy ? "Creating…" : "Create"}</button>
        <button type="button" className="wfe-btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

const FALLBACK_TEMPLATES = [
  { kind: "scheduled", summary: "Runs on a daily cron and can also be run by hand.", requires: [] },
  { kind: "event", summary: "Runs when its named event is emitted.", requires: [] },
  { kind: "after-chain", summary: "Runs after another workflow succeeds.", requires: [] },
  { kind: "human-approval", summary: "Drafts, waits for a human decision, then acts.", requires: [] },
  { kind: "model-typed", summary: "One model step with a declared output schema.", requires: [] },
];

function AddStepForm({ ed, after, onDone }: { ed: Editor; after: string | null; onDone: () => void }) {
  const doc = ed.doc!;
  const [id, setId] = useState("");
  const [kind, setKind] = useState<StepKind>("model");
  const [needs, setNeeds] = useState<string[]>(after && doc.steps[after] ? [after] : []);
  const [required, setRequired] = useState("");
  const taken = id in doc.steps;
  const idOk = STEP_ID_RE.test(id) && !taken;
  const req = ADD_REQUIRES[kind];
  const ok = idOk && (!req || required.trim().length > 0);
  const lane = doc.options.lanes[0] ?? "openaiLow";
  return (
    <form className="wfe-panel" aria-label={`Add a step to ${doc.name}`} onSubmit={async (e) => {
      e.preventDefault();
      if (ok && await ed.edit("/api/workflows/step", { op: "add", id, kind, needs, fields: newStepFields(kind, lane, required) }, `Add step ${id}`)) onDone();
    }}>
      <label className="wfe-field"><span>Step id</span>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="summarize" aria-invalid={!!id && !idOk} autoFocus />
        {id && !idOk && <em className="wfe-err">{taken ? `${id} is already a step.` : "A letter, then letters, digits, _ or -."}</em>}
      </label>
      <label className="wfe-field"><span>Kind</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as StepKind)}>
          {PAGE_ADD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <em>Command steps are added from the CLI: <code>{CLI} step add {doc.name} &lt;id&gt; --kind command --argv …</code></em>
      </label>
      {req && (
        <label className="wfe-field"><span>{req.label}</span>
          <input value={required} onChange={(e) => setRequired(e.target.value)} />
        </label>
      )}
      <fieldset className="wfe-field"><legend>Runs after</legend>
        <div className="wfe-checks">
          {Object.keys(doc.steps).map((s) => (
            <label key={s}><input type="checkbox" checked={needs.includes(s)} onChange={(e) => setNeeds(e.target.checked ? [...needs, s] : needs.filter((x) => x !== s))} /> {s}</label>
          ))}
          {Object.keys(doc.steps).length === 0 && <em>No steps yet.</em>}
        </div>
      </fieldset>
      <div className="wfe-actions">
        <button type="submit" className="wfe-btn wfe-primary" disabled={!ok || ed.busy}>{ed.busy ? "Adding…" : "Add step"}</button>
        <button type="button" className="wfe-btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/* ── The step inspector (ISC-158, ISC-160) ── */

export function StepInspector({ ed, stepId, onClose, onRemoved }: { ed: Editor; stepId: string; onClose: () => void; onRemoved: () => void }) {
  const doc = ed.doc!;
  const stored = doc.steps[stepId] ?? {};
  const kind = typeof stored.kind === "string" ? stored.kind : "unknown";
  const fields = fieldsFor(kind);
  const initial = useCallback(() => Object.fromEntries(fields.filter((f) => !f.readOnly).map((f) => [f.key, toFormText(f.shape, stored[f.key])])), [fields, stored]);
  const [form, setForm] = useState<Record<string, string>>(initial);
  const loaded = useRef<Record<string, string>>(form);
  useEffect(() => {
    const next = initial();
    setForm((f) => (JSON.stringify(f) === JSON.stringify(loaded.current) ? next : f));
    loaded.current = next;
  }, [doc.hash, stepId]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = stepPatch(kind, stored, form);
  const dirty = patch.ok ? Object.keys(patch.patch).length > 0 : true;
  const needs = Array.isArray(stored.needs) ? (stored.needs as string[]) : [];
  const others = Object.keys(doc.steps).filter((s) => s !== stepId);
  const dependents = others.filter((s) => Array.isArray(doc.steps[s].needs) && (doc.steps[s].needs as string[]).includes(stepId));

  const save = async () => { if (patch.ok && dirty) await ed.edit("/api/workflows/step", { op: "set", id: stepId, fields: patch.patch }, `Edit ${stepId}`); };
  const toggleNeed = (s: string, on: boolean) => ed.edit("/api/workflows/step", { op: on ? "connect" : "disconnect", from: s, to: stepId }, `${on ? "Connect" : "Disconnect"} ${s} → ${stepId}`);
  const remove = async () => { if (await ed.edit("/api/workflows/step", { op: "remove", id: stepId }, `Remove step ${stepId}`)) onRemoved(); };

  return (
    <aside className="wfd-detail wfe-inspector" aria-label={`Edit step ${stepId} of ${doc.name}`}>
      <header><strong>{stepId}</strong><span className="wfe-kind">{kind}</span><button type="button" onClick={onClose} aria-label="Close inspector"><X size={14} aria-hidden /></button></header>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {fields.map((f) => {
          const id = `wfe-${stepId}-${f.key}`;
          const err = !patch.ok ? patch.errors[f.key] : undefined;
          if (f.readOnly) {
            return (
              <div key={f.key} className="wfe-field">
                <span>{f.label}</span>
                <pre className="wfd-pre mono">{toFormText(f.shape, stored[f.key]) || "none"}</pre>
                <em>Command lines change from the CLI: <code>{CLI} step set {doc.name} {stepId} --{f.key} …</code></em>
              </div>
            );
          }
          const value = form[f.key] ?? "";
          const set = (v: string) => setForm({ ...form, [f.key]: v });
          return (
            <label key={f.key} htmlFor={id} className="wfe-field">
              <span>{f.label}{f.required ? " *" : ""}{f.shape === "list" ? " (one per line)" : ""}</span>
              {f.shape === "lane" ? (
                <select id={id} value={value} onChange={(e) => set(e.target.value)}>
                  {!doc.options.lanes.includes(value) && <option value={value}>{value || "choose a lane"}</option>}
                  {doc.options.lanes.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              ) : f.shape === "text" ? (
                <input id={id} value={value} onChange={(e) => set(e.target.value)} aria-invalid={!!err} />
              ) : (
                <textarea id={id} value={value} onChange={(e) => set(e.target.value)} aria-invalid={!!err} className={f.shape === "schema" ? "mono" : undefined}
                  rows={f.shape === "schema" ? 8 : f.shape === "list" ? 3 : 5} spellCheck={f.shape === "long"} />
              )}
              {f.key === "side_effects" && doc.options.sideEffects.length > 0 && <em>Known: {doc.options.sideEffects.join(", ")}</em>}
              {err && <em className="wfe-err">{err}</em>}
            </label>
          );
        })}
        <div className="wfe-actions">
          <button type="submit" className="wfe-btn wfe-primary" disabled={!dirty || !patch.ok || ed.busy}>{ed.busy ? "Saving…" : "Save step"}</button>
          <button type="button" className="wfe-btn" disabled={!dirty} onClick={() => setForm(initial())}>Reset</button>
        </div>
      </form>
      <fieldset className="wfe-field wfe-needs"><legend>Runs after</legend>
        <div className="wfe-checks">
          {others.map((s) => (
            <label key={s}><input type="checkbox" checked={needs.includes(s)} disabled={ed.busy} onChange={(e) => void toggleNeed(s, e.target.checked)} /> {s}</label>
          ))}
          {others.length === 0 && <em>This is the only step.</em>}
        </div>
      </fieldset>
      <div className="wfe-remove">
        <button type="button" className="wfe-btn wfe-danger" disabled={ed.busy} onClick={() => void remove()} title={dependents.length ? `${dependents.join(", ")} run after this step; the server will refuse until they no longer do.` : undefined}>
          <Trash2 size={13} aria-hidden /> Remove step
        </button>
        {dependents.length > 0 && <em>{dependents.join(", ")} {dependents.length === 1 ? "runs" : "run"} after this step.</em>}
      </div>
    </aside>
  );
}

/* ── The definition editor (ISC-161) ── */

type Check = { state: "idle" } | { state: "checking" } | { state: "valid" } | { state: "invalid"; issues: string[] } | { state: "error"; text: string };

export function YamlEditor({ ed, onClose }: { ed: Editor; onClose: () => void }) {
  const doc = ed.doc!;
  const [text, setText] = useState(doc.text);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const base = useRef({ hash: doc.hash, text: doc.text });
  useEffect(() => {
    if (base.current.hash === doc.hash) return;
    const was = base.current.text;
    base.current = { hash: doc.hash, text: doc.text };
    setText((t) => (t === was ? doc.text : t));
  }, [doc.hash, doc.text]);
  const changed = text !== doc.text;

  useEffect(() => {
    if (!changed) { setCheck({ state: "idle" }); return; }
    setCheck({ state: "checking" });
    let live = true;
    const t = setTimeout(async () => {
      const r = await postAction("/api/workflows/definition", { name: doc.name, text, dry_run: true });
      if (!live) return;
      if (!r.ok) { setCheck({ state: "error", text: r.reason }); return; }
      if (r.body.valid === true) setCheck({ state: "valid" });
      else setCheck({ state: "invalid", issues: (Array.isArray(r.body.issues) ? r.body.issues : []).map((i) => {
        const x = i as { path?: string; message?: string };
        return `${x.path ? `${x.path}: ` : ""}${x.message ?? String(i)}`;
      }) });
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [text, changed, doc.name]);

  return (
    <section className="wfe-yaml" aria-label={`Definition of ${doc.name}`}>
      <header>
        <strong className="mono">{doc.path}</strong>
        <span className="wfe-check" data-state={check.state} role="status">
          {check.state === "idle" ? "No changes" : check.state === "checking" ? "Checking…" : check.state === "valid" ? "Valid; nothing written yet" : check.state === "invalid" ? `${check.issues.length} problem${check.issues.length === 1 ? "" : "s"}` : check.text}
        </span>
        <span className="wfe-spacer" />
        <button type="button" className="wfe-btn wfe-primary" disabled={check.state !== "valid" || ed.busy} onClick={() => void ed.edit("/api/workflows/definition", { text }, "Save YAML")}>{ed.busy ? "Saving…" : "Save"}</button>
        <button type="button" className="wfe-btn" disabled={!changed} onClick={() => setText(doc.text)}>Revert</button>
        <button type="button" className="wfe-btn" onClick={onClose}>Close</button>
      </header>
      <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Definition YAML" rows={Math.min(40, Math.max(14, text.split("\n").length + 2))} />
      {check.state === "invalid" && <ul className="wfe-issues" role="alert">{check.issues.map((i, n) => <li key={n}>{i}</li>)}</ul>}
    </section>
  );
}

export function EditorStyles() {
  return (
    <style>{`
.wfe-bar-wrap{margin:8px 0 4px}
.wfe-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line,#2a2a2a);border-radius:10px;background:var(--panel,#0d1320)}
.wfe-btn{display:inline-flex;gap:5px;align-items:center;font-size:12px;padding:5px 10px;border-radius:7px;border:1px solid #334155;background:#111a2b;color:#e2e8f0;cursor:pointer;white-space:nowrap}
.wfe-btn:hover:not(:disabled){border-color:#3b82f6}
.wfe-btn:disabled{opacity:.45;cursor:not-allowed}
.wfe-btn[aria-pressed="true"],.wfe-btn[aria-expanded="true"]{border-color:#3b82f6;background:#15233d}
.wfe-primary{background:#1d4ed8;border-color:#2563eb;color:#fff}
.wfe-danger{border-color:#7f1d1d;color:#fca5a5}
.wfe-danger:hover:not(:disabled){border-color:#ef4444}
.wfe-editing{font-size:12px;color:#94a3b8;white-space:nowrap}
.wfe-editing strong{color:#e6edf7}
.wfe-drift{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid #475569;color:#94a3b8;white-space:nowrap}
.wfe-drift[data-tone="warn"]{border-color:#f59e0b;color:#fbbf24}
.wfe-hint{font-size:12px;color:#64748b}
.wfe-spacer{flex:1}
.wfe-note{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;font-size:12px;margin:6px 0 0;padding:7px 10px;border-radius:8px;line-height:1.5}
.wfe-note button{background:none;border:none;color:inherit;cursor:pointer;padding:2px}
.wfe-ok{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.35);color:#a7f3d0}
.wfe-err{color:#fca5a5}
p.wfe-err{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.4)}
.wfe-panel{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-start;margin-top:8px;padding:12px;border:1px solid var(--line,#2a2a2a);border-radius:10px;background:var(--panel,#0d1320)}
.wfe-field{display:flex;flex-direction:column;gap:4px;font-size:12px;min-width:0;border:0;padding:0;margin:0 0 10px}
.wfe-panel .wfe-field{margin:0;min-width:180px}
.wfe-field>span,.wfe-field>legend{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;padding:0}
.wfe-field em{font-style:normal;font-size:11px;color:#64748b;line-height:1.45}
.wfe-field em.wfe-err{color:#fca5a5}
.wfe-field code{font-size:10.5px;overflow-wrap:anywhere}
.wfe-field input,.wfe-field select,.wfe-field textarea{font:inherit;font-size:12px;color:#e2e8f0;background:#0a1120;border:1px solid #334155;border-radius:6px;padding:5px 7px;width:100%;box-sizing:border-box}
.wfe-field textarea{resize:vertical}
.wfe-field [aria-invalid="true"]{border-color:#ef4444}
.wfe-checks{display:flex;flex-wrap:wrap;gap:4px 12px}
.wfe-checks label{display:inline-flex;gap:5px;align-items:center;font-size:12px;color:#e2e8f0;text-transform:none;letter-spacing:0}
.wfe-actions{display:flex;gap:8px;align-items:center;flex-basis:100%}
.wfe-inspector form{display:flex;flex-direction:column}
.wfe-inspector header{gap:8px}
.wfe-inspector header strong{flex:1;overflow:hidden;text-overflow:ellipsis}
.wfe-kind{font-size:11px;color:#94a3b8;border:1px solid #334155;border-radius:999px;padding:1px 7px}
.wfe-needs{margin-top:14px;padding-top:10px;border-top:1px solid #1e293b}
.wfe-remove{display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid #1e293b}
.wfe-remove em{font-style:normal;font-size:11px;color:#64748b}
.wfe-yaml{margin:8px 0;border:1px solid var(--line,#2a2a2a);border-radius:10px;background:var(--panel,#0d1320);overflow:hidden}
.wfe-yaml header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid #1e293b;font-size:12px}
.wfe-yaml header strong{font-weight:500;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50ch}
.wfe-check{font-size:11px;color:#94a3b8}
.wfe-check[data-state="valid"]{color:#34d399}
.wfe-check[data-state="invalid"],.wfe-check[data-state="error"]{color:#f87171}
.wfe-yaml textarea{display:block;width:100%;box-sizing:border-box;border:0;outline:none;resize:vertical;background:#070d1a;color:#e2e8f0;font-size:12px;line-height:1.55;padding:10px 12px;tab-size:2}
.wfe-issues{margin:0;padding:8px 12px 10px 28px;font-size:12px;color:#fca5a5;border-top:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.05)}
.wfd-port{fill:#0a1120;stroke:#64748b;stroke-width:1.5;cursor:crosshair}
.wfd-port:hover,.wfd-node:hover .wfd-port{stroke:#3b82f6;fill:#1d4ed8}
.wfd-port-in{fill:#0a1120;stroke:#475569;stroke-width:1.5;pointer-events:none}
.wfd-node[data-drop="1"] rect{stroke:#22c55e;stroke-width:3}
.wfd-drag{stroke:#3b82f6;stroke-width:2;stroke-dasharray:6 4;fill:none;pointer-events:none}
.wfd-edge[data-editable="1"]{cursor:pointer}
.wfd-edge[data-sel="1"] path:first-of-type{stroke:#3b82f6!important;stroke-width:3}
.wfd-unlink{cursor:pointer}
.wfd-unlink rect{fill:#7f1d1d;stroke:#ef4444}
.wfd-unlink text{font-size:11px;fill:#fee2e2;font-weight:600}
.wfd-unlink:hover rect,.wfd-unlink:focus rect{fill:#991b1b}
.wfd-lane-drift{font-size:11px;fill:#fbbf24}
`}</style>
  );
}
