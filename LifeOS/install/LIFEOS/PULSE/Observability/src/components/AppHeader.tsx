"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Menu, X, Eye, Ghost } from "lucide-react";
import { useObserverMode } from "@/contexts/ObserverModeContext";
import { TabFreshnessPill } from "@/components/TabFreshnessPill";
// Nav manifest is shared with the command palette — single source of truth.
// AGENTS (metaNav) is pinned in the right cluster on EVERY page — it's the
// meta view of the system working on itself, never part of the scrolling row.
// Row 2 (componentNav + internalNav) is the machine plane, PERMANENT on every
// page: named components, a divider, then the internals — all flat links.
// The SYSTEM mode-switch is gone (2026-08-28).
import { tier1Nav, componentNav, internalNav, metaNav, type NavItem } from "@/lib/palette/nav-manifest";
import { useEnabledModules } from "@/lib/use-enabled-modules";

const fontStyle = { fontFamily: "'concourse-t3', sans-serif" };

export default function AppHeader() {
  const pathname = usePathname();
  // A tab whose module is switched off in PULSE.toml would open a page with no
  // backend answering it, so drop it from both rows and the mobile menu.
  // ported from public PR #1749, @elhoim
  const isEnabled = useEnabledModules();
  const tier1 = tier1Nav.filter(isEnabled);
  const components = componentNav.filter(isEnabled);
  const internals = internalNav.filter(isEnabled);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const { observerMode, toggleObserverMode } = useObserverMode();

  useEffect(() => { setMobileMenuOpen(false); }, [pathname]);

  // Browser-tab naming: every page reads "Pulse | <Page>" keyed off the first path segment.
  // Next's streamed metadata commit can land AFTER this effect on initial load and reset the
  // title to the layout default, so re-assert via a short-lived observer until it settles.
  useEffect(() => {
    const seg = pathname.split("/")[1] ?? "";
    const page = seg === "" ? "Home" : seg === "telos" ? "TELOS" : seg.charAt(0).toUpperCase() + seg.slice(1);
    const want = `Pulse | ${page}`;
    const assert = () => { if (document.title !== want) document.title = want; };
    assert();
    const obs = new MutationObserver(assert);
    obs.observe(document.head, { childList: true, characterData: true, subtree: true });
    const settle = setTimeout(() => obs.disconnect(), 3000);
    return () => { obs.disconnect(); clearTimeout(settle); };
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) setMobileMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [mobileMenuOpen]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/"
      // Today is the root page, so its tab is lit on "/" as well.
      : href === "/today" ? pathname === "/" || pathname.startsWith("/today")
      : pathname.startsWith(href);

  const agentsItem = metaNav[0];
  const AgentsIcon = agentsItem.icon;

  const mobileLink = (item: NavItem, size: "lg" | "sm") => {
    const active = isActive(item.href);
    const Icon = item.icon;
    return (
      <Link key={item.href} href={item.href}
        className={cn("flex items-center gap-2.5 px-3 rounded-lg transition-colors",
          size === "lg" ? "py-2.5 text-[15px] tracking-[0.12em]" : "py-2 text-[13px] tracking-[0.08em]",
          active
            ? size === "lg" ? "bg-white/15 text-ink-1 font-semibold" : "bg-white/10 text-ink-1"
            : size === "lg" ? "font-medium text-ink-2 hover:text-ink-1 hover:bg-white/5" : "text-ink-3 hover:text-ink-2 hover:bg-white/5"
        )} style={fontStyle}>
        <Icon className={size === "lg" ? "w-4 h-4" : "w-3.5 h-3.5"} />{item.label}
      </Link>
    );
  };

  const machineLink = (item: NavItem) => {
    const active = isActive(item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] tracking-[0.08em] rounded transition-colors shrink-0",
          active ? "bg-white/10 text-ink-1" : "text-ink-3 hover:text-ink-2 hover:bg-white/5"
        )}
        style={fontStyle}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" />
        {item.label}
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-50 px-3 sm:px-6 pt-3">
      <div
        className="max-w-[1920px] mx-auto rounded-2xl overflow-visible"
        style={{
          background:
            "var(--sheet-bg)",
          backdropFilter: "blur(28px) saturate(1.5)",
          WebkitBackdropFilter: "blur(28px) saturate(1.5)",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow:
            "var(--glass-shadow)",
        }}
      >
      {/* ── Row 1 — the life plane (persistent global nav) ── */}
      <div className="border-b border-line-1">
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6">
          <div className="flex items-center min-h-14 py-1.5 gap-4 lg:gap-6">
            <Link href="/" className="flex items-center gap-3 shrink-0">
              <Image src="/lifeos-logo.png" alt="LifeOS" width={28} height={28} className="h-7 w-7 object-contain" />
              <span className="text-lg tracking-[0.25em] text-ink-1" style={{ fontFamily: "'advocate-c14', sans-serif", fontWeight: 600 }}>
                PULSE
              </span>
            </Link>

            {/* Wraps to additional lines when items overflow — same pattern as the
                machine row. Never clips items behind a hidden scrollbar. */}
            <nav
              className="hidden md:flex flex-wrap flex-1 items-center justify-start xl:justify-center gap-1 gap-y-1 min-w-0"
            >
              {tier1.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-1.5 px-2 lg:px-2.5 xl:px-3 py-2 text-[12px] lg:text-[13px] xl:text-[14px] tracking-[0.08em] xl:tracking-[0.1em] rounded-md transition-all duration-200 shrink-0",
                      active ? "bg-blue-500/20 text-ink-1 font-semibold" : "font-medium text-ink-3 hover:text-ink-1 hover:bg-white/5"
                    )}
                    style={fontStyle}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* ── Right cluster: AGENTS (meta, pinned) · Observer ── */}
            <div className="flex items-center gap-2 shrink-0 ml-auto">
              <Link
                href={agentsItem.href}
                className={cn(
                  "hidden md:flex items-center gap-1.5 px-3 py-2 text-[13px] xl:text-[14px] tracking-[0.12em] rounded-md transition-all duration-200 shrink-0",
                  isActive(agentsItem.href)
                    ? "text-ink-1 font-semibold"
                    : "font-medium text-ink-2 hover:text-ink-1"
                )}
                style={{
                  ...fontStyle,
                  background: isActive(agentsItem.href) ? "rgba(59,130,246,0.15)" : "transparent",
                  border: isActive(agentsItem.href) ? "1px solid rgba(154,203,255,0.3)" : "1px solid var(--line-2)",
                }}
              >
                <AgentsIcon className="w-4 h-4 shrink-0" />
                {agentsItem.label}
              </Link>

              <button
                onClick={toggleObserverMode}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] tracking-[0.1em] transition-all duration-200",
                  observerMode
                    ? "text-warn"
                    : "text-ink-3 hover:text-ink-2 hover:bg-white/5"
                )}
                style={observerMode ? { background: "rgba(251,191,36,0.14)", border: "1px solid rgba(251,191,36,0.3)" } : undefined}
                title={observerMode ? "Observer mode ON — sensitive data hidden" : "Toggle observer mode"}
              >
                {observerMode ? <Ghost className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline" style={fontStyle}>OBSERVER</span>
              </button>
              <button
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                className="flex md:hidden items-center justify-center w-10 h-10 rounded-lg text-ink-3 hover:text-ink-1 hover:bg-white/5 transition-colors"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* The light thread — a blue→ember filament between the planes; the one
          warm signature detail that keeps the technical frame human. */}
      <div
        aria-hidden
        className="h-px w-full"
        style={{
          marginTop: "-1px",
          background:
            "linear-gradient(90deg, transparent 4%, rgba(59,130,246,0.45) 30%, rgba(154,203,255,0.35) 50%, rgba(224,164,88,0.4) 72%, transparent 96%)",
        }}
      />

      {/* ── Row 2 — the machine plane, PERMANENT. Named major components, a
          divider, then the internals — every page one click, no dropdowns. Lighter
          ground + smaller type keep it visually second-rank without hiding it. ── */}
      <div className="rounded-b-2xl" style={{ background: "var(--surface-1)" }}>
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6">
          <div className="hidden md:flex items-center min-h-11 py-1 gap-1">
            <nav className="flex flex-wrap flex-1 items-center justify-start gap-1 gap-y-1.5 min-w-0">
              {components.map(machineLink)}

              {internals.length > 0 && <span aria-hidden className="mx-1 h-4 w-px shrink-0" style={{ background: "var(--line-1)" }} />}

              {internals.map(machineLink)}
            </nav>
            <TabFreshnessPill className="shrink-0" />
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div ref={mobileMenuRef} className="md:hidden border-b border-line-1 rounded-b-2xl overflow-hidden" style={{ background: "rgba(5, 8, 20, 0.9)", backdropFilter: "blur(22px) saturate(1.6)", WebkitBackdropFilter: "blur(22px) saturate(1.6)" }}>
          <nav className="flex flex-col px-4 py-3 gap-1">
            <div className="text-xs uppercase tracking-wider text-ink-3 px-3 py-1">Sections</div>
            {tier1.map((item) => mobileLink(item, "lg"))}
            <div className="text-xs uppercase tracking-wider text-ink-3 px-3 py-1 mt-2">Meta</div>
            {metaNav.map((item) => mobileLink(item, "lg"))}
            <div className="text-xs uppercase tracking-wider text-ink-3 px-3 py-1 mt-2">Components</div>
            {components.map((item) => mobileLink(item, "sm"))}
            {internals.length > 0 && <div className="text-xs uppercase tracking-wider text-ink-3 px-3 py-1 mt-2">Internals</div>}
            {internals.map((item) => mobileLink(item, "sm"))}
          </nav>
        </div>
      )}
      </div>
    </header>
  );
}
