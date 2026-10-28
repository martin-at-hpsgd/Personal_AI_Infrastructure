// Single source of truth for Pulse's page manifest.
// AppHeader renders the nav from these arrays; the command palette derives its
// page commands from them. Adding a page here updates both surfaces.
import {
  Activity,
  BarChart3,
  BookMarked,
  Boxes,
  Bot,
  BookOpen,
  Brain,
  Briefcase,
  Clapperboard,
  ClipboardCheck,
  Compass,
  Container,
  DollarSign,
  FolderKanban,
  Fingerprint,
  FlaskConical,
  Gauge,
  Gem,
  Home,
  Library,
  Link2,
  ListOrdered,
  MapPin,
  MessageCircleQuestionMark,
  MessageSquare,
  Network,
  Radar,
  ScrollText,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Target,
  TrendingUp,
  UsersRound,
  Waypoints,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Palette-only match aliases; the nav bar ignores this field. */
  keywords?: string[];
  /**
   * PULSE.toml [modules] key backing this page. When that module is switched
   * off its tab disappears from the nav and the palette instead of opening a
   * page with no data behind it. Entries with no key are always shown — either
   * they are infrastructure, or Pulse cannot serve the dashboard without them.
   * ported from public PR #1749, @elhoim
   */
  module?: string;
}

// ── Tier 1 — the persistent global nav (Life sections + System home).
// This is the ONLY always-visible menu. Everything else is contextual.
export const tier1Nav: NavItem[] = [
  // /life and /books shipped as pages with no route into them from anywhere —
  // not in the nav, not in the palette, reachable only by typing the URL.
  // public issue #1708, @schmetti-dev
  { href: "/today", label: "TODAY", icon: Sun, keywords: ["today", "home", "agenda", "calendar", "blockers", "next move", "recommendation", "mood", "sleep", "readiness", "morning"], module: "today" },
  { href: "/life", label: "LIFE", icon: Compass, keywords: ["overview", "today", "snapshot", "dashboard", "rings"] },
  { href: "/telos", label: "TELOS", icon: Target, keywords: ["goals", "mission", "problems"], module: "telos" },
  { href: "/work", label: "WORK", icon: FolderKanban, keywords: ["kanban", "sessions", "tasks", "projects", "repos", "sites"], module: "work" },
  { href: "/content", label: "CONTENT", icon: Clapperboard, keywords: ["videos", "pipeline", "conveyor"], module: "content" },
  { href: "/corpus", label: "CORPUS", icon: BookMarked, keywords: ["published", "writing", "posts", "tweets", "newsletter", "search my content", "opinions", "archive"], module: "corpus" },
  { href: "/health", label: "HEALTH", icon: Activity, keywords: ["sleep", "fitness"], module: "health" },
  { href: "/finances", label: "FINANCES", icon: DollarSign, keywords: ["money", "burn", "expenses", "revenue"], module: "finances" },
  { href: "/business", label: "BUSINESS", icon: Briefcase, keywords: ["company", "newsletter"], module: "business" },
  { href: "/growth", label: "GROWTH", icon: TrendingUp, keywords: ["metrics", "subscribers", "audience"], module: "growth" },
  { href: "/local", label: "LOCAL", icon: MapPin, keywords: ["civic", "crime", "city"], module: "local" },
  { href: "/gear", label: "GEAR", icon: Boxes, keywords: ["assets", "inventory", "own", "stuff"], module: "gear" },
  { href: "/share", label: "SHARE", icon: Link2, keywords: ["files", "links", "uploads", "share link", "screenshots", "recordings", "zight"], module: "share" },
  { href: "/house", label: "HOUSE", icon: Home, keywords: ["home", "lights", "hue", "vacuum", "roomba", "thermostat", "devices", "smart home"], module: "house" },
  { href: "/books", label: "BOOKS", icon: Library, keywords: ["reading", "library", "favorites", "authors"], module: "books" }, // public issue #1708, @schmetti-dev
  { href: "/velocity", label: "VELOCITY", icon: Gauge, keywords: ["shipping", "commits", "velocity", "throughput", "git", "repos", "pace"], module: "velocity" },
  { href: "/atlas", label: "ATLAS", icon: Waypoints, keywords: ["graph", "assets", "estate", "infrastructure", "blast radius", "domains", "workers", "current state"], module: "atlas" },
  { href: "/memory", label: "CORTEX", icon: Brain, keywords: ["memory", "knowledge", "wiki", "notes", "archive", "graph"], module: "memory" },
  { href: "/synapse", label: "SYNAPSE", icon: Share2, keywords: ["ideas", "capture", "router", "amber"], module: "synapse" },
];

// ── Meta — pinned in the header's right cluster on EVERY page, outside both
// rows. Agents is the view of the system working on itself, so it never
// scrolls away and never depends on which plane you're in.
export const metaNav: NavItem[] = [
  { href: "/agents", label: "AGENTS", icon: UsersRound, keywords: ["system", "vitals", "runs", "meta"] },
];

// ── Row 2 — the machine plane, PERMANENT on every page. Named major
// components ride flat (a proper-named subsystem is never hidden behind a
// reveal — principal directive, 2026-08-28); the internals follow flat in internalNav.
// The SYSTEM mode-switch that used to gate this plane is gone.
export const componentNav: NavItem[] = [
  { href: "/gauntlet", label: "Gauntlet", icon: FlaskConical, keywords: ["questions", "models", "answers", "science", "benchmark"], module: "gauntlet" },
  { href: "/assistant", label: "Assistant", icon: Bot, keywords: ["chat", "ask", "da"], module: "da" },
  { href: "/algorithm", label: "Algorithm", icon: Workflow, keywords: ["thinking", "doctrine", "rules", "loop"], module: "algorithm" },
  { href: "/bunker", label: "Bunker", icon: Container, keywords: ["apps", "chassis"], module: "bunker" },
  { href: "/achilles", label: "Achilles", icon: ShieldAlert, keywords: ["vulnerabilities", "findings", "remediation", "registry", "weakness", "cve", "security work", "vuln management"], module: "achilles" },
  { href: "/socrates", label: "Socrates", icon: MessageCircleQuestionMark, keywords: ["questions", "standing questions", "question ledger", "current state", "unknowns", "unanswerable", "blind spots", "surprise", "stm", "delta"], module: "socrates" },
  { href: "/relay", label: "Relay", icon: MessageSquare, keywords: ["texting", "imessage", "tex", "bridge", "guard", "countersign", "lock"], module: "relay" },
  { href: "/vigil", label: "Vigil", icon: Radar, keywords: ["monitor", "events", "alerts", "watch", "heartbeat"], module: "vigil" },
  { href: "/running", label: "Running", icon: Activity, keywords: ["processes", "stuck", "hung", "stray", "orphans", "long-running", "idle", "launchd", "jobs", "running work", "scan"], module: "vigil" },
  { href: "/workflows", label: "Workflows", icon: Network, keywords: ["workflows", "jobs", "scheduled", "cron", "launchd", "pipelines", "sops", "automation", "graph of algorithms", "on demand", "inventory", "cloud", "local", "workers", "cloudflare"], module: "workflows" },
  { href: "/vera", label: "Vera", icon: Fingerprint, keywords: ["people", "profiles", "trust", "credibility", "claims", "sources", "person ledger", "spider", "standing", "reputation"], module: "vera" },
  { href: "/conduit", label: "Conduit", icon: Radar, keywords: ["sensors"], module: "conduit" },
];

// ── Row 2, after the divider — the system internals. Flat links like the
// components beside them; the Ops and Reference hover dropdowns are gone
// (principal directive, 2026-09-22). Upgrades folded into Review on 2026-10-10: Review's page holds the
// pending queue and the applied list, and Ledger stays beside it as the registry of what shipped.
export const internalNav: NavItem[] = [
  { href: "/prioritize", label: "Prioritize", icon: ListOrdered, keywords: ["prioritize", "recommendations", "what should I work on", "next", "focus"], module: "prioritize" },
  { href: "/review", label: "Review", icon: ClipboardCheck, keywords: ["review", "self-review", "decisions", "scorecard", "what to improve", "weekly review", "upgrades", "queue", "hypotheses", "recommendations", "improvements", "directives", "proposals", "coach", "corrections", "coachloop", "assistant behavior", "self-improvement"], module: "review" },
  { href: "/ledger", label: "Ledger", icon: ScrollText, keywords: ["versions", "updates", "deploys", "drift", "integrity", "registry", "changelog"], module: "ledger" },
  { href: "/security", label: "Security", icon: ShieldCheck, keywords: ["monitoring"] },
  { href: "/performance", label: "Performance", icon: BarChart3, keywords: ["performance", "latency"], module: "performance" },
  { href: "/usage", label: "Usage", icon: Gauge, keywords: ["tokens", "cost"], module: "usage" },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/hooks", label: "Hooks", icon: Webhook },
  { href: "/docs", label: "Docs", icon: BookOpen, keywords: ["documentation", "wiki"], module: "docs" },
  { href: "/styleguide", label: "Style", icon: Gem, keywords: ["styleguide", "design", "theme", "glass", "tokens", "material"] },
];

const homeEntry: NavItem = { href: "/", label: "Home", icon: Home, keywords: ["dashboard", "pulse", "today"] };

/** Every page the palette can jump to, in display order. */
export const paletteEntries: NavItem[] = [
  homeEntry,
  ...tier1Nav,
  ...metaNav,
  ...componentNav,
  ...internalNav,
];
