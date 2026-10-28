"use client";
import { useState } from "react";
import { useApi } from "@/lib/api";
import {
  Shield, ShieldAlert, ShieldX, ShieldCheck, Eye, Lock,
  FileWarning, Server, Info, ChevronDown, ChevronRight, Terminal, Globe,
  BookOpen as BookIcon, Radar, Boxes, Clock, AlertTriangle, Cloud,
} from "lucide-react";
import {
  PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill, dimStyle,
  type Dim,
} from "@/components/ui/chrome";
import type { LucideIcon } from "lucide-react";
import TelosRiskRegister from "@/components/TelosRiskRegister";

// ── API shape (as of the 2026-05-06 minimal-v1 security model) ──
// GET /api/security             → { model, description, denyList, hooks }
// GET /api/security/hooks-detail → Record<command, HookDetail>
interface HookRegistration { type: string; matcher: string; command: string; status: "active" | "missing" }
interface HookDetail { description: string; behavior: string; event: string; canBlock: boolean }
interface SecurityData {
  model: string;
  description: string;
  denyList: string[];
  hooks: HookRegistration[];
}

// ── /api/security/attack-surface (PRIVATE — runtime-only, never in the static export) ──
interface SurfaceTarget { name: string; type: string; multiTenant?: boolean }
interface SurfaceFinding { target: string; category: string; check: string; evidence: string }
interface AttackSurfaceData {
  schedule: string;
  discovery: string;
  inventory: {
    lastSync: string | null;
    curated: number | null;
    discovered: number | null;
    dnsHosts: number | null;
    workerOrigins: number | null;
    targets: SurfaceTarget[];
  } | null;
  scan: {
    timestamp: string | null;
    summary: { pass: number; fail: number; error: number; skip: number } | null;
    targetsScanned: number;
    findingCounts: { critical: number; high: number; medium: number; low: number };
    findings: Record<string, SurfaceFinding[]>;
  } | null;
}

/**
 * State of a PRIVATE endpoint: null while the fetch is in flight, "unavailable"
 * once it has failed. The two private sections used to share `null` for both, so
 * an install that never serves those routes — the public payload has no
 * infrastructure scanner and no risk register — sat on "Loading…" forever
 * (public issue #1799, @jacobo-ortiz, follow-up to the /security route ship).
 */
type PrivateData<T> = T | "unavailable" | null;

/** Read a private endpoint, collapsing a bad status or a thrown error to "unavailable". */
function usePrivate<T>(path: string): PrivateData<T> {
  const q = useApi<T>(path);
  return q.data ?? (q.isError ? "unavailable" : null);
}

/** Shared body for a section whose private source isn't part of this install. */
function NotConfigured({ what }: { what: string }) {
  return (
    <Panel>
      <p className="text-xs text-center py-6 text-ink-3">Not configured on this install — {what}</p>
    </Panel>
  );
}


function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ── Section Header ──
function SectionHeader({ icon: Icon, title, count, accentClass = "text-dim-freedom" }: {
  icon: LucideIcon; title: string; count?: number; accentClass?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3 mt-8 first:mt-0">
      <Icon className={`w-5 h-5 shrink-0 ${accentClass}`} />
      <h2 className="text-sm font-semibold tracking-wider uppercase whitespace-nowrap text-ink-1">{title}</h2>
      {count !== undefined && <span className="text-xs text-ink-3 ml-1 shrink-0">({count})</span>}
    </div>
  );
}

// ── Deny-rule grouping ──
// Deny entries look like `Bash(rm -rf /)`, `Write(~/.claude/**/memory/**)`, `Edit(...)`.
// Group by the leading tool so the list reads as policy, not a wall of regex.
interface DenyGroup { tool: string; icon: LucideIcon; dim: Dim; entries: string[] }

function groupDenyList(denyList: string[]): DenyGroup[] {
  const toolMeta: Record<string, { icon: LucideIcon; dim: Dim }> = {
    Bash: { icon: Terminal, dim: "err" },
    Write: { icon: FileWarning, dim: "warn" },
    Edit: { icon: FileWarning, dim: "warn" },
    Read: { icon: Eye, dim: "freedom" },
    WebFetch: { icon: Globe, dim: "freedom" },
    WebSearch: { icon: Globe, dim: "freedom" },
  };
  const groups = new Map<string, DenyGroup>();
  for (const raw of denyList) {
    const m = raw.match(/^(\w+)\((.*)\)$/);
    const tool = m ? m[1] : "Other";
    const arg = m ? m[2] : raw;
    const meta = toolMeta[tool] ?? { icon: Lock, dim: "neutral" as Dim };
    if (!groups.has(tool)) groups.set(tool, { tool, icon: meta.icon, dim: meta.dim, entries: [] });
    groups.get(tool)!.entries.push(arg);
  }
  // Bash/Write/Edit first (the destructive ones), then the rest alphabetically.
  const order = ["Bash", "Write", "Edit", "Read", "WebFetch", "WebSearch"];
  return [...groups.values()].sort((a, b) => {
    const ai = order.indexOf(a.tool), bi = order.indexOf(b.tool);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.tool.localeCompare(b.tool);
  });
}

function DenyGroupCard({ group }: { group: DenyGroup }) {
  const color = dimStyle(group.dim, true).color as string;
  return (
    <Panel className="flex flex-col gap-2">
      <PanelHeader
        icon={group.icon}
        title={<span style={{ color }}>{group.tool}</span>}
        meta={`(${group.entries.length})`}
      />
      <div className="space-y-1">
        {group.entries.map((entry, i) => (
          <code
            key={i}
            className="block text-xs mono rounded px-2 py-1 bg-surface-1 text-ink-2"
            style={{ wordBreak: "break-all" }}
          >
            {entry}
          </code>
        ))}
      </div>
    </Panel>
  );
}

// ── Hook Detail Row ──
function HookDetailRow({ hook, detail }: { hook: HookRegistration; detail?: HookDetail }) {
  const [expanded, setExpanded] = useState(false);
  const isActive = hook.status === "active";
  const Arrow = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="border-b border-line-1 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 py-2.5 w-full text-left px-2 rounded transition-colors hover:bg-surface-1"
      >
        <Arrow className="w-3 h-3 shrink-0 text-ink-3" />
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: isActive ? "var(--ok)" : "var(--err)" }}
        />
        <span className="text-xs mono flex-1 truncate text-ink-1">{hook.command}</span>
        <span className="text-xs text-ink-3">{hook.type} · {hook.matcher}</span>
        {detail?.canBlock && <Pill dim="err">CAN BLOCK</Pill>}
        {detail && !detail.canBlock && <Pill dim="neutral">ADVISORY</Pill>}
        {!isActive && <Pill dim="err">MISSING</Pill>}
      </button>
      {expanded && detail && (
        <div className="pl-10 pr-4 pb-3 space-y-2">
          <div>
            <div className="text-xs tracking-wider uppercase mb-0.5 text-ink-3">Description</div>
            <div className="text-xs text-ink-1">{detail.description}</div>
          </div>
          <div>
            <div className="text-xs tracking-wider uppercase mb-0.5 text-ink-3">Behavior</div>
            <div className="text-xs text-ink-2">{detail.behavior}</div>
          </div>
          <div className="flex gap-4">
            <div>
              <span className="text-xs text-ink-3">Event: </span>
              <span className="text-xs mono text-dim-freedom">{detail.event}</span>
            </div>
            <div>
              <span className="text-xs text-ink-3">Blocking: </span>
              <span className={`text-xs ${detail.canBlock ? "text-err" : "text-ink-2"}`}>
                {detail.canBlock ? "Yes (can deny the call)" : "No (advisory only)"}
              </span>
            </div>
          </div>
        </div>
      )}
      {expanded && !detail && (
        <div className="pl-10 pr-4 pb-3">
          <p className="text-xs text-ink-3">No detail registered for this hook.</p>
        </div>
      )}
    </div>
  );
}

// ── Defense-layer card (the three-layer model) ──
function LayerCard({ n, icon: Icon, title, where, body, dim }: {
  n: number; icon: LucideIcon; title: string; where: string; body: string; dim: Dim;
}) {
  const color = dimStyle(dim, true).color as string;
  return (
    <div className="px-3 py-3 rounded-lg bg-surface-1 border border-line-1">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="mono text-xs text-ink-3">{n}</span>
        <Icon className="w-4 h-4 shrink-0" style={{ color }} />
        <span className="text-xs font-semibold whitespace-nowrap text-ink-1">{title}</span>
      </div>
      <code className="text-xs mono block mb-1" style={{ color }}>{where}</code>
      <p className="text-xs text-ink-2">{body}</p>
    </div>
  );
}

// ══════════════════════════════════════════
// Main Page
// ══════════════════════════════════════════

// ── Attack Surface Monitoring section ──
function TypePill({ type, multiTenant }: { type: string; multiTenant?: boolean }) {
  const dim: Dim = type === "api" ? "freedom" : type === "worker" ? "rhythms" : "creative";
  return (
    <span className="inline-flex items-center gap-1">
      <Pill dim={dim}>{type}</Pill>
      {multiTenant && <Pill dim="warn">multi-tenant</Pill>}
    </span>
  );
}

function AttackSurfaceSection({ surface }: { surface: PrivateData<AttackSurfaceData> }) {
  const [showTargets, setShowTargets] = useState(false);
  const [sev, setSev] = useState<string | null>(null);
  if (surface === "unavailable") {
    return (
      <div>
        <SectionHeader icon={Radar} title="Attack Surface Monitoring" />
        <NotConfigured what="this section reads a private infrastructure scanner that runs alongside Pulse." />
      </div>
    );
  }
  if (!surface) {
    return (
      <div>
        <SectionHeader icon={Radar} title="Attack Surface Monitoring" />
        <Panel><p className="text-xs text-center py-6 text-ink-3">Loading scan status…</p></Panel>
      </div>
    );
  }
  const inv = surface.inventory;
  const scan = surface.scan;
  const fc = scan?.findingCounts;
  const critHigh = [...(scan?.findings?.critical ?? []), ...(scan?.findings?.high ?? [])];
  // Severity tiles filter the findings panel: no tile → the default crit+high view;
  // an active tile → that one severity (medium/low included, keyed straight off scan.findings).
  const shown = sev ? (scan?.findings?.[sev] ?? []) : critHigh;

  return (
    <div>
      <SectionHeader icon={Radar} title="Attack Surface Monitoring" count={scan?.targetsScanned} accentClass="text-dim-freedom" />
      <p className="text-xs mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-2">
        <span className="flex items-center gap-1.5"><Clock className="w-3 h-3" /> Hourly scan · last run {relTime(scan?.timestamp)}</span>
        <span className="flex items-center gap-1.5"><Cloud className="w-3 h-3" /> Discovery {relTime(inv?.lastSync)} (4×/day, local)</span>
        <span className="flex items-center gap-1.5 text-ink-3"><Lock className="w-3 h-3" /> Private — read live from this machine, never shipped</span>
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile icon={Globe} label="Targets Scanned" value={scan?.targetsScanned ?? "—"} dim="freedom" />
        <StatTile icon={Shield} label="Curated" value={inv?.curated ?? "—"} dim="ok" />
        <StatTile icon={Radar} label="Discovered Sites" value={inv?.dnsHosts ?? "—"} dim="creative" />
        <StatTile icon={Boxes} label="Worker Origins" value={inv?.workerOrigins ?? "—"} dim="rhythms" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile icon={ShieldX} label="Critical" value={fc?.critical ?? 0} dim={fc?.critical ? "err" : "ok"}
          active={sev === "critical"} onClick={() => setSev(sev === "critical" ? null : "critical")} />
        <StatTile icon={ShieldAlert} label="High" value={fc?.high ?? 0} dim={fc?.high ? "warn" : "ok"}
          active={sev === "high"} onClick={() => setSev(sev === "high" ? null : "high")} />
        <StatTile icon={Eye} label="Medium" value={fc?.medium ?? 0} dim="freedom"
          active={sev === "medium"} onClick={() => setSev(sev === "medium" ? null : "medium")} />
        <StatTile icon={Info} label="Low" value={fc?.low ?? 0} dim="rhythms"
          active={sev === "low"} onClick={() => setSev(sev === "low" ? null : "low")} />
      </div>

      {shown.length > 0 ? (
        <Panel className="p-2 mb-3">
          {shown.map((f, i) => (
            <div key={i} className="flex items-start gap-2 px-2 py-1.5 text-xs border-b last:border-b-0 border-[var(--hairline)]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-err" />
              <span className="mono text-ink-1">{f.target}</span>
              <span className="text-ink-3">{f.category}/{f.check}</span>
              <span className="text-ink-2 truncate">{f.evidence}</span>
            </div>
          ))}
        </Panel>
      ) : (
        <p className="text-xs mb-3 flex items-center gap-1.5 text-ink-2">
          <ShieldCheck className="w-3.5 h-3.5 text-ok" /> {sev ? `No ${sev} findings on the current surface.` : "No critical or high findings on the current surface."}
        </p>
      )}

      <button
        onClick={() => setShowTargets((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-ink-2 hover:text-ink-1 mb-2"
      >
        {showTargets ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Auto-discovered targets ({inv?.targets?.length ?? 0})
      </button>
      {showTargets && (
        <Panel className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5">
            {(inv?.targets ?? []).map((t) => (
              <div key={t.name} className="flex items-center justify-between gap-2 text-xs">
                <span className="mono truncate text-ink-2">{t.name}</span>
                <TypePill type={t.type} multiTenant={t.multiTenant} />
              </div>
            ))}
          </div>
        </Panel>
      )}
      <p className="text-xs mt-3 ml-1 text-ink-3">
        Doctrine: <code className="text-ink-2">LIFEOS/DOCUMENTATION/Security/README.md</code>
      </p>
    </div>
  );
}

export default function SecurityPage() {
  const securityQ = useApi<SecurityData>("/api/security");
  const data = securityQ.data ?? null;
  const hookDetails = useApi<Record<string, HookDetail>>("/api/security/hooks-detail").data ?? {};
  const surface = usePrivate<AttackSurfaceData>("/api/security/attack-surface");
  const loading = securityQ.isPending;
  const failed = securityQ.isError;
  const [hookFilter, setHookFilter] = useState<"active" | "missing" | null>(null);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96 text-ink-2">
        <Shield className="w-6 h-6 animate-pulse mr-2 text-dim-freedom" /> Loading security model...
      </div>
    );
  }
  if (failed || !data) {
    return (
      <div className="flex items-center justify-center h-96 text-err">
        <ShieldAlert className="w-6 h-6 mr-2" /> Failed to load security data
      </div>
    );
  }

  const denyGroups = groupDenyList(data.denyList ?? []);
  const hooks = data.hooks ?? [];
  const activeHooks = hooks.filter(h => h.status === "active").length;
  const missingHooks = hooks.length - activeHooks;
  const shownHooks = hookFilter
    ? hooks.filter(h => (hookFilter === "active" ? h.status === "active" : h.status !== "active"))
    : hooks;

  return (
    <PageShell>
      <PageHeader
        icon={Shield}
        title="Security"
        subtitle={data.description}
        actions={<span className="text-xs mono text-ink-3">{data.model}</span>}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile icon={ShieldCheck} label="Defense Layers" value={3} dim="ok" />
        <StatTile icon={ShieldX} label="Deny Rules" value={data.denyList?.length ?? 0} dim="err" />
        <StatTile icon={Server} label="Active Hooks" value={activeHooks} dim="freedom"
          active={hookFilter === "active"} onClick={() => setHookFilter(hookFilter === "active" ? null : "active")} />
        {missingHooks > 0 && <StatTile icon={ShieldAlert} label="Missing Hooks" value={missingHooks} dim="warn"
          active={hookFilter === "missing"} onClick={() => setHookFilter(hookFilter === "missing" ? null : "missing")} />}
      </div>

      {/* Attack Surface Monitoring (private, runtime-only) */}
      <AttackSurfaceSection surface={surface} />
      <TelosRiskRegister securityOnly readyToScroll={surface !== null} />

      {/* Three-layer model */}
      <div>
        <SectionHeader icon={Shield} title="How Security Works" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-2">
          <LayerCard
            n={1} icon={BookIcon} title="Constitutional Rule" dim="freedom"
            where="LIFEOS_SYSTEM_PROMPT.md"
            body="The Security Protocol in the system prompt. External content is read-only data, never instructions. This is the actual defense — it survives compaction and binds every mode and agent."
          />
          <LayerCard
            n={2} icon={ShieldX} title="Native Deny List" dim="err"
            where="settings.json · permissions.deny"
            body="Harness-enforced hard denials. The list below. Deterministic — the call never runs. Edit these in settings.json directly."
          />
          <LayerCard
            n={3} icon={ShieldAlert} title="Git Hooks" dim="warn"
            where="LIFEOS/TOOLS/githooks/"
            body="Git judges what actually lands, from any tool. pre-commit refuses a plaintext .env, secret-shaped values and identity content in system files; pre-push refuses any remote GitHub does not confirm private. No LifeOS hook reads a tool call to decide whether it may run."
          />
        </div>
        <p className="text-xs mb-2 ml-1 text-ink-2">
          Full model: <code className="text-ink-2">LIFEOS/DOCUMENTATION/Security/README.md</code>
        </p>
      </div>

      {/* Deny List */}
      <div>
        <SectionHeader icon={ShieldX} title="Native Deny List" count={data.denyList?.length ?? 0} accentClass="text-err" />
        <p className="text-xs mb-3 flex items-center gap-1.5 text-ink-2">
          <Info className="w-3 h-3" /> Harness-enforced. Read-only here — edit <code className="mono text-ink-2">settings.json</code> <code className="mono text-ink-2">permissions.deny</code> to change.
        </p>
        {denyGroups.length === 0 ? (
          <Panel>
            <p className="text-xs text-center py-6 text-ink-3">Deny list is empty.</p>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {denyGroups.map((g) => <DenyGroupCard key={g.tool} group={g} />)}
          </div>
        )}
      </div>

      {/* Hooks */}
      <div>
        <SectionHeader icon={Server} title="Security Hooks" count={shownHooks.length} />
        <p className="text-xs mb-3 flex items-center gap-1.5 text-ink-2">
          <Info className="w-3 h-3" /> Click a hook to see what it does and whether it can block a call. Green = registered and the file exists.
        </p>
        {shownHooks.length === 0 ? (
          <Panel>
            <p className="text-xs text-center py-6 text-ink-3">{hookFilter ? "No hooks in this view." : "No security hooks registered."}</p>
          </Panel>
        ) : (
          <Panel className="p-2">
            {shownHooks.map((hook, i) => (
              <HookDetailRow key={i} hook={hook} detail={hookDetails[hook.command]} />
            ))}
          </Panel>
        )}
        <p className="text-xs mt-3 ml-1 text-ink-3">
          Hook wiring lives in <code className="text-ink-2">~/.claude/settings.json</code>.
        </p>
      </div>
    </PageShell>
  );
}
