/**
 * The files the Business tab reads, in one place so `/api/life/business` and the tab's
 * freshness pill (`/api/tab-freshness?tab=business`) cannot drift apart (Pulse ISA ISC-19.1).
 */
import { existsSync, readdirSync } from "fs"
import { join } from "path"

/**
 * The active company directory under `businessDir` (USER/WORK/YOUR_COMPANIES), found by
 * enumeration, never by a hardcoded name. Only a dir that has a REVENUE folder qualifies:
 * the old `?? dirs[0]` fallback named an arbitrary company as the active one (public issue
 * #1842, @jacobo-ortiz). No qualifying dir returns "", which the page reads as a fresh install.
 */
export function resolveCompanyDir(businessDir: string): string {
  if (!existsSync(businessDir)) return ""
  const dirs = readdirSync(businessDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => join(businessDir, d.name))
  return dirs.find((d) => existsSync(join(d, "REVENUE"))) ?? ""
}

/** The revenue report the page shows as latest: the last `.md` in name order, or "" when none. */
export function latestRevenueFile(revenueDir: string): string {
  if (!revenueDir || !existsSync(revenueDir)) return ""
  const files = readdirSync(revenueDir).filter((f) => f.endsWith(".md")).sort().reverse()
  return files[0] ?? ""
}

/** Every file `/api/life/business` reads, in read order: the top README, the company README, the latest revenue report. */
export function businessSourcePaths(businessDir: string): string[] {
  const out = [join(businessDir, "README.md")]
  const co = resolveCompanyDir(businessDir)
  if (co) {
    out.push(join(co, "README.md"))
    const rev = latestRevenueFile(join(co, "REVENUE"))
    if (rev) out.push(join(co, "REVENUE", rev))
  }
  return out
}
