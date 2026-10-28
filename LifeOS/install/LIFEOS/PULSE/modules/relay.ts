/**
 * Relay Pulse module — read-only status card for the texting bridge.
 *
 * Routes:
 *   GET /api/relay/status → bridge up, last inbound, last reply, guard denies (24h), lock state
 *
 * The data comes from LIFEOS/TOOLS/RelayStatus.ts, the same read the texting skill's Status tool prints.
 * It carries no sender number and no hash, so the card never shows digits.
 */
import { readRelayStatus } from "../../TOOLS/RelayStatus.ts";

const MODULE_NAME = "relay";
const CACHE_TTL_MS = 2_000;
const state: { running: boolean; cache: { at: number; body: unknown } | null } = { running: false, cache: null };

export function start(): void {
  state.running = true;
  console.log(`[${MODULE_NAME}] Started — serving /api/relay/status`);
}

export function health(): { running: boolean } {
  return { running: state.running };
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/relay/status") return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const now = Date.now();
  if (!state.cache || now - state.cache.at > CACHE_TTL_MS) {
    try {
      state.cache = { at: now, body: { available: true, checked_at: new Date(now).toISOString(), ...(await readRelayStatus()) } };
    } catch (err) {
      return Response.json({ available: false, reason: String(err) }, { status: 503 });
    }
  }
  return Response.json(state.cache.body);
}
