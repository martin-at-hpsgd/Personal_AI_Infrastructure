// Minimal smoke-test workflow — proves /workflows can find and run a file.
//
// Rewritten 2026-08-06 against the live runtime contract (probe run
// wf_a2b9c8df-62c). The June 2026 version was written for a shape the runtime
// no longer accepts: a default-exported run({agent}) whose agent() took the
// label first. It would have failed on execution, and it cost a real design
// pass an hour of doubt about which signature was current. The contract now:
// the script body runs directly, agent/parallel/pipeline/phase/log are
// globals, and agent() takes the prompt first.

export const meta = {
  name: 'Hello',
  description: 'smoke-test workflow',
  phases: [{ title: 'Greet', detail: 'one agent, one sentence' }],
}

phase('Greet')
const greeting = await agent('Say hello in one short sentence.', { label: 'greet' })

return { greeting }
