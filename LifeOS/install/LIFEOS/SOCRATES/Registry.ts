/**
 * Socrates Registry — loads and validates the standing-question ledger.
 *
 * Questions are DATA, not code: they live under LIFEOS/USER/SOCRATES/questions/
 * (the private USER repo — git history is the audit trail). The engine ships
 * with zero real questions; `seeds/template.json` is a generic starter a fresh
 * install copies in. Achilles registry pattern: invariants refuse malformed
 * rows, duplicate ids, and credential-shaped strings at load time.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";

const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const QUESTIONS_DIR = process.env.SOCRATES_QUESTIONS_DIR ?? join(CLAUDE, "LIFEOS/USER/SOCRATES/questions");

export const DOMAINS = ["security", "financial", "infra", "ownership", "operations", "health", "content", "prediction", "personal"] as const;
export const CADENCES = ["hourly", "daily", "weekly", "monthly"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

/** One STP whose closer reads — a standing question. (SocratesDesign.md v2 § The one object.) */
export interface Question {
  id: string; // SOC-0001
  entity: string; // "principal" scope for v0; field exists for tenants later
  domain: (typeof DOMAINS)[number];
  text: string;
  rationale?: string;
  /** Plain-language ideal state this question checks against. Authored, never derived. */
  ideal: string;
  status: "active" | "unanswerable" | "retired";
  verifier: "deterministic" | "judged" | "attested";
  /** Registry rows are read-closers by definition; write-closer STPs are ISAs/issues. */
  closer_mode: "read";
  node_type?: "refill" | "retire" | "protect";
  experiential?: boolean;
  /** Which adapter answers it. Absent ⇔ status "unanswerable". */
  answerer?: { adapter: string; ref?: string };
  cadence: (typeof CADENCES)[number];
  severity: (typeof SEVERITIES)[number];
  /** Expected verdict shape. Default: pass. Value comparisons for numeric questions. */
  expect?: { gte?: number; lte?: number; unit?: string };
  accounted_for?: number;
  ruled_out?: string[];
  provenance: string;
  telos_ref?: string;
  /** ThreatModel risk register id (R-xxx) this question watches; the router passes it to Achilles as risk_ref. */
  risk_ref?: string;
  /** Graduation seam: the ISA this question spawned, when committed to. */
  isa_ref?: string;
  /** Where a persisting failure goes. Default "achilles" (register + ticket).
   *  "none" for questions that are a VIEW over Achilles or over a finder that
   *  already registers its own findings (the scanner): registering the question
   *  would tell the same fact twice, and a question answered by Achilles would
   *  feed on its own output. The question still
   *  ticks and still shows on the Socrates board; it just never becomes an entry. */
  route?: "achilles" | "none";
}

const SECRET_SHAPES =
  /(AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|password\s*=\s*\S|api[_-]?key\s*[:=]\s*[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9_\-.]{20,}|sk-[A-Za-z0-9]{20,})/i;

export function assertQuestion(q: Question): void {
  invariant(/^SOC-\d{4}$/.test(q.id), `bad id ${q.id}`);
  invariant(q.text.trim().length > 0, `${q.id}: text required`);
  invariant(q.ideal.trim().length > 0, `${q.id}: ideal required`);
  invariant((DOMAINS as readonly string[]).includes(q.domain), `${q.id}: bad domain ${q.domain}`);
  invariant((CADENCES as readonly string[]).includes(q.cadence), `${q.id}: bad cadence ${q.cadence}`);
  invariant((SEVERITIES as readonly string[]).includes(q.severity), `${q.id}: bad severity ${q.severity}`);
  invariant(["active", "unanswerable", "retired"].includes(q.status), `${q.id}: bad status ${q.status}`);
  invariant(["deterministic", "judged", "attested"].includes(q.verifier), `${q.id}: bad verifier ${q.verifier}`);
  invariant(q.closer_mode === "read", `${q.id}: registry rows are read-closers`);
  invariant(q.route === undefined || q.route === "achilles" || q.route === "none", `${q.id}: bad route ${q.route}`);
  // The unanswerable contract: no answerer ⇔ unanswerable, and vice versa.
  if (q.status === "active") invariant(!!q.answerer?.adapter, `${q.id}: active question requires an answerer`);
  if (q.status === "unanswerable") invariant(!q.answerer, `${q.id}: unanswerable question must not name an answerer`);
  invariant(!SECRET_SHAPES.test(JSON.stringify(q)), `${q.id} contains a credential-shaped string`);
}

export function loadQuestions(dir = QUESTIONS_DIR): Question[] {
  if (!existsSync(dir)) return [];
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const pack = JSON.parse(readFileSync(join(dir, f), "utf8")) as { questions: Question[] };
    invariant(Array.isArray(pack.questions), `${f}: pack must carry a questions[] array`);
    for (const q of pack.questions) {
      assertQuestion(q);
      invariant(!seen.has(q.id), `duplicate question id ${q.id} (in ${f})`);
      seen.add(q.id);
      out.push(q);
    }
  }
  return out;
}

/** Copy the generic template pack into an empty USER questions dir (fresh install). */
export function seedIfEmpty(dir = QUESTIONS_DIR): boolean {
  if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".json"))) return false;
  const template = join(CLAUDE, "LIFEOS/SOCRATES/seeds/template.json");
  if (!existsSync(template)) return false;
  mkdirSync(dir, { recursive: true });
  const content = readFileSync(template, "utf8");
  // Validate before writing — a broken template must not seed a broken ledger.
  for (const q of (JSON.parse(content) as { questions: Question[] }).questions) assertQuestion(q);
  Bun.write(join(dir, "seed-v0.json"), content);
  return true;
}
