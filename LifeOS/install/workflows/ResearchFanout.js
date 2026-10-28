// ResearchFanout — a researcher fleet as one script: collect in parallel, merge into claims, verify by stakes and tier.
//
// Why this exists: twelve intents (OSINT lookups, people search, vulnerability sweeps, competitor profiles, upgrade
// research, speaking opportunities) each launched seven to nine researchers by hand and merged them
// in my head. The 709-intent read on 2026-10-16 found the same shape in all of them (Router ISA F8, R129). Here the
// deadline, the fail-open behaviour, the merge and the verification are code; the report is still written by the DA,
// because each intent's Output format is its own contract.
//
// Tier (Algorithm § Routing) decides retries and checks, never the fleet: the
// caller passes the researchers. Tier 4 retries a researcher that timed out or died, once. Tier 5, or any run whose
// stakes name people or companies, sends every merged claim to three skeptics and keeps it only on a majority, then
// runs a completeness critic. `stakes` adds verification and nothing else: this script sees no authorization record and
// checks none. An intent that researches a named person or company, or lets a researcher scan a host, writes its
// authorization record (target, scope, basis, time) in the main session before launching it, and names any active-scan
// scope in that researcher's prompt; a researcher whose prompt names no scope is told to stay passive.
//
// Invoked by: the researcher-fleet intents' Tool contracts, as
//   Workflow({name: "ResearchFanout", args: {question, researchers: [{key, prompt, agentType?, model?}], tier, stakes}})

export const meta = {
  name: 'ResearchFanout',
  description: 'Run a researcher fleet in parallel, merge findings into sourced claims, and verify them by tier and stakes',
  whenToUse: 'An intent that launches several researchers on one question and merges what they find',
  phases: [
    { title: 'Collect', detail: 'one agent per researcher, fail-open on a deadline' },
    { title: 'Merge', detail: 'one agent deduplicates findings into sourced claims' },
    { title: 'Verify', detail: 'three skeptics per claim batch at tier 5 or when stakes name people or companies' },
    { title: 'Critic', detail: 'tier 5: what was missed' },
  ],
}

// `args` can arrive as a JSON string (UpgradeFanout, run wf_2c46a8c5-435).
const input = (() => {
  if (!args) return {}
  if (typeof args === 'string') { try { return JSON.parse(args) } catch { return {} } }
  return args
})()

const question = String(input.question || '')
const researchers = Array.isArray(input.researchers) ? input.researchers : []
const stakes = ['people', 'company'].includes(input.stakes) ? input.stakes : 'public'
const tier = Math.max(3, Math.min(5, Number(input.tier) || 3))
const verifyAll = tier >= 5 || stakes !== 'public'
const DEADLINE_MS = Number(input.deadlineMs) || 6 * 60 * 1000
const BATCH = 8
const SKEPTICS = 3   // skeptics per claim batch; a claim needs a majority of these, not of the ones that answered

if (!question || !researchers.length) {
  return { error: 'ResearchFanout needs args.question and a non-empty args.researchers', tier, stakes }
}

function withDeadline(promise, label) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true, label }), DEADLINE_MS) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      claim: { type: 'string', description: 'one fact, stated plainly' },
      evidence: { type: 'string', description: 'what the source says, quoted or closely paraphrased' },
      url: { type: 'string', description: 'where it was read; empty only for a CLI result named in evidence' },
    }, required: ['claim', 'evidence', 'url'] } },
    notChecked: { type: 'array', items: { type: 'object', properties: {
      source: { type: 'string' }, reason: { type: 'string' },
    }, required: ['source', 'reason'] } },
  },
  required: ['findings', 'notChecked'],
}

const CLAIMS = {
  type: 'object',
  properties: {
    claims: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      claim: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } },
      researchers: { type: 'array', items: { type: 'string' } },
    }, required: ['id', 'claim', 'sources', 'researchers'] } },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'claims the researchers disagree on, each stated with both sides' },
  },
  required: ['claims', 'conflicts'],
}

const REFUTE = {
  type: 'object',
  properties: {
    verdicts: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' },
    }, required: ['id', 'refuted', 'reason'] } },
  },
  required: ['verdicts'],
}

const GAPS = {
  type: 'object',
  properties: { gaps: { type: 'array', items: { type: 'string' } } },
  required: ['gaps'],
}

const collectOne = (r) => withDeadline(agent(
  `${r.prompt}

The question this fleet serves: ${question}

Done looks like: every fact you found as its own finding, with the evidence and where you read it. A source you could not reach, or one that needs a key, plan or login, goes in notChecked with the reason; never guess past it. Read and look only: no writes, no sign-ups, no active scans unless your prompt names that scope.`,
  { label: `collect:${r.key}`, phase: 'Collect', schema: FINDINGS, ...(r.agentType ? { agentType: r.agentType } : {}), ...(r.model ? { model: r.model } : {}) },
), r.key)

phase('Collect')
let collected = await parallel(researchers.map((r) => () => collectOne(r)))
const failed = (x) => !x || x.__timedOut
if (tier >= 4) {
  const retry = researchers.filter((_, i) => failed(collected[i]))
  if (retry.length) {
    log(`retrying ${retry.length} researcher(s) once: ${retry.map((r) => r.key).join(', ')}`)
    const again = await parallel(retry.map((r) => () => collectOne(r)))
    let k = 0
    collected = collected.map((x) => (failed(x) ? again[k++] : x))
  }
}
const timedOut = researchers.filter((_, i) => failed(collected[i])).map((r) => r.key)
if (timedOut.length) log(`no result from ${timedOut.length} researcher(s): ${timedOut.join(', ')}`)
const raw = researchers.flatMap((r, i) => (failed(collected[i]) ? [] : collected[i].findings.map((f) => ({ ...f, researcher: r.key }))))
const notChecked = researchers.flatMap((r, i) => (failed(collected[i]) ? [] : collected[i].notChecked.map((n) => ({ ...n, researcher: r.key }))))

if (!raw.length) return { question, tier, stakes, claims: [], refuted: [], conflicts: [], notChecked, timedOut, gaps: [], findings: 0 }

phase('Merge')
const merged = await agent(
  `Merge these research findings into claims. Question: ${question}

Each claim states one fact once, lists every source URL that supports it and every researcher who found it, and gets a short id (C1, C2, ...). Findings that disagree become one conflict line that states both sides; never pick a side silently. Keep every distinct fact; drop only exact repeats.

Findings (JSON):
${JSON.stringify(raw)}`,
  { label: 'merge', phase: 'Merge', schema: CLAIMS, effort: 'high' },
)
let claims = merged ? merged.claims : []
const conflicts = merged ? merged.conflicts : []
let refuted = []

if (verifyAll && claims.length) {
  phase('Verify')
  const batches = []
  for (let i = 0; i < claims.length; i += BATCH) batches.push(claims.slice(i, i + BATCH))
  const judged = await pipeline(batches, (batch, _b, bi) => parallel(Array.from({ length: SKEPTICS }, (_, v) => () => agent(
    `You are a skeptic checking research claims${stakes !== 'public' ? ` about a real ${stakes === 'people' ? 'person' : 'company'}` : ''}. Try to refute each claim by opening its sources. Refute it when no source says it, the source is about a different entity, it is out of date, or it rests on one weak source. Default to refuted when you cannot confirm it.

Claims (JSON):
${JSON.stringify(batch)}`,
    { label: `verify:B${bi}.${v}`, phase: 'Verify', schema: REFUTE, effort: 'high' },
  ))).then((votes) => ({ batch, votes: votes.filter(Boolean) })))
  const keep = new Set(), drop = []
  for (const j of judged.filter(Boolean)) {
    for (const c of j.batch) {
      const vs = j.votes.map((v) => v.verdicts.find((x) => x.id === c.id)).filter(Boolean)
      const upheld = vs.filter((v) => !v.refuted).length
      // A majority of the three skeptics asked, never of the ones that answered: a skeptic that died or timed out is not a vote to uphold.
      if (upheld * 2 > SKEPTICS) keep.add(c.id)
      else drop.push({ ...c, reasons: vs.filter((v) => v.refuted).map((v) => v.reason) })
    }
  }
  refuted = drop
  claims = claims.filter((c) => keep.has(c.id))
  log(`${claims.length} claims survived verification, ${refuted.length} refuted or unconfirmed`)
}

let gaps = []
if (tier >= 5) {
  phase('Critic')
  const g = await agent(
    `A research fleet answered: ${question}
Researchers: ${researchers.map((r) => r.key).join(', ')}. Not checked: ${JSON.stringify(notChecked)}. Surviving claims: ${JSON.stringify(claims.map((c) => c.claim))}.
Name what is missing: a source family nobody ran, a fact the question needs that no claim covers, a claim that rests on one source. Each gap in one line.`,
    { label: 'critic', phase: 'Critic', schema: GAPS, effort: 'high' },
  )
  gaps = g ? g.gaps : []
}

return { question, tier, stakes, verified: verifyAll, claims, refuted, conflicts, notChecked, timedOut, gaps, findings: raw.length }
