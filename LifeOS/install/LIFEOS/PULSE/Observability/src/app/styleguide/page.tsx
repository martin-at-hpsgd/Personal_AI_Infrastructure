"use client";

/**
 * /styleguide — the standing Pulse style guide, rendered WITH the real
 * primitives it documents. This page is both spec and proof: if the
 * material system regresses, this page shows it first.
 *
 * Blue technical dashboard: custom type, numbered sections, crisp panels.
 */

import { useState } from "react";
import {
  Panel,
  PanelHeader,
  PageShell,
  PageHeader,
  StatTile,
  TabBar,
  Pill,
  EmptyState,
  type Dim,
} from "@/components/ui/chrome";
import {
  Gem,
  Activity,
  Layers,
  Type,
  Droplets,
  Wind,
  HeartPulse,
  Wallet,
  Feather,
  Ghost,
} from "lucide-react";

const DIMS: { dim: Dim; label: string }[] = [
  { dim: "health", label: "Health" },
  { dim: "money", label: "Money" },
  { dim: "freedom", label: "Freedom" },
  { dim: "creative", label: "Creative" },
  { dim: "relationships", label: "Relations" },
  { dim: "rhythms", label: "Rhythms" },
  { dim: "blue", label: "Accent" },
  { dim: "ok", label: "OK" },
  { dim: "warn", label: "Warn" },
  { dim: "err", label: "Error" },
];

const TOKENS: { name: string; varName: string; note: string }[] = [
  { name: "Ground", varName: "--ground", note: "the night field — html only, body stays transparent" },
  { name: "Surface 1", varName: "--surface-1", note: "sunken wells: toolbars, table heads" },
  { name: "Surface 2", varName: "--surface-2", note: "blue panel surface" },
  { name: "Surface 3", varName: "--surface-3", note: "hover / elevated" },
  { name: "Line 1–3", varName: "--line-2", note: "hairline → card border → hover border" },
  { name: "Ink 1–3", varName: "--ink-1", note: "primary → muted → faint" },
  { name: "Accent", varName: "--accent-blue", note: "one accent, deployed with restraint" },
  { name: "Ember", varName: "--ember", note: "warm accent used by money-related content" },
];

export default function StyleguidePage() {
  const [tab, setTab] = useState<string>("materials");

  return (
    <PageShell>
      <PageHeader
        icon={Gem}
        title="Pulse Material"
        subtitle="The shared blue dashboard theme. These are the components and custom fonts used across Pulse."
      />

      <TabBar
        tabs={[
          { id: "materials", label: "Materials", icon: Layers },
          { id: "type", label: "Type", icon: Type, dim: "creative" },
          { id: "color", label: "Color", icon: Droplets, dim: "freedom" },
          { id: "motion", label: "Motion", icon: Wind, dim: "rhythms" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* ── Principles — always visible; the contract in five lines ── */}
      <Panel>
        <PanelHeader title="Principles" icon={Gem} />
        <div className="grid gap-2 text-[15px] text-ink-2 leading-relaxed">
          <p><span className="text-ink-1">One blue dashboard.</span> Pages share deep navy surfaces, blue borders, and consistent spacing.</p>
          <p><span className="text-ink-1">A quiet drafting grid.</span> The background belongs to Pulse. Individual pages inherit it.</p>
          <p><span className="text-ink-1">Custom type throughout:</span> Advocate headings, Concourse body text, and Triplicate numbers.</p>
          <p><span className="text-ink-1">Numbers use tabular figures;</span> section indices follow reading order. Status colors keep their meaning.</p>
          <p><span className="text-ink-1">Use the chrome kit.</span> Panel, StatTile, TabBar, Pill — never hand-rolled cards or bespoke palettes.</p>
        </div>
      </Panel>

      {tab === "materials" && (
        <>
          <div className="grid md:grid-cols-3 gap-6">
            <Panel>
              <PanelHeader title="glass — the card" icon={Layers} />
              <p className="text-sm text-ink-2">Standard blue panel with a fine border, restrained depth, and compact corners.</p>
            </Panel>
            <div className="glass-raised rounded-lg p-5">
              <PanelHeader title="glass-raised — elevated" icon={Layers} />
              <p className="text-sm text-ink-2">Popovers, the command palette, modals. Brighter edge, deeper shadow throw.</p>
            </div>
            <div className="glass-sunken rounded-lg p-5">
              <PanelHeader title="glass-sunken — wells" icon={Layers} />
              <p className="text-sm text-ink-2">Table heads, toolbars, inputs. No edge light — recessed, quiet.</p>
            </div>
          </div>
          <div className="glass-silver rounded-lg p-5">
            <PanelHeader title="glass-silver — the KPI strip" icon={Layers} />
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.85)" }}>The bright tier — a silver gradient for headline numbers and hero strips. One per view at most; it competes with everything.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatTile label="Hover physics" value="−1px" unit="lift" icon={Activity} dim="blue" sub="edge light brightens, border sharpens" />
            <StatTile label="Health" value="87" unit="%" icon={HeartPulse} dim="health" sub="dimension-tinted example" />
            <StatTile label="Money" value="42.5k" icon={Wallet} dim="money" sub="mono values, tabular" />
            <StatTile label="Empty states" value="soft" icon={Ghost} dim="neutral" sub="never blank panels" />
          </div>
          <Panel hover>
            <PanelHeader title="interactive panel" icon={Activity} meta="hover me" />
            <EmptyState icon={Feather} title="This panel carries the hover raise." hint="Interactive glass lifts one pixel and brightens its edge — restraint over spectacle." />
          </Panel>
        </>
      )}

      {tab === "type" && (
        <Panel>
          <PanelHeader title="the two voices" icon={Type} />
          <div className="flex flex-col gap-5 py-2">
            <div>
              <h1>Advocate — page titles</h1>
              <div className="text-[13px] text-ink-3 mt-1">h1 · custom narrow display</div>
            </div>
            <div>
              <h2>advocate narrow — section heads</h2>
              <div className="text-[13px] text-ink-3 mt-1">h2 · lowercase, letterspaced</div>
            </div>
            <div>
              <h3>heliotrope caps — sub-sections</h3>
              <div className="text-[13px] text-ink-3 mt-1">h3 · the quiet tier</div>
            </div>
            <div>
              <p className="max-w-[64ch]">Concourse carries the body text. Longer reading passages keep their established custom serif treatment.</p>
            </div>
            <div>
              <span className="mono data-glow text-[24px] text-[color:var(--accent-soft)]">31337 · 8.23.0 · 14/16</span>
              <div className="text-[13px] text-ink-3 mt-1">Triplicate mono — the technical voice. Data, versions, counts. Tabular figures keep changing values aligned.</div>
            </div>
          </div>
        </Panel>
      )}

      {tab === "color" && (
        <>
          <Panel>
            <PanelHeader title="tokens" icon={Droplets} meta="globals.css is the single source" />
            <div className="grid sm:grid-cols-2 gap-3">
              {TOKENS.map((t) => (
                <div key={t.name} className="flex items-center gap-3">
                  <span
                    className="w-9 h-9 rounded-lg border border-line-2 shrink-0"
                    style={{ background: `var(${t.varName})` }}
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-ink-1">{t.name} <span className="mono text-[12px] text-ink-3">{t.varName}</span></div>
                    <div className="text-[13px] text-ink-2">{t.note}</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="dimension + status chips" icon={Droplets} />
            <div className="flex flex-wrap gap-2">
              {DIMS.map(({ dim, label }) => (
                <Pill key={dim} dim={dim}>{label}</Pill>
              ))}
            </div>
            <p className="text-[13px] text-ink-3 mt-3">Life dimensions and warning states retain distinct colors. Blue carries navigation and emphasis.</p>
          </Panel>
        </>
      )}

      {tab === "motion" && (
        <Panel>
          <PanelHeader title="three gestures, no more" icon={Wind} />
          <div className="grid gap-3 text-[15px] text-ink-2">
            <p><span className="text-ink-1">Static background.</span> The drafting grid stays still so attention remains on the data.</p>
            <p><span className="text-ink-1">Page enter.</span> One 480ms rise per navigation, applied by PageShell. Content never staggers item-by-item.</p>
            <p><span className="text-ink-1">Hover lift.</span> Interactive glass raises 1px and brightens its edge in 250ms.</p>
            <p className="text-[13px] text-ink-3">Transitions use CSS timing. Reduced-motion preferences remove the page entrance animation.</p>
          </div>
        </Panel>
      )}
    </PageShell>
  );
}
