# TerraformPlan

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Safety gates · Tool contract · Output format · References

A pre-apply review of a Terraform plan: what it will do, what it destroys or replaces, and the security, cost and compliance consequences, each tied to a resource address in the plan, with a verdict on whether to apply it as is.

Our ideal-state port of Fabric's `analyze_terraform_plan`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The review delivers what the principal wants from this input, inferred before writing and never asked for. Pasted plan output (`terraform plan`, or the JSON from `terraform show -json`) means a review of that plan before it is applied. A file means the same for the plan it holds: a text or JSON plan is read directly, a binary plan file is read through `terraform show` (§ Tool contract), and a diff of `.tf` files means the plan that change is expected to produce, with the Plan line reading `Not available (predicted from the configuration diff)`. A URL (a CI log, a pull request with plan output) means a review of the plan found there. A bare question about plans ("what does -/+ mean", "is replacing an RDS instance risky") means a direct, plain answer to it, with no review shape. A described change with no plan ("we're moving the database to a new subnet group") means what its plan will most likely do and what to check in it, with the Plan line reading `Not available (predicted from the description)`. "This" or nothing means the plan in the conversation. Input that holds no plan and asks nothing about one gets the single line `**Not a Terraform plan:** {what it is instead}`. A typed hint ("just security", "cost only") overrides the default read and narrows the review to what it names; asking whether a plan is safe to apply, or to review it before applying, asks for the full review, since its Verdict is that answer. The request's own instructions win over § Output format: a structure or set of sections it names, a length or word limit, or a prohibition it states (no cost figures, no recommendations, no prose) is followed exactly, and every rule below about facts, addresses, destroys and secrets still holds inside that shape.
- The Plan line carries the plan's own counts: the numbers on its `Plan: … to add, … to change, … to destroy.` line, or, for a JSON plan, counted from each resource change's actions, with a replacement counted once under add and once under destroy as Terraform counts it. When anything is replaced, the line adds the number of replacements. A plan with no closing `Plan:` line because it was cut off reads `Not available (plan output is truncated; visible so far: {a} to add, {c} to change, {d} to destroy)`, the visible counts tallied from the resource changes the input does show, and the totals are never guessed.
- A plan that is cut off or noisy (ANSI colour codes, `Refreshing state` and `Reading` lines, warnings, CI timestamps, interleaved log output) is read past the noise to every resource change it shows, and each visible destroy, replacement and risk is reviewed in full as for a complete plan. The review says plainly that the rest is unseen: the Summary or Verdict names that the totals are unknown and that the missing part could hold further destroys or replacements, the Verdict is never `Safe to apply`, and one takeaway is getting the complete plan output (`terraform show` on the saved plan, or the full CI log) before applying.
- Every resource the plan destroys or replaces (`-`, `-/+`, `+/-`, "must be replaced", "will be destroyed") is named in Main points by its address, or by its module path when many share one. A replacement names the attribute that forces it (the `# forces replacement` line) and what the replacement puts at risk: stored data for databases, buckets, volumes, file systems and keys; addresses and DNS names for load balancers, IPs and instances; downtime when nothing creates the new one before destroying the old (`-/+` rather than `+/-`). The loss is stated as far as the plan shows it: data is lost unless restored, and the review names any restore path the plan does show (`snapshot_identifier`, `replicate_source_db`, `final_snapshot_identifier`) or its absence (`skip_final_snapshot = true`), never asserting the new resource comes up empty when the plan does not show that.
- Every security point names the resource address and the exact attribute and value that create the risk (`cidr_blocks = ["0.0.0.0/0"]` on port 22, `Principal = "*"`, `storage_encrypted = false`, an IAM `Action = "*"`), and says what an attacker or a mistake could do with it. Only risks the plan's changes create or remove are listed; a risk that exists elsewhere in the account and that the plan does not touch is not invented.
- Each consequence goes only as far as the plan supports it. No benefit the plan does not show (resilience, availability, a security or compliance gain beyond the changed attribute itself), no timing the plan cannot know (how long DNS takes to update, a TTL read as a guarantee of when clients switch rather than how long resolvers may keep the old answer, how long downtime lasts), and no outcome stated as certain that depends on state outside the plan. When a risk turns on something the plan does not show (what an attached IAM policy or role grants, a policy document that is `(known after apply)`, resources managed elsewhere, whether a data store holds data), the point names what is missing and what to check, instead of concluding either way.
- Every cost point names the resource and the change that drives the cost (an instance class, a count, a storage size, a NAT gateway, provisioned IOPS) and says whether spend goes up or down. A cost point carries no dollar figure, monthly estimate or percentage, since a plan holds no prices; only a request that asks for figures gets them, as approximate list price for the named size, marked approximate.
- Compliance points name what the plan changes about tagging, encryption, logging, retention, backups, deletion protection or public access, by resource address and attribute, and stop at what that change does; a verdict on a named framework or audit (PCI, SOC 2, HIPAA) appears only when the request names one.
- Every resource address, attribute and value in the review exists in the input. A value the plan shows as `(known after apply)` is treated as unknown, never guessed. A value the plan shows as `(sensitive value)` stays unmentioned, and a secret the plan shows in clear text (a password, token or key in a non-sensitive attribute) is never repeated: the review names the attribute, says the plan output exposes it, and treats that exposure as a security point.
- Context the request states about the plan (a named job or pipeline, a workspace, "prod" or "production") raises the stakes of a destroy, replacement or newly open port, and the review weighs it; production is never assumed when the input does not say it.
- Main points are the most consequential changes and concerns, ranked by consequence, at most 10, each one line of at most 30 words and as short as it can be while still naming the address, the attribute and the consequence. A small plan gets fewer points rather than padding. Each point opens on its kind in bold, one of **Destroy**, **Replace**, **Security**, **Cost**, **Compliance**, **Drift** or **Change**, then names its resource address in backticks. Changes Terraform found made outside of Terraform ("Objects have changed outside of Terraform") are listed as **Drift**.
- Takeaways are at most 5 actions of at most 30 words each the reviewer can take before applying this plan, each specific to it (snapshot `aws_db_instance.main` first, narrow the ingress rule to the office range, add `lifecycle { prevent_destroy = true }`, move the subnet change into its own plan), never general advice that would fit any plan. `-target` is never the recommended way to apply part of a plan: Terraform documents it for exceptional recovery, so a plan that should go in pieces is split into separate changes.
- The Verdict is one of `Safe to apply`, `Apply with care` or `Do not apply as is`, followed by one sentence of why. A plan that destroys or replaces anything, or is cut off so that part of it is unseen, is never `Safe to apply`. A plan that destroys or replaces stored data without evidence it was meant, opens an administrative port or a data store to the internet, removes encryption or deletion protection, or exposes a secret is `Do not apply as is`.
- The Summary is one sentence of at most 25 words that says what the plan does and its single most important consequence.
- Words are plain and exact, the vocabulary an infrastructure engineer would use with a colleague reviewing the same plan.
- `bun skills/Fabric/Tools/TerraformPlanCheck.ts` passed on the exact review before it was delivered, with `--plan` pointing at the plan whenever one was supplied. Where no shell is available, the counts, the destroy and replace coverage and the addresses are checked by hand against the plan, and nothing about the check appears in the output.

## Anti-criteria

- Never a destroy or replacement left out of Main points, or described as an update.
- Never a resource address, attribute, value, count or price that the input does not contain or support.
- Never a secret value from the plan repeated in the review.
- Never a consequence, benefit, timing or compliance conclusion the plan does not support, such as a replaced database asserted to come back empty, a DNS TTL read as a switchover guarantee, or resilience the change does not add.
- Never a dollar figure or cost estimate the request did not ask for.
- Never a cut-off plan reviewed as if complete, or its visible changes dropped behind a bare `Not available`.
- Never a structure, length limit or prohibition the request states overridden by § Output format.
- Never `-target` recommended as the way to apply part of a plan.
- Never generic findings or takeaways ("follow least privilege", "review the changes carefully", "monitor costs") that would read the same under any plan.
- Never a review shape (Summary, Plan, Verdict, Main points) produced for a question, or for input that holds no plan.
- Never a plan reviewed from its `Plan:` line or a fetched page summary instead of every resource change in it.
- Never `terraform apply`, `plan`, `destroy`, `import`, `state` or `init` run to produce or check the review.
- No preamble, warnings, notes or commentary outside the sections in § Output format, and no item repeated across sections.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-terraformplan — code checks on the Plan line, verdict wording and sections; judged checks on catching each destroy and replacement with its data loss, naming the exact risky attribute, plan-specific takeaways, and secrets kept out of the review.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The plan: pasted `terraform plan` text or `terraform show -json` output, a file path (text, JSON or binary plan, or a `.tf` diff), a URL, a described change, a question about plans, or "this"/nothing for the plan in the conversation. A URL or video is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs).
- An optional hint narrowing the review.

## Safety gates

- The only Terraform command this intent runs is `terraform show` on a saved plan file, which reads it and changes nothing. Every other command (`apply`, `plan`, `destroy`, `import`, `state`, `init`, `refresh`) touches real infrastructure, state or credentials and is never run here.
- Plan output can hold secrets. A pasted plan saved for the checker goes to the session scratch directory, never into a repository, and is deleted after the check.

## Tool contract

Run from `~/.claude`. A binary plan file is turned into text from the directory it was made in, where its providers are installed:

```bash
terraform show -no-color <planfile>     # human-readable; or: terraform show -json <planfile>
#   fails without that directory's providers: say so in one line instead of guessing the plan
```

Save the review (and the plan, when it was pasted), check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/TerraformPlanCheck.ts <review|-> [--plan <plan.txt|plan.json>] [--json]
#   exit 0: shape holds (and, with --plan, counts, destroy/replace coverage, addresses and secrets agree with the plan)
#   exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

A question's answer, a hint-narrowed review (only some sections asked for) and a review in a structure the request named skip the check, since their shape is not the review's; for those, the counts, the destroy and replace coverage, the addresses and the secrets are checked by hand against the plan.

### Intent-to-Flag Mapping

| What the request supplied | Flags |
|---|---|
| A plan (pasted, a file, or found at a URL) | `<review> --plan <saved plan>` |
| A `.tf` diff or a described change (no plan seen) | `<review>` alone |
| The review should be read by another tool | add `--json` |

## Output format

```markdown
## Terraform plan review: {what the plan does, in a few words}

**Summary:** {one sentence, at most 25 words}

**Plan:** {a} to add, {c} to change, {d} to destroy

**Verdict:** {Safe to apply | Apply with care | Do not apply as is}. {One sentence of why.}

### Main points

1. **Replace** `aws_db_instance.main`: `storage_encrypted` forces replacement; the database is destroyed and its data lost unless restored, and `skip_final_snapshot = true` leaves no final snapshot.
2. **Security** `aws_security_group_rule.ssh`: opens port 22 to `0.0.0.0/0`.

### Takeaways

1. {an action to take before applying this plan}
```

- The Plan line takes an import count first when the plan has one (`1 to import, 2 to add, …`) and ends with `(N replacement)` or `(N replacements)` when anything is replaced. It reads `Not available ({reason})` when no plan was seen or the plan was cut off; a cut-off plan's reason carries the visible counts (`Not available (plan output is truncated; visible so far: 1 to add, 2 to change, 1 to destroy)`).
- A plan with no changes (`No changes. Your infrastructure matches the configuration.`) reads `0 to add, 0 to change, 0 to destroy`, is `Safe to apply`, and carries no Main points or Takeaways unless it reports drift.
- A question gets a plain prose answer. Input with no plan is the single line `**Not a Terraform plan:** {what it is instead}`.

## References

- Upstream: `Patterns/analyze_terraform_plan/system.md` (a 20-word one-sentence summary, the 10 most critical changes or concerns at up to 16 words each, and 5 takeaways, as numbered Markdown lists covering infrastructure changes, security, cost and compliance).
- `Tools/TerraformPlanCheck.help.md`: the checker's rules and exit codes.
