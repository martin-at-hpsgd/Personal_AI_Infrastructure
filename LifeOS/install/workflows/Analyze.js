// Analyze — the /a passes in parallel, each through its own skill call, each pass's sourced claims checked by a skeptic.
//
// Why this exists: on 2026-10-16 /a ran five Opus passes as hand-launched agents with no progress card and no check,
// and one pass ran a tool "to look" that wrote a trend line and sent an alert (Router ISA F8, R131). Here the passes,
// the read-only rule and the check are code. The synthesis stays in the main session, because /a's output is one
// integrated analysis and the principal's yes decides what lands.
//
// Tier (Algorithm § Routing): every pass is checked by one skeptic; tier 5 adds a
// completeness critic.
//
// Invoked by the analysis command (maintainer-side; not in the public release) and the context-load review as
//   Workflow({name: "Analyze", args: {subject, facts, extras: [{skill, args, why}], tier, skipBle?}})

export const meta = {
  name: 'Analyze',
  description: 'Run the /a analysis passes in parallel through their own skills, read-only, and check each pass',
  whenToUse: '/a, and any intent that runs Superior, Unify, Simplify Survey and BitterLessonEngineering on one subject',
  phases: [
    { title: 'Passes', detail: 'one agent per skill pass, read-only' },
    { title: 'Check', detail: 'a skeptic re-reads the sources behind each pass' },
    { title: 'Critic', detail: 'tier 5: what no pass covered' },
  ],
}

const input = (() => {
  if (!args) return {}
  if (typeof args === 'string') { try { return JSON.parse(args) } catch { return {} } }
  return args
})()

const subject = String(input.subject || '')
const facts = String(input.facts || '')
const tier = Math.max(3, Math.min(5, Number(input.tier) || 3))
if (!subject) return { error: 'Analyze needs args.subject', tier }

const CORE = [
  { skill: 'Superior', args: `Elevate — ${subject}`, why: 'how a far smarter, fully informed mind would do it' },
  { skill: 'Unify', args: `Harmonize — ${subject}, across its own parts and the things it touches`, why: 'whether its parts are in harmony' },
  { skill: 'Simplify', args: `Survey — ${subject}`, why: 'what can be cut without breaking anything (Survey only)' },
  ...(input.skipBle ? [] : [{ skill: 'BitterLessonEngineering', args: subject, why: 'which rules a smarter model would not need' }]),
]
const passes = [...CORE, ...(Array.isArray(input.extras) ? input.extras : [])]

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'the pass result in three sentences or fewer' },
    findings: { type: 'array', items: { type: 'object', properties: {
      claim: { type: 'string' },
      evidence: { type: 'string', description: 'path:line, a quoted line, or the read-only command and its output' },
      recommendation: { type: 'string' },
      lands: { type: 'string', description: 'the file or system the change would land in' },
      needsYes: { type: 'boolean', description: 'true when it changes doctrine, identity or anything the principal must ratify' },
    }, required: ['claim', 'evidence', 'recommendation', 'lands', 'needsYes'] } },
  },
  required: ['summary', 'findings'],
}

const CHECK = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: {
    index: { type: 'integer' }, holds: { type: 'boolean' }, reason: { type: 'string' },
  }, required: ['index', 'holds', 'reason'] } } },
  required: ['verdicts'],
}

const READ_ONLY = 'Read only. Never edit or write any file in the subject, and never run a tool, script or test the sources name, even with --help, because some tools write when run (2026-10-16: a pass ran OutputReconciler.ts --help, which ran a full pass, appended a trend line and sent an alert). The one write allowed is the Simplify survey record under LIFEOS/MEMORY/WORK/.'

phase('Passes')
const results = await pipeline(
  passes,
  (p) => agent(
    `Run the ${p.skill} skill (Skill tool, skill: "${p.skill}", args: ${JSON.stringify(p.args)}) at full depth, then return its findings. Never summarize the skill from memory or cut it short. Purpose of this pass: ${p.why}.

Subject: ${subject}
${facts ? `Facts and paths already found:\n${facts}\n` : ''}
Done looks like: every finding the skill produced, each with evidence a reader can open, the change it recommends, where that change lands, and whether it needs the principal's yes.

${READ_ONLY}`,
    { label: `pass:${p.skill}`, phase: 'Passes', schema: FINDINGS, effort: 'high' },
  ),
  (r, p) => (!r ? { skill: p.skill, failed: true } : agent(
    `You are a skeptic checking one analysis pass (${p.skill}) on: ${subject}. Open the evidence behind each finding and say whether it holds. It fails when the cited file or line does not say it, the claim overstates what the source shows, or it is about something other than the subject. Default to not holding when you cannot open the evidence.

${READ_ONLY}

Findings (JSON, indexed from 0):
${JSON.stringify(r.findings)}`,
    { label: `check:${p.skill}`, phase: 'Check', schema: CHECK, effort: 'high' },
  ).then((c) => ({ skill: p.skill, why: p.why, summary: r.summary, findings: r.findings.map((f, i) => {
    const v = c ? c.verdicts.find((x) => x.index === i) : null
    return { ...f, holds: v ? v.holds : null, check: v ? v.reason : 'unchecked' }
  }) }))),
)

// A stage that throws drops its item to null, and an agent that dies returns null: both count as a failed pass.
const done = results.filter(Boolean)
const failedPasses = passes.filter((_, i) => !results[i] || results[i].failed).map((p) => p.skill)
if (failedPasses.length) log(`passes with no result: ${failedPasses.join(', ')}`)

let gaps = []
if (tier >= 5) {
  phase('Critic')
  const g = await agent(
    `These analysis passes ran on: ${subject}
${done.filter((r) => !r.failed).map((r) => `${r.skill}: ${r.summary}`).join('\n')}
Name what no pass covered: a part of the subject nobody read, a risk nobody tested, a claim that rests on one source. One line each.

${READ_ONLY}`,
    { label: 'critic', phase: 'Critic', schema: { type: 'object', properties: { gaps: { type: 'array', items: { type: 'string' } } }, required: ['gaps'] }, effort: 'high' },
  )
  gaps = g ? g.gaps : []
}

return { subject, tier, passes: done.filter((r) => !r.failed), failedPasses, gaps }
