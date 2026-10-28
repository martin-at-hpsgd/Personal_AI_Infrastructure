"use client";

/**
 * The bottom drawer on the Pipelines canvas (Cue's node config panel, read-only
 * here): the selected workflow's full card, its evidence and findings, its
 * latest runs, and the same actions as the Dashboard row. A selected skill
 * tile shows that skill's intents instead, each one clickable into its card.
 */

import { ChevronDown, ChevronUp, ExternalLink, PencilLine, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  EVIDENCE_PHRASE,
  EXECUTOR_META,
  HEALTH_META,
  HealthGlyph,
  RUNTIME_META,
  SeverityMark,
  clock24,
  healthOf,
  isDeclared,
  lastRunNote,
  relativeAgo,
  type Finding,
  type Inventory,
  type WorkflowRecord,
} from "../shared";
import { PathText } from "../strip";
import type { ActivityRow } from "./api";
import { RunButton } from "./run";
import { AppIcons } from "./app-icons";
import { StatusMark, formatDuration } from "./status";

function Slot({ label, value, empty, inferred, mono = false }: { label: string; value: ReactNode; empty: boolean; inferred?: boolean; mono?: boolean }) {
  return (
    <div className="wf2-slot" data-empty={empty ? "1" : undefined}>
      <div className="wf2-slot-label">
        {label}
        {inferred && <span className="wf2-slot-flag" title="inferred from the code, not declared by a person">inferred</span>}
      </div>
      <div className={mono ? "wf2-slot-value mono" : "wf2-slot-value"}>{empty ? "not declared" : value}</div>
    </div>
  );
}

export function RecordDrawer({
  record,
  inv,
  findings,
  runs,
  now,
  collapsed,
  onToggle,
  onClose,
  onOpenCard,
  onBack,
  onEdit,
}: {
  record: WorkflowRecord;
  inv: Inventory;
  findings: Finding[];
  runs: ActivityRow[];
  now: number;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  onOpenCard: (id: string) => void;
  /** Present when the record was opened from a skill tile: returns to that list. */
  onBack?: () => void;
  /** Opens a typed workflow in the Canvas tab editor (ISC-167). */
  onEdit?: (name: string) => void;
}) {
  const r = record;
  const c = r.card;
  const ev = r.evidence;
  const health = healthOf(r, findings);
  const M = RUNTIME_META[r.runtime];
  const sop = isDeclared(c, "sop") ? inv.sops.find((s) => s.id === c.sop || s.path === c.sop) : undefined;
  const open = findings.filter((f) => !f.acknowledged);
  const acked = findings.filter((f) => f.acknowledged);

  return (
    <section className="wf2-drawer" data-collapsed={collapsed ? "1" : undefined} aria-label={`Workflow ${r.title}`}>
      <header className="wf2-drawer-head" style={{ borderTopColor: M.color }}>
        {onBack && (
          <button type="button" className="wf2-act" onClick={onBack} title="Back to the skill's intents">
            ← {r.group}
          </button>
        )}
        <span className="wf2-dot" style={{ background: M.color }} aria-hidden />
        <h2 className="wf2-drawer-title">{r.title}</h2>
        <AppIcons apps={r.apps} size={16} />
        <span className="wf2-chip">{M.label}</span>
        {r.group !== "—" && <span className="wf2-muted">{r.group}</span>}
        <span className="wf2-health">
          <HealthGlyph health={health} />
          {HEALTH_META[health].label}
        </span>
        <span className="wf2-drawer-actions">
          <RunButton record={r} />
          {r.runtime === "workflow" && onEdit && (
            <button type="button" className="wf2-act" onClick={() => onEdit(r.name)} title="Open this workflow in the Canvas editor">
              <PencilLine size={13} aria-hidden /> Edit
            </button>
          )}
          <button type="button" className="wf2-act" onClick={() => onOpenCard(r.id)}>
            <ExternalLink size={13} aria-hidden /> Open card
          </button>
          <button type="button" className="wf2-icon" onClick={onToggle} aria-label={collapsed ? "Expand the drawer" : "Collapse the drawer"} aria-expanded={!collapsed}>
            {collapsed ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          </button>
          <button type="button" className="wf2-icon" onClick={onClose} aria-label="Close the drawer">
            <X size={16} aria-hidden />
          </button>
        </span>
      </header>

      {!collapsed && (
        <div className="wf2-drawer-body">
          <div className="wf2-slots">
            <Slot label="Purpose" value={c.purpose} empty={!isDeclared(c, "purpose")} inferred={c.inferred.includes("purpose")} />
            <Slot label="Input" value={c.input} empty={!isDeclared(c, "input")} inferred={c.inferred.includes("input")} />
            <Slot
              label="Steps"
              empty={!isDeclared(c, "steps")}
              inferred={c.inferred.includes("steps")}
              value={
                <ol className="wf2-steps">
                  {c.steps.map((s) => {
                    const E = EXECUTOR_META[s.executor];
                    const Icon = E.icon;
                    return (
                      <li key={s.id}>
                        <Icon size={13} style={{ color: E.color }} aria-hidden />
                        <span className="mono">{s.label}</span>
                        <span className="wf2-muted">{E.label}</span>
                      </li>
                    );
                  })}
                </ol>
              }
            />
            <Slot
              label="SOP"
              empty={!isDeclared(c, "sop")}
              inferred={c.inferred.includes("sop")}
              value={sop ? <>{sop.title} <span className="mono wf2-muted"><PathText value={sop.path} /></span></> : <span className="mono"><PathText value={c.sop ?? ""} /></span>}
            />
            <Slot label="Output" value={c.output} empty={!isDeclared(c, "output")} inferred={c.inferred.includes("output")} />
            <Slot label="Destination" value={<PathText value={c.destination ?? ""} />} empty={!isDeclared(c, "destination")} inferred={c.inferred.includes("destination")} />
          </div>

          <div className="wf2-drawer-cols">
            <dl className="wf2-facts">
              <div className="wf2-facts-title">Where it lives</div>
              <div><dt>Trigger</dt><dd>{r.trigger.display || "—"}{r.trigger.expr && <span className="mono wf2-muted"> · {r.trigger.expr}</span>}</dd></div>
              <div><dt>Defined in</dt><dd className="mono"><PathText value={r.definedIn || "—"} /></dd></div>
              {r.alsoInstalledAs && <div><dt>Scheduled by</dt><dd className="mono"><PathText value={r.alsoInstalledAs} /></dd></div>}
              <div><dt>Installed</dt><dd>{r.installed}{!r.enabled && " · disabled"}</dd></div>
            </dl>
            <dl className="wf2-facts">
              <div className="wf2-facts-title">Evidence</div>
              <div>
                <dt>Last run</dt>
                <dd>{ev.lastRunAt ? <>{relativeAgo(ev.lastRunAt, now)} <span className="mono wf2-muted">{clock24(ev.lastRunAt)}</span></> : <span className="wf2-muted">{lastRunNote(r)}</span>}</dd>
              </div>
              <div><dt>Status</dt><dd>{ev.lastStatus === "error" ? "failed" : ev.lastStatus}</dd></div>
              <div><dt>Runs</dt><dd className="mono">{ev.runs != null ? ev.runs.toLocaleString("en-US") : "not counted"}</dd></div>
              <div><dt>Read from</dt><dd>{EVIDENCE_PHRASE[ev.kind]}{ev.source && <span className="mono wf2-muted wf2-block"><PathText value={ev.source} /></span>}</dd></div>
            </dl>
            <div className="wf2-facts">
              <div className="wf2-facts-title">Findings</div>
              {findings.length === 0 ? (
                <div className="wf2-muted">None.</div>
              ) : (
                <ul className="wf2-findings">
                  {[...open, ...acked].map((f, i) => (
                    <li key={`${f.kind}:${i}`} data-quiet={f.acknowledged ? "1" : undefined}>
                      <SeverityMark severity={f.severity} />
                      <span>{f.sentence}{f.acknowledged && <span className="wf2-muted"> (acknowledged)</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="wf2-facts">
              <div className="wf2-facts-title">Latest runs</div>
              {runs.length === 0 ? (
                <div className="wf2-muted">No run with a time is recorded for this workflow.</div>
              ) : (
                <ul className="wf2-mini-runs">
                  {runs.slice(0, 6).map((a) => (
                    <li key={a.key}>
                      <StatusMark status={a.status} />
                      <span className="mono">{clock24(a.at)}</span>
                      <span className="wf2-muted mono">{formatDuration(a.durationMs)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function SkillDrawer({
  skill,
  records,
  findingsMap,
  collapsed,
  onToggle,
  onClose,
  onPick,
}: {
  skill: string;
  records: WorkflowRecord[];
  findingsMap: Map<string, Finding[]>;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <section className="wf2-drawer" data-collapsed={collapsed ? "1" : undefined} aria-label={`Skill ${skill}`}>
      <header className="wf2-drawer-head" style={{ borderTopColor: RUNTIME_META.skill.color }}>
        <span className="wf2-dot" style={{ background: RUNTIME_META.skill.color }} aria-hidden />
        <h2 className="wf2-drawer-title">{skill}</h2>
        <span className="wf2-chip">skill</span>
        <span className="wf2-muted">{records.length} on-demand intent{records.length === 1 ? "" : "s"}. Skills run inside a session, not from this page.</span>
        <span className="wf2-drawer-actions">
          <button type="button" className="wf2-icon" onClick={onToggle} aria-label={collapsed ? "Expand the drawer" : "Collapse the drawer"} aria-expanded={!collapsed}>
            {collapsed ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          </button>
          <button type="button" className="wf2-icon" onClick={onClose} aria-label="Close the drawer">
            <X size={16} aria-hidden />
          </button>
        </span>
      </header>
      {!collapsed && (
        <div className="wf2-drawer-body">
          <ul className="wf2-skill-list">
            {records.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onPick(r.id)}>
                  <HealthGlyph health={healthOf(r, findingsMap.get(r.id))} />
                  <span className="wf2-skill-cell">
                    <span className="wf2-skill-name">{r.title}</span>
                    <AppIcons apps={r.apps} />
                  </span>
                  <span className="wf2-muted">{r.card.purpose ?? "purpose not declared"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
