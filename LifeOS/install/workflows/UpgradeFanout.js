// UpgradeFanout — the Upgrade skill's source sweep, as a script.
//
// Why this exists: the sweep used to be eight loose Agent dispatches that I
// babysat by hand, nudging idle ones and tracking a deadline in my head.
// Here the deadline, the fail-open behaviour and the return shape are code.
// Findings come back as data; the report is still written by the DA, because
// the Upgrade output format is a voice contract and a script can't hold it.
//
// Runtime contract verified live 2026-08-06 (run wf_a2b9c8df-62c, 0 agents,
// 31ms): agent/parallel/pipeline/phase/log/workflow are globals, setTimeout
// and clearTimeout are real, AbortSignal is NOT available, and Date.now() and
// Math.random() throw.
//
// Invoked by: skills/Upgrade/Intents/Upgrade.md

export const meta = {
  name: 'UpgradeFanout',
  description: 'Sweep every Upgrade source in parallel and return structured findings',
  phases: [
    { title: 'Collect', detail: 'one agent per source family, fail-open on a deadline' },
    { title: 'Ground', detail: 'inventory what LifeOS already has, for prior-status tags' },
  ],
}

// ── input ──────────────────────────────────────────────────────────────────
// `args` arrives as a JSON STRING, not an object, even when the caller passes
// a real JSON value in the tool call (observed live, run wf_2c46a8c5-435: the
// guard below fired because args.sources was undefined on a string). Parse
// defensively rather than trusting the documented object shape.
const input = (() => {
  if (!args) return {}
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return {} }
  }
  return args
})()

// ── deadline ───────────────────────────────────────────────────────────────
// Fail-open is the whole point: a slow source degrades coverage, it never
// stalls the run. One hung GitHub agent once cost ~1 hour (2026-07-18).
const DEADLINE_MS = input.deadlineMs || 4 * 60 * 1000

async function withDeadline(promise, label) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true, label }), DEADLINE_MS)
  })
  const result = await Promise.race([promise, timeout])
  clearTimeout(timer)
  return result
}

// ── schemas ────────────────────────────────────────────────────────────────
// Evidence is required by the type rather than requested in the prose. An
// agent cannot return a technique without quoting the thing it came from.
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'the source family this agent swept' },
    items: {
      type: 'array',
      description: 'one entry per extractable technique; empty when there is nothing',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          source_ref: { type: 'string', description: 'version, URL, or creator @ MM:SS' },
          quote: { type: 'string', description: 'verbatim quote or code block, never a summary' },
          technique: { type: 'string', description: 'what it does, at most two sentences' },
          judgment: { type: 'string', description: 'adoptable technique, or bugfix/noise' },
        },
        required: ['title', 'source_ref', 'quote', 'technique', 'judgment'],
      },
    },
    skipped: {
      type: 'array',
      description: 'sources checked with nothing extractable, and why',
      items: {
        type: 'object',
        properties: { what: { type: 'string' }, why: { type: 'string' } },
        required: ['what', 'why'],
      },
    },
    state_updates: {
      type: 'string',
      description: 'ids/versions seen this run, for the seen-state files; empty string if none',
    },
  },
  required: ['source', 'items', 'skipped', 'state_updates'],
}

const GROUNDING_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          verdict: { type: 'string', description: 'YES, NO, PARTIAL, or DISCUSSED' },
          evidence: { type: 'string', description: 'file:line citations, never recall' },
        },
        required: ['question', 'verdict', 'evidence'],
      },
    },
    rejected_ideas: { type: 'array', items: { type: 'string' } },
    open_upgrade_claims: { type: 'array', items: { type: 'string' } },
  },
  required: ['answers', 'rejected_ideas', 'open_upgrade_claims'],
}

// ── sources ────────────────────────────────────────────────────────────────
// Caller supplies the briefs so the skill stays the single source of truth for
// what each source is and how it is fetched. Lanes follow OPERATIONAL_PREFERENCES
// § Model selection. A source may carry `agentType` (a roster agent such as a
// web-capable researcher on the OpenAI lane); the schema still binds its
// return. `model` is the Claude-tier fallback for a source with no agentType.
const sources = input.sources || []
const groundingBrief = input.groundingBrief

if (!sources.length) {
  log('no sources supplied — pass {sources:[{key,model,prompt}], groundingBrief} as args')
  return { findings: [], coverage: [], grounding: null }
}

// ── collect ────────────────────────────────────────────────────────────────
log(`sweeping ${sources.length} source families, ${Math.round(DEADLINE_MS / 1000)}s deadline`)

const collected = await parallel(
  sources.map((s) => () =>
    withDeadline(
      agent(s.prompt, {
        label: `source:${s.key}`,
        phase: 'Collect',
        schema: FINDINGS_SCHEMA,
        ...(s.agentType ? { agentType: s.agentType } : { model: s.model || 'opus' }),
      }),
      s.key,
    ),
  ),
)

const grounding = groundingBrief
  ? await withDeadline(
      agent(groundingBrief, {
        label: 'grounding',
        phase: 'Ground',
        schema: GROUNDING_SCHEMA,
        model: 'opus',
      }),
      'grounding',
    )
  : null

// ── shape the return ───────────────────────────────────────────────────────
// Coverage is reported honestly: a source that timed out or died says so,
// so the report's Sources Processed line cannot silently claim full coverage.
const coverage = []
const findings = []

collected.forEach((result, i) => {
  const key = sources[i].key
  if (!result) {
    coverage.push({ source: key, status: 'failed' })
  } else if (result.__timedOut) {
    coverage.push({ source: key, status: 'timed out' })
  } else {
    coverage.push({
      source: key,
      status: 'ok',
      techniques: result.items.length,
      skipped: result.skipped.length,
    })
    findings.push(result)
  }
})

const degraded = coverage.filter((c) => c.status !== 'ok')
if (degraded.length) {
  log(`degraded coverage: ${degraded.map((c) => `${c.source} (${c.status})`).join(', ')}`)
}

const groundingOut = grounding && grounding.__timedOut ? null : grounding
if (groundingBrief && !groundingOut) {
  log('grounding leg did not deliver — prior-status tags must be gathered inline')
}

return {
  findings,
  coverage,
  grounding: groundingOut,
  totals: {
    sources_ok: coverage.filter((c) => c.status === 'ok').length,
    sources_degraded: degraded.length,
    techniques: findings.reduce((n, f) => n + f.items.length, 0),
    skipped: findings.reduce((n, f) => n + f.skipped.length, 0),
  },
}
