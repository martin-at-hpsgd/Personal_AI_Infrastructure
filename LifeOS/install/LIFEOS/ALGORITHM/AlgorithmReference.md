# Algorithm reference

The resident Algorithm remains the run contract. These sections preserve relocated source text verbatim. Read the applicable section when its resident trigger fires; uncertain relevance requires reading that section. Skill, dispatch, spend, telemetry and close contracts remain resident.

## Loop background

Every capability in the system — context gathering, thinking skills, research, agents, audits, the nudge layer, the principal's corrections — exists to enhance the ISA: sharpen its criteria, surface its unknowns, fold in what the work teaches, until it is the hard-to-vary shape of what done actually means. Enhancement never stops: during the build (nudges), at the close (gates), and after completion (a reopened ISA continues the same climb in a later run; ~27% of runs iterate).

For anything with persistent identity — an app, a library, this system — the ISA outlives every run. Between runs it is the thing's current state: the criteria it satisfies, with evidence. For applications that file lives with the app, and Development Test re-runs its criteria through Assay on demand (calling the `bunker test` row engine where the app is registered), so an app's criteria set is green because its asserts actually ran. After deploy, Bunker's probes run the same rows against the live app. "Add a feature" means "add criteria that don't hold yet."
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

Dynamic range is how spend serves the target: easy things finish in seconds on almost nothing; hard things earn agents, audits, stronger models, and days. Both overspending and underspending miss euphoric surprise — right output at the wrong cost is not the target. The criteria keep it honest: you cannot close what you did not verify, so difficulty pulls the right resources in on its own.

A run is the loop applied once. Below is what must be true when it is done. How to get there is my job.

## Events ask the rest

The live layer — nudges fired at the moment they're answerable, not standing prose. One runner, `hooks/AlgorithmNudge.hook.ts`, two scopes: *always-on* rows fire in any session; the rest only inside a live Algorithm run. The bound below is load-bearing and was violated by this file's own table until 2026-07-30: a `principal messages mid-run` row asked about a message sitting in the model's context, survived every review because it was dead, and is now cut. Deterministic, zero inference. The three rows keyed on the prompt (skill USE WHEN, plain-language depth, doctrine-class judgment) were cut 2026-10-25 by this same bound: the prompt is in the model's context, the skill listing carries USE WHEN, depth is native, and doctrine-class scrutiny is § Spend's call. Rows are bounded by construction: a row may only ask a question about an outcome already stated in this file, and only about **state the model cannot observe from its own context** — an unwritten or stale ISA, a destructive op's blast radius, a capability the manifest knows is broken. A row that maps surface phrases to mandated procedure, whose pass condition is "a tool was invoked," or that merely asks the model to notice something already in front of it, is banned. One named exception: entry rows — depth-directive and doctrine-class — key on the prompt itself, because their job is making the run exist; an entry misjudgment leaves no run for any in-run check to bind, which no in-context observation can recover after the fact, and prose teeth for exactly this class failed live twice before each row was added.

| When | Ask |
|---|---|
| Deep into a session, no ISA registered *(always-on)* | Still trivial, or does done need writing down? |
| A criterion is about a behavioral/quality/regression property one direct probe can't close | Multi-sample class? Then its assert row is an `eval` row (`suite:` → Assay's EvalRunner, reached through the `bunker test` row engine) on the integrity or build lane at a stage above the criterion's asserts — the row is required, only its depth (lane, cadence, k) is a spend call. A choice between candidates (which cover, which draft) is a `pairwise` row (Tournament: a flipped bracket, stable winner) on the same lanes. Otherwise a direct-probe row closes it. |
| Long stretch with no ISA edits | Is the ISA still the true shape of done? |
| An ISA carrying `## Features` is edited with no `absence_review:` frontmatter key and phase ≠ complete *(always-on)* | Run the absence pass (ISA Scaffold § Absence pass): one non-forked fresh reviewer briefed from Problem, Vision, Articulation, Goal, Constraints, and Out of Scope only — never the criteria — names at most seven failures the work must survive; disposition each as an `absence` manifest row, or log the skip as a Decisions row and set `absence_review: skipped — <reason>`. Advisory: the on-disk key's absence is a state the model cannot see from context, which is the only thing a row may ask about. |
| A destructive infra op ran (delete worker/domain/zone/record/bucket/route) *(always-on)* | What did that resource own per the provider's authority API? Re-list from the authority post-op — a warm-cache probe is not the authority — and prove the flow it served still runs at baseline (criterion 16). |
| An ISA edit landed on a project ISA with no L1 in its ladder (and no legacy `## Articulation` section) *(always-on)* | This project's describe-it-in-text ideal state was never extracted (ISAFormat v2.28.0). `IsaAlign.ts status` reports it as owing a Discuss round in `discover` mode: run it before building further, drafting from the ISA's own text first (`IsaLadder.ts migrate <isa> --full`) so the round confirms rather than starts cold, or take the principal's `proceed` and log it (criterion 6). |
| An ISA edit landed on an ISA whose `IsaAlign.ts status` carries an `align` or `deepen` reason *(always-on, v8.41.0)* | The ISA's own state says direction is uncertain (a corrected restate never re-aligned, asks clustering, thick fog, no ladder). Run `Skill("ISA","discuss <isa>")` at the mode and depth the line names before building the uncertain part, or take the principal's `proceed` and log it as a dated `discuss skipped` Decisions row (criterion 6). |

## Source provenance

Source: relocated from Algorithm 8.29.1; the current Algorithm version is in `LATEST`. The sixteen completion clauses and everyday execution contracts remain in the resident file.

## Telemetry & records

Relocated from Algorithm 8.32.0 at 8.33.0. Read before working an ISA with other sessions, fanning criteria out, or changing run-state telemetry.

- **Run states.** `phase:` is a lifecycle bracket, never a station walk. `deriveAscent()` in `LIFEOS/TOOLS/ascent.ts` is the one table that names and colours every run state across the Kitty tab, the status line, the Pulse board and the ISA HTML mirror; ISASync mirrors every ISA write to `work.json`. Model: `LIFEOS/DOCUMENTATION/Algorithm/AscentStates.md`. On every ISA write whose derived state changed, `hooks/ISASync.hook.ts` injects a `<lifeos-ascent-delta>` block; the LifeOSHooks plugin draws it as a pinned status line, and without the plugin the model echoes it verbatim once per transition.
- **The frontier.** Criteria may carry ordering edges, a trailing `(after: ID, ID)` (ISAFormat v2.21.0). `bun LIFEOS/TOOLS/IsaFrontier.ts frontier|claim|release|status|validate <isa>` computes the takeable set (open, blockers resolved, unlocked) and gives concurrent sessions atomic per-criterion locks (`MEMORY/STATE/isa-locks/`, 2h stale TTL). This is optional tooling for concurrent sessions: a session working an ISA another session may also be working can take its unit before building and release it at close; a solo run never needs the protocol, and no run requires it. Edges are optional: encode real ordering only, and no gate may require them. IsaFrontier never writes the ISA.
- **Fan-out.** When agents or a Workflow written for the task carry a build, the shape is my call; nothing requires a fixed lane structure, waves, or a plan-approval wait. Lane agents never write the ISA, push or deploy (`SubagentShipGuard`); the main session is the ISA's only writer, by hand or through `IsaFold.ts`, and ticks a criterion only from evidence it has seen. The principal's only optional input is width ("go wide", "keep it serial").
- **Second looks.** Cross-vendor: `Agent(subagent_type:"Astra", prompt:"MODE: audit\nslug: …")`. In-family: `Agent(subagent_type:"Opus", prompt:"MODE: audit\n…")`; `Agent(subagent_type:"Fable")` while the Fable budget is open (`bun LIFEOS/ROUTER/FableBudget.ts`) or on the principal's word (RouterSystem § Fable budget, 2026-10-16). A fork inherits the build context and defends its own code, and a review that lost its context returns a confident, hollow verdict, so the brief restates the goal and criteria.
- **Records.** Registry: `MEMORY/STATE/work.json`. Reflections land in `LIFEOS/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl`; `Reflect.ts` derives the operational fields, never self-scored.

## Routing

**These are BLE rules: the principal's routing preferences, followed by their intent, with freedom in how.** Each rule says what the principal wants from routing and what usually gets it; none prescribes steps. I follow every one on every dispatch, inside an Algorithm run or not, and when the work shows a better way to the same intent I take it and say why in one sentence. The hard floors bind as written: rule 14 (the effort range), rule 16 (the blast-radius floor), rule 24 (the stakes floor for claims about real people or companies) and rules 29 and 30 (the side lanes).

**The written route makes the preferences checkable.** A run with features writes one `Lane: <Agent> · <effort>` or `Lane: inline` line per feature before building (ISAFormat.md § Feature blocks), and each dispatch's description names its feature (`build:F3 api`). The LifeOSHooks plugin draws the route as it is written, a background judgment question of about half a second flags a likely misfit beside it, and `bun LIFEOS/ROUTER/RouteCheck.ts check <isa> --session <id>` reads what ran against what was written at the end. None of it waits on a model or refuses work. The route serves one target, a Socrates standing question: results at least as good as last week; spend is reported beside it and never fails it, because the goal is the smartest result, not the cheapest (Router ISA F16, 2026-10-26).

This section is the single home for routing: who runs what, at what effort and how wide. Each numbered rule is 16 words or fewer. The router code reads its rules from this section and `bun LIFEOS/ROUTER/Router.ts rules` prints them; model IDs behind each name live in `LIFEOS/TOOLS/models.ts`, and how the router code works is `LIFEOS/DOCUMENTATION/Router/RouterSystem.md`.

**The ladder**

1. First goal: highest-quality results that cause euphoric surprise; time to a usable result is quality.
2. Second: on a close call, take the smarter model and higher effort; spend comes last.
3. These are BLE preferences: follow each one's intent; the named hard floors bind as written.
4. Opus: strongest at open judgment, design and max work at xhigh. The default and the advisor.
5. Sonnet: execution: building, fixing, documents and polish once the approach is set.
6. Sol: execution for scheduled jobs and the Codex door, or on the principal's word.
7. Fable: the top model, costliest, read-only. Hardest judgment only, gently: one leg per run.
8. Sol audit: the OpenAI eye, read-only; exhaustive coverage, needle-in-a-haystack hunts, cross-vendor checks.
9. Haiku: cheapest; near-mechanical work a script could almost do.
10. Open judgment usually suits Opus; a set approach suits Sonnet.

**Handoff**

11. Inline: stay in session when the work needs this conversation's context or is quick.
12. Handoffs work best for a separable leg a brief can fully describe.

**Effort**

13. Effort usually follows how hard the thinking is and what a quiet mistake costs, not size.
14. Never low, never max: medium, high or xhigh. High suits most work.

**Guardrails**

15. The rung usually follows how much deciding is left more than job size.
16. Deploys, secrets, auth, migrations, irreplaceable data need a careful model: Sonnet minimum, Sol on Codex.
17. Depth words: the hard part gets Opus xhigh (an agent if needed) and thinking skills.
18. Publish-bound, security and core-surface work gets an independent look (Review.ts counts), or a logged reason.
19. Routine checker: Sonnet at medium, one per run; Sol audit only for exhaustive or security checks.
20. A brief sent below Opus names acceptance and paths, or goes up a rung.
21. Scheduled jobs run on subscriptions: Haiku and Sonnet on Claude, Sol via codex.
22. Evals test the model the DA runs on; their judges ride the helper lanes.

**Width**

23. Width follows separable parts: one or two inline, three or more a Workflow tier.
24. Claims about real people or companies run at tier five with adversarial verification.

**Fable**

25. Fable budget not open: Opus at xhigh takes the work; Sol audit takes second looks.
26. Fable decides or reviews; the building fans out to Sonnet and Opus in parallel.

**Subagents**

27. Same-model subagents only for parallel width, fresh-eyes review, or context the session can't hold.
28. Teach the how with a skill and act with a tool before adding an agent.

**Side lanes**

29. Grok: side lane, never a rung; no secrets; never builds or audits.
30. Muse: side lane, never a rung; no secrets; never in private trees, never audits.

**Width tiers**

Rules 23 and 24 size how wide a run goes by counting its separable parts: pieces of the run that do not wait on each other and can each be checked on their own (a Feature in a build, one researcher's source family, one critic's lens, one /a pass).

| Tier | Separable parts in this run | Shape |
|---|---|---|
| 1 | one | Inline, no Workflow; the part's check runs |
| 2 | two, or a few small ones in one place | Inline, no Workflow; each part's check reruns |
| 3 | three or four | A Workflow, one lane per part, each lane's check rerun by the script, one merged pass |
| 4 | five or more, independent | Parallel lanes with per-lane deadlines and retries, each lane's check rerun by the script |
| 5 | a large slice, or claims about real people or companies | Many lanes with deadlines, multi-lens adversarial verification, a completeness critic, resumable |

- The tier comes from the work asked for, never from the size of what it touches, and is named in one line before the work starts.
- Stakes raise the floor: output asserting facts about a real person or company is tier 5 however few its parts; deploys, secrets and auth keep rule 16.
- Saved scripts (`workflows/ResearchFanout.js`, `CriticPanel.js`, `Analyze.js`) take `tier` in their args and never hard-code it.
- A skill run the principal asked for may run as a Workflow at tier 3 or above, as may `dw`, `uc`, the `p` levels and a time suffix; `y` alone never starts one, and no scheduled or self-initiated loop does.
- Speed is part of quality: a fast single-synthesis job stays inline even when it touches many files, and code that already fans out stays code.
