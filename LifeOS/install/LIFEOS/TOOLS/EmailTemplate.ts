/** Local configuration adapter for the shared house email layout. */
import { readFileSync } from "node:fs";
import { renderEmailLayout } from "./EmailLayout";
import { lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

interface Brand {
  name: string;
  logoUrl: string;
  company: string;
  supportEmail: string;
  footerBrand: string;
}

const DEFAULT_BRAND: Brand = {
  name: "LifeOS",
  logoUrl: "",
  company: "",
  supportEmail: "",
  footerBrand: "Sent by LifeOS",
};

function loadBrand(): Brand {
  try {
    const raw = readFileSync(lifeosPath("USER", "CONFIG", "email-brand.json"), "utf8");
    return { ...DEFAULT_BRAND, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_BRAND;
  }
}

/** House design tokens. Senders that build custom `bodyHtml` use these
 * so their content reads as part of the same card. */
export const T = {
  pageBg: "#f1f5f9",
  cardBg: "#ffffff",
  bannerBg: "#0b0c0e",
  contentBg: "#f8fafc",
  border: "#e2e8f0",
  text: "#0f172a",
  body: "#334155",
  dim: "#64748b",
  blue: "#2563eb",
  red: "#b91c1c",
  amber: "#92400e",
  green: "#047857",
  sans: "'Avenir Next',Avenir,'Helvetica Neue',-apple-system,'Segoe UI',Roboto,sans-serif",
  mono: "'SF Mono',Menlo,Consolas,monospace",
} as const;


export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A key/value rows table matching the house style. Values are raw HTML —
 * `esc()` anything untrusted before passing it in. */
export function kvRows(rows: Array<[string, string]>): string {
  const tr = rows
    .map(
      ([k, v]) => `<tr>
      <td style="padding:9px 14px 9px 0;border-top:1px solid ${T.border};color:${T.dim};font:15px/1.5 ${T.sans};white-space:nowrap;vertical-align:top">${esc(k)}</td>
      <td style="padding:9px 0;border-top:1px solid ${T.border};color:${T.body};font:16px/1.5 ${T.sans}">${v}</td>
    </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tr}</table>`;
}

/** A content card block for list-style emails (findings, ideas). Inner HTML
 * is raw — `esc()` anything untrusted. */
export function cardBlock(inner: string, opts: { accent?: string } = {}): string {
  const left = opts.accent ? `border-left:3px solid ${opts.accent};` : "";
  return `<div style="background:${T.contentBg};border:1px solid ${T.border};${left}border-radius:6px;padding:14px 16px;margin:0 0 12px 0;font:16px/1.6 ${T.sans};color:${T.body}">${inner}</div>`;
}

export interface BrandedEmail {
  /** Which LifeOS system is speaking — the banner wordmark, e.g. "Bunker", "Achilles". */
  system: string;
  /** Short state label rendered as a pill above the title, e.g. "2 open", "Not working". */
  badge?: string;
  /** Status-block tint, pill, and button color: T.red / T.amber / T.green for alerts, defaults to brand blue. */
  accent?: string;
  title: string;
  subtitle?: string;
  /** Key/value rows under the header (values are raw HTML). */
  rows?: Array<[string, string]>;
  /** Free-form content section (raw HTML) — build it with cardBlock()/kvRows(). */
  bodyHtml?: string;
  /** Plain-prose explanation or instruction near the bottom. */
  note?: string;
  /** One action button. Public URL or the principal's own Pulse only. */
  cta?: { label: string; url: string };
  /** Small dim footer line; defaults to a generic automated-mail line. */
  footer?: string;
}

/** Render the full HTML document for a branded LifeOS email. */
export function renderEmail(e: BrandedEmail): string {
  const brand = loadBrand();
  const bodyHtml = [
    e.badge ? `<p style="font-size:14px;font-weight:700;color:${e.accent ?? T.blue};">${esc(e.badge)}</p>` : "",
    e.subtitle ? `<p style="color:${T.body};font-size:16px;">${esc(e.subtitle)}</p>` : "",
    e.rows?.length ? kvRows(e.rows) : "",
    e.bodyHtml ?? "",
  ].join("");
  return renderEmailLayout({
    brand: { name: e.system, subtitle: brand.name + " operations", accent: e.accent ?? T.blue },
    subject: e.title, preheader: e.subtitle ?? e.title, heading: e.title, bodyHtml,
    cta: e.cta, footerNote: [e.note, e.footer].filter(Boolean).join(" "),
  }).html;
}
