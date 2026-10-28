# Elevate

The Superior pass for the task in front of us, delivered in the Output format below.

## Ideal State

- The scope line (`Scope: <inferred scope>, from <what was asked>, because <reason>.`) names the proper scope of SKILL.md § Scope Comes First and existed before the scope map; the real goal and the real constraints existed before any approach was written.
- An ask with two plausible scopes that would give different answers, or an inferred scope still too small for the pass to earn anything, had its scope settled by the scope interview before mapping when a principal could be asked, or carries the Inputs flag line when none could; an ask whose scope was clear ran with no interview.
- A caller that fixed the scope or the length ("scope is fixed, no interview", "one paragraph, inline", "read-only, inline, brief") gets exactly that: no interview, the caller's scope in the scope line, and an answer at the requested length that still carries the superior approach, the material gaps with their verdicts, and what changes.
- The scope map covers all of the inferred scope, not a sample of it, from tool evidence (its components, entry points, data flow, boundaries, scale and dependencies, plus the goal it serves), and every later row traces back to something on it.
- The superior approach is concrete: what that mind would actually do, from first move to finished, specific enough to execute, and it does not read as our plan with stronger adjectives.
- The gap table holds every material difference between its approach and ours, each row tagged with which of our limits caused it (missing knowledge, inherited convention, invented constraint, framing, effort budget, or tooling habit) and carrying a verdict: adopt now, adopt in part, or blocked by a named real limit.
- Every knowledge gap became a lookup we can run now.
- The changed plan says what we will now do differently, or gives an explicit finding that our approach survived the comparison and why.
- In full mode the superior approach came from a fresh agent briefed blind, with the goal, the scope map, the sources behind every figure and the real constraints, never our current plan, draft, or preferred option.
- Adopted gaps that touch an ISA land in its criteria or `## Decisions` in the same turn; when the caller is read-only (an analysis that recommends and never edits), they come back as recommended ISA edits instead.

## Anti-criteria

- "We can't, because we're not that smart" is never a verdict; the nearest executable version is found instead.
- No gap ends without an executable change or a named real limit: an approach that needs omniscience or resources nobody has is never handed over unconverted.
- A constraint the principal actually set (a budget, a security gate, a stated preference or a permission boundary) is never dropped, even if a superior mind would not have chosen it; only imagined limits are.
- The scope is never defaulted: neither the literal file or function named, nor "the whole system" unless the ask points there.
- No silent scope change: a superior approach that changes what is being built goes to the principal as a direction question before anyone builds it.

## Inputs

- **Scope interview:** up to three questions, asked one at a time, each offering the inferred scope as the default with a `proceed` override.
- **Scope map evidence:** read the code, docs, ISA and configs; for a large scope, fan out `Explore` agents across its parts.
- **No principal to ask (headless, inside another skill or agent):** take the best inferred scope and flag it in one line (`⚠️ Scoped to Y from the ask X because R; redirect if wrong`).
- Goal or a constraint still missing and it would change the answer: ask; otherwise flag the assumption and continue.

## Tool contract

### Modes

| Mode | When | Shape |
|------|------|-------|
| **light** | default; inline lens during a run | One pass by me. Write the superior approach before rereading our current plan, then diff. |
| **full** | the principal asks for depth, the task is max-effort, or our plan already exists and anchoring is likely | A fresh agent produces the superior approach blind; I build the gap table and changed plan. |

### Full-mode brief (tool-contract)

Dispatch one fresh-context agent on the top Anthropic lane (`Agent`, subagent_type `Opus`, AUDIT mode, read-only). The brief carries:

- the task and the real goal behind it,
- the scope map and the sources behind it (paths, docs, figures with where they came from), with the instruction to survey that scope itself before proposing anything,
- the hard constraints: physics, and every constraint the principal actually set,
- the Superior Mind definition from SKILL.md, verbatim,
- the instruction to return only the superior approach, concrete from first move to finished, plus what that mind knows that a typical practitioner would not.

The brief never carries our current plan, draft, or preferred option. That omission is the reason full mode exists.

For a cross-vendor read on max-level work, a second blind brief goes to `Astra` in AUDIT mode; differences between the two superior approaches are themselves gaps worth tabling.

## Output format

```markdown
## Superior: [task]

**Real goal:** [the outcome behind the request, one sentence]

**Scope:** [inferred scope], from [what was asked], because [reason]

### Scope map
[components, boundaries, data flow, scale, dependencies, and the goal, each from evidence]

### The superior approach
[concrete approach, first move to finished]

### Gap table
| Superior mind does | We were going to | Our limit | Verdict |
|---|---|---|---|
| ... | ... | knowledge / convention / invented constraint / framing / effort / habit | adopt / partial / blocked: [real limit] |

### Changed plan
[what we now do differently, or why ours held]

**Biggest lift:** [the one gap that matters most, one sentence]
```

When the caller set the length, the answer fits it: an inline paragraph drops the headings and the printed scope map but keeps the scope line, the superior approach, the material gaps with verdicts, and the changed plan.
