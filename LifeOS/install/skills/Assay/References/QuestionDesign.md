# Question Design

**Contents:** What the engine is · Does the judgment layer fit · Deterministic first · Extract field, code fact or question · Choosing the primitive · Writing a question · Designing the state · The layers · One call or two · Composing the answers · Thresholds by consequence · Escalation · Proving the decomposition · Cases · Iteration · Calibration toward enforce · Review checklist

This is the doctrine a designer reads before turning a decision into the judgment layer judgments. The artifact it produces is a question-system file whose shape is defined in `LIFEOS/ASSAY/QuestionSystem.ts`; the run that produces it is `Intents/CreateQuestions.md`.

Every rule links its source. A rule marked *(ours)* is derived here rather than stated by a source, and the sentence after it says why.

The linked sources are TypeSafe's published documentation of the System One question format, which the judgment layer's current engine answers as well. Claims about how a model behaves, such as speed and the "jaggedness" list, were measured on Jev 1.13, the engine retired 2026-10-10, and have not been re-measured on the current engine. Treat them as the starting expectation and let the design-time run decide. Every "jaggedness" link below is that measurement page.

[jaggedness]: https://docs.typesafe.ai/model-jaggedness/jev-1.13 "Jev 1.13 jaggedness (engine retired 2026-10-10)"

## What the engine is

- It answers typed questions about one state with probabilities: a noul returns P(yes), a choice a distribution over the options you wrote, a score a distribution over ordered levels plus the expected position ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).
- It reads text, and it also reads images, audio and video attached beside the state (`media`; `LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Engine). A question about media is written the same way, and the case set for it carries the media.
- Questions in one call are answered independently and in parallel, and no answer becomes context for another. A question can never depend on another question's answer, so composition always happens in code ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).
- A call takes a fraction of a second (measure the median on your own machine; a text question is typically a few hundred milliseconds), and adding questions to it barely changes the time ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one), [fan-out](https://docs.typesafe.ai/patterns/fan-out)). The SDE cascade cookbook lists input tokens as the only billed tokens, so a call costs roughly the state plus the text of every question in it ([SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)).
- It reads literally, cannot count, do arithmetic or compare dates, loses accuracy on indirection and on irrelevant state, does not treat state as hostile, and keeps no arithmetic identities between separate questions ([jaggedness][jaggedness]).
- Question ids are never sent to it. Choice option names and every description are ([noul](https://docs.typesafe.ai/primitives/noul), [choice](https://docs.typesafe.ai/primitives/choice)).
- It writes no text and does no work. Anything that needs prose, a reason, or an action goes to a model (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Anti-doctrine).

## Does the judgment layer fit

Decide fit before designing anything. The artifact records it as `fit.verdict` (`glance`, `partial`, `not-glance`) with a reason, and a `not-glance` system carries no stages. A v2 system also lists in `fit.tiers` which of the four tiers it uses (code, extract, decide, write), and it uses only the tiers the task needs (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Pipelines).

| When the decision… | The right tool | Why |
|---|---|---|
| can be settled from facts code already has: a lookup, a list, a count, a date, a pattern | code | Code is exact and free, and an unearned judgment only flags and an earned confident no fails, but neither replaces a deterministic gate (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Anti-doctrine) |
| needs a value from an open answer space: an amount, a date, a name, an order number, a list, an estimate | an extract field (Clairic) | Clef cannot list every possible value as an option; Clairic returns the value itself, with a span for copied text (§ Extract field, code fact or question) |
| needs a written reason or a draft | the write step (an LLM through `Inference.ts`) | Neither engine generates text ([jaggedness § Generation][jaggedness]) |
| needs several hops of reasoning, arithmetic over the text, or knowledge that is not in the state | a reasoning model, or code that reduces it first | Indirection and math are the engine's weakest edges, and current facts should come from your data rather than model weights ([jaggedness][jaggedness], [how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)) |
| is the principal's taste or values, with no labels yet | the principal | A check sits at the lowest tier that can honestly answer it, and taste stays human until labels move it down (`skills/Assay/SKILL.md` § Choosing a check) |
| is a reading of text or state a careful person makes in a second, over many items | the judgment layer (`glance` verdict) | This is the shape the engine is built for |

The judgment layer often fits part of a decision: the gate, or the easy majority, with the rest escalated. That is `partial`, and the reason says which part.

A volume test belongs in every fit verdict *(ours)*. A system leaves shadow only when real outcomes supply labels, so estimate the days to reach the tune floors: positives needed divided by daily volume times the expected positive rate. At 200 items a day and 5% positives, 30 positives take about three days; at five items a week and 10% positives they take over a year. The floors are in `LIFEOS/ASSAY/Report.ts` (`tuneBlockedBy`). A decision that will never reach them can still use the judgment layer advisorily, to rank or to suggest, and the fit reason says so. Nothing in the sources connects volume to time-to-enforce, and without this estimate a design can look finished while having no path out of shadow.

## Deterministic first

Everything code can decide exactly is layer zero. Deny lists, zone lists, path matches and asserts never consult a model (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Anti-doctrine), and deterministic work stays in code because it is reliable and cheap ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).

These go to code:

- membership in a known list (known senders, allowlists, denylists, VIPs)
- counting of anything a pattern or parser can find; to count items that need judging, ask one noul per item and add the answers in code ([jaggedness § Counting][jaggedness])
- arithmetic and numeric comparison, and numeric representations such as hex colors, which code converts to a named bucket first ([jaggedness § Numeric representations][jaggedness])
- date ordering, durations and windows; extracting a date from text is an extract field of type `date`, and everything after extraction is code ([jaggedness § Date and time][jaggedness])
- parsing: headers, domains, URLs, attachment types, thread position
- anything that must never be wrong

A fact enters the engine's state as a named value or bucket, never as raw numbers to compare. `reply_age: "over a week"` works; two timestamps do not ([jaggedness][jaggedness]).

A fact that decides outright sits in a policy rule ahead of any judgment, and a fact that only sometimes matters stays a policy condition rather than state *(ours)*. Every fact left for the engine to rediscover is a question it can get wrong for no reason, and the report's decided-by-deterministic count shows how much traffic never needed a judgment at all.

## Extract field, code fact or question

A design sorts every need it has into one of three places *(ours)*. The test is what the answer looks like.

| The answer is… | It goes to | Example |
|---|---|---|
| already in a field code can read, or computable from one | a code fact (`deterministic`) | the sender domain, the thread length, a known-VIP flag |
| a value written in the state, or computed from values written there, from an open answer space | an extract field (`extract`) | the budget in a sponsor email, the issue count, the total with tax, days since delivery |
| a judgment among outcomes you can list | a question (`stages`) | real sponsor or disguised pitch, fit with the audience, urgency |

An extract field turns open text into facts, so the arithmetic and comparisons that follow are code, never a question: extract the budget and the issue count, divide them in a `derive` fact, then compare it with the floor in a policy rule. Ask Clef only for what is still a judgment after extraction. Text values are checked against their span in code and come back null when they do not match, so a policy reads a missing or unverified value as unknown, never as zero. A field that only feeds the write step still belongs in `extract` when the write step would otherwise have to find it itself, because a value handed to the writer cannot be invented by it.

Each tier must earn its place against the LLM-only baseline (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Pipelines): a design that adds Clairic and Clef in front of an LLM but does no better on the holdout, at no lower latency or tokens, ships as the LLM call alone.

## Choosing the primitive

The question type is what separates the shapes, and each becomes a different piece of code (`skills/Assay/SKILL.md` § Choosing a check):

| The question | Primitive | What the code does with it |
|---|---|---|
| Is this true? | noul | an `if` |
| Which of these? (an unordered set) | choice | a `switch` |
| How much? (an ordered ladder) | score | a sort, or a threshold |

- A noul is not a scale. P("strong in Python") is how likely the proposition is, not how strong the candidate is, so a question about degree is a score ([noul](https://docs.typesafe.ai/primitives/noul)).
- A choice is relative and a noul is absolute. A choice spreads probability over the options it was given and names the best of them even when none applies, while nouls per option can all be low ([jaggedness § Common-sense structural invariants][jaggedness]). "Does anything apply" is a noul gate and "which one" is a choice route; many systems need both.
- Critical, high, medium and low form a ladder and can be sorted. Korean, Mexican and Thai cannot, so a question over them is a choice (`skills/Assay/SKILL.md` § Choosing a check).
- Two outcomes with no in-between are a noul ([score § Writing good levels](https://docs.typesafe.ai/primitives/score)). `validate` refuses a score with fewer than three levels.
- Extraction from a bounded answer space is a choice with a "not stated" option, never a request for the value ([jaggedness § Generation][jaggedness]).
- A threshold tuned on a noul never carries over to a choice asking the same thing ([jaggedness][jaggedness]).

## Writing a question

- Ask one proposition. "Is the customer angry and asking for a refund?" is two nouls combined in code ([noul](https://docs.typesafe.ai/primitives/noul)).
- Phrase it so a high value means yes. A negated question inverts the meaning for the code that reads it later ([noul](https://docs.typesafe.ai/primitives/noul)), and double negatives cost accuracy ([jaggedness § Indirection][jaggedness]).
- When a question exists to catch a mistake, ask about the mistake ("Is this value absent from the source?"), so the costly case is `true` and an any-flag rule reads naturally ([SDE cascade § Appendix A](https://docs.typesafe.ai/cookbooks/sde_cascade)).
- Make the boundary sharp. "Any" leaves no middle ground, and boundary cases go in the criteria ([noul](https://docs.typesafe.ai/primitives/noul), [jaggedness § Literal reading][jaggedness]).
- Put the whole meaning in the instructions. The id `requests_credentials` never reaches the engine, so the sentence must say everything ([noul](https://docs.typesafe.ai/primitives/noul)). Option names do reach it, so name options with words, not codes ([choice](https://docs.typesafe.ai/primitives/choice)).
- Point at the state by backticked path, such as `message.subject`, so the question reads exactly the field meant ([how to build § Use structure in the input state](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).
- Add criteria only when they measurably help: try the question with and without them on dev and keep the better one ([noul](https://docs.typesafe.ai/primitives/noul)). Instructions and criteria must agree; a `true` description that means no confuses the engine ([jaggedness § Contradictory instructions][jaggedness]).
- When part of a question comes from code (a record, a policy, a taxonomy node), give it its own field in structured instructions and refer to it by name instead of splicing it into the sentence ([how to build § Use structure in the questions](https://docs.typesafe.ai/concepts/how-to-build-with-system-one), [advanced](https://docs.typesafe.ai/primitives/advanced)).
- Give confusable choice options contrastive objects with the same field names on each, such as `what`, `not_for` and `examples` ([choice](https://docs.typesafe.ai/primitives/choice), [advanced](https://docs.typesafe.ai/primitives/advanced)).
- Every choice carries a no-match option, a `null` description or an explicit "none of these" ([choice](https://docs.typesafe.ai/primitives/choice)). The contract refuses a choice without one.
- Score levels describe concrete situations, not degrees: "broken, but a workaround exists", never "moderately severe". Each level is judged on its own and the engine never sees a level's number or its neighbours, so "worse than the previous level" means nothing ([score](https://docs.typesafe.ai/primitives/score)).
- Keep a score to one dimension, and give a rare extreme that you act on differently its own level ([score](https://docs.typesafe.ai/primitives/score)). A score takes at most ten levels; eleven returns a server error ([autoresearch](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)).
- Examples in criteria steer hard and only help when they look like real inputs, and higher confidence after adding one does not show the answer got more correct ([score § Structured level descriptions](https://docs.typesafe.ai/primitives/score)). Never copy a dev case into criteria examples *(ours)*. It turns the dev split into a memory test, and the dev number stops predicting holdout.
- Never ask a proposition and its negation and combine them. On one ticket P(refund) was 0.72 and P(not refund) 0.47, a sum of 1.19 ([jaggedness § Common-sense structural invariants][jaggedness]).
- When a wrong answer makes you explain what you meant, that explanation is the missing half of the instruction ([jaggedness § Literal reading][jaggedness]).
- A candidate question can be screened before any case runs by making the question text itself the state and asking nouls about it: whether the named fields can answer it, whether it means one thing under its criteria, whether it will vary across inputs ([autoresearch § Next steps](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)). `Assay.ts ask --caller question-design` does this in one call.
- Inputs outside the engine's primary language are accepted at lower accuracy ([state](https://docs.typesafe.ai/concepts/state)). If the decision will see them, the case set carries them, and a language fact may route them to escalation.

## Designing the state

- Send the minimum. State is the material you would hand a panel of experts, limited to what the questions need; unrelated detail distracts the engine and hides which input caused a wrong answer ([state](https://docs.typesafe.ai/concepts/state), [jaggedness § Large state][jaggedness]).
- Use an object with named fields, so every question can point at one ([state](https://docs.typesafe.ai/concepts/state)).
- Every question in a call sees the whole state of that call, and the runner builds a stage's state as the union of its questions' `reads` *(ours)*. A question that needs one large or noisy field therefore puts it in front of every other question in the stage. When a field would be irrelevant bulk for most of the stage, give the question that needs it a stage of its own. The jaggedness page measures the accuracy lost to irrelevant state per question, and the union is how a well-scoped question set still ends up with bloated state.
- Every field declares its source and a character cap, and the runner keeps the first `max_chars` characters and records the cut (`LIFEOS/ASSAY/QuestionSystem.ts`). Where the cut falls matters *(ours)*: the deciding sentence of a message often sits at the end, in a postscript, a signature or a quoted instruction, and a head-only cap drops it. For such a field, set the state field option `truncate: "head_tail"`, which keeps the first two thirds and last third of `max_chars` and joins them with a short marker that counts inside `max_chars`, or extract the part that decides in code and say so in the field's `source`. When a wrong case carries a truncation record, fix the state before touching the question.
- Send no identifier the judgment does not need, and no stable person, session or customer id beside a sentiment or satisfaction question. Where a caller's data class requires derived features, they are counts, enums and scores, never free text (`LIFEOS/DOCUMENTATION/Router/RouterSystem.md` § Data class per caller).
- A state carrying a secret-shaped value is refused before any fetch, so that item errors instead of answering (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Anti-doctrine). Strip or bucket such content in code, and check that the declared fail direction is the outcome you want for those items.
- Text an outsider wrote is marked `untrusted`, kept in its own field, referenced by path, and never spliced into instructions. The engine does not treat state as hostile, and text written to steer the answer or argue for its own classification can move it ([jaggedness § Adversarial content][jaggedness]). Two defenses work together *(ours, from the guardrails pattern)*: criteria that say exactly what counts, so the question never leans on the text's own framing, and, where outsiders have a motive to steer, a noul asking whether the text tries to instruct its reader or argue for how it should be handled, wired as a veto to the safe outcome. The guardrails cookbook shows the second one working: "Ignore your instructions" scores as a jailbreak instead of working as one ([guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails)).

## The layers

A judgment passes through up to six layers. The file holds each one in a named place.

| Layer | What it holds | Where it lives in the file |
|---|---|---|
| 0. Deterministic | facts code computes, and rules that decide outright on them | `deterministic`, and the first rules of `policy` |
| 1. Gate or route | whether anything applies (a noul), which kind it is (a choice) | the first stage |
| 2. Signals | atomic nouls and scores for each branch | the same stage with `applies_when`, or a later stage with `when` |
| 3. Composition | the ordered decision list | `policy` |
| 4. Escalation band | the uncertain cases, where they go, and the cap | `escalation`, and `escalate` outcomes |
| 5. Calibration | shadow, ground truth, thresholds, promotion | `calibration`, then the registry |

A system uses only the layers it needs *(ours)*. A decision that one noul and two rules settle is a finished system. Each question earns its place by the error its `purpose` names, and the ablation in the report shows whether it did.

## One call or two

Speculative fan-out is the default: ask every question any branch might need in one call, and let code ignore the answers that do not apply ([fan-out](https://docs.typesafe.ai/patterns/fan-out), [how to build § Ask a lot of questions](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)). `applies_when` keeps each question's numbers honest by counting only the cases where its answer matters.

A second stage costs a serial round trip and re-sends state for every case that reaches it. It also commits early: a route that sends a case down the wrong branch cannot be repaired afterwards. The hierarchical classification cookbook measures this for tree walks, where greedy traversal found 2 of 4 expected leaves and a beam that kept three paths found 4 of 4 ([hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification)).

A second stage is warranted when one of these holds:

- The branch needs state the gate does not, such as a retrieved policy, a taxonomy subtree, or a large field (the union rule above).
- The arithmetic favors it at the declared volume *(ours)*. With state S, gate question text G, branch question text B, branch state S′ and a fraction r of cases routed, one call costs S + G + B per case and two cost S + G + r(S′ + B). Staging pays when B(1 − r) > rS′, which means few cases route and the branch question text is large next to the state it re-sends.
- Code must compute something from a first-stage answer before the next judgment, such as a date part extracted by a choice and then compared. Facts in the artifact are computed before the run, so this chain needs the consumer's code between stages, and the design says so.

When a route is often close, keep the branches in the first stage, or gate the later stage on shares. The `{ q, option, p_gte }` leaf runs a branch for every case whose share for that option clears p, whichever option is the top pick, which is the beam-style walk *(ours)*. A `choice` condition tests only the top pick, so a staged branch behind it runs for one option per case. That is the greedy failure the beam search exists to avoid, and it applies only to `choice` conditions.

A question in a stage that did not run reads `unasked`, and a weighted term over an unasked question contributes 0 (`LIFEOS/ASSAY/QuestionSystem.ts`). A weighted rule that mixes stages must be guarded by the later stage's condition *(ours)*, or cases that never reached that stage score low without anyone deciding they should.

## Composing the answers

The policy is an ordered decision list per decision: the first matching rule wins, and the decision's default applies when none does (`LIFEOS/ASSAY/QuestionSystem.ts`). The combination always happens in code ([how to build § Combine question outputs in code](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).

Order the rules as hard deterministic outcomes, then vetoes, then the rules for an uncertain answer on any question that decides (escalate, or the favored outcome), then positive rules, then weighted rules *(ours)*. First match wins, so a veto placed after a positive rule never fires on the cases that rule already took. `rule_hits` in the report counts how often each rule decided a case, and such a shadowed rule shows a count of zero.

One exception to that order: when every rule of a decision resolves to the same outcome, order changes only which rule gets the credit. The doubt rule then goes last, so the positive rules keep their credit in `rule_hits` and in the decided-by counts.

Independent red flags combine as any-flag, so one confident flag decides. In the condition language that is `any` over `is: "yes"` conditions. The SDE cascade gates this way so "one confident red flag is enough instead of being averaged into silence" ([SDE cascade § Step 4](https://docs.typesafe.ai/cookbooks/sde_cascade)).

The vendor's own worked example shows what averaging does *(ours, from its numbers)*. Its spam risk is 0.45 × credentials + 0.30 × identity mismatch + 0.25 × unexpected reward, reviewed between 0.4 and 0.6 and quarantined at 0.6 ([how to build § Putting it all together](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)). A message that certainly asks for a password and shows neither other sign scores 0.45 and goes to review, so the most heavily weighted sign can never quarantine a message on its own.

Any-flag has its own cost *(ours)*: false alarms add up. If N flags each misfire independently on a fraction f of clean items, the rule fires on about 1 − (1 − f)^N of them, so eight flags at 2% flag about 15% of clean traffic. Keep vetoes few and precise, judge them by the rule's end-to-end false-alarm rate rather than each flag's own, and cut a flag whose ablation shows it only adds false alarms.

Weighted terms are for compensating preferences, where strength on one dimension may make up for weakness on another, as in ranking candidates ([composite scoring](https://docs.typesafe.ai/patterns/composite-scoring), [score § Splitting a complex judgment](https://docs.typesafe.ai/primitives/score)). Scores are normalized to 0–1 by dividing by the top level so the weights mean what they say ([score](https://docs.typesafe.ai/primitives/score)); the contract does this for you. Two questions that correlate at 0.9 or more measure the same thing and double-count in a weighted sum, so keep the clearer one ([autoresearch § Next steps](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)).

A pick or position under its threshold matches no `choice` or `score_gte`/`score_lte` condition, so the case falls through to later rules and eventually the default (`LIFEOS/ASSAY/QuestionSystem.ts`). Before any rule that reads a pick or position, write the rule for `is: "uncertain"` on that question *(ours)*, so the design, not rule order, decides where a low-confidence answer goes.

The default outcome is what the system does when it knows nothing *(ours)*. Choose the outcome whose error is cheaper under ignorance. That is also what the call site's fail-open or fail-closed setting should produce, since every caller must still finish when the engine is disabled (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § The caller contract).

The baseline question is asked in the same call and never read by policy (`LIFEOS/ASSAY/QuestionSystem.ts`).

## Thresholds by consequence

A judgment-layer threshold is a confidence floor. For a noul it is two-sided and falls between 0.5 and 1; for a choice the floor is 1/options and for a score it is 1/levels, since confidence cannot fall below that. A noul is yes when p ≥ t, no when p ≤ 1 − t, and uncertain in between; a choice or score is uncertain when its confidence is under t (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § The loop; `LIFEOS/ASSAY/QuestionSystem.ts`, `Threshold`). The band between 1 − t and t is the natural escalation band. A noul's confidence is never below 0.5, so a noul threshold under 0.5 would mean nothing is ever uncertain, and the contract refuses it. A choice or score threshold under its own floor has the same effect.

The vendor advice translates *(ours)*. The noul docs say to raise the threshold when a false yes is expensive, lower it when a missed yes is expensive, and send the middle to a person ([noul](https://docs.typesafe.ai/primitives/noul)). A two-sided threshold cannot go lower than 0.5, so the favored error is expressed in the policy, by where `uncertain` goes:

| The decision favors | The rule that acts | Raising t |
|---|---|---|
| precision (a wrong act is costly) | `is: "yes"` | fewer, surer acts; more cases fall to no or escalation |
| recall (a missed act is costly) | `{ not: { q, is: "no" } }`, acting on yes and uncertain | fewer confident no's, so more acts |
| balanced | yes acts, no does not, `is: "uncertain"` escalates | a wider escalation band |

Each threshold names the error it favors and why, traced to the decision's declared costs (`LIFEOS/ASSAY/QuestionSystem.ts`, `costs` and `Threshold`).

The guardrails cookbook arrives at the same band from the other side: each hazard noul there has a review threshold and a higher action threshold, 0.35 and 0.70 under its strict policy ([guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails)). A single two-sided threshold of 0.7 gives nearly that pair (no at 0.3 or below, yes at 0.7 or above), with review as the uncertain band *(ours)*.

Riskier outcomes need more evidence than routine ones, even within one system ([confidence § Thresholds scale with risk](https://docs.typesafe.ai/confidence), [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)). With one threshold per question, give the risky outcome a rule that also requires a second signal, or a single-term weighted rule on that option's probability. Such numbers live in the system file and never in consuming code.

What `decide()` compares is specific to the type, as verified in `LIFEOS/ASSAY/Assay.ts` on 2026-09-28: for a noul the two-sided confidence, for a choice the chosen option's probability, for a score the answer's `confidence`. The vendor's `confidence` on a choice is a statistic of the spread and can differ a lot from the chosen probability: their five-question example picks `returns` at probability 0.61 with confidence 0.42 ([choice](https://docs.typesafe.ai/primitives/choice)). Thresholds read off vendor examples do not carry over.

A score condition reads the expected position, which can fall between levels and can hide a split: 1.0 may be all probability on level 1 or half on each of levels 0 and 2 ([score](https://docs.typesafe.ai/primitives/score)). Read a score condition together with its confidence, and never interpolate a magnitude between levels ([jaggedness § Math using score][jaggedness]).

Design-time thresholds are provisional. Start conservative ([confidence](https://docs.typesafe.ai/confidence)), test them against accuracy on your data ([how to build § Route on uncertainty](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)), and take the middle of the widest plateau of best score rather than a knife edge that wins by one case, which is the rule `Assay.ts tune` applies (`LIFEOS/ASSAY/Assay.ts`, `plateauMidpoint`). Judge by balanced accuracy, never raw agreement: on a ledger with a handful of positives in hundreds of rows, a threshold nothing clears scores over 99% agreement (`LIFEOS/ASSAY/Assay.ts`, `recommendBalanced`). The registry row is emitted uncalibrated, and once registered the registry is the only home of a threshold (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § The caller contract).

## Escalation

The uncertain band goes somewhere on purpose: a model judge, a reasoning model, a person, or nowhere, in which case uncertain resolves to the favored outcome ([how to build § Route on uncertainty](https://docs.typesafe.ai/concepts/how-to-build-with-system-one), [confidence § Three paths](https://docs.typesafe.ai/confidence)). `escalation.to` names the target and `max_rate` caps it.

Derive the cap from capacity *(ours)*. For a person it is the number of items they will really review in a day divided by daily volume; for a model it is the budget left after the judgment-layer calls divided by the cost of one escalation. A measured escalation rate over the cap means the questions do not separate in that band. Add or sharpen the question that would settle it, rather than narrowing the band until confident mistakes appear. The report computes accuracy on the cases it did not escalate (`LIFEOS/ASSAY/QuestionSystem.ts`), so escalating the hard cases raises accuracy by construction; read accuracy and escalation rate together, with the cap as the limit.

The SDE cascade shows the payoff: the cheap path handles the easy items, only flagged items pay for the expensive model, and sweeping the gate gives a cost-quality frontier above every single model ([SDE cascade § Step 6](https://docs.typesafe.ai/cookbooks/sde_cascade)).

Escalation outcomes are labels, but biased ones *(ours)*. They cover only the uncertain band, so they can place the band's edges and say nothing about confident mistakes. Keep a small random audit of confident answers going to the same target, as the enforce-mode eval judge does by sending one confident answer in ten to the model judge (`LIFEOS/DOCUMENTATION/Router/RouterSystem.md` § Data class per caller, `eval-judge`).

## Proving the decomposition

A decomposition claims that several small questions beat one big one. The report tests the claim on the cases.

- The baseline is one holistic question per decision, asked in the same call and never used by policy, and the report states the composed decision's margin over it (`LIFEOS/ASSAY/QuestionSystem.ts`). It states two margins: the all-scored margin, over every scored case, and the judged-only margin (`baseline.judged`), over the cases a judgment decided rather than a deterministic rule. Rules that code settles make the all-scored margin look better than the questions earned, so only the judged-only margin decides whether to ship the baseline alone. The vendor cookbooks show the usual result: per-field flags fired at 0.95 and 0.85 where the holistic head said 0.56 ([SDE cascade § Step 3](https://docs.typesafe.ai/cookbooks/sde_cascade)), and asking for a score directly reached a held-out error of 2.15 where discovered questions reached 1.77 ([autoresearch](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)). If the composed system does not beat the baseline on the judged-only holdout margin, ship the baseline question alone *(ours)*, because it costs less and the cases found it no worse.
- Drop-one ablation from the cached answers flags a question whose removal does not lower accuracy. Before cutting it, look at the cases it exists for *(ours)*. A question built for a rare, costly error shows no ablation effect on a case set with few such cases, the way a question that applies to one row in ten looks useless in a 60-note sample and is still the most useful column ([autoresearch § The method](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)). Add cases for that error, or keep the question and say why in its `purpose`.
- Pairs that correlate at 0.9 or more keep the clearer question ([autoresearch § Next steps](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)).
- Read twins as pairs *(ours, generalized from the mutation probe in `LIFEOS/DOCUMENTATION/Router/RouterSystem.md` § Data class per caller, `isc-tier-shadow`)*. Two look-alike cases that differ only on the deciding fact are right only when both are right, and a question whose answer barely moves between twins is not reading the fact it was written for. The report lists every wrong case with its answers; check each wrong twin against its partner.
- The decided-by counts (deterministic, judgment, escalation, default) show where traffic ends up. A large default share means the rules do not cover the traffic.

## Cases

- An agent that never sees the design writes them from the problem statement alone and labels each with the expected decision. `escalate` is a legitimate label when a careful person could not decide from the input either (`LIFEOS/ASSAY/QuestionSystem.ts`, `Case`).
- Every outcome of every decision needs enough cases on its side, because balanced accuracy is undefined when a class is missing (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Artifact labels from Bunker). The intent sets the floors.
- Twins share a split *(ours, from grouped splits in [autoresearch § Next steps](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery))*. With one twin in dev and its partner in holdout, iterating on dev tunes the holdout answer.
- Injection cases push toward the costly error *(ours)*. A promotional message insisting it is urgent tests the question; one that politely asks to be ignored tests nothing.
- Every case is synthesized, with no real personal data and no secret values, and each question is labelled on its own rather than all questions sharing one scalar that only reproduces the existing gate's blind spots (`LIFEOS/ASSAY/fixtures/README.md`).
- Per-question labels are optional and come from a labeller who never saw the engine's answers (`LIFEOS/ASSAY/QuestionSystem.ts`, `Case.labels`). They separate a wrong question from a wrong policy.

## Iteration

- Iteration reads dev only, and the final number comes from holdout, read once ([autoresearch § The method](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)). A holdout that was read and then iterated on is spent; fresh cases come from the case author.
- The moves are: rewrite (the literal reading missed the meaning), split (one question judged two things), move to code (the engine was asked to count, compute, compare or look up), cut (ablation shows nothing lost and no rare case needs it), add (a wrong case had no question that could have caught it), and criteria on or off. Each move names the dev cases behind it.
- Keep a change only when the dev number improves ([autoresearch § The autoresearch loop](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)). Most of the gain comes from the first design: one proposal reached 1.87 and four more rounds reached 1.77 ([autoresearch](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)). Rounds are therefore few, and a plateau ends them.
- A miss becomes one more question and one kept case, never a longer prompt (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § The miss loop).

## Calibration toward enforce

Design-time numbers never promote anything. The cases are synthesized and labelled by an agent, which makes them proxy evidence: visible in measurement, never earned (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Artifact labels from Bunker). The system reaches production in shadow, where no verdict acts and every answer is logged beside what actually happened (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § The loop).

- Ground truth must not depend on the consumer's own action *(ours, extending the rule for corrective callers in `LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Anti-doctrine)*. Once code acts on a verdict, the outcome it later observes was shaped by that action. A message that was never surfaced is never answered, so "no reply" cannot label it unimportant. Name a signal that exists whether or not the system acted: a principal-attested label, a later explicit action by the principal, or an independent lane.
- Labels earn calibration only when the principal attested them, directly or by delegation; model and deterministic labels stay proxy (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Artifact labels from Bunker).
- The floors, as read on 2026-09-28 (read live values before relying on them): `Assay.ts status` flags any enforced question with fewer samples than its `min_labels` (per question, else the registry default) or with a ground-truth source that is not principal-attested (`LIFEOS/ASSAY/Assay.ts`, `statusPolicyFindings`), and for glance rows only noul labels count toward that floor (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Artifact labels from Bunker); `tune` blocks under 200 matched rows, under 30 positives, on no separation between classes, on balanced accuracy under the caller's `enforce_bar`, and on a model mismatch (`LIFEOS/ASSAY/Assay.ts`, `tuneBlockedBy`); enforce needs a registry row with the agreement, date and model, and reverts to shadow when the engine's model changes (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § The loop).
- After enforce, keep a sample of confident answers flowing to the independent source so agreement stays measurable (`LIFEOS/DOCUMENTATION/Router/RouterSystem.md` § Data class per caller, `eval-judge`).
- The case set becomes the system's regression suite *(ours)*. Rerun it when the engine's model changes, since a model change reverts enforce anyway, and the report records the model and a hash per question so runs compare.

## Review checklist

The designer's red-team pass and the second opinion look for these.

| Smell | Fix |
|---|---|
| The engine is asked to count, add, compare dates, or look something up | Move it to code |
| "and" or "or" joins two conditions in a noul | Split it |
| A negated noul, or a noul and its negation both asked | Phrase it affirmatively and ask it once |
| A choice with no no-match option, or a choice standing in for "does anything apply" | Add the no-match option; add a noul gate |
| Score levels that say "more", "worse", or carry numbers | Rewrite them as situations |
| Instructions that only make sense next to the question id | Put the meaning in the text |
| Veto signals averaged in a weighted sum | An any-flag rule |
| A rule reads a pick or position with no uncertain rule before it | Add the uncertain rule |
| A weighted rule mixes stages without a guard | Guard it with the later stage's condition |
| Outsider text in instructions, or not marked `untrusted` | Isolate and mark it; tighten criteria; add a steering noul |
| One question's large field shared with a whole stage | Give that question its own stage |
| A head-only cap on a field whose deciding part can sit at the end | Head and tail, or extract in code |
| A threshold whose favor and reason do not trace to the costs | Trace it or change it |
| An escalation cap unrelated to the target's capacity | Derive it |
| Ground truth that is the consumer's own action | Name an independent signal |
| Criteria examples copied from dev cases | Replace them with invented ones |
