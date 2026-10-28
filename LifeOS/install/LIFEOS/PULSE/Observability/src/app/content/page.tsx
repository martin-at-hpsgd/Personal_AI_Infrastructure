"use client";

import { useEffect, useState } from "react";
import { apiSend, useApi, useApiMutation } from "@/lib/api";
import { PageShell, PageHeader, Panel, Pill, dimStyle, type Dim } from "@/components/ui/chrome";

// ── CONVEYOR: the live content board. Dense cards, SSE push, poll fallback. ──

interface Item {
  id: string;
  title: string;
  type: string;
  stage: string;
  legs: Record<string, string>;
  stage_status?: string;
  activity?: string;
  activity_at?: string;
  blocked?: boolean;
  attempt?: number;
  requested_run?: string;
  /** Produce components from the type profile (typed intake); absent on older rows. */
  steps?: Record<string, string>;
  /** Named run for this type: regular | sponsored | podcast. */
  run?: string;
  created: string;
}
interface TypeProfile {
  label: string;
  legs: string[];
  steps: string[];
  run: string;
  color: Dim;
}
interface BoardData {
  columns: string[];
  legs: string[];
  types?: Record<string, TypeProfile>;
  items: Item[];
  counts: Record<string, number>;
}

// Status → design-token dimension. running=blue, done=ok, failed=err, changes=warn.
function legDim(s: string): Dim {
  return (
    { pending: "neutral", running: "blue", done: "ok", failed: "err", "changes-requested": "warn" } as Record<string, Dim>
  )[s] ?? "neutral";
}
function elapsed(fromISO?: string, nowMs = Date.now()): string {
  if (!fromISO) return "";
  const s = Math.max(0, Math.round((nowMs - Date.parse(fromISO)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function ContentPage() {
  const [data, setData] = useState<BoardData | null>(null);
  const [live, setLive] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Polling is only the fallback beside the SSE stream: it switches on when the stream is unavailable.
  const [polling, setPolling] = useState(false);
  const board = useApi<BoardData>("/api/content", { enabled: polling, refetchInterval: 2500 });

  const deleteItem = useApiMutation((id: string) => apiSend(`/api/content/${id}`, "DELETE"), { invalidates: ["/api/content"] });
  const setItemType = useApiMutation((v: { id: string; type: string }) => apiSend(`/api/content/${v.id}/type`, "POST", { type: v.type }), { invalidates: ["/api/content"] });
  const runItem = useApiMutation((id: string) => apiSend(`/api/content/${id}/run`, "POST"), { invalidates: ["/api/content"] });

  // Keep the last good frame when a poll fails; apply each successful poll.
  useEffect(() => {
    if (board.data) setData(board.data);
  }, [board.data, board.dataUpdatedAt]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000); // not-data: 1s clock tick for the elapsed-time labels
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    const startPoll = () => setPolling(true);
    try {
      es = new EventSource("/api/content/stream");
      es.onmessage = (ev) => {
        try {
          setData(JSON.parse(ev.data));
          setLive(true);
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        setLive(false);
        es?.close();
        startPoll();
      };
    } catch {
      startPoll();
    }
    return () => {
      es?.close();
    };
  }, []);

  const columns = data?.columns ?? ["inbox", "prep", "produce", "review", "publishing", "done"];

  return (
    <PageShell>
      <style>{`
        @keyframes conv-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.3; transform:scale(.8); } }
        @keyframes conv-glow { 0%,100% { box-shadow: 0 0 0 1px var(--accent-blue); } 50% { box-shadow: 0 0 0 1px var(--accent-blue), 0 0 12px -3px var(--accent-blue); } }
        @keyframes conv-shim { 0% { background-position:-160% 0; } 100% { background-position:160% 0; } }
        .conv-run { animation: conv-glow 1.6s ease-in-out infinite; }
        .conv-dot { animation: conv-pulse 1.1s ease-in-out infinite; }
        .conv-bar { background:linear-gradient(90deg,transparent,var(--accent-blue),transparent); background-size:200% 100%; animation:conv-shim 1.4s linear infinite; }
        .conv-x { color:var(--ink-3); cursor:pointer; transition:color .15s ease; background:none; border:none; font-family:inherit; }
        .conv-x:hover { color:var(--err); }
      `}</style>

      <PageHeader
        title="Content"
        subtitle="drop → transcribe → make (the type decides the steps) → review → ship (the type decides the legs)"
        actions={
          <>
            <Pill dim={live ? "ok" : "neutral"}>
              <span
                className={live ? "conv-dot" : undefined}
                style={{ width: 6, height: 6, borderRadius: 999, background: live ? "var(--ok)" : "var(--ink-3)" }}
              />
              {live ? "LIVE" : "POLLING"}
            </Pill>
            <span className="text-[12px] text-ink-3 mono">{data ? `${data.items.length}` : "…"}</span>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns.length}, minmax(0,1fr))`, gap: 8 }}>
        {columns.map((col) => {
          const items = (data?.items ?? []).filter((it) => (it.stage ?? "inbox") === col);
          return (
            <Panel key={col} className="p-2 min-h-[calc(100vh-220px)]" style={{ background: "var(--surface-1)" }}>
              <div
                className="text-[10px] tracking-[0.16em] px-0.5 pt-0.5 pb-2"
                style={{ color: items.length ? "var(--accent-blue)" : "var(--ink-3)" }}
              >
                {col.toUpperCase()} <span className="text-ink-3">{items.length}</span>
              </div>
              {items.map((it) => {
                const running = it.stage_status === "running";
                const failed = it.stage_status === "failed" || it.blocked;
                const done = it.stage_status === "done";
                const dot = `var(--${running ? "accent-blue" : failed ? "err" : done ? "ok" : "ink-3"})`;
                const statusLabel = running ? "RUNNING" : failed ? "BLOCKED" : done ? "READY" : "IDLE";
                const types = data?.types ?? {};
                const profile = types[it.type];
                const typed = Boolean(profile);
                const typeColor: Dim = profile?.color ?? "neutral";
                // The type is a free choice until produce starts; after that the branches are being worked.
                const retypable = ["inbox", "prep"].includes(it.stage) && Object.keys(types).length > 0;
                const border = running
                  ? "var(--accent-blue)"
                  : failed
                    ? "var(--err)"
                    : done
                      ? "rgba(74,222,128,0.4)"
                      : "var(--line-2)";
                return (
                  <Panel
                    key={it.id}
                    className={`p-3 mb-2 relative overflow-hidden ${running ? "conv-run" : ""}`}
                    style={{ borderColor: border }}
                  >
                    {running && <div className="conv-bar" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 }} />}

                    {/* Title row */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                      <span className={running ? "conv-dot" : undefined} style={{ width: 7, height: 7, borderRadius: 999, background: dot, flex: "0 0 auto", marginTop: 4 }} />
                      <span className="text-ink-1" style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, flex: 1, minWidth: 0, wordBreak: "break-word" }}>{it.title}</span>
                      <button
                        type="button"
                        className="conv-x"
                        title="Delete item — stops its tasks"
                        aria-label={`Delete ${it.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete "${it.title}" and stop its tasks?`)) {
                            deleteItem.mutate(it.id);
                          }
                        }}
                        style={{ fontSize: 15, lineHeight: 1, padding: "0 2px", flex: "0 0 auto" }}
                      >
                        ×
                      </button>
                    </div>

                    {/* Meta row: type · status · elapsed */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "8px 0 2px", paddingLeft: 14 }}>
                      {retypable ? (
                        <select
                          value={typed ? it.type : ""}
                          title="Content type — decides which steps get made and which legs it ships on"
                          aria-label={`Type for ${it.title}`}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            setItemType.mutate({ id: it.id, type: e.target.value });
                          }}
                          className="rounded-full text-[11px] font-medium uppercase cursor-pointer"
                          style={{ ...dimStyle(typeColor, true), padding: "1px 8px", fontFamily: "inherit", border: "none", appearance: "auto" }}
                        >
                          {!typed && <option value="">untyped · pick</option>}
                          {Object.entries(types).map(([k, p]) => (
                            <option key={k} value={k}>{p.label}</option>
                          ))}
                        </select>
                      ) : (
                        <Pill dim={typeColor} className="uppercase" title={typed ? `${it.type} · ${it.run ?? profile?.run ?? "regular"} run` : "untyped"}>
                          {profile?.label ?? it.type}
                        </Pill>
                      )}
                      <span style={{ fontSize: 9.5, letterSpacing: "0.08em", color: dot, fontWeight: 600 }}>{statusLabel}</span>
                      {it.requested_run ? (
                        <Pill dim="blue" title={`${it.requested_run} run queued`}>RUN QUEUED · {it.requested_run.toUpperCase()}</Pill>
                      ) : (
                        !["review", "publishing", "done"].includes(it.stage) && (
                          <button
                            type="button"
                            title={`Queue the ${it.run ?? profile?.run ?? "regular"} run for this type (staged, never auto-published)`}
                            onClick={(e) => {
                              e.stopPropagation();
                              runItem.mutate(it.id);
                            }}
                            className="rounded-full text-[12px] font-medium cursor-pointer"
                            style={{ ...dimStyle("blue", true), padding: "1px 8px", fontFamily: "inherit" }}
                          >
                            ▶ RUN
                          </button>
                        )
                      )}
                      {(running || done) && it.activity_at && (
                        <span className="text-ink-3" style={{ fontSize: 9.5 }}>{elapsed(it.activity_at, nowMs)}</span>
                      )}
                      {failed && it.attempt ? <span style={{ fontSize: 9.5, color: "var(--err)" }}>try {it.attempt}</span> : null}
                    </div>

                    {/* Activity line */}
                    {it.activity && (
                      <div
                        style={{ fontSize: 10.5, color: running ? "var(--accent-blue)" : failed ? "var(--err)" : "var(--ink-3)", margin: "3px 0 0", paddingLeft: 14, lineHeight: 1.35, wordBreak: "break-word" }}
                      >
                        {it.activity}
                      </div>
                    )}

                    {/* Divider */}
                    <div className="bg-line-2" style={{ height: 1, margin: "9px 0 8px", marginLeft: 14 }} />

                    {/* The branches: MAKE = produce steps from the type profile, SHIP = publish legs. */}
                    {[
                      { label: "MAKE", entries: Object.entries(it.steps ?? {}) },
                      { label: "SHIP", entries: Object.entries(it.legs ?? {}) },
                    ]
                      .filter((row) => row.entries.length > 0)
                      .map((row) => (
                        <div key={row.label} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, paddingLeft: 14, marginBottom: 4 }}>
                          <span className="text-ink-3" style={{ fontSize: 8.5, letterSpacing: "0.16em", width: 30, flex: "0 0 auto" }}>{row.label}</span>
                          {row.entries.map(([name, status]) => {
                            const d = legDim(status);
                            return (
                              <Pill key={name} dim={d} title={`${name}: ${status}`}>
                                <span style={{ width: 5, height: 5, borderRadius: 999, background: `var(--${d === "blue" ? "accent-blue" : d === "neutral" ? "ink-3" : d})` }} />
                                {name}
                              </Pill>
                            );
                          })}
                        </div>
                      ))}
                  </Panel>
                );
              })}
            </Panel>
          );
        })}
      </div>
    </PageShell>
  );
}
