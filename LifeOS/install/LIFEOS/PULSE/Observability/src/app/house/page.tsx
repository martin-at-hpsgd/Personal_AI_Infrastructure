"use client";

import { useCallback, useEffect, useState } from "react";
import { Home, Lightbulb, Bot, RefreshCw, BatteryCharging, Trash2, Power, Thermometer, Camera, BedDouble, Droplets } from "lucide-react";
import { PageShell, PageHeader, Panel, Pill, EmptyState } from "@/components/ui/chrome";
import EmptyStateGuide from "@/components/EmptyStateGuide";
import { CameraPreviews } from "./camera-previews";
import { apiSend, useApi } from "@/lib/api";

// ── shapes (mirror LIFEOS/MEMORY/_HOUSE/latest.json) ──
interface Light { id: string; name: string; on: boolean; bri: number | null; reachable: boolean }
interface Room { id: string; name: string; type: string; anyOn: boolean; allOn: boolean; bri: number | null; lights: Light[] }
interface Vacuum {
  slug: string; name: string; floor: string; ip: string; reachable: boolean;
  phase: string | null; label?: string; battery: number | null; binFull: boolean | null;
  cleaning?: boolean; docked?: boolean; minutes: number | null; error?: string | null;
}
interface BedSide {
  side: string; solo: boolean; mine: boolean; state: string | null; on: boolean;
  targetC: number | null; currentC: number | null;
}
interface Bed {
  ok: boolean; model?: string | null; online?: boolean | null; hasWater?: boolean | null;
  needsPriming?: boolean | null; priming?: boolean | null; lastHeard?: string | null; sides?: BedSide[]; error?: string;
}
interface House {
  fetchedAt: string;
  lights: { ok: boolean; roomCount?: number; lightCount?: number; anyOn?: boolean; rooms?: Room[]; error?: string };
  vacuums: { ok: boolean; count?: number; robots?: Vacuum[]; error?: string };
  bed?: Bed;
  climate?: { ok: boolean; error?: string; thermostats: { id: string; name: string; currentC: number | null; targetC: number | null; mode: string | null }[] };
  cameras?: { ok: boolean; error?: string; devices: { id: string; name: string; connection: string; present: boolean }[] };
}

function freshness(iso: string | null): string {
  if (!iso) return "unknown";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function batteryColor(pct: number | null): string {
  if (pct === null) return "var(--ink-3)";
  if (pct >= 60) return "var(--ok)";
  if (pct >= 25) return "var(--warn)";
  return "var(--err)";
}

export default function HousePage() {
  const { data: house = null, isPending: loading, refetch } = useApi<House>("/api/house", { refetchInterval: 15000 });
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000); // not-data: clock tick for relative ages
    return () => clearInterval(t);
  }, []);

  // Act, then refetch so the UI reconfirms from the device's own reported state.
  const act = useCallback(
    async (device: string, target: string, action: string, value?: number) => {
      const key = `${device}:${target}:${action}`;
      setPending(key);
      try {
        try {
          await apiSend("/api/house/action", "POST", { device, target, action, value });
        } catch {
          /* as before: a failed action still refetches the device's reported state */
        }
        await refetch();
      } finally {
        setPending(null);
      }
    },
    [refetch],
  );

  if (loading && !house) {
    return (
      <PageShell>
        <PageHeader title="House" icon={Home} subtitle="Loading home devices…" />
      </PageShell>
    );
  }

  // Fresh install: /api/house answers { ok: false } until house-poll has primed the cache.
  if (!house?.lights || !house?.vacuums) {
    return (
      <PageShell>
        <PageHeader title="House" icon={Home} subtitle="No home devices configured yet" />
        <EmptyStateGuide
          section="House"
          description="Lights, vacuums, thermostats, cameras and the bed appear here once the house poller has read your devices. It needs a home skill (not part of the public release) that names your bridges and devices; once one is installed, the poller fills the cache."
          hideInterview
          daPromptExample="help me set up my home devices"
        />
      </PageShell>
    );
  }

  const rooms = house?.lights.rooms ?? [];
  const vacuums = house?.vacuums.robots ?? [];
  const lightsOn = rooms.reduce((n, r) => n + r.lights.filter((l) => l.on).length, 0);
  const cleaning = vacuums.filter((v) => v.cleaning).length;
  const bed = house?.bed?.ok ? house.bed : null;
  const bedSides = bed?.sides ?? [];
  const bedOn = bedSides.some((s) => s.on);
  const readingsFresh = !!house && Number.isFinite(Date.parse(house.fetchedAt)) && now - Date.parse(house.fetchedAt) < 180000;

  return (
    <PageShell>
      <PageHeader
        title="House"
        icon={Home}
        subtitle={`${lightsOn} lights on · ${vacuums.length} vacuum${vacuums.length === 1 ? "" : "s"}${cleaning ? ` · ${cleaning} cleaning` : ""}`}
        actions={
          <button
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-ink-2 hover:text-ink-1 transition-colors"
            style={{ background: "var(--surface-2)" }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> {house ? `cached ${freshness(house.fetchedAt)}` : "refresh"}
          </button>
        }
      />

      <CameraPreviews />

      <section className="mt-8" aria-label="Thermostats">
        <div className="flex items-center gap-2 mb-3">
          <Thermometer className="w-4 h-4 text-ink-3" />
          <h2 className="text-[13px] font-semibold text-ink-2">Thermostats</h2>
        </div>
        {house?.climate?.ok && readingsFresh ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {house.climate.thermostats.map(t => (
              <Panel key={t.id} className="p-4">
                <div className="flex justify-between gap-3"><span className="font-medium text-ink-1">{t.name}</span><Pill dim="neutral">{t.mode ?? "Mode unavailable"}</Pill></div>
                <div className="text-3xl text-ink-1 mt-3">{t.currentC ?? "—"} <span className="text-lg text-ink-3">°C</span></div>
                <div className="text-[13px] text-ink-3 mt-2">Target {t.targetC === null ? "unavailable" : `${t.targetC} °C`}</div>
              </Panel>
            ))}
          </div>
        ) : <EmptyState icon={Thermometer} title="Thermostat readings unavailable" hint={!readingsFresh ? "House readings are out of date. Waiting for an update." : house?.climate?.error ?? "Waiting for the next house update"} />}
      </section>

      <details className="mt-8">
        <summary className="text-sm text-ink-3 cursor-pointer">Camera network details</summary>
      <section className="mt-3" aria-label="Camera network details">
        <div className="flex items-center gap-2 mb-3">
          <Camera className="w-4 h-4 text-ink-3" />
          <h2 className="text-[13px] font-semibold text-ink-2">Network inventory</h2>
        </div>
        <p className="text-[13px] text-ink-3 mb-3">Router names and network presence are separate from the Apple Home previews above.</p>
        {!house?.cameras?.ok && <p role="status" className="text-[13px] text-[color:var(--warn)] mb-3">{house?.cameras?.error ?? "Waiting for camera discovery"}</p>}
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {(house?.cameras?.devices ?? []).map(c => (
            <Panel key={c.id} className="p-4 flex flex-col gap-2">
              <div className="font-medium text-ink-1 break-words">{c.name}</div>
              <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
                <span className="capitalize">{c.connection}</span>
                <Pill dim={!house?.cameras?.ok || !readingsFresh ? "neutral" : c.present ? "blue" : "warn"}>{!readingsFresh ? "Reading expired" : !house?.cameras?.ok ? "Status unavailable" : c.present ? "On network" : "Not on network"}</Pill>
              </div>
            </Panel>
          ))}
        </div>
        {house?.cameras?.ok && !house.cameras.devices.length && <EmptyState icon={Camera} title="No cameras discovered" hint="No camera or doorbell names were reported by the router." />}
      </section>

      </details>

      {/* ── Bed ── */}
      <section className="mt-8">
        <div className="flex items-center gap-2 mb-3">
          <BedDouble className="w-4 h-4 text-ink-3" />
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            Bed {house?.bed?.ok && <span className="text-ink-3/70 normal-case tracking-normal">· Eight Sleep {house.bed.model ?? "Pod"}{bedOn ? " · on" : " · off"}</span>}
          </h2>
        </div>
        {house?.bed?.ok ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {bedSides.map((s) => {
              const sideArg = s.solo ? "mine" : s.side;
              const busy = pending?.startsWith(`bed:${sideArg}`);
              return (
                <Panel key={s.side} className="p-4 flex flex-col gap-3" style={s.on ? { borderColor: "var(--accent-blue)" } : undefined}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-ink-1 font-medium capitalize">{s.solo ? "Whole bed" : `${s.side} side`}</div>
                      <div className="text-[12px] text-ink-3">
                        {s.on ? `target ${s.targetC ?? "—"} °C` : "off"} · now {s.currentC ?? "—"} °C
                      </div>
                    </div>
                    <Pill dim={s.on ? "blue" : "neutral"}>{s.state ?? "—"}</Pill>
                  </div>
                  {s.on && (
                    <input
                      type="range"
                      min={13}
                      max={44}
                      defaultValue={s.targetC ?? 27}
                      disabled={busy}
                      onMouseUp={(e) => act("bed", sideArg, "temp", Number((e.target as HTMLInputElement).value))}
                      onTouchEnd={(e) => act("bed", sideArg, "temp", Number((e.target as HTMLInputElement).value))}
                      className="w-full accent-[color:var(--accent-blue)]"
                      title="Target °C (13 cold … 44 hot)"
                    />
                  )}
                  <div className="flex gap-2">
                    {s.on ? (
                      <ActBtn label="Off" onClick={() => act("bed", sideArg, "off")} busy={busy} />
                    ) : (
                      <ActBtn label="On" primary onClick={() => act("bed", sideArg, "on")} busy={busy} />
                    )}
                    <ActBtn label="Cool 19°" onClick={() => act("bed", sideArg, "temp", 19)} busy={busy} />
                    <ActBtn label="Warm 30°" onClick={() => act("bed", sideArg, "temp", 30)} busy={busy} />
                  </div>
                  <div className="flex items-center gap-3 text-[12px] text-ink-3">
                    <span className="inline-flex items-center gap-1"><Droplets className="w-3.5 h-3.5" /> {bed?.hasWater ? "water ok" : "low water"}</span>
                    {bed?.needsPriming && <span className="text-[color:var(--warn)]">needs priming</span>}
                    {bed?.online === false && <span className="text-[color:var(--err)]">offline</span>}
                  </div>
                </Panel>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={BedDouble} title="Bed unreachable" hint={house?.bed?.error ?? "Eight Sleep not configured"} />
        )}
      </section>

      {/* ── Vacuums ── */}
      <section className="mt-8">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="w-4 h-4 text-ink-3" />
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">Vacuums</h2>
        </div>
        {house?.vacuums.ok ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {vacuums.map((v) => {
              const busy = pending?.startsWith(`vacuum:${v.floor}`);
              return (
                <Panel key={v.slug} className="p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-ink-1 font-medium">{v.name}</div>
                      <div className="text-[12px] text-ink-3 capitalize">{v.floor}</div>
                    </div>
                    <Pill dim={v.cleaning ? "ok" : v.error ? "err" : "blue"}>{v.label ?? v.phase ?? "—"}</Pill>
                  </div>
                  <div className="flex items-center gap-4 text-[13px]">
                    <span className="inline-flex items-center gap-1.5" style={{ color: batteryColor(v.battery) }}>
                      <BatteryCharging className="w-4 h-4" />
                      {v.battery ?? "—"}%
                    </span>
                    {v.binFull && <span className="text-[color:var(--warn)] inline-flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> bin full</span>}
                  </div>
                  <div className="flex gap-2">
                    {v.cleaning ? (
                      <ActBtn label="Stop" onClick={() => act("vacuum", v.floor, "stop")} busy={busy} />
                    ) : (
                      <ActBtn label="Clean" primary onClick={() => act("vacuum", v.floor, "clean")} busy={busy} />
                    )}
                    <ActBtn label="Dock" onClick={() => act("vacuum", v.floor, "dock")} busy={busy} />
                    <ActBtn label="Find" onClick={() => act("vacuum", v.floor, "locate")} busy={busy} />
                  </div>
                </Panel>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Bot} title="Vacuums unreachable" hint={house?.vacuums.error} />
        )}
      </section>

      {/* ── Lights ── */}
      <section className="mt-8">
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-ink-3" />
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            Lights {house?.lights.ok && <span className="text-ink-3/70 normal-case tracking-normal">· {lightsOn} on across {rooms.length} rooms</span>}
          </h2>
        </div>
        {house?.lights.ok ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {rooms.map((room) => {
              const on = room.lights.filter((l) => l.on).length;
              const busy = pending?.startsWith(`light:${room.name}`);
              return (
                <Panel key={room.id} className="p-4 flex flex-col gap-3" style={room.anyOn ? { borderColor: "var(--ember)" } : undefined}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-ink-1 font-medium truncate">{room.name}</div>
                      <div className="text-[12px] text-ink-3">{on}/{room.lights.length} on</div>
                    </div>
                    <button
                      onClick={() => act("light", room.name, room.anyOn ? "off" : "on")}
                      disabled={busy || room.lights.length === 0}
                      className="shrink-0 w-9 h-9 rounded-lg inline-flex items-center justify-center transition-colors disabled:opacity-40"
                      style={{ background: room.anyOn ? "color-mix(in oklab, var(--ember) 22%, transparent)" : "var(--surface-2)", color: room.anyOn ? "var(--ember)" : "var(--ink-3)" }}
                      title={room.anyOn ? "Turn off" : "Turn on"}
                    >
                      <Power className="w-4 h-4" />
                    </button>
                  </div>
                  {room.anyOn && (
                    <input
                      type="range"
                      min={0}
                      max={100}
                      defaultValue={room.bri !== null ? Math.round((room.bri / 254) * 100) : 100}
                      disabled={busy}
                      onMouseUp={(e) => act("light", room.name, "bri", Number((e.target as HTMLInputElement).value))}
                      onTouchEnd={(e) => act("light", room.name, "bri", Number((e.target as HTMLInputElement).value))}
                      className="w-full accent-[color:var(--ember)]"
                    />
                  )}
                </Panel>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Lightbulb} title="Hue bridge unreachable" hint={house?.lights.error} />
        )}
      </section>

      {/* ── Coming online ── */}
      <section className="mt-8">
        <Panel className="p-4">
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3 mb-2">Coming online</div>
          <div className="flex flex-wrap gap-2">
            <Pill dim="neutral">Locks · Sensors — next phase</Pill>
          </div>
        </Panel>
      </section>
    </PageShell>
  );
}

function ActBtn({ label, onClick, busy, primary }: { label: string; onClick: () => void; busy?: boolean; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40"
      style={
        primary
          ? { background: "color-mix(in oklab, var(--accent-blue) 24%, transparent)", color: "var(--accent-blue)" }
          : { background: "var(--surface-2)", color: "var(--ink-2)" }
      }
    >
      {busy ? "…" : label}
    </button>
  );
}
