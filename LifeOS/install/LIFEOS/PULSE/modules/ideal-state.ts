/**
 * Ideal State — Pulse module for the recommend-only ideal-state loop.
 *
 *   GET /api/ideal-state/recommendations   open recommendations (rows and builds)
 *   GET /api/ideal-state/gap               the latest reconcile report
 *
 * Read-only: accepting or dismissing a recommendation stays a principal action
 * through `bun LIFEOS/IDEALSTATE/IdealState.ts accept|dismiss <id>`.
 *
 */
import { loadStore } from "../../IDEALSTATE/Recommend"
import { readJson, statePath } from "../../IDEALSTATE/Store"

export function start(): void {}
export function stop(): void {}
export function health(): { status: string } { return { status: "healthy" } }

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "GET") return null
  const sub = pathname.replace(/^\/api\/ideal-state/, "") || "/"
  if (sub === "/recommendations" || sub === "/") {
    const recs = loadStore().recs.filter((r) => r.status === "open")
    return Response.json({ open: recs.length, recommendations: recs })
  }
  if (sub === "/gap") return Response.json(readJson(statePath("reconcile.json"), null))
  return null
}
