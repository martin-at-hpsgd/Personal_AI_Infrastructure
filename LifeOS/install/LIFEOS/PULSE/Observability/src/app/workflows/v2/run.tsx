"use client";

/**
 * Run Now: one provider owns eligibility, the confirmation dialog and the
 * inline results, so the Dashboard row, the canvas drawer and the card all
 * show the same state for the same workflow.
 *
 * The server decides (POST /api/workflows/run re-checks the id against the
 * current inventory). The page only mirrors its eligibility map so the button
 * can be disabled with the server's own reason.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, CircleX, LoaderCircle, Play } from "lucide-react";
import { hhmm, RUNTIME_META, type WorkflowRecord } from "../shared";
import { postRun, type LiveState, type RunEligibility } from "./api";

type RunResult =
  | { state: "pending" }
  | { state: "ok"; label: string; startedAt: string }
  | { state: "error"; reason: string };

interface RunCtx {
  eligibility: (r: WorkflowRecord) => RunEligibility;
  request: (r: WorkflowRecord) => void;
  result: (id: string) => RunResult | undefined;
}

const Ctx = createContext<RunCtx | null>(null);

export function useRunner(): RunCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRunner outside RunProvider");
  return c;
}

export function RunProvider({
  live,
  liveProblem,
  onStarted,
  children,
}: {
  live: LiveState | null;
  /** Why the live state is missing, shown as the disabled reason. */
  liveProblem: string | null;
  onStarted: () => void;
  children: ReactNode;
}) {
  const [confirming, setConfirming] = useState<{ record: WorkflowRecord; label: string } | null>(null);
  const [results, setResults] = useState<Record<string, RunResult>>({});

  const eligibility = useCallback(
    (r: WorkflowRecord): RunEligibility => {
      if (!live) return { allowed: false, reason: liveProblem ?? "Checking whether this can run…" };
      return live.runnable[r.id] ?? { allowed: false, reason: live.defaultReason };
    },
    [live, liveProblem],
  );

  const request = useCallback(
    (r: WorkflowRecord) => {
      const e = eligibility(r);
      if (e.allowed) setConfirming({ record: r, label: e.label });
    },
    [eligibility],
  );

  const fire = useCallback(async () => {
    if (!confirming) return;
    const { record } = confirming;
    setConfirming(null);
    setResults((m) => ({ ...m, [record.id]: { state: "pending" } }));
    const out = await postRun(record.id);
    setResults((m) => ({ ...m, [record.id]: out.ok ? { state: "ok", label: out.label, startedAt: out.startedAt } : { state: "error", reason: out.reason } }));
    if (out.ok) onStarted();
  }, [confirming, onStarted]);

  const value = useMemo<RunCtx>(() => ({ eligibility, request, result: (id) => results[id] }), [eligibility, request, results]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {confirming && <ConfirmRun record={confirming.record} label={confirming.label} onCancel={() => setConfirming(null)} onConfirm={fire} />}
    </Ctx.Provider>
  );
}

function ConfirmRun({ record, label, onCancel, onConfirm }: { record: WorkflowRecord; label: string; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
      if (e.key === "Tab" && boxRef.current) {
        const f = boxRef.current.querySelectorAll<HTMLElement>("button");
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [onCancel]);

  return createPortal(
    <div className="wf2-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={boxRef} className="wf2-confirm" role="alertdialog" aria-modal="true" aria-labelledby="wf2-confirm-title" aria-describedby="wf2-confirm-body">
        <div className="wf2-confirm-eyebrow">
          <span className="wf2-dot" style={{ background: RUNTIME_META[record.runtime].color }} aria-hidden />
          {RUNTIME_META[record.runtime].label} · {record.trigger.display}
        </div>
        <h2 id="wf2-confirm-title" className="wf2-confirm-title">Run “{record.title}” now?</h2>
        <p id="wf2-confirm-body" className="wf2-confirm-body">
          This asks launchd to start <code>{label}</code> once, outside its schedule. If it is already running, launchd leaves that run alone and nothing new starts.
        </p>
        <div className="wf2-confirm-actions">
          <button ref={cancelRef} type="button" className="wf2-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="wf2-btn" data-tone="go" onClick={onConfirm}>
            <Play size={13} aria-hidden /> Run now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Run Now control plus its inline result. `compact` drops the label text for dense rows. */
export function RunButton({ record, compact = false }: { record: WorkflowRecord; compact?: boolean }) {
  const { eligibility, request, result } = useRunner();
  const e = eligibility(record);
  const res = result(record.id);
  const pending = res?.state === "pending";
  return (
    <span className="wf2-run">
      <button
        type="button"
        className="wf2-act"
        data-tone="go"
        disabled={!e.allowed || pending}
        aria-disabled={!e.allowed || pending}
        title={e.allowed ? `Start ${e.label} now` : e.reason}
        onClick={(ev) => { ev.stopPropagation(); request(record); }}
      >
        {pending ? <LoaderCircle size={13} className="wf2-spin" aria-hidden /> : <Play size={13} aria-hidden />}
        {!compact && <span>Run Now</span>}
      </button>
      {res && res.state !== "pending" && (
        <span className="wf2-run-result" data-tone={res.state} role="status" title={res.state === "error" ? res.reason : `launchctl kickstart ${res.label}`}>
          {res.state === "ok" ? <CircleCheck size={13} aria-hidden /> : <CircleX size={13} aria-hidden />}
          <span>{res.state === "ok" ? `started ${hhmm(res.startedAt)}` : res.reason}</span>
        </span>
      )}
    </span>
  );
}
