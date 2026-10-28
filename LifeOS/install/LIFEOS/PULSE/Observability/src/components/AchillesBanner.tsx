"use client";

import { useState } from "react";
import { useApi } from "@/lib/api";

// Global Achilles security-work banner. Shows at the top of every Pulse page
// whenever the vulnerability registry holds an OPEN critical or high entry —
// i.e. there is real security work to be done. It clears when the entry is
// closed (remediated / accepted / false_positive) through the Achilles CLI,
// never through a browser-local dismiss: the registry is the state.
// Supersedes the amber-ack SynapseAlertBanner as the security surface
// (LIFEOS/ACHILLES/ISA.md, maintainer-side; not in the public release, Decisions 2026-08-26); /api/synapse/ack stays live.

interface BannerItem { id: string; title: string; severity: string; work_issue: number | null }
interface BannerData { alert: boolean; open_critical: number; open_high: number; items: BannerItem[] }

export default function AchillesBanner() {
  const [open, setOpen] = useState(false);
  // On any error the query keeps its last good data (or none), so the banner stays hidden or as it was.
  const { data } = useApi<BannerData>("/api/achilles/banner", { refetchInterval: 60_000 });

  if (!data?.alert) return null;

  return (
    <div style={{ background: "linear-gradient(90deg,#7f1d1d,#b91c1c)", color: "#fff", borderBottom: "1px solid rgba(255,255,255,0.15)" }}>
      <div className="max-w-[1920px] mx-auto" style={{ padding: "8px 16px" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", width: "100%", textAlign: "left", padding: 0, display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 600, letterSpacing: "0.02em" }}
        >
          <span style={{ fontSize: 15 }}>🛡️</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Achilles: {data.items.length} open {data.items.length === 1 ? "vulnerability" : "vulnerabilities"} (critical/high)
            {data.items[0] ? ` — ${data.items[0].title}` : ""}
            {data.items.length > 1 ? ` +${data.items.length - 1} more` : ""}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.85 }}>{open ? "hide ▲" : "review ▼"}</span>
        </button>
        {open && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {data.items.map((it) => (
              <div key={it.id} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 12, opacity: 0.95 }}>
                <span style={{ fontWeight: 700, flex: "none" }}>{it.id}</span>
                <span style={{ textTransform: "uppercase", fontSize: 10, letterSpacing: "0.06em", flex: "none", opacity: 0.85 }}>{it.severity}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                <a href="/achilles" style={{ color: "#fff", textDecoration: "underline", flex: "none" }}>open Achilles →</a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
