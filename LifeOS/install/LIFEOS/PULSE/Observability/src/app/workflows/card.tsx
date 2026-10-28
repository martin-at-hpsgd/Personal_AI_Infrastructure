"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ScrollText, X } from "lucide-react";
import { Pill, type Dim } from "@/components/ui/chrome";
import {
  EXECUTORS,
  EXECUTOR_META,
  HEALTH_META,
  HealthGlyph,
  RUNTIME_META,
  SeverityMark,
  clock24,
  EVIDENCE_PHRASE,
  lastRunNote,
  isDeclared,
  relativeAgo,
  runtimeTint,
  slotsDeclared,
  type Finding,
  type Health,
  type Inventory,
  type WorkflowRecord,
} from "./shared";
import { PathText, Strip } from "./strip";
import { AppIcons } from "./v2/app-icons";

const INSTALLED_DIM: Record<WorkflowRecord["installed"], Dim> = {
  loaded: "ok",
  deployed: "blue",
  "on-disk": "warn",
  absent: "err",
  "n/a": "neutral",
};

const INSTALLED_TEXT: Record<WorkflowRecord["installed"], string> = {
  loaded: "loaded in launchd",
  deployed: "deployed as configured",
  "on-disk": "on disk, not loaded",
  absent: "not installed",
  "n/a": "nothing to install",
};

const STATUS_DIM: Record<WorkflowRecord["evidence"]["lastStatus"], Dim> = { ok: "ok", error: "err", unknown: "neutral" };
const STATUS_TEXT: Record<WorkflowRecord["evidence"]["lastStatus"], string> = { ok: "ok", error: "failed", unknown: "unknown" };
/* ── Facts below the strip ── */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wf-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function WorkflowCard({
  record,
  inv,
  findings,
  health,
  now,
  onClose,
  onOpen,
}: {
  record: WorkflowRecord;
  inv: Inventory;
  findings: Finding[];
  health: Health;
  now: number;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const r = record;
  const c = r.card;
  const ev = r.evidence;
  const M = RUNTIME_META[r.runtime];

  // Focus in on open, back to the opener on close; Escape closes; the page
  // behind does not scroll while the card is up.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]:not([tabindex='-1'])");
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  // Re-anchor at the top when the card switches to a linked record.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [r.id]);

  // The card's own sop slot is the authority; the SOP registry only lends it a title.
  const sopDeclared = isDeclared(c, "sop");
  const sop = sopDeclared ? inv.sops.find((s) => s.id === c.sop || s.path === c.sop) : undefined;
  const byId = new Map(inv.records.map((x) => [x.id, x]));
  const execPresent = EXECUTORS.filter((e) => c.steps.some((s) => s.executor === e));
  const open = findings.filter((f) => !f.acknowledged);
  const acked = findings.filter((f) => f.acknowledged);

  // Portalled to <body>: the page sheet animates with a transform, which would
  // otherwise make it the containing block for this fixed overlay.
  return createPortal(
    <div className="wf-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className="wf-drawer glass-raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-card-title"
        data-record={r.id}
      >
        <div className="wf-drawer-top" style={{ background: `linear-gradient(180deg, ${runtimeTint(r.runtime, 0.12)}, transparent)` }}>
          <div className="wf-drawer-eyebrow">
            <span className="wf-group-swatch" style={{ background: M.color }} aria-hidden />
            <span>{M.label}</span>
            {r.group !== "—" && <><span className="wf-sep">/</span><span>{r.group}</span></>}
            <span className="wf-sep">/</span>
            <span className="mono">{r.name}</span>
            <span className="wf-drawer-health">
              <HealthGlyph health={health} />
              <span>{HEALTH_META[health].label}</span>
            </span>
            <button ref={closeRef} type="button" className="wf-close" onClick={onClose} aria-label="Close card">
              <X size={16} aria-hidden />
            </button>
          </div>

          {/* SOP, pinned: the rule the work answers to sits above everything else. */}
          <div className="wf-sop" data-empty={sopDeclared ? "0" : "1"} data-inferred={c.inferred.includes("sop") ? "1" : undefined} title={c.inferred.includes("sop") ? "inferred from the code, not declared by a person" : undefined}>
            <ScrollText size={14} aria-hidden />
            <span className="wf-sop-label">SOP</span>
            {sopDeclared ? (
              <span className="wf-sop-value">
                {sop ? <><span>{sop.title}</span><span className="mono wf-muted"><PathText value={sop.path} /></span></> : <span className="mono"><PathText value={c.sop ?? ""} /></span>}
              </span>
            ) : (
              <span className="wf-sop-value wf-dashed-text">not declared yet</span>
            )}
          </div>

          <div className="wf-purpose">
            <div className="wf-purpose-kicker">{r.title} <AppIcons apps={r.apps} /></div>
            {isDeclared(c, "purpose") ? (
              <h2 id="wf-card-title" className="wf-purpose-title" data-inferred={c.inferred.includes("purpose") ? "1" : undefined} title={c.inferred.includes("purpose") ? "inferred from the code, not declared by a person" : undefined}>{c.purpose}</h2>
            ) : (
              <h2 id="wf-card-title" className="wf-purpose-title" data-empty="1">
                Purpose not declared yet
              </h2>
            )}
          </div>
        </div>

        <div className="wf-drawer-body">
          <Strip r={r} />

          <div className="wf-strip-foot">
            <span className="wf-legend-inline">
              {execPresent.length === 0 ? (
                <span className="wf-muted">No transforms declared, so nothing says who does the work.</span>
              ) : (
                execPresent.map((e) => {
                  const E = EXECUTOR_META[e];
                  const Icon = E.icon;
                  return (
                    <span key={e} className="wf-exec-chip">
                      <Icon size={12} style={{ color: E.color }} aria-hidden />
                      {E.label}: {E.blurb}
                    </span>
                  );
                })
              )}
            </span>
            <span className="wf-muted mono">{slotsDeclared(c)}/6 slots filled{c.inferred.length > 0 ? ` · ${c.inferred.length} inferred` : ""}</span>
          </div>

          <div className="wf-facts-grid">
            <dl className="wf-facts">
              <div className="wf-facts-title">Where it lives</div>
              <Fact label="Runtime">
                <span className="wf-inline"><span className="wf-group-swatch" style={{ background: M.color }} aria-hidden />{M.label} · {M.blurb}</span>
              </Fact>
              <Fact label="Defined in"><span className="mono wf-break"><PathText value={r.definedIn || "—"} /></span></Fact>
              {r.seenIn && r.seenIn.length > 1 && (
                <Fact label="Seen in"><span className="mono wf-break">{r.seenIn.map((path, i) => <span className="wf-block" key={path}>{i + 1}. <PathText value={path} /></span>)}</span></Fact>
              )}
              {r.alsoInstalledAs && (
                <Fact label="Scheduled by"><span className="mono wf-break"><PathText value={r.alsoInstalledAs} /></span></Fact>
              )}
              <Fact label="Installed">
                <Pill dim={INSTALLED_DIM[r.installed] ?? "neutral"}>{INSTALLED_TEXT[r.installed] ?? r.installed}</Pill>
              </Fact>
              <Fact label="Declared">
                {r.declared ? "yes, a definition home names it" : "no, nothing declares it"}
                {!r.enabled && <span className="wf-tag" style={{ marginLeft: 8 }}>disabled</span>}
              </Fact>
              <Fact label="Cadence">{r.trigger.display || "—"}</Fact>
              {r.trigger.expr && (
                <Fact label="Expression"><span className="mono wf-break">{r.trigger.expr}</span></Fact>
              )}
            </dl>

            <dl className="wf-facts">
              <div className="wf-facts-title">Evidence</div>
              <Fact label="Last run">
                {ev.lastRunAt ? (
                  <>
                    {relativeAgo(ev.lastRunAt, now)} <span className="mono wf-muted">{clock24(ev.lastRunAt)}</span>
                  </>
                ) : (
                  <span className="wf-muted">{lastRunNote(r)}</span>
                )}
              </Fact>
              <Fact label="Status"><Pill dim={STATUS_DIM[ev.lastStatus] ?? "neutral"}>{STATUS_TEXT[ev.lastStatus] ?? ev.lastStatus}</Pill></Fact>
              <Fact label="Runs">{ev.runs != null ? <span className="mono">{ev.runs.toLocaleString("en-US")}</span> : <span className="wf-muted">not counted</span>}</Fact>
              <Fact label="Read from">
                {EVIDENCE_PHRASE[ev.kind] ?? ev.kind}
                {ev.source && <span className="mono wf-muted wf-break wf-block"><PathText value={ev.source} /></span>}
              </Fact>
            </dl>
          </div>

          <div className="wf-card-section">
            <div className="wf-facts-title">Linked records</div>
            {r.linked.length === 0 ? (
              <div className="wf-muted">None. No other home runs this same work.</div>
            ) : (
              <div className="wf-finding-links">
                {r.linked.map((id) => {
                  const other = byId.get(id);
                  return other ? (
                    <button
                      key={id}
                      type="button"
                      className="wf-reclink"
                      onClick={() => onOpen(id)}
                      style={{ borderColor: runtimeTint(other.runtime, 0.35), background: runtimeTint(other.runtime, 0.08) }}
                    >
                      <span className="wf-reclink-dot" style={{ background: RUNTIME_META[other.runtime].color }} aria-hidden />
                      <span className="wf-reclink-text">{other.title}</span>
                      <span className="mono wf-muted">{RUNTIME_META[other.runtime].label}</span>
                    </button>
                  ) : (
                    <span key={id} className="wf-reclink" data-missing="1" title="Not in the current inventory">
                      <span className="mono">{id}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="wf-card-section">
            <div className="wf-facts-title">Findings for this workflow</div>
            {findings.length === 0 ? (
              <div className="wf-muted">None.</div>
            ) : (
              <ul className="wf-findings wf-findings-card">
                {[...open, ...acked].map((f, i) => (
                  <li key={`${f.kind}:${i}`} className="wf-finding" data-quiet={f.acknowledged ? "1" : "0"}>
                    <SeverityMark severity={f.severity} />
                    <span className="wf-finding-text">{f.sentence}</span>
                    {f.acknowledged && <Pill dim="neutral">acknowledged</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
