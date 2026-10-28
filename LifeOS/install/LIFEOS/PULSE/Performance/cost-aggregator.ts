#!/usr/bin/env bun
/**
 * @version 2.0.0
 * Cost Aggregator — scans Claude Code session JSONLs for token usage data
 * and computes per-session costs.
 *
 * Data source: ~/.claude/projects/{project}/{uuid}.jsonl
 * Output: MEMORY/OBSERVABILITY/session-costs.jsonl
 *
 * Runs incrementally: tracks last scan time, only processes new/modified files.
 * Called by Pulse cron every 15 minutes or directly for initial scan.
 */

import { join, basename, dirname } from "path"
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync } from "fs"
import { homedir } from "node:os";
import { pricingFor, currentModel, type Pricing } from "../../TOOLS/models"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
const LIFEOS_DIR = join(HOME, ".claude", "LIFEOS")
const PROJECTS_DIR = join(HOME, ".claude", "projects")
const OUTPUT_FILE = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "session-costs.jsonl")
const STATE_FILE = join(LIFEOS_DIR, "PULSE", "Performance", "aggregator-state.json")

// Prices come from LIFEOS/TOOLS/model-pricing.json, generated daily by ModelSync
// from Anthropic's public pricing page — no table lives here. pricingFor() resolves
// exact id → same family+version (dated ids) → the tier's current row. Cache
// writes are priced by TTL: transcripts carry usage.cache_creation with separate
// ephemeral_5m / ephemeral_1h counts, and the 1h rate is 1.6× the 5m rate.
const unpriced = new Set<string>()
function getPricing(model: string): Pricing {
  const hit = pricingFor(model)
  if (hit) return hit.pricing
  if (!unpriced.has(model)) {
    unpriced.add(model)
    console.error(`[cost-aggregator] no price row for '${model}' — falling back to CURRENT.sonnet; run ModelSync --sync`)
  }
  return pricingFor(currentModel("sonnet"))?.pricing ?? { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }
}

interface SessionCost {
  sessionId: string
  project: string
  firstTimestamp: string
  lastTimestamp: string
  models: Record<string, number> // model -> message count
  primaryModel: string
  messageCount: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  costInput: number
  costOutput: number
  costCacheWrite: number
  costCacheRead: number
  costTotal: number
  fileSize: number
  filePath: string
}

interface AggregatorState {
  lastScanMs: number
  sessionsProcessed: number
}

function loadState(): AggregatorState {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"))
  } catch { /* fresh start */ }
  return { lastScanMs: 0, sessionsProcessed: 0 }
}

function saveState(state: AggregatorState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function loadExistingSessionIds(): Set<string> {
  const ids = new Set<string>()
  try {
    if (!existsSync(OUTPUT_FILE)) return ids
    const lines = readFileSync(OUTPUT_FILE, "utf-8").trim().split("\n").filter(Boolean)
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        if (d.sessionId) ids.add(d.sessionId)
      } catch { /* skip malformed */ }
    }
  } catch { /* no existing file */ }
  return ids
}

function processSessionFile(filePath: string, projectSlug: string): SessionCost | null {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const lines = raw.split("\n").filter(Boolean)

    const models: Record<string, number> = {}
    let messageCount = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheWriteTokens = 0
    let cacheReadTokens = 0
    let firstTimestamp = ""
    let lastTimestamp = ""
    let costInput = 0
    let costOutput = 0
    let costCacheWrite = 0
    let costCacheRead = 0

    for (const line of lines) {
      let d: any
      try { d = JSON.parse(line) } catch { continue }

      if (d.type !== "assistant") continue
      const msg = d.message
      if (!msg?.usage) continue

      const model = msg.model || "<unknown>"
      const usage = msg.usage

      // Skip synthetic messages
      if (model === "<synthetic>") continue

      const pricing = getPricing(model)
      const inTok = usage.input_tokens ?? 0
      const outTok = usage.output_tokens ?? 0
      const cwTok = usage.cache_creation_input_tokens ?? 0
      const crTok = usage.cache_read_input_tokens ?? 0
      // TTL split: when the breakdown is present, price 1h writes at the 1h rate;
      // otherwise (older transcripts) treat all writes as 5m.
      const cw1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
      const cw5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : cwTok

      inputTokens += inTok
      outputTokens += outTok
      cacheWriteTokens += cwTok
      cacheReadTokens += crTok
      models[model] = (models[model] ?? 0) + 1
      messageCount++

      costInput += (inTok * pricing.input) / 1_000_000
      costOutput += (outTok * pricing.output) / 1_000_000
      costCacheWrite += (cw5m * pricing.cacheWrite5m + cw1h * pricing.cacheWrite1h) / 1_000_000
      costCacheRead += (crTok * pricing.cacheRead) / 1_000_000

      const ts = d.timestamp
      if (ts && typeof ts === "string") {
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts
      }
    }

    if (messageCount === 0) return null

    const primaryModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "<unknown>"
    const sessionId = basename(filePath, ".jsonl")
    const fileSize = statSync(filePath).size

    return {
      sessionId,
      project: projectSlug,
      firstTimestamp,
      lastTimestamp,
      models,
      primaryModel,
      messageCount,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
      costInput: Math.round(costInput * 10000) / 10000,
      costOutput: Math.round(costOutput * 10000) / 10000,
      costCacheWrite: Math.round(costCacheWrite * 10000) / 10000,
      costCacheRead: Math.round(costCacheRead * 10000) / 10000,
      costTotal: Math.round((costInput + costOutput + costCacheWrite + costCacheRead) * 10000) / 10000,
      fileSize,
      filePath,
    }
  } catch {
    return null
  }
}

async function main() {
  const startMs = Date.now()
  const state = loadState()
  const existingIds = loadExistingSessionIds()
  const isFullScan = process.argv.includes("--full")

  if (!existsSync(PROJECTS_DIR)) {
    console.log("No projects directory found")
    process.exit(0)
  }

  // Ensure output directory exists
  const outDir = dirname(OUTPUT_FILE)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  // Find all project directories
  const projectDirs: string[] = []
  try {
    for (const entry of readdirSync(PROJECTS_DIR)) {
      const full = join(PROJECTS_DIR, entry)
      try {
        if (statSync(full).isDirectory()) projectDirs.push(full)
      } catch { /* skip inaccessible */ }
    }
  } catch {
    console.log("Cannot read projects directory")
    process.exit(0)
  }

  let newSessions = 0
  let skipped = 0
  let errors = 0

  for (const projDir of projectDirs) {
    const projectSlug = basename(projDir)

    // Scan for session JSONL files (direct children, UUID-named)
    let entries: string[]
    try { entries = readdirSync(projDir) } catch { continue }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue
      const sessionId = entry.replace(".jsonl", "")

      // Skip already processed
      if (!isFullScan && existingIds.has(sessionId)) {
        skipped++
        continue
      }

      const filePath = join(projDir, entry)

      // Incremental: skip files older than last scan (unless full scan)
      if (!isFullScan && state.lastScanMs > 0) {
        try {
          const mtime = statSync(filePath).mtimeMs
          if (mtime < state.lastScanMs) { skipped++; continue }
        } catch { continue }
      }

      const cost = processSessionFile(filePath, projectSlug)
      if (cost) {
        appendFileSync(OUTPUT_FILE, JSON.stringify(cost) + "\n")
        newSessions++
      } else {
        errors++
      }
    }

    // Also scan subagent JSONLs inside session directories
    for (const entry of entries) {
      const sessionDir = join(projDir, entry)
      if (entry.endsWith(".jsonl")) continue // already handled files
      const subagentDir = join(sessionDir, "subagents")
      if (!existsSync(subagentDir)) continue

      let subEntries: string[]
      try { subEntries = readdirSync(subagentDir) } catch { continue }

      for (const subEntry of subEntries) {
        if (!subEntry.endsWith(".jsonl")) continue
        const agentId = subEntry.replace(".jsonl", "")

        if (!isFullScan && existingIds.has(agentId)) { skipped++; continue }

        const filePath = join(subagentDir, subEntry)

        if (!isFullScan && state.lastScanMs > 0) {
          try {
            const mtime = statSync(filePath).mtimeMs
            if (mtime < state.lastScanMs) { skipped++; continue }
          } catch { continue }
        }

        const cost = processSessionFile(filePath, projectSlug)
        if (cost) {
          appendFileSync(OUTPUT_FILE, JSON.stringify(cost) + "\n")
          newSessions++
        }
      }
    }
  }

  state.lastScanMs = Date.now()
  state.sessionsProcessed += newSessions
  saveState(state)

  const elapsed = Date.now() - startMs
  console.log(`Cost aggregation complete: ${newSessions} new, ${skipped} skipped, ${errors} errors (${elapsed}ms)`)
}

main().catch((err) => {
  console.error("Cost aggregator failed:", err)
  process.exit(1)
})
