#!/usr/bin/env bun
/** Gated wrapper for dd-cli. Existing purchase review, ceilings, and the CLI's
 * own Proceed? prompt still apply. Direct dd-cli execution is outside this wrapper.
 * Usage: SubmitOrder.ts <request.json> --issue-confirmation
 *        SubmitOrder.ts <request.json> --confirmation-token <principal-echo>
 * Request: {cartUuid, tipCents, amountUsd, card, address, intent}.
 * The preview, account addresses and payment methods are re-read and bound to the token; amountUsd must equal the
 * preview total, address must be the account's default address id, and card must name the default card's last four.
 */
import { issue, requireConfirmation, probeConfirmation } from "../../../LIFEOS/TOOLS/Confirm.ts";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Spending ceiling used when Config.md names none. Config.md may set a different standing ceiling. */
export const DEFAULT_CEILING_USD = 75;
const CONFIG = join(getClaudeDir(), "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Order/Config.md");

/**
 * The per-order ceiling in USD. Reads the line "Per-order ceiling: $N" from Config.md; a missing line keeps the safe default,
 * and a line that names a ceiling this tool cannot parse as a positive number is an error, never a silent fallback.
 * A missing Config.md is an error: the skill is not set up (see Setup.md).
 */
export function orderCeilingUsd(configPath = CONFIG): number {
  if (!existsSync(configPath)) throw new Error(`No order config at ${configPath}; set the skill up first (see Setup.md).`);
  const line = readFileSync(configPath, "utf8").split("\n").find((l) => /per-order ceiling/i.test(l));
  if (!line) return DEFAULT_CEILING_USD;
  const m = line.match(/\$\s?(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Config.md names a per-order ceiling this tool cannot read: "${line.trim()}". Write it as "Per-order ceiling: $75".`);
  return n;
}

/**
 * The grand total in USD from the provider's `order preview` output, or null when none can be read. The last line that
 * names a total (not a subtotal) and carries a decimal amount wins, because the grand total closes the breakdown. A JSON
 * `"total": 12.34` field is read the same way. A null result means the wrapper refuses: it never guesses a total.
 */
export function previewTotalUsd(preview: string): number | null {
  let found: number | null = null;
  for (const line of preview.split("\n")) {
    const m = line.match(/(?<!sub[\s-]?)\btotal\b[^\d\n]{0,40}?\$?\s?(\d{1,6}(?:,\d{3})*\.\d{2})\b/i) ?? line.match(/"total"\s*:\s*"?\$?(\d{1,6}\.\d{1,2})\b/i);
    if (m) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) found = n;
    }
  }
  return found;
}

/** Every object in a provider JSON payload, depth first, so a field is found under `structuredContent` or any wrapper. */
function objects(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) objects(x, out);
  else if (v && typeof v === "object") { out.push(v as Record<string, unknown>); for (const x of Object.values(v)) objects(x, out); }
  return out;
}
function parsed(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

/**
 * The id of the account-wide default delivery address from `address list` JSON, or null when exactly one entry is not
 * marked `is_default`. `order submit` has no address flag, so this is where the order goes; null means the wrapper refuses.
 */
export function defaultAddressId(json: string): string | null {
  const hits = objects(parsed(json)).filter((o) => o.is_default === true);
  if (hits.length !== 1) return null;
  const id = hits[0]!.address_id ?? hits[0]!.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

/**
 * The last four digits of the card `order submit` charges, from `payment-method list` JSON: the entry named by
 * `default_payment_method_id`, or the one marked `is_default`. Null when it cannot be told; the wrapper then refuses.
 */
export function defaultCardLast4(json: string): string | null {
  const all = objects(parsed(json));
  const defId = all.find((o) => o.default_payment_method_id != null)?.default_payment_method_id;
  const cards = all.filter((o) => o.last4 != null || o.last_four != null);
  const card = defId != null ? cards.find((o) => String(o.id ?? o.payment_method_id) === String(defId)) : cards.filter((o) => o.is_default === true).at(0);
  const last4 = String(card?.last4 ?? card?.last_four ?? "");
  return /^\d{4}$/.test(last4) ? last4 : null;
}

type Request = { cartUuid: string; tipCents: number; amountUsd: number; card: string; address: string; intent: string };
export async function submitOrder(request: Request, token?: string, issueOnly = false, ceilingUsd = orderCeilingUsd(), readCli?: (args: string[]) => Promise<string>): Promise<number> {
  if (!request || ![request.cartUuid, request.card, request.address, request.intent].every(v => typeof v === "string" && v.trim()) ||
      !Number.isSafeInteger(request.tipCents) || request.tipCents < 0 || !Number.isFinite(request.amountUsd) || request.amountUsd <= 0 || request.amountUsd > ceilingUsd) {
    console.error(`Order refused: complete reviewed cart, card, address, tip and total at or below $${ceilingUsd} required; a higher total needs the principal to place the order themselves.`);
    return 2;
  }
  // Missing confirmation refuses before even launching the external CLI.
  if (!issueOnly && !token) {
    const result = requireConfirmation({ action: "order-submit", detail: JSON.stringify(request) });
    if (!result.ok) console.error(result.reason);
    return 1;
  }
  const cli = join(homedir(), ".local", "bin", "dd-cli");
  async function read(args: string[]): Promise<string> {
    if (readCli) return readCli(args);
    const child = Bun.spawn([cli, ...args, "--intent", request.intent], { stdout: "pipe", stderr: "pipe" });
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error("DoorDash review failed; no submission attempted");
    return stdout;
  }
  const preview = await read(["order", "preview", "--cart-uuid", request.cartUuid, "--beautify"]);
  // The ceiling is enforced against the provider's own total, not only the caller-supplied amountUsd.
  const previewTotal = previewTotalUsd(preview);
  if (previewTotal === null) {
    console.error("Order refused: the provider's preview carries no readable total, so the ceiling cannot be checked. The principal places this order themselves.");
    return 2;
  }
  // The preview is fetched without the tip, and the tip is charged on submit, so the ceiling covers both.
  const chargedUsd = previewTotal + request.tipCents / 100;
  if (chargedUsd > ceilingUsd) {
    console.error(`Order refused: the provider's preview total $${previewTotal.toFixed(2)} plus the $${(request.tipCents / 100).toFixed(2)} tip is above the $${ceilingUsd} ceiling; a higher total needs the principal to place the order themselves.`);
    return 2;
  }
  // The confirmed amount must be the provider's preview total, not merely under the ceiling. The tip is not part of it:
  // it is confirmed separately as tipCents, bound to the token with the request, and counted in the ceiling check above.
  if (Math.round(request.amountUsd * 100) !== Math.round(previewTotal * 100)) {
    console.error(`Order refused: the confirmed total $${request.amountUsd.toFixed(2)} is not the provider's preview total $${previewTotal.toFixed(2)}; show the new preview and confirm again.`);
    return 2;
  }
  const addresses = await read(["--json-output", "address", "list"]);
  const deliverTo = defaultAddressId(addresses);
  if (deliverTo === null || deliverTo !== request.address.trim()) {
    console.error(`Order refused: the account's default delivery address (${deliverTo ?? "unreadable"}) is not the confirmed address ${request.address}; order submit delivers to the default, so set it with the principal's ok and confirm again.`);
    return 2;
  }
  const payments = await read(["--json-output", "payment-method", "list"]);
  const last4 = defaultCardLast4(payments);
  if (last4 === null || !new RegExp(`\\b${last4}\\b`).test(request.card)) {
    console.error(`Order refused: the account's default card (${last4 ? `ending ${last4}` : "unreadable"}) is not the confirmed card "${request.card}"; order submit charges the default card.`);
    return 2;
  }
  // Payment methods are bound too, so a default-card change between challenge and echo voids the token.
  const detail = JSON.stringify({ request, preview, addresses, payments });
  if (issueOnly) {
    console.log(JSON.stringify({ action: "order-submit", detail, token: issue("order-submit", detail) }));
    return 0;
  }
  const result = requireConfirmation({ action: "order-submit", detail, token });
  if (!result.ok) { console.error(result.reason); return 1; }
  // Do not pass --yes: retain the provider's existing interactive confirmation.
  const child = Bun.spawn([cli, "order", "submit", "--cart-uuid", request.cartUuid, "--tip-cents", String(request.tipCents), "--intent", request.intent], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

if (import.meta.main) {
  if (process.argv.includes("--probe")) process.exit(probeConfirmation());
  try {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: SubmitOrder.ts <request.json> --issue-confirmation | --confirmation-token <principal-echo>");
    const index = process.argv.indexOf("--confirmation-token");
    process.exit(await submitOrder(await Bun.file(path).json(), index < 0 ? undefined : process.argv[index + 1], process.argv.includes("--issue-confirmation")));
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
