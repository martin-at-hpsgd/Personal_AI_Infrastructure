// Browser contract only. Personal records are fetched at runtime.
export interface LifeRisk {
  id: string; title: string; domain: string; score: number; level: string;
  likelihood: number; impact: number; owner: string; review_by: string; scenario: string;
  prevent: Coverage; detect: Coverage; respond: Coverage;
  links: { raw: string; kind: string; ref: string }[];
  /** Open technical Achilles findings rolled up through the estate register; null when the API gave none. */
  open_findings: number | null;
}
export interface Coverage { state: string; text: string }
export interface LifeRiskData { risks: LifeRisk[]; errors: string[]; section_line: number | null; count: number }
export interface EstateRisk { id: string; telos_ref?: string; scope?: string }
export function riskQuery(search: string): string | null {
  const id = new URLSearchParams(search).get("risk");
  return id && /^(R\d+|R-\d{3}|ACH-\d{4})$/.test(id) ? id : null;
}
export function riskHref(id: string): string | null {
  if (/^R\d+$/.test(id)) return `/telos?risk=${id}`;
  if (/^(R-\d{3}|ACH-\d{4})$/.test(id)) return `/achilles?risk=${id}`;
  if (/^SOC-\d{4}$/.test(id)) return `/socrates?question=${id}`;
  return null;
}
/** Reject unusable envelopes; malformed rows remain a visible validation error. */
export function parseLifeRiskData(value: unknown): LifeRiskData | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.risks) || !Array.isArray(body.errors)) return null;
  const errors = body.errors.filter((e): e is string => typeof e === "string");
  const text = (v: unknown) => typeof v === "string" ? v : "";
  const coverage = (value: unknown): Coverage => {
    if (!value || typeof value !== "object") return { state: "unknown", text: "" };
    const item = value as Record<string, unknown>;
    return { state: ["have", "partial", "none", "unknown"].includes(text(item.state)) ? text(item.state) : "unknown", text: text(item.text) };
  };
  const risks: LifeRisk[] = [];
  for (const [index, item] of body.risks.entries()) {
    const r = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!/^R\d+$/.test(text(r.id)) || !text(r.title) || ![r.score, r.likelihood, r.impact].every(n => typeof n === "number" && Number.isFinite(n)) || risks.some(existing => existing.id === r.id)) {
      errors.push(`Risk row ${index + 1} is malformed or duplicated and cannot be displayed.`); continue;
    }
    risks.push({ id: text(r.id), title: text(r.title), domain: text(r.domain) || "unknown", score: r.score as number,
      likelihood: r.likelihood as number, impact: r.impact as number, level: text(r.level) || "Unknown", owner: text(r.owner), review_by: text(r.review_by), scenario: text(r.scenario),
      prevent: coverage(r.prevent), detect: coverage(r.detect), respond: coverage(r.respond),
      links: Array.isArray(r.links) ? r.links.flatMap(l => l && typeof l === "object" && typeof l.ref === "string" ? [{ ref: l.ref, raw: text(l.raw) || l.ref, kind: text(l.kind) }] : []) : [],
      open_findings: typeof r.open_findings === "number" && Number.isFinite(r.open_findings) ? r.open_findings : null,
    });
  }
  return { risks, errors, count: risks.length, section_line: typeof body.section_line === "number" ? body.section_line : null };
}
export function selectRisks(risks: LifeRisk[], domain = "all", selected: string | null = null): LifeRisk[] {
  return risks.filter(r => selected ? r.id === selected : domain === "all" || r.domain === domain)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, undefined, { numeric: true }));
}
export function findingLifeRisks(finding: { id: string; risk_ref?: string }, risks: LifeRisk[], estate: EstateRisk[]): LifeRisk[] {
  const parent = estate.find(r => r.id === finding.risk_ref);
  return selectRisks(risks.filter(r => r.links.some(l =>
    (l.kind === "achilles" && l.ref === finding.id) ||
    (l.kind === "register" && l.ref === finding.risk_ref)) || r.id === parent?.telos_ref));
}
export function achillesLifeRiskIds(risks: LifeRisk[], estate: EstateRisk[]): string[] {
  return risks.filter(r => r.domain === "security" || r.links.some(l => l.kind === "register" || l.kind === "achilles") || estate.some(e => e.telos_ref === r.id)).map(r => r.id);
}
