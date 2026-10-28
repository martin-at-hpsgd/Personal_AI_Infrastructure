"use client";

// Page actions for typed workflows. Each control posts to a Pulse route that
// calls the same engine module as the matching `workflow` CLI command, and
// shows the server's own sentence when it refuses (the validator's message for
// an edit). Nothing here writes a file or decides validity on its own.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Link2, Pause, Play, X } from "lucide-react";
import { checkInput, fieldsOf, parsePauseState, parseWaiting, postAction, type PauseState, type PendingApproval } from "./controls-model";
import { getJson } from "./api";
import type { Definition } from "./defs-model";
import { principalTz } from "../principal-tz";

type Msg = { kind: "ok" | "err"; text: string } | null;

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`wfc-note wfc-${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</p>;
}

/* ── Run form (ISC-92, ISC-93) ── */

export function RunForm({ d }: { d: Definition }) {
  const fields = useMemo(() => fieldsOf(d.input), [d.input]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const check = checkInput(fields, values);
  const blocked = !d.valid || d.runs_on !== "local";
  const start = async () => {
    if (!check.ok || blocked) return;
    setBusy(true);
    const r = await postAction("/api/workflows/run", { workflow: d.name, input: check.value });
    setBusy(false);
    setMsg(r.ok ? { kind: "ok", text: `Started ${d.name} (occurrence ${String(r.body.occurrence_key ?? "")}). Follow it in Activity.` } : { kind: "err", text: r.reason });
  };
  return (
    <form className="wfc-box" aria-label={`Run ${d.name}`} onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <strong className="wfc-title">Run now</strong>
      {fields.length === 0 && <p className="wf-muted">Takes no input.</p>}
      {fields.map((f) => {
        const err = !check.ok ? check.errors[f.key] : undefined;
        const id = `run-${d.name}-${f.key}`;
        return (
          <label key={f.key} htmlFor={id} className="wfc-field">
            <span className="mono">{f.key}{f.required ? " *" : ""} <em>{f.type}</em></span>
            {f.type === "boolean" ? (
              <select id={id} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                <option value="">—</option><option value="true">true</option><option value="false">false</option>
              </select>
            ) : (
              <input id={id} value={values[f.key] ?? ""} placeholder={f.type === "json" ? "JSON" : f.enumValues?.join(" | ") ?? ""} aria-invalid={!!err} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
            {err && values[f.key] !== undefined && <span className="wfc-err">{err}</span>}
          </label>
        );
      })}
      <button type="submit" className="wfc-btn" disabled={!check.ok || busy || blocked} title={blocked ? (d.valid ? `Runs on ${d.runs_on}; only local workflows start from here.` : "Fix the validation errors first.") : !check.ok ? "Fill in the required input first." : undefined}>
        <Play size={12} aria-hidden /> {busy ? "Starting…" : "Start"}
      </button>
      <Note msg={msg} />
    </form>
  );
}

/* ── Schedule form (ISC-105) ── */

type SchedAction = "cron" | "every" | "at" | "in" | "remove";

export function ScheduleForm({ d, onChanged }: { d: Definition; onChanged: () => void }) {
  const [action, setAction] = useState<SchedAction>("cron");
  const [a, setA] = useState("");
  const [tz, setTz] = useState(principalTz);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const save = async () => {
    setBusy(true);
    const body =
      action === "cron" ? { name: d.name, action, cron: a, timezone: tz } :
      action === "every" ? { name: d.name, action, every: a } :
      action === "at" ? { name: d.name, action, at: a } :
      action === "in" ? { name: d.name, action, in: a } :
      { name: d.name, action, target: a };
    const r = await postAction("/api/workflows/schedule", body);
    setBusy(false);
    if (r.ok) {
      const launchd = r.body.launchd as { reason?: string } | undefined;
      setMsg({ kind: "ok", text: `Saved.${launchd?.reason ? ` launchd: ${launchd.reason}.` : ""}` });
      onChanged();
    } else setMsg({ kind: "err", text: r.reason });
  };
  const placeholder = { cron: "0 9 * * *", every: "90m, 2h, 1d", at: "2026-10-01T09:00:00-07:00", in: "20m, 2h", remove: "schedule, interval, once or a position" }[action];
  return (
    <form className="wfc-box" aria-label={`Schedule ${d.name}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <strong className="wfc-title">Schedule</strong>
      <div className="wfc-inline">
        <select aria-label="Schedule kind" value={action} onChange={(e) => { setAction(e.target.value as SchedAction); setMsg(null); }}>
          <option value="cron">cron</option><option value="every">every</option><option value="at">once at</option><option value="in">once in</option><option value="remove">remove</option>
        </select>
        <input aria-label="Schedule value" value={a} placeholder={placeholder} onChange={(e) => setA(e.target.value)} className="mono" />
        {action === "cron" && <input aria-label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} className="mono" />}
        <button type="submit" className="wfc-btn" disabled={busy || a.trim() === ""}>{busy ? "Saving…" : "Save"}</button>
      </div>
      <Note msg={msg} />
    </form>
  );
}

/* ── runs_on and pause (ISC-106, ISC-69) ── */

export function RunsOnControl({ d, onChanged }: { d: Definition; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(d.runs_on === "cloud" ? { kind: "ok", text: 'On cloud. Any deploy waits for your "y"; nothing deploys from here.' } : null);
  const change = async (target: string) => {
    setBusy(true);
    const r = await postAction("/api/workflows/runs-on", { name: d.name, runs_on: target });
    setBusy(false);
    if (r.ok) {
      const deploy = r.body.deploy as { message?: string } | undefined;
      setMsg({ kind: "ok", text: deploy?.message ?? "Saved." });
      onChanged();
    } else setMsg({ kind: "err", text: r.reason });
  };
  return (
    <div className="wfc-box">
      <strong className="wfc-title">Runs on</strong>
      <div className="wfc-inline">
        <select aria-label={`Where ${d.name} runs`} value={d.runs_on} disabled={busy} onChange={(e) => void change(e.target.value)}>
          <option value="local">local</option><option value="cloud">cloud</option>
        </select>
        {d.runs_on === "cloud" && <span className="wfc-pending">deploy waiting for your “y”</span>}
      </div>
      <Note msg={msg} />
    </div>
  );
}

export function PauseButton({ d, onChanged }: { d: Definition; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    const r = await postAction(d.enabled ? "/api/workflows/pause" : "/api/workflows/resume", { name: d.name });
    setBusy(false);
    if (r.ok) { setErr(null); onChanged(); } else setErr(r.reason);
  };
  return (
    <span className="wfc-pause-wrap">
      <button type="button" className="wfc-btn wfc-small" disabled={busy} onClick={(e) => { e.stopPropagation(); void toggle(); }} aria-label={`${d.enabled ? "Pause" : "Resume"} ${d.name}`}>
        {d.enabled ? <><Pause size={12} aria-hidden /> Pause</> : <><Play size={12} aria-hidden /> Resume</>}
      </button>
      {err && <span className="wfc-err" role="alert">{err}</span>}
    </span>
  );
}

/* ── Link on canvas (ISC-22) ── */

export function LinkPanel({ defs, onChanged }: { defs: Definition[]; onChanged: () => void }) {
  const names = defs.map((d) => d.name);
  const [up, setUp] = useState(names[0] ?? "");
  const [down, setDown] = useState(names[1] ?? names[0] ?? "");
  const [status, setStatus] = useState("succeeded");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [schemas, setSchemas] = useState<{ up: unknown; down: unknown } | null>(null);
  const link = async () => {
    setBusy(true);
    const r = await postAction("/api/workflows/link", { upstream: up, downstream: down, status });
    setBusy(false);
    if (r.ok) { setSchemas(null); setMsg({ kind: "ok", text: `Linked: ${down} runs after ${up} (${status}).` }); onChanged(); return; }
    setMsg({ kind: "err", text: r.reason });
    setSchemas(r.body && ("upstream_output" in r.body || "downstream_input" in r.body) ? { up: r.body.upstream_output, down: r.body.downstream_input } : null);
  };
  if (names.length < 2) return null;
  return (
    <form className="wfc-box wfc-link" aria-label="Link two workflows" onSubmit={(e) => { e.preventDefault(); void link(); }}>
      <strong className="wfc-title"><Link2 size={13} aria-hidden /> Link on canvas</strong>
      <div className="wfc-inline">
        <select aria-label="Upstream workflow" value={up} onChange={(e) => setUp(e.target.value)}>{names.map((n) => <option key={n}>{n}</option>)}</select>
        <span className="wf-muted">then</span>
        <select aria-label="Downstream workflow" value={down} onChange={(e) => setDown(e.target.value)}>{names.map((n) => <option key={n}>{n}</option>)}</select>
        <span className="wf-muted">when it</span>
        <select aria-label="Upstream outcome" value={status} onChange={(e) => setStatus(e.target.value)}><option>succeeded</option><option>failed</option><option>completed</option></select>
        <button type="submit" className="wfc-btn" disabled={busy || up === down}>{busy ? "Linking…" : "Link"}</button>
      </div>
      <Note msg={msg} />
      {schemas && (
        <div className="wfc-schemas">
          <div><span className="mono">{up} output</span><pre>{JSON.stringify(schemas.up, null, 2)}</pre></div>
          <div><span className="mono">{down} input</span><pre>{JSON.stringify(schemas.down, null, 2)}</pre></div>
        </div>
      )}
    </form>
  );
}

/* ── Waiting for you (ISC-129) ── */

export function WaitingPanel({ tick }: { tick: number }) {
  const [rows, setRows] = useState<PendingApproval[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const p = parseWaiting(await getJson("/api/workflows/waiting"));
      if (p.ok) { setRows(p.value); setProblem(null); } else setProblem(p.reason);
    } catch (e) { setProblem(`/api/workflows/waiting failed: ${e instanceof Error ? e.message : String(e)}`); }
  }, []);
  useEffect(() => { void load(); }, [load, tick]);
  const answer = async (w: PendingApproval, approved: boolean) => {
    setBusy(`${w.run_id}/${w.step_id}`);
    const r = await postAction("/api/workflows/answer", { runId: w.run_id, stepId: w.step_id, approved });
    setBusy(null);
    setMsg(r.ok ? { kind: "ok", text: `${approved ? "Approved" : "Declined"} ${w.workflow} · ${w.step_id}; the run is resuming.` } : { kind: "err", text: r.reason });
    void load();
  };
  if (problem) return <p className="wfc-note wfc-err" role="alert">Waiting-for-you list unavailable: {problem}</p>;
  if (!rows || rows.length === 0) return msg ? <Note msg={msg} /> : null;
  return (
    <section className="wfc-waiting" aria-label="Waiting for you">
      <strong className="wfc-title">Waiting for you · {rows.length}</strong>
      {rows.map((w) => {
        const key = `${w.run_id}/${w.step_id}`;
        return (
          <div key={key} className="wfc-wait-row">
            <span className="mono wfc-wf">{w.workflow}</span>
            <span className="wf-muted mono">{w.step_id}</span>
            <span className="wfc-prompt">{w.prompt || "No prompt given."}</span>
            <button type="button" className="wfc-btn wfc-approve" disabled={busy === key} onClick={() => void answer(w, true)} aria-label={`Approve ${w.workflow} ${w.step_id}`}><Check size={12} aria-hidden /> Approve</button>
            <button type="button" className="wfc-btn wfc-decline" disabled={busy === key} onClick={() => void answer(w, false)} aria-label={`Decline ${w.workflow} ${w.step_id}`}><X size={12} aria-hidden /> Decline</button>
          </div>
        );
      })}
      <Note msg={msg} />
    </section>
  );
}

/* ── Global pause indicator (ISC-123) ── */

export function GlobalPauseIndicator({ tick }: { tick: number }) {
  const [s, setS] = useState<PauseState | null>(null);
  useEffect(() => {
    let live = true;
    getJson("/api/workflows/pause-state").then((raw) => { if (live) setS(parsePauseState(raw)); }).catch(() => { if (live) setS(null); });
    return () => { live = false; };
  }, [tick]);
  if (!s || !s.available || !s.paused) return null;
  return (
    <span className="wfc-global-pause" role="status" title="workflow pause --all is engaged; no local workflow starts a run until workflow resume --all.">
      <Pause size={12} aria-hidden /> All workflows paused
    </span>
  );
}

export function ControlsStyles() {
  return (
    <style>{`
.wfc-box{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:10px 12px;margin:8px 0;display:flex;flex-direction:column;gap:8px}
.wfc-title{font-size:12px;letter-spacing:.02em;display:inline-flex;gap:6px;align-items:center}
.wfc-inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wfc-box input,.wfc-box select{background:transparent;color:inherit;border:1px solid var(--line,#333);border-radius:6px;padding:4px 8px;font-size:12px;min-width:0}
.wfc-box input:focus-visible,.wfc-box select:focus-visible,.wfc-btn:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
.wfc-field{display:flex;flex-direction:column;gap:4px;font-size:12px;max-width:420px}
.wfc-field em{opacity:.6;font-style:normal}
.wfc-btn{display:inline-flex;gap:4px;align-items:center;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line,#333);background:transparent;color:inherit;cursor:pointer;align-self:flex-start}
.wfc-btn:disabled{opacity:.45;cursor:not-allowed}
.wfc-small{padding:3px 8px}
.wfc-note{font-size:12px;margin:0}
.wfc-ok{color:var(--ok,#22c55e)}
.wfc-err{color:var(--err,#ef4444);font-size:12px}
.wfc-pending{font-size:11px;border:1px solid var(--warn,#f59e0b);color:var(--warn,#f59e0b);border-radius:999px;padding:2px 8px}
.wfc-schemas{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
.wfc-schemas pre{font-size:11px;margin:4px 0 0;padding:8px;border:1px solid var(--line,#333);border-radius:6px;overflow:auto;max-height:180px}
.wfc-waiting{border:1px solid var(--warn,#f59e0b);border-radius:10px;padding:10px 12px;margin:10px 0;display:flex;flex-direction:column;gap:6px;background:rgba(245,158,11,.06)}
.wfc-wait-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px}
.wfc-wf{font-weight:600}
.wfc-prompt{flex:1 1 240px;min-width:0}
.wfc-approve{border-color:var(--ok,#22c55e)}
.wfc-decline{border-color:var(--err,#ef4444)}
.wfc-global-pause{display:inline-flex;white-space:nowrap;flex-shrink:0;line-height:1.2;gap:6px;align-items:center;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--warn,#f59e0b);color:var(--warn,#f59e0b)}
.wfc-pause-wrap{display:inline-flex;gap:6px;align-items:center}
.wfc-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}
`}</style>
  );
}
