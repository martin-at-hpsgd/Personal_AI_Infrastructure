"use client";
import { useEffect, useState } from "react";
import {
  Activity,
  Heart,
  Apple,
  FlaskConical,
  Pill as PillIcon,
  Stethoscope,
  ClipboardList,
  FileText,
  Lock,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import { FreshnessIndicator, type FreshnessData } from "@/components/FreshnessIndicator";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import { ApiError, useApi } from "@/lib/api";
import { fmtClock, fmtDateParts } from "@/lib/time";
import TrendBoard, { type HealthDay, type HealthJournalDay } from "@/components/health/TrendBoard";
import {
  PageShell,
  PageHeader,
  Panel,
  PanelHeader,
  StatTile,
  Pill,
  TabBar,
  type TabSpec,
  type Dim,
} from "@/components/ui/chrome";

interface HealthFile {
  name: string;
  sections: string[];
}

interface Section {
  heading: string;
  body: string;
}

interface LiveDaily {
  day: string;
  sleep: number | null;
  readiness: number | null;
  activity: number | null;
  steps: number | null;
  spo2: number | null;
}

interface LiveSource {
  status: string;
  records?: number;
  lastSuccess?: string | null;
  lastError?: string | null;
  note?: string;
}

interface LiveCurrent {
  generated_at?: string;
  day?: string;
  last_night?: {
    oura_sleep_score?: number | null;
    oura_readiness_score?: number | null;
    sleep_duration_h?: number | null;
  };
  sources?: Record<string, LiveSource>;
}

interface HealthLive {
  current: LiveCurrent | null;
  daily: LiveDaily[];
  days?: HealthDay[];
  journal?: HealthJournalDay[];
}

interface HealthData {
  files?: HealthFile[];
  supplements?: Section[];
  live?: HealthLive;
  freshness?: FreshnessData;
}

interface FileMeta {
  icon: LucideIcon;
  label: string;
  priority: number;
}

const FILE_META: Record<string, FileMeta> = {
  METRICS: { icon: Activity, label: "Metrics", priority: 1 },
  FITNESS: { icon: Heart, label: "Fitness", priority: 2 },
  NUTRITION: { icon: Apple, label: "Nutrition", priority: 3 },
  CONDITIONS: { icon: ClipboardList, label: "Conditions", priority: 4 },
  MEDICATIONS: { icon: PillIcon, label: "Medications", priority: 5 },
  PROVIDERS: { icon: Stethoscope, label: "Providers", priority: 6 },
  HISTORY: { icon: FileText, label: "History", priority: 7 },
  SUPPLEMENTS: { icon: PillIcon, label: "Supplements", priority: 5 },
};

function fileMeta(name: string): FileMeta {
  if (name.startsWith("lab_results")) {
    return {
      icon: FlaskConical,
      label: name.replace(/^lab_results_/, "Labs — "),
      priority: 0,
    };
  }
  return FILE_META[name.toUpperCase()] || { icon: FileText, label: name, priority: 99 };
}

function FileCard({ file }: { file: HealthFile }) {
  const meta = fileMeta(file.name);
  const Icon = meta.icon;
  return (
    <Panel hover style={{ borderLeft: "3px solid var(--health)" }}>
      <PanelHeader
        title={meta.label}
        icon={Icon}
        actions={
          <Pill dim="health" className="tabular-nums">
            {file.sections.length} section{file.sections.length === 1 ? "" : "s"}
          </Pill>
        }
      />
      <div className="space-y-1.5" data-sensitive>
        {file.sections.slice(0, 8).map((s, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-ink-2">
            <span
              className="w-1 h-1 rounded-full mt-1.5 shrink-0"
              style={{ backgroundColor: "var(--rhythms)", opacity: 0.6 }}
            />
            <span className="line-clamp-2">{s}</span>
          </div>
        ))}
        {file.sections.length > 8 && (
          <div className="text-[12px] italic pt-1 text-ink-3">
            + {file.sections.length - 8} more
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Supplements ──

interface Supplement {
  name: string;
  dose?: string;
  purpose?: string;
  cadence?: string;
  category?: string;
  status?: string;
}

const CATEGORY_ORDER = ["Foundational", "Longevity", "Nootropic", "Allergy", "Rx"];
const CATEGORY_DIM: Record<string, Dim> = {
  Foundational: "health",
  Longevity: "rhythms",
  Nootropic: "blue",
  Allergy: "creative",
  Rx: "money",
};

function field(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`));
  return m ? m[1].trim() : undefined;
}

function parseSupplements(sections: Section[]): { items: Supplement[]; notes?: string } {
  const items: Supplement[] = [];
  let notes: string | undefined;
  for (const s of sections) {
    if (s.heading.toLowerCase() === "notes") {
      notes = s.body;
      continue;
    }
    const dose = field(s.body, "Dose");
    const category = field(s.body, "Category");
    if (!dose && !category) continue; // not a supplement entry
    items.push({
      name: s.heading,
      dose,
      purpose: field(s.body, "Purpose"),
      cadence: field(s.body, "Cadence"),
      category,
      status: field(s.body, "Status"),
    });
  }
  return { items, notes };
}

function SupplementCard({ s }: { s: Supplement }) {
  const dim = (s.category && CATEGORY_DIM[s.category]) || "health";
  const inactive = s.status && !/^active/i.test(s.status);
  return (
    <Panel hover style={{ borderLeft: `3px solid var(--${dim})` }}>
      <PanelHeader
        title={s.name}
        icon={PillIcon}
        actions={
          s.category ? (
            <Pill dim={dim}>{s.category}</Pill>
          ) : undefined
        }
      />
      <div className="space-y-1.5" data-sensitive>
        {s.dose && (
          <div className="text-sm font-medium text-ink-1">{s.dose}</div>
        )}
        {s.cadence && (
          <div className="text-[12px] uppercase tracking-wide text-ink-3">{s.cadence}</div>
        )}
        {s.purpose && <div className="text-xs text-ink-2">{s.purpose}</div>}
        {s.status && (
          <div
            className="text-[12px] pt-1"
            style={{ color: inactive ? "var(--ink-3)" : "var(--health)" }}
          >
            {s.status}
          </div>
        )}
      </div>
    </Panel>
  );
}

function SupplementsTab({ sections }: { sections: Section[] }) {
  const [dailyOnly, setDailyOnly] = useState(false);
  const { items, notes } = parseSupplements(sections);

  if (items.length === 0) {
    return (
      <EmptyStateGuide
        section="Supplements"
        description="Your daily and as-needed supplement stack — dose, purpose, and cadence per item."
        userDir="HEALTH"
        daPromptExample="add my supplements to the health page"
      />
    );
  }

  const dailyItems = items.filter((s) => /daily/i.test(s.cadence || ""));
  const daily = dailyItems.length;
  const shown = dailyOnly ? dailyItems : items;
  const categories = Array.from(
    new Set(items.map((s) => s.category).filter(Boolean) as string[]),
  ).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
        <StatTile
          label="Tracked"
          value={<span data-sensitive>{items.length}</span>}
          dim="health"
          icon={PillIcon}
        />
        <StatTile
          label="Daily"
          value={<span data-sensitive>{daily}</span>}
          dim="rhythms"
          icon={Activity}
          active={dailyOnly}
          onClick={() => setDailyOnly(!dailyOnly)}
        />
        <StatTile
          label="Categories"
          value={<span data-sensitive>{categories.length}</span>}
          dim="blue"
          icon={LayoutGrid}
        />
      </div>

      <p className="text-sm flex items-center gap-2 text-ink-3">
        <Lock className="w-3.5 h-3.5" /> Fully private. Observer mode blurs all data below.
      </p>

      {categories.map((cat) => {
        const group = shown.filter((s) => s.category === cat);
        if (group.length === 0) return null;
        return (
          <section key={cat}>
            <h2 className="text-[13px] font-medium uppercase tracking-widest text-ink-3 mb-4">
              {cat}
            </h2>
            <div className="prob-grid">
              {group.map((s) => (
                <SupplementCard key={s.name} s={s} />
              ))}
            </div>
          </section>
        );
      })}

      {notes && (
        <Panel style={{ borderLeft: "3px solid var(--rhythms)" }}>
          <PanelHeader title="Notes" icon={FileText} />
          <div className="text-xs text-ink-2 whitespace-pre-line" data-sensitive>
            {notes.replace(/^- /gm, "• ")}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ── Live data (health sync pipeline) ──

const SOURCE_LABEL: Record<string, string> = {
  oura: "Oura",
  apple: "Apple Health",
  eightsleep: "Eight Sleep",
  function: "Function Health",
};

function sourceDim(status: string): Dim {
  if (status === "ok") return "health";
  if (status === "awaiting-first-export") return "creative";
  return "blue";
}

function shortDay(day: string): string {
  // A day key has no zone: anchor at noon UTC so the principal's zone never shifts the day.
  return fmtDateParts(`${day}T12:00:00Z`, { month: "short", day: "numeric" });
}

function LiveSection({ live }: { live: HealthLive }) {
  const cur = live.current;
  const today = live.daily.length > 0 ? live.daily[live.daily.length - 1] : null;
  const sleep = cur?.last_night?.oura_sleep_score ?? today?.sleep ?? null;
  const readiness = cur?.last_night?.oura_readiness_score ?? today?.readiness ?? null;
  const spo2 = today?.spo2 ?? null;
  // Oura finalizes activity (incl. Apple Health-synced steps) at end of day —
  // fall back to the most recent finalized day rather than showing "–" all day.
  const lastAct = [...live.daily].reverse().find((d) => d.activity != null || d.steps != null) ?? null;
  const actLabel = lastAct && lastAct !== today ? ` · ${shortDay(lastAct.day)}` : "";
  const sources = cur?.sources ? Object.entries(cur.sources) : [];

  return (
    <section>
      <h2 className="text-[13px] font-medium uppercase tracking-widest text-ink-3 mb-4 flex items-center gap-2">
        <Heart className="w-4 h-4" /> Live — {cur?.day || "today"}
      </h2>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-5 mb-4">
        <StatTile
          label="Sleep Score"
          value={<span data-sensitive>{sleep ?? "–"}</span>}
          dim="health"
          icon={Heart}
        />
        <StatTile
          label="Readiness"
          value={<span data-sensitive>{readiness ?? "–"}</span>}
          dim="rhythms"
          icon={Activity}
        />
        <StatTile
          label="SpO2"
          value={<span data-sensitive>{spo2 != null ? `${spo2.toFixed(1)}%` : "–"}</span>}
          dim="blue"
          icon={Stethoscope}
        />
        <StatTile
          label={`Activity${actLabel}`}
          value={<span data-sensitive>{lastAct?.activity ?? "–"}</span>}
          dim="creative"
          icon={Activity}
        />
        <StatTile
          label={`Steps${actLabel}`}
          value={
            <span data-sensitive>
              {lastAct?.steps != null ? lastAct.steps.toLocaleString() : "–"}
            </span>
          }
          dim="money"
          icon={Activity}
        />
      </div>

      {(live.days?.length ?? 0) > 1 && (
        <TrendBoard days={live.days ?? []} journal={live.journal ?? []} />
      )}

      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-4">
          {sources.map(([key, s]) => (
            <Pill key={key} dim={sourceDim(s.status)}>
              {SOURCE_LABEL[key] || key}: {s.status}
              {s.status === "ok" && s.lastSuccess
                ? ` · ${fmtClock(s.lastSuccess)}`
                : ""}
            </Pill>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Page ──

type TabKey = "overview" | "supplements";
const TABS: TabSpec<TabKey>[] = [
  { id: "overview", label: "Overview", icon: Activity, dim: "health", hint: "1" },
  { id: "supplements", label: "Supplements", icon: PillIcon, dim: "rhythms", hint: "2" },
];

function OverviewTab({ files, live }: { files: HealthFile[]; live?: HealthLive }) {
  const [labsOnly, setLabsOnly] = useState(false);
  const labs = files.filter((f) => f.name.startsWith("lab_results"));
  const nonLabs = files.filter((f) => !f.name.startsWith("lab_results"));
  const hasLive = !!live && (live.current != null || live.daily.length > 0);

  return (
    <div className="space-y-6">
      {hasLive && <LiveSection live={live!} />}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
        <StatTile
          label="Tracked Sources"
          value={<span data-sensitive>{files.length}</span>}
          dim="health"
          icon={Activity}
        />
        <StatTile
          label="Lab Panels"
          value={<span data-sensitive>{labs.length}</span>}
          dim="rhythms"
          icon={FlaskConical}
          active={labsOnly}
          onClick={() => setLabsOnly(!labsOnly)}
        />
      </div>

      <p className="text-sm flex items-center gap-2 text-ink-3">
        <Lock className="w-3.5 h-3.5" /> Fully private. Observer mode blurs all data below.
      </p>

      {labs.length > 0 && (
        <section>
          <h2 className="text-[13px] font-medium uppercase tracking-widest text-ink-3 mb-4 flex items-center gap-2">
            <FlaskConical className="w-4 h-4" /> Lab Panels
          </h2>
          <div className="prob-grid">
            {labs.map((f) => (
              <FileCard key={f.name} file={f} />
            ))}
          </div>
        </section>
      )}
      {!labsOnly && nonLabs.length > 0 && (
        <section>
          <h2 className="text-[13px] font-medium uppercase tracking-widest text-ink-3 mb-4">
            Core Files
          </h2>
          <div className="prob-grid">
            {nonLabs.map((f) => (
              <FileCard key={f.name} file={f} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function HealthPage() {
  const { data = null, error: queryError } = useApi<HealthData>("/api/life/health", { retry: false });
  // A non-2xx reply stays "loading" as before; only a network failure surfaces as an error.
  const error = !data && queryError && !(queryError instanceof ApiError) ? String(queryError) : null;
  const [tab, setTab] = useState<TabKey>("overview");

  // Hash-routed tab state (matches finances/agents pattern).
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace(/^#/, "");
      if (h === "overview" || h === "supplements") setTab(h);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1") changeTab("overview");
      if (e.key === "2") changeTab("supplements");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeTab = (k: TabKey) => {
    setTab(k);
    if (typeof window !== "undefined") window.location.hash = k;
  };

  if (error) {
    return (
      <PageShell>
        <Panel style={{ borderLeft: "3px solid var(--err)" }}>
          <h2 className="font-medium text-err">Failed to load health</h2>
          <p className="text-sm text-ink-2">{error}</p>
        </Panel>
      </PageShell>
    );
  }
  if (!data) return <div className="p-8 text-sm text-ink-3">Loading Health...</div>;

  const files = (data.files || [])
    .slice()
    .sort((a, b) => fileMeta(a.name).priority - fileMeta(b.name).priority);
  const isFreshInstall = files.length === 0;

  return (
    <PageShell>
      <PageHeader
        title="Health"
        icon={Activity}
        subtitle="Labs, fitness, nutrition, and supplements — fully private. Press 1/2 to switch tabs."
        actions={<FreshnessIndicator freshness={data.freshness} />}
      />

      {isFreshInstall && (
        <EmptyStateGuide
          section="Health Snapshots"
          description="Lab results, fitness data, nutrition tracking, and trends over time."
          userDir="HEALTH"
          daPromptExample="help me set up where my health data lives"
        />
      )}

      <TabBar tabs={TABS} active={tab} onChange={changeTab} />

      {tab === "overview" && <OverviewTab files={files} live={data.live} />}
      {tab === "supplements" && <SupplementsTab sections={data.supplements || []} />}
    </PageShell>
  );
}
