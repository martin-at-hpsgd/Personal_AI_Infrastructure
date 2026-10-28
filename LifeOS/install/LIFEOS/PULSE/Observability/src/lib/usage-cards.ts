/**
 * Marks for one /usage account card. Pulse computes `active` (slug === active_slug, so at most one row)
 * and `org_label` ("Personal" or the org name) in accountsView; the page only reads them, so the
 * card grid and the API cannot disagree about which row is live (one ACTIVE card at most).
 */
export interface CardInput { slug: string; active?: boolean; org_label?: string | null }
export interface CardRecommendation { switch: boolean; best: string | null }
export interface CardMarks { active: boolean; recommended: boolean; orgLabel: string | null }

export function accountCardMarks(a: CardInput, rec: CardRecommendation | null): CardMarks {
  return {
    active: a.active === true,
    recommended: rec?.switch === true && rec.best === a.slug,
    orgLabel: typeof a.org_label === "string" && a.org_label.length > 0 ? a.org_label : null,
  };
}
