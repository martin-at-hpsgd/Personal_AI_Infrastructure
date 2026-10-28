// CriticPanel — independent critics on one artifact, findings deduplicated in code, kept only when skeptics uphold them.
//
// Why this exists: a blog-attack intent launched twelve attackers in one message, and an algorithm audit and other panel
// intents ran their lenses by hand, then trusted every finding that came back (Router ISA F8, R130). Here the panel,
// the dedup and the skeptic pass are code. The critics and skeptics only read; the main session decides and makes
// every fix, because it is the only writer of the artifact.
//
// Tier (Algorithm § Routing) decides the check: below tier 5 one skeptic per
// finding, at tier 5 three with a majority. Tier 4 and up retries a critic that timed out or died, once.
//
// Invoked as Workflow({name: "CriticPanel", args: {artifact: {what, path?, text?}, critics: [{key, prompt, agentType?, model?}], tier}})

export const meta = {
  name: 'CriticPanel',
  description: 'Run independent critics on one artifact, dedupe their findings, and keep only the ones skeptics uphold',
  whenToUse: 'An intent that sends several critics or lenses at one draft, plan or system and acts on what they find',
  phases: [
    { title: 'Critique', detail: 'one agent per critic, read-only, fail-open on a deadline' },
    { title: 'Verify', detail: 'skeptics try to refute each deduplicated finding' },
  ],
}

const input = (() => {
  if (!args) return {}
  if (typeof args === 'string') { try { return JSON.parse(args) } catch { return {} } }
  return args
})()

const artifact = input.artifact || {}
const critics = Array.isArray(input.critics) ? input.critics : []
const tier = Math.max(3, Math.min(5, Number(input.tier) || 3))
const VOTES = tier >= 5 ? 3 : 1
const DEADLINE_MS = Number(input.deadlineMs) || 8 * 60 * 1000
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }

if (!artifact.what || (!artifact.path && !artifact.text) || !critics.length) {
  return { error: 'CriticPanel needs args.artifact {what, path or text} and a non-empty args.critics', tier }
}

const where = artifact.path ? `Read it in full at ${artifact.path}.` : `It is below.\n\n${artifact.text}`

function withDeadline(promise, label) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true, label }), DEADLINE_MS) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      location: { type: 'string', description: 'where in the artifact: a heading, line, quote or file:line' },
      issue: { type: 'string', description: 'what is wrong, in one or two sentences' },
      evidence: { type: 'string', description: 'the quote or fact that shows it' },
      fix: { type: 'string', description: 'the change that would remove it' },
    }, required: ['severity', 'location', 'issue', 'evidence', 'fix'] } },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const critiqueOne = (c) => withDeadline(agent(
  `${c.prompt}

The artifact: ${artifact.what}. ${where}

Done looks like: every real problem you find through your lens, each located, evidenced from the artifact and given a fix. Return no findings rather than weak ones. Read only: never edit, write or run anything that changes a file.`,
  { label: `critic:${c.key}`, phase: 'Critique', schema: FINDINGS, ...(c.agentType ? { agentType: c.agentType } : {}), ...(c.model ? { model: c.model } : {}) },
), c.key)

phase('Critique')
let got = await parallel(critics.map((c) => () => critiqueOne(c)))
const failed = (x) => !x || x.__timedOut
if (tier >= 4) {
  const retry = critics.filter((_, i) => failed(got[i]))
  if (retry.length) {
    log(`retrying ${retry.length} critic(s) once: ${retry.map((c) => c.key).join(', ')}`)
    const again = await parallel(retry.map((c) => () => critiqueOne(c)))
    let k = 0
    got = got.map((x) => (failed(x) ? again[k++] : x))
  }
}
const silent = critics.filter((_, i) => failed(got[i])).map((c) => c.key)
if (silent.length) log(`no result from ${silent.length} critic(s): ${silent.join(', ')}`)

// Dedup in code: the same location and the same opening words of the issue are one finding, credited to every critic.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
const keyOf = (f) => `${norm(f.location).join(' ')}|${norm(f.issue).slice(0, 6).join(' ')}`
const byKey = new Map()
critics.forEach((c, i) => {
  if (failed(got[i])) return
  for (const f of got[i].findings) {
    const k = keyOf(f)
    const seen = byKey.get(k)
    if (seen) {
      seen.critics.push(c.key)
      if (RANK[f.severity] < RANK[seen.severity]) seen.severity = f.severity
    } else byKey.set(k, { ...f, critics: [c.key] })
  }
})
const findings = [...byKey.values()].map((f, i) => ({ id: `F${i + 1}`, ...f }))
if (!findings.length) return { artifact: artifact.what, tier, survived: [], refuted: [], silent, raw: 0 }

phase('Verify')
const judged = await pipeline(findings, (f) => parallel(Array.from({ length: VOTES }, (_, v) => () => agent(
  `You are a skeptic. Try to refute this finding about ${artifact.what}. ${where}

Refute it when the artifact does not say what the finding claims, the problem is a matter of taste, the fix would break something the artifact needs, or the evidence is misread. Default to refuted when you cannot confirm it from the artifact. Read only: never edit, write or run anything that changes a file.

Finding (JSON): ${JSON.stringify(f)}`,
  { label: `verify:${f.id}.${v}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
))).then((votes) => ({ f, votes: votes.filter(Boolean) })))

const survived = [], refuted = []
for (const j of judged.filter(Boolean)) {
  const upheld = j.votes.filter((v) => !v.refuted).length
  // A majority of the skeptics asked (VOTES), never of the ones that answered: a skeptic that died or timed out is not a vote to uphold.
  if (upheld * 2 > VOTES) survived.push(j.f)
  else refuted.push({ ...j.f, reasons: j.votes.filter((v) => v.refuted).map((v) => v.reason) })
}
survived.sort((a, b) => RANK[a.severity] - RANK[b.severity])
log(`${survived.length} of ${findings.length} findings upheld`)
return { artifact: artifact.what, tier, survived, refuted, silent, raw: findings.length }
