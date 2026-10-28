#!/usr/bin/env bun
/**
 * GrokQuery.ts - xAI Grok chat-completions client
 *
 * Invocation path for the Grok agent (agents/Grok.md). OpenAI-compatible
 * chat completions against api.x.ai; model defaults from CROSS_VENDOR.grok
 * in models.ts so the pin has one home.
 *
 * DATA CLASS: any class. xAI is a trusted vendor for all data since
 * 2026-10-16 (OPERATIONAL_PREFERENCES § Model selection). Secret values
 * (keys, tokens, passwords) never leave: the .env read deny rules in
 * settings.json keep them out of reach, and the Grok agent never forwards
 * one it is handed.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/GrokQuery.ts "<query>"
 *   bun ~/.claude/LIFEOS/TOOLS/GrokQuery.ts --model <grok id> "<query>"
 *   bun ~/.claude/LIFEOS/TOOLS/GrokQuery.ts --json "<query>"
 *
 * Options:
 *   --model <id>       Grok model id (default: CROSS_VENDOR.grok)
 *   --system <prompt>  Prepend a system instruction
 *   --max-tokens <n>   Cap output tokens (default: 2048)
 *   --json             Emit raw API JSON
 *   -h, --help         Usage — costs nothing, sends no request
 *
 * Environment:
 *   XAI_API_KEY         xAI API key — direct api.x.ai. The only route: a broker
 *                       adds a party between us and xAI, so there is no fallback.
 *
 * Send side: no hook inspects the call. Secret values stay out of reach through
 * the native .env read deny rules in settings.json, and the Grok agent refuses
 * a brief that carries one.
 *
 * Exit codes: 0 ok, 1 error (missing key, API failure, empty response)
 *
 * @author LifeOS System
 * @version 2.0.4
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { CROSS_VENDOR } from './models'
import { recordModelUse } from "./lib/ModelUse";
import { getClaudeDir } from './Paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', cyan: '\x1b[36m',
}

const XAI_URL = 'https://api.x.ai/v1/chat/completions'

const USAGE = `Usage: bun ~/.claude/LIFEOS/TOOLS/GrokQuery.ts [options] "<query>"

Never put a secret value (key, token, password) in a prompt (see file header).

Options:
  --model <id>       Grok model id (default: ${CROSS_VENDOR.grok})
  --system <prompt>  Prepend a system instruction
  --max-tokens <n>   Cap output tokens (default: 2048)
  --json             Emit raw API JSON
  -h, --help         this message — costs nothing, sends no request`

/** Canonical .env is ~/.claude/.env — never $LIFEOS_CONFIG_DIR/.env. */
function loadEnv(): Record<string, string> {
  const envPath = join(getClaudeDir(), '.env')
  const env: Record<string, string> = {}
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/)
      if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // fall through to process.env
  }
  return env
}

const ENV = loadEnv()
const XAI_KEY = ENV.XAI_API_KEY || process.env.XAI_API_KEY || ''

interface Opts {
  model: string
  system?: string
  maxTokens: number
  json: boolean
}

function parseArgs(argv: string[]): { opts: Opts; query: string } {
  const opts: Opts = { model: CROSS_VENDOR.grok, maxTokens: 2048, json: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--model': opts.model = argv[++i] ?? opts.model; break
      case '--system': opts.system = argv[++i]; break
      case '--max-tokens': opts.maxTokens = Number(argv[++i]) || opts.maxTokens; break
      case '--json': opts.json = true; break
      default: rest.push(argv[i])
    }
  }
  return { opts, query: rest.join(' ').trim() }
}

interface Parsed { text: string; model: string; raw: unknown }

async function grok(query: string, opts: Opts): Promise<Parsed> {
  const messages: Array<{ role: string; content: string }> = []
  if (opts.system) messages.push({ role: 'system', content: opts.system })
  messages.push({ role: 'user', content: query })

  const model = opts.model

  const res = await fetch(XAI_URL, {
    method: 'POST',
    // Auth rides the header, never the URL (URLs leak to logs and history).
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${XAI_KEY}`,
    },
    // 4 minutes: Grok's reasoning on long benchmark prompts ran past the old 120 s limit on most cells.
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: opts.maxTokens,
      temperature: 0.2,
    }),
  })

  const data = await res.json() as any
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || data.error || `HTTP ${res.status}`)
  }

  recordModelUse(data.model ?? opts.model, Number(data.usage?.completion_tokens ?? 0))
  const text = (data.choices?.[0]?.message?.content ?? '').trim()
  // Report the model the API says actually ran, not the one we asked for —
  // a silent server-side substitution should be visible to the caller.
  return { text, model: data.model ?? opts.model, raw: data }
}

async function main() {
  const argv = process.argv.slice(2)

  // --help must NEVER reach the API (same rule as GeminiSearch.ts and
  // PerplexitySearch.ts, where an unguarded --help was billed as a live call).
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    process.exit(argv.length === 0 ? 1 : 0)
  }

  const { opts, query } = parseArgs(argv)

  if (!XAI_KEY) {
    console.error(`${colors.red}Error: XAI_API_KEY not set in ~/.claude/.env${colors.reset}`)
    process.exit(1)
  }
  try { const z = await import('./XaiZdr'); if (z.needsRefresh()) await z.check(XAI_KEY) } catch {}
  if (!query) {
    console.error(`${colors.red}Error: no query provided${colors.reset}`)
    console.error(USAGE)
    process.exit(1)
  }

  let result: Parsed
  try {
    result = await grok(query, opts)
  } catch (e: any) {
    console.error(`${colors.red}Grok API error: ${e.message}${colors.reset}`)
    process.exit(1)
  }

  if (opts.json) {
    console.log(JSON.stringify(result.raw, null, 2))
    return
  }

  if (!result.text) {
    console.error(`${colors.red}Grok returned an empty response${colors.reset}`)
    process.exit(1)
  }

  console.log(result.text)
  console.log(`${colors.dim}model: ${result.model} · route: xai direct${colors.reset}`)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`${colors.red}${e?.message ?? e}${colors.reset}`)
    process.exit(1)
  })
}
