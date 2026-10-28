---
name: Development
metadata:
  short-description: "Builds, tests, modifies, and checks up on software against its ISA, keeping the code and its ISA criteria in agreement."
version: 1.4.3
description: Builds, tests, modifies and checks up on software against its ISA, from a one-file change to a giant system. Build turns intent into ISA criteria and makes them pass; Test proves the ISA is well formed, matches the code, and every criterion's Assay eval passes; Modify changes criteria first, then code; Checkup joins the ISA with production, Vigil, Errata and Achilles, says why each red criterion is red, and repairs the ISA. Each run is sized to the ask: small work inline, wide work a workflow. USE WHEN build an app, site, game, tool, CLI or pipeline, start a new project, implement or change a feature, fix a bug in an app, test the app, is the code in sync with the ISA, run the app evals, catch up an old repo into an ISA, health check, checkup, why are these ISCs red, audit the ISA, sync the ISA with production. NOT FOR editing an ISA's articulation alone (ISA), eval or judge design (Assay), new skills (CreateSkill), workflow definitions (Workflows), slides, images, Visualize, deploying (the project deploy command).
evals:
  manual:
    reason: "whether Build produces an ISA the principal accepts, and whether runs stay fast, can only be judged on real work"
    falsifier: "the principal rejects the ISA from a real Build as a wrong articulation, or a small change takes minutes of ceremony before code"
---

# Development

**Contents:** Ideal State · Intent Routing · Data & Config · Acceptance (output contract) · Safety gates · Execution · Tools · Gotchas · Examples

The thin actor between an ISA and its code. The ISA holds the rigor: what done means, every criterion, every criterion's eval. Assay is how each criterion is verified, and the only eval system a build may use (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § One eval system), at the cheapest honest tier: a code assert when the criterion is literal, a judgment-layer question when it needs reading, a judge only when neither can answer, the principal for taste. Development builds, tests and modifies until the code and the ISA agree.

## Ideal State

- At the end of every run the code and its ISA agree: every criterion in scope carries an eval at the cheapest honest Assay tier, and its result is recorded in the ISA.
- Criteria change before the code they govern; only a trivial change (a typo, a value, an obvious one-liner) skips the ISA.
- Nothing the principal will see or use is called done until acceptance against a reference they approved has passed (§ Acceptance); passing tests are the builder's signal, not the done signal.
- The report on such work opens with the acceptance verdict and its capture paths. The captures show the whole thing working the way the principal meets it: a page renders top to bottom at desktop and phone widths and looks like the reference. A report without a passing verdict, and without the principal's waiver, does not call the work done, fixed or shipped.
- The criteria are the only artifact written before the code.
- Nothing here deploys or writes production data; the project's gated deploy command ships.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **Build** | new app, new feature, "build this", an existing repo with no ISA | `Intents/Build.md` |
| **Test** | "test the app", "is it in sync", "run the evals", a check before deploy | `Intents/Test.md` |
| **Modify** | change, fix or remove behavior in an app that has an ISA | `Intents/Modify.md` |
| **Checkup** | "health check", "checkup", "why are these ISCs red", "get everything in sync", "audit the ISA" | `Intents/Checkup.md` |

| File | Read when |
|------|-----------|
| `References/Guards.md` | a guard refuses an edit or a builder, or you need to know whether an edit is checked against an ISA |
| `References/Inventory.md` | reading `Inventory.ts` or `sync` output, or the code section of a `Checkup.ts` bundle |
| `References/Tools.md` | a run needs a tool's full flags, output or exit codes, or is reading ISAGate's `bundled-claim` finding |
| `References/Sizing.md` | questioning a run's tier, or checking whether sizing holds on the shape scoreboard |

## Data & Config

User customizations at `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Development/` (`PREFERENCES.md` and any files it lists) override the defaults when that directory exists.

## Acceptance (output contract)

- **Done means acceptance passed:** the work was met the way the principal will meet it, compared to the reference and their words, and passed, with the captures. Criteria and tests are the builder's tools, not the done signal. Only the principal waives acceptance. (2026-10-07: a product page reached production broken while its whole test suite passed. `IsaCheck.ts acceptance` checks the recorded verdict at run end; the deploy path does not check it, `References/Guards.md`.)
- The reference is the existing thing the work should be like (looked for in LifeOS and the project first), or a rough mock or sample output when nothing exists. The principal approves it before code is written, and the ISA links it.

- **How deep acceptance goes follows what the principal will meet** (principal, 2026-10-12: speed is part of the experience). A rendered page, app UI or user-facing flow, anything deployed, and anything on a `high-risk-path` get the fresh agent below. A CLI, hook, internal tool or doctrine change is accepted by the builder's recorded run of the real command the principal would run, its output captured and compared with their words; that run is the verdict recorded under `## Status`.

For the first kind: a fresh, non-forked agent of a lineage other than the builder's when one is available (Astra for Claude-built work). Its brief carries exactly four things and nothing else, no criteria, diff, test results or builder notes:

1. The principal's words, verbatim.
2. The reference: a path, URL or screenshot.
3. Where the running thing is (preview or live URL, sign-in path) and that it must be opened in a real browser through Interceptor at desktop and phone widths, or run the way the principal runs it.
4. The return shape: `verdict: pass|fail`, one line why, every capture it viewed, and each difference from the reference.

It never fixes what it finds. The main session records `acceptance: <verdict> <date> <capture paths>` under the ISA's `## Status` and leads the report with it; a waiver is recorded as `acceptance: waived <date> <the principal's words>`. Before a Build or Modify report calls such work done, `IsaCheck.ts acceptance <isa> --since <the run's start date>` exits 0.

## Safety gates

- Nothing non-trivial is built without criteria in an ISA. In a project that has an ISA, every change, a one-liner included, starts and finishes with it (ISASystem.md § Code sync), and code refuses it otherwise: at the first edit, at the turn end, and at the release and deploy (`References/Guards.md`).
- Deploying is part of no intent. Build and Modify end with the independent code review (`LIFEOS/TOOLS/Review.ts`) on the committed HEAD of each deployable repo the run touched, scoped as CfEnv scopes a deploy: the deploy directory, or the repo root when that directory is git-ignored build output. Its blockers are fixed inside the run before it reports done, so the deploy only reviews what nobody reviewed. A run never clears its own review with `--allow-dirty`, `--waive-blockers` or `--past-round-cap`; those reasons are the principal's. A span the review has blocked four times hits the round cap: the run stops patching, rethinks the approach, and brings it to the principal. A blocker the run did not cause, such as an inherited span over the 64-batch ceiling, is reported to the principal as that, not treated as the run's own failure. The project's gated deploy command ships: it re-runs the review only on spans nobody reviewed, then Bunker probes the live app against the ISA.

## Execution

Every Build, Modify, Test and Checkup run is sized to the work asked for (principal, 2026-10-10: five tiers to choose from instead of three; 2026-10-12: small work stays fast). Tiers 1 and 2 run inline in this session with no Workflow: build, rerun the criteria's evals, report. Tiers 3 to 5 are a Workflow tool script written for that run; read the Claude Code harness's built-in workflow-authoring reference before the first script of a session, and independent lanes run in parallel, never one after another in a loop (PreToolGuard refuses a `for` loop of `await agent(` that carries no `// serial:` reason). The tier comes from the work asked for: the criteria this request adds, changes or tests. A large ISA with a small request is a small tier. Ultracode stays off unless the principal turns it on.

The five tiers are the Router's, the one table in Algorithm § Routing, which every skill sizes by (Router ISA F8, 2026-10-16). In a Development run a part is one Feature, or a group of criteria inside one Feature that can be built and checked on its own. So one criterion or one file is tier 1, a few criteria in one Feature tier 2, one Feature end to end or two small ones tier 3, several independent Features tier 4, and a new project or a large slice tier 5.

A separate checker agent is not part of any tier from 1 to 4 (principal, 2026-10-10: fewer separate checker runs when the work already checks itself properly). The run's own eval rerun, acceptance, and `LIFEOS/TOOLS/Review.ts` at the end of the run (the deploy re-runs it only on unreviewed spans; cross-vendor, depth set by path, fails closed) are the independent looks. One checker runs per run, over the merged diff and never per lane, only when a trigger fires:

- a criterion in scope has no code assert and can only be judged (trigger `judged`);
- the diff touches auth, payments, migrations, secrets or deploy config (`high-risk-path`);
- the work is in no deployable repo, so `Review.ts` never runs on it, such as `~/.claude` hooks, doctrine, tools and other code committed without a deploy (`no-review`);
- a lane needed a fix round, or edited the test or eval files its own criteria point at (`fix-round`).

A checker the principal asks for outside these triggers is `manual`. The checker's model and effort follow router rule 19 (`bun LIFEOS/ROUTER/Router.ts rules`); its brief is the diff, the criteria and their test rows, and one question: do these tests prove these criteria. When no checker ran, the report names the reason ("evals rerun by the script, Review.ts at run end"), which is router rule 18's logged reason. The main session logs each checker's result with `bun LIFEOS/ROUTER/Router.ts checker-log <trigger> found|clean`, so a trigger that never catches anything can be dropped.

At every tier:

- Each agent's brief carries the ISA path, the principal's words for this request, and the ISA Decisions that bear on it, so no agent works blind.
- Verification runs at each criterion's cheapest honest Assay tier, never as fixed stages.
- The full-ISA fast pass runs once, as one step; it never sets the width.
- The main session stays the ISA's only writer and ticks criteria from the workflow's returned evidence.
- Acceptance (§ Acceptance) runs after the build, at the depth § Acceptance sets.

The tier is mine to pick from the request and is named in one line before the work starts. If a run's tier turns out wrong, the next script resizes; a running workflow is never reached by SendMessage.

### Launch contract

- The launch `args` carry `{ isa: "<ISA path>", tier: <1-5>, lanes: [{ feature: "F<n>", name: "<lane>", criteria: ["ISC-4", …] }] }`, and every agent label starts with its role and lane in the `build:F<n> <name>` form (`verify:<Agent>:F<n> <name>`, `fix<round>:F<n> <name>`), with `phase` set to the role. The workflow view (`LIFEOS/TOOLS/WorkflowView.ts`) links a run to its ISA only through these, so a run without them draws with no ISA in the statusline, the band and the answer card.
- The run report carries a workflow block (a `workflow` fence) for each run it launched: one line, the run id then a plain summary (` ```workflow` / `wf_… · T3 · 5 agents · ISA 41/60` / ` ``` `). The terminal swaps it for the live coloured card, and other channels show the line.

## Tools

Three tools in `Tools/`: `Inventory.ts` (the repo's surface list, and `sync` against an ISA), `IsaCheck.ts` (`bar`, `write-probes`, `acceptance`, `conform` and `stamp`, the one writer of an ISA's `checkup:` and `isa_format:` keys) and `Checkup.ts` (Checkup's evidence bundle). Each intent's Tool contract carries the commands it runs; every flag, output and exit code is in `References/Tools.md`.

## Gotchas

- **The Workflow tool needs the user's own opt-in; this skill does not supply it.** The harness allows Workflow only under ultracode or the user's own words. Tiers 3 to 5 launch a Workflow only after the user has opted in during that session (ultracode, `dw`, or asking for a workflow in words). Without that opt-in the run stays inline at tier 2 and says so in the tier line.
- **Heavy process is not rigor; the rigor lives in the criteria and their evals.** ISAClimb (retired 2026-10-05) was slow to reach first code on every run. Sizing each script to the requested work (§ Execution) is the guard; the incidents and the shape scoreboard are in `References/Sizing.md`.
- **Subagents can't commit or push.** Their Bash runs inside a Seatbelt profile that refuses writes to the private trees' `.git`. Agents hand results back; the main session ticks criteria, commits and ships.
- **Test Strategy commands run from the ISA's folder** unless the ISA's frontmatter says `probe_cwd: config-root`. Relative paths in probes resolve against that folder.
- **The inventory sees only some surface kinds, and sync catches missing criteria, not weak ones.** Its uncovered list needs criteria found by hand (2026-09-24: `case` labels read as fake commands); what it sees and how sync counts coverage are in `References/Inventory.md`.

## Examples

User: "Build a CLI for my recipes" → Build intent → the repo's ISA holds atomic criteria with evals at the cheapest honest tier, they pass under Test, and acceptance passed against the reference the principal approved.

User: "Is the code in sync with the ISA?" → Test intent → a four-part report: well formed, sync with the surface kinds the inventory cannot see, every criterion's result at its Assay tier, and the read.

User: "Why are so many ISCs red on <app>?" → Checkup intent → every red criterion has a cause (code, row, no-eval, unrecorded, environment, obsolete) and its repair, uncovered complaints became criteria, and the ISA status shows red before and after.

User: "Fix the login bug in the app" → Modify intent → the ISA gained the criterion whose eval would have caught the bug, that eval was seen failing then passing, and the fast tier passed across the ISA.
