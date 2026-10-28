/** Pure house email layout. Generated into Worker repos; no filesystem or personal configuration. */
export const escapeEmail = (value: unknown): string => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");
const FONT = "-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif";

/** bodyHtml is composed by trusted application code; every remote field must be escaped. */
export function renderEmailLayout(input: {
  brand: { name: string; subtitle: string; accent: string }; subject: string; preheader?: string; heading?: string;
  bodyHtml: string; cta?: { label: string; url: string }; footerNote?: string;
}): { html: string; text: string; senderName: string } {
  const brand = input.brand;
  const esc = escapeEmail;
  const ctaUrl = input.cta && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/i.test(input.cta.url) ? input.cta.url : undefined;
  const cta = ctaUrl ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:28px;"><tr><td bgcolor="${brand.accent}" style="border-radius:6px;"><a href="${esc(ctaUrl)}" style="display:inline-block;padding:14px 24px;color:#fff;text-decoration:none;font-weight:700;font-size:16px;">${esc(input.cta!.label)}</a></td></tr></table>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(input.subject)}</title></head><body style="margin:0;padding:0;background:#f1f5f9;color:#0f172a;font-family:${FONT};"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(input.preheader ?? input.subject)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;"><tr><td align="center" style="padding:28px 12px;"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#0b0c0e;border-bottom:4px solid ${brand.accent};padding:26px 28px;"><div style="font-size:22px;line-height:1.3;font-weight:750;letter-spacing:0.09em;color:#fff;text-transform:uppercase;">${esc(brand.name)}</div><div style="font-size:14px;color:#cbd5e1;margin-top:7px;">${esc(brand.subtitle)}</div></td></tr>
<tr><td style="padding:28px 24px;font-family:${FONT};font-size:17px;line-height:1.65;overflow-wrap:anywhere;word-break:break-word;">${input.heading ? `<h1 style="margin:0 0 20px;font-size:26px;line-height:1.3;">${esc(input.heading)}</h1>` : ""}${input.bodyHtml}${cta}${input.footerNote ? `<p style="font-size:14px;color:#64748b;margin:22px 0 0;">${esc(input.footerNote)}</p>` : ""}</td></tr>
<tr><td style="padding:20px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:13px;color:#64748b;line-height:1.7;"><strong style="color:#334155;">${esc(brand.name)}</strong><br>${esc(brand.subtitle)} · LifeOS</td></tr></table></td></tr></table></body></html>`;
  const text = html.replace(/<head>[\s\S]*?<\/head>/i, "").replace(/<\/(div|p|tr|h\d)>/gi, "\n").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
  return { html, text: text + (ctaUrl ? `\n\n${input.cta!.label}: ${ctaUrl}` : ""), senderName: brand.name };
}
