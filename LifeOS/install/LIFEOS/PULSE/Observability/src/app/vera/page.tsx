"use client";
import { useState } from "react";
import { useApi } from "@/lib/api";
import { AlertTriangle, Fingerprint, Users } from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill } from "@/components/ui/chrome";

// Vera — versioned ideal-state profiles of people; the profile is the artifact,
// every score a projection. Read-only over the redacted snapshot; mutations via
// `bun LIFEOS/VERA/Vera.ts`. The 1-100 VERA composite is computed at read time
// and decomposes into branch scores, leaf bars and the exact rows; grey =
// insufficient signal (absence widens, never subtracts), personal-sensitivity
// rows never reach this surface. Scope: profiles are for public figures and for
// people who agreed to be profiled (VeraSystem.md § Who may be profiled).

interface Leaf {
  leaf: string; branch: string; estimate: number | null; interval: number;
  n: number; rows: number; trajectory: number | null; insufficient: boolean;
}
interface Claim {
  id: string; statement: string; happened: string; kind: string;
  resolution: string | null; axes: string[]; source: string; confidence: number;
}
interface Composite { score: number; n: number; coverage: number }
interface Person {
  slug: string; title: string; claims: number; leaves: Leaf[]; recent: Claim[];
  vera?: Composite; branches?: { branch: string; composite: Composite }[];
  analysis?: { analysis: string; bullets: string[] } | null;
}
interface Data {
  generated: string; stale: boolean; age_minutes: number;
  axes: { branches: { name: string; leaves: { name: string }[] }[] };
  people: Person[];
}

const GREY = "rgba(255,255,255,0.25)";
const BLUE = "#3B82F6";

/** 1-100 VERA composite; 100 = perfectly kind, perfectly intelligent ASI. */
function scoreColor(s: number): string {
  if (s >= 75) return "#4ade80";
  if (s >= 55) return BLUE;
  if (s >= 40) return "rgba(255,255,255,0.65)";
  return "#f87171";
}

function ScoreBadge({ c, size = 40 }: { c?: Composite; size?: number }) {
  if (!c) return null;
  return (
    <div style={{
      width: size + 8, height: size, borderRadius: 8, flex: "none",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      border: `1px solid ${scoreColor(c.score)}44`, background: `${scoreColor(c.score)}14`,
    }}>
      <span style={{ fontSize: size * 0.45, fontWeight: 700, color: scoreColor(c.score), lineHeight: 1 }}>{c.score}</span>
      <span style={{ fontSize: 8, opacity: 0.55, letterSpacing: 0.5 }}>VERA</span>
    </div>
  );
}

/** Radar outline over all 16 leaves; grey spokes where signal is insufficient. */
function Spider({ leaves, size = 120 }: { leaves: Leaf[]; size?: number }) {
  const c = size / 2;
  const r = c - 8;
  const pts = leaves.map((l, i) => {
    const angle = (Math.PI * 2 * i) / leaves.length - Math.PI / 2;
    const v = l.estimate ?? 0.15;
    return { x: c + Math.cos(angle) * r * v, y: c + Math.sin(angle) * r * v, ok: !l.insufficient };
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
  return (
    <svg width={size} height={size}>
      {[0.25, 0.5, 0.75, 1].map((ring) => (
        <circle key={ring} cx={c} cy={c} r={r * ring} fill="none" stroke="rgba(255,255,255,0.07)" />
      ))}
      <path d={path} fill="rgba(59,130,246,0.15)" stroke={BLUE} strokeWidth={1.2} />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.2} fill={p.ok ? BLUE : GREY} />
      ))}
    </svg>
  );
}

function LeafBar({ l }: { l: Leaf }) {
  const traj = l.trajectory === null ? "" : l.trajectory > 0.005 ? " ↗" : l.trajectory < -0.005 ? " ↘" : " →";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "2px 0" }}>
      <span style={{ width: 150, opacity: 0.8, flex: "none" }}>{l.leaf}</span>
      <div style={{ flex: 1, height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, position: "relative" }}>
        {!l.insufficient && l.estimate !== null && (
          <>
            <div style={{
              position: "absolute", left: `${Math.max(0, (l.estimate - l.interval)) * 100}%`,
              width: `${(Math.min(1, l.estimate + l.interval) - Math.max(0, l.estimate - l.interval)) * 100}%`,
              top: 0, bottom: 0, background: "rgba(59,130,246,0.18)", borderRadius: 4,
            }} />
            <div style={{ position: "absolute", left: `calc(${l.estimate * 100}% - 2px)`, width: 4, top: -1, bottom: -1, background: BLUE, borderRadius: 2 }} />
          </>
        )}
      </div>
      <span style={{ width: 160, fontFamily: "monospace", fontSize: 11, opacity: l.insufficient ? 0.4 : 0.8, flex: "none" }}>
        {l.insufficient ? "insufficient signal" : `${l.estimate!.toFixed(2)} ±${l.interval.toFixed(2)} n≈${l.n.toFixed(1)}${traj}`}
      </span>
    </div>
  );
}

export default function VeraPage() {
  const vera = useApi<Data>("/api/vera", { refetchInterval: 60_000 });
  const data = vera.data ?? null;
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const people = data?.people ?? [];
  const totalClaims = people.reduce((n, p) => n + p.claims, 0);
  const withSignal = people.filter((p) => p.leaves.some((l) => !l.insufficient)).length;
  const shown = (filter === "with_signal" ? people.filter((p) => p.leaves.some((l) => !l.insufficient)) : people)
    .slice()
    .sort((a, b) => (b.vera?.score ?? 0) - (a.vera?.score ?? 0));

  return (
    <PageShell>
      <PageHeader
        icon={Fingerprint}
        title="Vera"
        subtitle="Versioned ideal-state profiles of people — the profile is the artifact, every score a projection with its own confidence"
      />

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 16 }}>
        Scope: profiles are for public figures, judged on their public work, and for people who agreed to be profiled. Do not import or enrich anyone else.
      </div>

      {data?.stale && (
        <Panel style={{ marginBottom: 16, border: "1px solid rgba(255,120,80,0.5)" }}>
          <div style={{ padding: "10px 16px", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            <AlertTriangle size={15} />
            Snapshot is {data.age_minutes < 0 ? "missing" : `${Math.round(data.age_minutes / 1440)} days old`} — re-export with <code>bun LIFEOS/VERA/Vera.ts export-pulse</code>.
          </div>
        </Panel>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        <StatTile label="People" value={String(people.length)} active={filter === null} onClick={() => setFilter(null)} />
        <StatTile label="Claim rows" value={String(totalClaims)} />
        <StatTile label="With signal" value={String(withSignal)} active={filter === "with_signal"} onClick={() => setFilter(filter === "with_signal" ? null : "with_signal")} />
        <StatTile label="Axes" value={data ? `${data.axes.branches.length} × ${data.axes.branches[0]?.leaves.length ?? 0}` : "—"} />
      </div>

      <Panel style={{ marginBottom: 16 }}>
        <PanelHeader icon={Users} title="Profiles" />
        {shown.map((p) => (
          <div key={p.slug} style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "10px 16px", cursor: "pointer" }} onClick={() => setOpen(open === p.slug ? null : p.slug)}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
              <ScoreBadge c={p.vera} />
              <Spider leaves={p.leaves} size={44} />
              <span style={{ fontWeight: 600, minWidth: 180 }}>{p.title}</span>
              <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.5 }}>{p.slug}</span>
              <span style={{ flex: 1 }} />
              {p.vera && <span style={{ fontSize: 11, opacity: 0.5 }}>coverage {Math.round(p.vera.coverage * 100)}%</span>}
              <Pill dim="neutral">{p.claims} claims</Pill>
              {p.leaves.every((l) => l.insufficient) && <Pill dim="neutral">no signal yet</Pill>}
            </div>
            {open === p.slug && (
              <div style={{ marginTop: 10, display: "flex", gap: 24, flexWrap: "wrap" }}>
                {p.analysis && (
                  <div style={{ flexBasis: "100%", fontSize: 13, lineHeight: 1.55 }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, opacity: 0.5, marginBottom: 4 }}>Analysis</div>
                    <p style={{ margin: "0 0 8px 0", opacity: 0.9, maxWidth: 900 }}>{p.analysis.analysis}</p>
                    <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.85 }}>
                      {p.analysis.bullets.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                    </ul>
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                  <ScoreBadge c={p.vera} size={72} />
                  <Spider leaves={p.leaves} size={180} />
                  {p.vera && <span style={{ fontSize: 11, opacity: 0.55 }}>evidence n≈{p.vera.n.toFixed(1)} · coverage {Math.round(p.vera.coverage * 100)}%</span>}
                </div>
                <div style={{ flex: 1, minWidth: 420 }}>
                  {(data?.axes.branches ?? []).map((b) => {
                    const bc = p.branches?.find((x) => x.branch === b.name)?.composite;
                    return (
                      <div key={b.name} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, opacity: 0.5, marginBottom: 2, display: "flex", gap: 8, alignItems: "center" }}>
                          {b.name}
                          {bc && <span style={{ color: scoreColor(bc.score), fontWeight: 700, fontSize: 12 }}>{bc.score}</span>}
                        </div>
                        {p.leaves.filter((l) => l.branch === b.name).map((l) => <LeafBar key={l.leaf} l={l} />)}
                      </div>
                    );
                  })}
                </div>
                <div style={{ flexBasis: "100%", fontSize: 12 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, opacity: 0.5, margin: "6px 0" }}>Recent claims</div>
                  {p.recent.map((cl) => (
                    <div key={cl.id} style={{ display: "flex", gap: 8, padding: "2px 0", opacity: 0.85 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.6, flex: "none" }}>{cl.happened}</span>
                      <Pill dim={cl.resolution === "resolved_true" ? "ok" : cl.resolution === "resolved_false" ? "err" : "neutral"}>{cl.kind}</Pill>
                      <span style={{ flex: 1 }}>{cl.statement}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        {people.length === 0 && (
          <div style={{ padding: "12px 16px", fontSize: 13, opacity: 0.6 }}>
            No profiles yet — run <code>bun LIFEOS/VERA/Vera.ts import-kb</code> then <code>export-pulse</code>.
          </div>
        )}
      </Panel>

      <div style={{ fontSize: 11, opacity: 0.5 }}>
        Ledgers: LIFEOS/USER/VERA/people/ · mutations via <code>bun LIFEOS/VERA/Vera.ts</code> · the composite is computed at read time and decomposes to its rows · grey = insufficient signal, never a judgment
      </div>
    </PageShell>
  );
}
