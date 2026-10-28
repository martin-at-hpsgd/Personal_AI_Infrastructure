"use client";

/**
 * The pipeline strip: TRIGGER → INPUT → TRANSFORMS → OUTPUT → DESTINATION.
 * One component draws it in both places it appears: full size in the card
 * drawer, and `compact` inside every catalog row. Both variants read the same
 * slots through the same helpers and share the stage proportions below, so the
 * row and the drawer cannot disagree about what a workflow does.
 *
 * Everything renders as <span> so the compact strip is valid inside the row's
 * <button>; the display rules live in styles.tsx.
 */

import { Fragment } from "react";
import { EXECUTORS, EXECUTOR_META, isDeclared, runtimeTint, hexAlpha, type Card, type WorkflowRecord } from "./shared";

type Stage = "trigger" | "input" | "transforms" | "output" | "destination";

const STAGES: readonly Stage[] = ["trigger", "input", "transforms", "output", "destination"];

const STAGE_LABEL: Record<Stage, string> = {
  trigger: "Trigger",
  input: "Input",
  transforms: "Transforms",
  output: "Output",
  destination: "Destination",
};

/** Flex-grow per stage. The compact column heads use the same numbers, which is what lines them up with the rows. */
const STAGE_GROW: Record<Stage, number> = { trigger: 0.85, input: 1, transforms: 1.7, output: 1, destination: 1 };

/** A compact strip shows at most this many transform boxes; a longer list shows one fewer plus a "+N" box. */
const COMPACT_MAX_STEPS = 4;

const TRIGGER_KIND_TEXT: Record<WorkflowRecord["trigger"]["kind"], string> = { schedule: "scheduled", daemon: "always on", "on-demand": "on demand" };

type TextSlot = "input" | "output" | "destination";
const INFERRED_TITLE = "inferred from the code, not declared by a person";

/** Breaks a path or dotted label only at "/" and "." so it never wraps mid-word. */
export function PathText({ value }: { value: string }) {
  return (
    <>
      {value.split(/(\s+)/).map((token, i) => {
        if (!token.includes("/") && !token.startsWith("com.")) return <Fragment key={i}>{token}</Fragment>;
        return (
          <Fragment key={i}>
            {token.split(/([/.])/).map((part, j) =>
              part === "/" || part === "." ? (
                <Fragment key={j}>
                  {part}
                  <wbr />
                </Fragment>
              ) : (
                <Fragment key={j}>{part}</Fragment>
              ),
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** Longest tail a compact box keeps before it drops the parent folder too. */
const COMPACT_TAIL_MAX = 28;

/**
 * A bare path in a compact box keeps its tail, cut at a "/" separator:
 * "~/.claude/LIFEOS/MEMORY/STATE/x.log" reads "…/STATE/x.log" (or "…/x.log"
 * when that is still long). The start of a path is the part every row shares;
 * the tail is what tells rows apart. Anything that is not a bare path is unchanged.
 */
export function compactPath(value: string): string {
  if (/\s/.test(value) || !value.includes("/")) return value;
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 3) return value;
  const two = `…/${parts.slice(-2).join("/")}`;
  return two.length <= COMPACT_TAIL_MAX ? two : `…/${parts[parts.length - 1]}`;
}

function EmptyBox({ stage, compact }: { stage: Stage; compact: boolean }) {
  const label = `${STAGE_LABEL[stage]}: not declared yet`;
  return (
    <span className="wf-box" data-empty="1" aria-label={label} title={compact ? label : undefined}>
      <span>{compact ? "not declared" : "not declared yet"}</span>
    </span>
  );
}

function TextBox({ stage, value, compact, inferred }: { stage: TextSlot; value: string; compact: boolean; inferred: boolean }) {
  return (
    <span className="wf-box" data-inferred={inferred ? "1" : undefined} title={inferred ? INFERRED_TITLE : compact ? `${STAGE_LABEL[stage]}: ${value}` : undefined}>
      <span className="wf-box-text">
        <PathText value={compact ? compactPath(value) : value} />
      </span>
    </span>
  );
}

function TriggerBox({ r, compact }: { r: WorkflowRecord; compact: boolean }) {
  const t = r.trigger;
  const kind = TRIGGER_KIND_TEXT[t.kind] ?? t.kind;
  return (
    <span
      className="wf-box"
      data-kind="trigger"
      style={{ borderColor: runtimeTint(r.runtime, 0.45) }}
      title={compact ? `Trigger: ${t.display || "—"} (${kind})${t.expr ? ` · ${t.expr}` : ""}` : undefined}
    >
      <span className="wf-box-strong">{t.display || "—"}</span>
      <span className="wf-box-meta">{kind}</span>
    </span>
  );
}

function StepsBox({ card, compact }: { card: Card; compact: boolean }) {
  const steps = card.steps;
  const inferred = card.inferred.includes("steps");
  const overflow = compact && steps.length > COMPACT_MAX_STEPS;
  const shown = overflow ? steps.slice(0, COMPACT_MAX_STEPS - 1) : steps;
  const hidden = overflow ? steps.slice(COMPACT_MAX_STEPS - 1) : [];
  return (
    <span className="wf-steps" data-inferred={inferred ? "1" : undefined} title={inferred ? INFERRED_TITLE : undefined} role={compact ? undefined : "list"}>
      {shown.map((s, i) => {
        const M = EXECUTOR_META[s.executor] ?? EXECUTOR_META.unknown;
        const Icon = M.icon;
        return (
          <span
            key={s.id || i}
            role={compact ? undefined : "listitem"}
            className="wf-step"
            data-executor={s.executor}
            title={inferred ? INFERRED_TITLE : compact ? `Step ${i + 1}: ${s.label} — done by ${M.blurb}` : undefined}
            style={{ borderColor: hexAlpha(M.color, 0.42), background: hexAlpha(M.color, 0.09), boxShadow: `inset 3px 0 0 ${M.color}` }}
          >
            {compact ? (
              <Icon size={12} className="wf-step-icon" style={{ color: M.color }} aria-hidden />
            ) : (
              <span className="wf-step-n mono">{i + 1}</span>
            )}
            <span className="wf-step-label">{s.label}</span>
            {!compact && (
              <span className="wf-step-exec" style={{ color: M.color }} title={M.blurb}>
                <Icon size={12} aria-hidden />
                {M.label}
              </span>
            )}
          </span>
        );
      })}
      {overflow && (
        <span
          className="wf-step wf-step-more"
          title={hidden.map((s, i) => `Step ${COMPACT_MAX_STEPS + i}: ${s.label} — ${(EXECUTOR_META[s.executor] ?? EXECUTOR_META.unknown).label}`).join("\n")}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

function Connector() {
  return (
    <span className="wf-connector" aria-hidden>
      <svg viewBox="0 0 32 12" preserveAspectRatio="none">
        <line x1="0" y1="6" x2="25" y2="6" className="wf-flow" />
        <path d="M24 1.5 30 6 24 10.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function StageBody({ stage, r, compact }: { stage: Stage; r: WorkflowRecord; compact: boolean }) {
  const c = r.card;
  switch (stage) {
    case "trigger":
      return <TriggerBox r={r} compact={compact} />;
    case "transforms":
      return isDeclared(c, "steps") ? <StepsBox card={c} compact={compact} /> : <EmptyBox stage={stage} compact={compact} />;
    case "input":
    case "output":
    case "destination":
      return isDeclared(c, stage) ? <TextBox stage={stage} value={c[stage] ?? ""} compact={compact} inferred={c.inferred.includes(stage)} /> : <EmptyBox stage={stage} compact={compact} />;
  }
}

/**
 * How a workflow runs, left to right. Full size in the drawer (stage labels
 * above each box); `compact` in a catalog row (one box height, text clamped,
 * full values on hover, labels carried by the column heads).
 */
export function Strip({ r, compact = false }: { r: WorkflowRecord; compact?: boolean }) {
  const steps = r.card.steps.length;
  return (
    <span
      className="wf-strip"
      data-compact={compact ? "1" : "0"}
      role={compact ? undefined : "list"}
      aria-label={compact ? undefined : "How this workflow runs, left to right"}
    >
      {STAGES.map((stage, i) => (
        <Fragment key={stage}>
          {i > 0 && <Connector />}
          <span role={compact ? undefined : "listitem"} className="wf-stage-wrap" data-stage={stage} style={{ flexGrow: STAGE_GROW[stage] }}>
            <span className="wf-stage">
              {!compact && (
                <span className="wf-stage-label">
                  {STAGE_LABEL[stage]}
                  {stage === "transforms" && steps > 0 ? ` · ${steps}` : ""}
                </span>
              )}
              <StageBody stage={stage} r={r} compact={compact} />
            </span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Stage labels for a table of compact strips, spaced exactly like the strip below them. */
export function StripHeads() {
  return (
    <span className="wf-strip wf-strip-heads" data-compact="1" aria-hidden>
      {STAGES.map((stage, i) => (
        <Fragment key={stage}>
          {i > 0 && <span className="wf-connector wf-connector-head">→</span>}
          <span className="wf-stage-wrap" data-stage={stage} style={{ flexGrow: STAGE_GROW[stage] }}>
            {STAGE_LABEL[stage]}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** What the transform colours mean, for a table of compact strips. */
export function ExecutorLegend() {
  return (
    <span className="wf-exec-legend" aria-label="Transform colours: who does each step">
      <span className="wf-muted">steps done by</span>
      {EXECUTORS.map((e) => {
        const M = EXECUTOR_META[e];
        const Icon = M.icon;
        return (
          <span key={e} className="wf-exec-legend-item" title={M.blurb}>
            <span className="wf-exec-legend-swatch" style={{ background: hexAlpha(M.color, 0.18), borderColor: hexAlpha(M.color, 0.6), boxShadow: `inset 2px 0 0 ${M.color}` }} aria-hidden />
            <Icon size={12} style={{ color: M.color }} aria-hidden />
            {M.label}
          </span>
        );
      })}
    </span>
  );
}
