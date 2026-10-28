/**
 * presence-context.ts — the per-turn "where is the principal, and what can he reach" block.
 *
 * Why: a hand-off once asked the principal to approve a step in a window on this Mac while he
 * was away on another device. The Location system already knew where he was, and nothing put
 * that in front of me. This block does, every prompt, so a hand-off he must act on arrives as
 * something he can open where he is.
 *
 * Silent when he is at this Mac (deliveries here are fine). Otherwise it names the device, the
 * place, and the channels Location's reachFor() gives for that device. Fails open: any error is
 * no block, never a blocked turn.
 */
import { nowRecord } from "../../LIFEOS/LOCATION/Location";

type Reach = { channel: string; for: string; how: string; url?: string };
type Rec = {
  name?: string | null; at_home?: boolean | null; stale?: boolean; fallback?: boolean;
  distance_home_km?: number | null; device?: { name: string; kind: string; signal: string }; reach?: Reach[];
};

/** The block for a nowRecord() result, or null when he is at this Mac. Pure, for tests. */
export function presenceBlock(r: Rec): string | null {
  const d = r.device;
  if (!d || d.kind === "this-mac") return null;
  const where = r.fallback ? "location unknown"
    : `${r.name ?? "unknown place"}${r.stale ? " (last known)" : ""}, ${r.at_home ? "at home" : `away from home${r.distance_home_km != null ? ` (${Math.round(r.distance_home_km)} km)` : ""}`}`;
  const device = d.kind === "unknown" ? "no device in use that I can see" : `${d.name} (${d.signal})`;
  const reach = (r.reach ?? []).map((x) => `- ${x.channel} for ${x.for}: ${x.url ? `${x.url} — ` : ""}${x.how}`).join("\n");
  return [
    "<principal-reach>",
    `📍 {{PRINCIPAL_NAME}} is NOT at this Mac. On: ${device}. Where: ${where}.`,
    "He cannot see this Mac's screen, the Interceptor test Chrome window, a local file, or anything opened here.",
    "Anything he must look at, click, approve or sign in to goes to him as something he can open where he is:",
    reach || "- share for files: upload through the share service and put the link in the answer",
    "- the real public URL of the page itself (a dashboard, a consent page), so he does the step in his own browser",
    "Never ask him to act on this Mac: no 'approve it in the test window', no localhost link, no ~/Downloads path, no `open` command.",
    "</principal-reach>",
  ].join("\n") + "\n";
}

/** The live block, or null (at this Mac, or any failure). */
export function presenceContext(): string | null {
  try { return presenceBlock(nowRecord() as Rec); } catch { return null; }
}
