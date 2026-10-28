import { basename } from "node:path";
import type { Card, Evidence, Step, Trigger, WorkflowRecord, Runtime } from "../types.ts";

const LIMIT = 200;
/**
 * A card field, trimmed to the 200-character payload ceiling without cutting a
 * word: anything longer is cut at the last word boundary before character 199
 * and ends in "…" (a single word longer than that is cut hard).
 */
export const short = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length <= LIMIT) return text;
  const head = text.slice(0, LIMIT - 1);
  const boundary = head.search(/\s\S*$/);
  return `${(boundary > 0 ? head.slice(0, boundary) : head).replace(/[\s,;:–—-]+$/, "")}…`;
};
/** A purpose reads as one sentence: the first one, when it fits; otherwise the whole text, shortened. */
export const purposeOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  // A sentence ends at . ! or ? followed by the end or a new sentence's opening
  // character, so "e.g. the" and "~/x.md" do not end one.
  const first = /^(.+?[.!?])(?=\s+[A-Z("'“‘`*]|$)/.exec(text)?.[1];
  return first && first.length <= LIMIT ? first : short(text);
};
/** Minutes as a person says them: 1 → every minute, 120 → every 2h, 1440 → daily. */
export function everyMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `every ${minutes}m`;
  if (minutes === 1) return "every minute";
  if (minutes === 60) return "hourly";
  if (minutes === 1440) return "daily";
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `every ${minutes / 1440}d`;
  if (minutes % 60 === 0) return `every ${minutes / 60}h`;
  return `every ${Math.round(minutes)}m`;
}
/** launchd StartInterval seconds, humanized; the raw seconds stay in trigger.expr. */
export function everySeconds(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`;
  return seconds % 60 === 0 ? everyMinutes(seconds / 60) : `every ${Math.round(seconds / 60)}m`;
}
export const emptyEvidence = (): Evidence => ({ kind: "none", lastRunAt: null, lastStatus: "unknown", source: null, runs: null });
export const step = (label: string, executor: Step["executor"] = "code", id = "1"): Step => ({ id: id.slice(0, 200), label: label.slice(0, 200), executor });
export const scriptName = (command: unknown): string => {
  const tokens = Array.isArray(command) ? command.map(String) : String(command ?? "").split(/\s+/);
  const token = tokens.find(t => /\.(ts|js|sh|py|mjs|cjs)(?:["']|$)/.test(t)) ?? tokens.find(t => !/^(bun|node|bash|sh|\{\{BUN\}\})$/.test(t)) ?? "script";
  return basename(token.replace(/["']/g, "")).slice(0, 200);
};
const CARD_SLOTS = ["purpose", "input", "steps", "sop", "output", "destination"] as const;
function outputForDestination(destination: string | null): string | null {
  if (!destination) return null;
  if (/\.jsonl$/i.test(destination)) return "JSONL event log";
  if (/\.json$/i.test(destination)) return "JSON state file";
  if (/\.log$/i.test(destination)) return "run log";
  if (/\.md$/i.test(destination)) return "Markdown file";
  if (/\.html$/i.test(destination)) return "HTML page";
  const named: Record<string, string> = {
    "iMessage via Relay": "text message",
    email: "email",
    "ntfy push": "push notification",
    "spoken via VoiceServer": "spoken notification",
    "Pulse log": "log line in Pulse",
  };
  return named[destination] ?? null;
}
export function card(fields: Partial<Card> = {}): Card {
  const destination = short(fields.destination);
  const output = short(fields.output);
  const derivedOutput = output === null ? outputForDestination(destination) : null;
  const inferred = CARD_SLOTS.filter(k => fields.inferred?.includes(k));
  if (derivedOutput !== null && !inferred.includes("output")) inferred.push("output");
  const result: Card = {
    purpose: purposeOf(fields.purpose), input: short(fields.input),
    steps: (fields.steps ?? []).map((s, i) => step(s.label, s.executor, s.id || String(i + 1))),
    sop: short(fields.sop), output: output ?? derivedOutput, destination, inferred, undeclared: [],
  };
  result.undeclared = CARD_SLOTS.filter(k => !result.inferred.includes(k) && (k === "steps" ? !result.steps.length || result.steps.every(s => s.executor === "unknown") : result[k] === null));
  return result;
}
export function record(runtime: Runtime, name: string, title: string, group: string, trigger: Trigger, definedIn: string, fields: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return { id: `${runtime}:${name}`, runtime, name, title: title.slice(0, 200), group: group.slice(0, 200),
    enabled: true, declared: true, installed: "deployed", trigger, evidence: emptyEvidence(), card: card(), definedIn,
    linked: [], ...fields };
}
export function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
}
/** Historical wording remains stable for the /assistant scheduled view. */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min.startsWith("*/") && hour === "*") return `every ${min.slice(2)}m`;
  if (hour.startsWith("*/") && dom === "*") return `every ${hour.slice(2)}h`;
  if (min !== "*" && hour === "*") return "hourly";
  if (min !== "*" && hour !== "*" && dom === "*" && mon === "*" && dow === "*") return `daily ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
  return expr;
}
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function cronTrigger(expr: string): Trigger {
  const interval = /^every (\d+)([mh])$/.exec(expr.trim());
  if (interval) {
    const minutes = Number(interval[1]) * (interval[2] === "h" ? 60 : 1);
    return { kind: "schedule", expr, display: everyMinutes(minutes), periodMinutes: minutes };
  }
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return { kind: "schedule", expr, display: expr.slice(0, 200), periodMinutes: null };
  const [m, h, dom, mon, dow] = p;
  if (p.every(x => x === "*")) return { kind: "schedule", expr, display: "every minute", periodMinutes: 1 };
  if (/^\*\/\d+$/.test(m) && h === "*") return { kind: "schedule", expr, display: everyMinutes(Number(m.slice(2))), periodMinutes: Number(m.slice(2)) };
  if (/^\*\/\d+$/.test(h)) return { kind: "schedule", expr, display: everyMinutes(Number(h.slice(2)) * 60), periodMinutes: Number(h.slice(2)) * 60 };
  if (/^\d+(,\d+)+$/.test(m) && h === "*") {
    // "0,30 * * * *" is every 30m when the minutes are evenly spaced around the hour.
    const mins = m.split(",").map(Number).sort((a, b) => a - b);
    const gaps = mins.map((x, i) => ((mins[(i + 1) % mins.length] - x + 60) % 60) || 60);
    if (gaps.every(g => g === gaps[0])) return { kind: "schedule", expr, display: everyMinutes(gaps[0]), periodMinutes: gaps[0] };
    return { kind: "schedule", expr, display: `hourly at ${mins.map(x => `:${String(x).padStart(2, "0")}`).join(", ")}`, periodMinutes: Math.max(...gaps) };
  }
  if (m !== "*" && h === "*") return { kind: "schedule", expr, display: `hourly at :${m.padStart(2, "0")}`, periodMinutes: 60 };
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*") {
    const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
    if (dow === "*") return { kind: "schedule", expr, display: `daily ${time}`, periodMinutes: 1440 };
    const selected = dow.split(",").flatMap(part => {
      const range = part.split("-").map(Number);
      return range.length === 2 ? Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i) : [Number(part)];
    }).map(n => n === 7 ? 0 : n).filter(n => n >= 0 && n <= 6).sort((a, b) => a - b);
    if (selected.length) {
      const gaps = selected.map((n, i) => ((selected[(i + 1) % selected.length] - n + 7) % 7) || 7);
      const label = selected.length === 1 ? `weekly ${days[selected[0]]}` : selected.length === 6 && !selected.includes(5) ? "Sat–Thu" : selected.map(n => days[n]).join(", ");
      return { kind: "schedule", expr, display: `${label} ${time}`, periodMinutes: Math.max(...gaps) * 1440 };
    }
  }
  return { kind: "schedule", expr, display: expr.slice(0, 200), periodMinutes: null };
}
