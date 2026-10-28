---
version: 1.0.4
last_updated: 2026-10-26
last_updated_by: da
convention: lifeos-freshness-v1
---

# Records: run lines, output lines, receipts and labels

> Four small records carry the quality loop. A run line says a skill ran. An output line says something crossed a boundary. A receipt is Assay's verdict on one artifact. A label is a human verdict on a check or an artifact. They are joined by ids and hashes, so a complaint can be traced to the output, the check and the skill behind it.

Assay (`AssaySystem.md`) writes the receipts and labels, the gates write the output lines, and a hook writes the run lines. Errata stores complaints only and joins to these records. The concept is in `../LifeOs/HillClimbing.md`.

## The four records at a glance

| Record | File | One line per | Written by | Appended or replaced |
|---|---|---|---|---|
| Run line | `LIFEOS/MEMORY/SKILLS/execution.jsonl` | Skill or intent invocation | The event-logger hook, after the Skill tool call | Appended |
| Output line | `LIFEOS/MEMORY/OBSERVABILITY/outputs-YYYY-MM.jsonl` | Output that crossed a boundary | The hand-off recorder, the send tools, the reply recorder | Appended, one file per month |
| Receipt | `LIFEOS/MEMORY/STATE/Proof/receipts/<key>.json` | Artifact (the latest boundary run) | Proof, art critique, deploy review, the eval runner | Replaced by a new boundary run, with the old one kept in `<key>.history.jsonl`. After the file lands, `ProofReceipt.writeReceipt` also mirrors the run to the STATVS `receipt` stream as counts and ids, never a finding's text; the file stays authoritative and a failed mirror never breaks the write |
| Label | `LIFEOS/USER/ASSAY/labels.jsonl` | Human verdict | Dismissals, the label batch, art-direction calibration | Appended, never rewritten |

`LIFEOS/MEMORY/` is a link into the private data repo, so everything above except the label file already lives there, and the label file sits in the same repo's `USER` tree. None of these files ships in a public release. This doc describes schemas only.

## 1. The run line

One line per skill or workflow run. It answers "did skill X run, when, in which session and turn."

```json
{
  "ts": "2026-01-01T00:00:00Z",
  "skill": "Research",
  "args": "quick: ...",
  "input": "quick: ...",
  "source": "hook",
  "session_id": "<session uuid>",
  "turn": "<turn uuid>",
  "run_id": "run_<uuid>",
  "parent_run_id": null,
  "prior_run_id_same_turn": null
}
```

| Field | Type | Meaning |
|---|---|---|
| `ts` | ISO 8601, seconds, `Z` | When the Skill call finished |
| `skill` | string | The skill's name. A workflow run carries the skill that owns it |
| `args` | string | The invocation arguments, with secret values redacted and long text truncated |
| `input` | string | A copy of `args`, kept for older readers |
| `source` | `"hook"` | Always `hook`: the line is written by the harness, not by the model |
| `session_id` | string or null | The session the run belongs to |
| `turn` | string or null | The id of the prompt being worked, when the router knows it and it is under six hours old |
| `run_id` | `run_` plus a uuid | The run's identity. Output lines point at it |
| `parent_run_id` | run id or null | Set only when the spawner passes it explicitly. Never guessed, so a nested run with no carrier reads as null |
| `prior_run_id_same_turn` | run id or null | The previous run in the same session and turn, when there is one |
| `agent_id`, `agent_type` | strings, optional | Present when a subagent made the call |

Beside each run line the hook keeps one small state file per session under `LIFEOS/MEMORY/STATE/run-state/`, holding `{run_id, turn, skill, ts}` for the latest run. An output's attribution reads it: an output belongs to the last skill invoked in its session, and the fields stay null when there is none. Attribution is by recency and can be wrong when two skills overlap in one session. It is never guessed beyond that.

Privacy: `args` can hold the text of a request, so it is redacted for secret shapes before it is written, the file is mode 0600, and it lives in the private data repo. No skill writes this line. A skill that is asked to log its own run is redundant with the hook.

## 2. The output line

One line per output that crossed a boundary: handed to the principal, sent, published, deployed, or closed into an ISA. The line is the denominator for coverage and the join key for Errata.

```json
{
  "v": 1,
  "output_id": "out_<uuid>",
  "ts": "2026-01-01T00:00:00.000Z",
  "session_id": "<session uuid>",
  "turn": "<turn uuid>",
  "run_id": "run_<uuid>",
  "skill": "Research",
  "workflow": null,
  "isa": null,
  "boundary": "handoff",
  "channel": "downloads",
  "kind": "page",
  "target": "path:downloads",
  "sha256": "<64 hex>",
  "bytes": 60738,
  "receipt_id": null,
  "decision": "allowed-labelled",
  "reason": "landed outside the gate"
}
```

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Schema version |
| `output_id` | `out_` plus a uuid | Generated by the writer |
| `ts` | ISO 8601 with milliseconds | When the line was written, which is after the tool succeeded |
| `session_id` | string | Required, non-empty |
| `turn` | string or null | The prompt being worked |
| `run_id` | run id or null | Joins to the run line's `run_id` |
| `skill`, `workflow`, `isa` | string or null | From the run attribution, when known |
| `boundary` | `handoff`, `send`, `publish`, `deploy`, `isa-close` | The same five names the receipt's destination uses |
| `channel` | token, up to 64 characters | The route: `downloads`, `desktop`, `open`, `artifact`, `reply`, `gmail`, `x`, `discord`, `slack`, `broadcast`, `cf-deploy`, and so on |
| `kind` | `video`, `image`, `audio`, `text`, `page`, `doc`, `diff`, `other` | The kind of artifact. `other` is a file whose extension `ProofKinds.ts` does not know |
| `target` | a class, never an address | See below |
| `sha256`, `bytes` | hex digest and integer | Computed by the writer from the bytes actually on disk (or the proofed copy of the bytes a tool sent), never from the caller's intent |
| `receipt_id` | string or null | The store key of the receipt the gate found (see the joins). Null when there was none, or when the landed bytes differ from the bytes the gate approved |
| `decision` | `allowed`, `allowed-labelled`, `blocked`, `overridden` | What the gate did. `allowed-labelled` means it went through with a stated reason, such as an open flag, an unmeasured kind, a gate error or bytes that landed outside the gate. `overridden` means the principal released a blocked send |
| `reason` | 1 to 240 characters | A plain reason. It may not contain an address, a URL, a path or an IP |

`target` is a redacted class: `email`, `url`, `other`, a recipient class such as `x`, `discord`, `slack` or `imessage`, or a path class (`path:downloads`, `path:desktop`, `path:documents`, `path:tmp`, `path:home`, `path:other`). The writer rejects any value that still looks like an address, a path, a URL or an IP.

Who writes it, and when:

| Writer | Boundary and channel | When |
|---|---|---|
| Hand-off recorder (PostToolUse) | `handoff`: `downloads`, `desktop`, `open`, `artifact` | After a gated Bash, Write, Edit or Artifact call succeeded. It also records files that landed in the delivery folders outside any gate, as `allowed-labelled` with reason "landed outside the gate" |
| Send tools and the chat-connector hook | `send` or `publish`: the tool's channel | After the transmit returned. A send that fails to transmit writes no line |
| Reply recorder (Stop) | `handoff`, channel `reply`, kind `text`, target `chat` | For a substantial reply only: 300 words or more, or a fenced block over 40 lines. A short reply writes nothing |

On a public install only the send tools write output lines. The hand-off recorder, the chat-connector hook and the reply recorder are maintainer-side and not in the public release.

If a gate approved one sha256 and different bytes landed, the line is written from the landed bytes, the decision becomes `allowed-labelled`, the reason becomes "post-state sha differs from proofed sha", `receipt_id` is null, and a Vigil event fires.

The `blocked` decision is part of the schema, and it is written. `SendGate` (sends, on every install) and, on the maintainer's install, `ProofGate` (hand-offs, not in the public release) each append a `blocked` line when they deny a call, naming the reason, so a denial is counted in coverage like any other decision. The denial is also visible to the assistant and, for sends, to the pending-record state. A blocked send never transmits, so it writes no `send` line.

Raw sender commands in Bash are denied on every install, so a send goes only through a send tool. The rest of this paragraph is maintainer-side and not in the public release; on a public install `LIFEOS/TOOLS/lib/McpWriteVerbs.ts` is read only by `OutputReconciler.ts`, which counts MCP sends after the fact when it is run. On the maintainer's install, the gates and recorders cover every `Artifact*` tool and the recorders cover every `mcp__` tool (native `ask` rules hold MCP sends; no MCP gate runs) unless its name carries a read verb (get, list, read, search, query and the like) and no write verb anywhere (the one rule in `McpWriteVerbs.ts`, plus two exact-name draft tools). The delivery backstop records files that land in a delivery root by two scans. After every tool call, a fast scan looks at Downloads and Desktop wherever something changed (the top level and one folder down, by each folder's change time) and at any path the call named. Once a day the reconciler walks Downloads and Desktop completely (eight levels, each with its own budget); for Documents, iCloud Drive and cloud drives it checks only the paths the independent activity log names as DA writes, and never lists a cloud folder, because listing placeholders can download them. ProofGate gates hand-offs into Downloads and Desktop; the other roots are recorded, not gated. A file whose kind `ProofKinds.ts` does not know is recorded as "other".

Privacy: no content, ever. The line holds a hash, a byte count and a class. It is mode 0600, written to a monthly file, and kept in the private data repo. The reply recorder keeps the reply text in a private state directory outside the data repo for seven days, so a proof can run later, and the output line holds only its hash.

## 3. The receipt: `assay-receipt/1`

One receipt per artifact, stored under a key that is the sha256 of the artifact's canonical absolute path (symlinks resolved). The key is the `receipt_id` that output lines carry.

`proof-receipt/1` is the older shape. It is still read and validated, and `assay-receipt/1` is a superset of it. Where the two differ, this section says so.

### Core fields (both schemas)

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"assay-receipt/1"` or `"proof-receipt/1"` | Which schema |
| `artifact` | absolute path | The file that was checked |
| `sha256` | 64 hex | The bytes that were checked. Freshness compares this to the file now |
| `size`, `mtimeMs` | numbers | Recorded for display. Never used to decide freshness |
| `kind` | `video`, `image`, `audio`, `text`, `page`, `doc` | What the artifact is |
| `ran_at` | ISO 8601 | When the boundary run happened |
| `run_id` | string, optional on `proof-receipt/1` | A random uuid for this boundary run. Two runs of the same bytes can share a millisecond, so `ran_at` alone cannot tell them apart. This is not the skill run's `run_id` (see the joins) |
| `duration_ms` | number | How long the checks took |
| `checks_file` | absolute path or null | The checks file used, or null for the standing profile alone |
| `profile` | list of strings | Names of what ran, plus notes such as `skill:<Name>`, `ask:<sha12>`, `dropped-reserved-id:<id>`, `compile:0-checks` |
| `verdict` | `pass`, `admitted-flagged`, `unmeasured`, `fail`, `unavailable`, `reference` | Derived from the findings, never authored. `pass` needs an ideal-state check that passed. `admitted-flagged` is a clean run where none passed and unearned flags carry it; `unmeasured` is a clean run where none passed and nothing flagged (AssaySystem.md § Receipts) |
| `counts` | object | `passed`, `code_fail`, `flags`, `unavailable`, `safety_passed` when the writer states it (how many of `passed` were the always-on safety checks), and on `assay-receipt/1` also `earned_fail` |
| `findings` | list | See below |
| `opt_outs` | list of `{selector, kind, reason}` | The opt-outs a project's composition declares, each with its stated reason. Empty unless a project directory was proofed |
| `reason` | string | Required when `verdict` is `reference`, at least 8 characters |
| `brief_sha256`, `checks_sha256` | hex or null | What the run was bound to, so a hand-edited check set is visible |
| `sampled_times` | list of numbers | The frame times a video or image run measured |
| `dismissals` | list of `{check, reason, at, by}` | Why an unearned flag does not apply. Appended by `dismiss`; each reason is at least 8 characters |
| `composition_sha256` | hex, optional | For a film run with a project: the hash of the composition it came from |

### Added by `assay-receipt/1`

| Field | Type | Meaning |
|---|---|---|
| `ideal_state` | one of three shapes | What the artifact was measured against: `{kind:"isa", path, revision, criteria?}` where `revision` is the sha256 of the ISA's bytes and `path` is absolute, `{kind:"ask", sha256}` for the ask's hash, or `{kind:"none", reason}` with a reason of at least 8 characters. A skill intent rides the ISA shape with `source:"intent"`, `skill` and `intent` added, `path` the intent file, `revision` its sha256 and `criteria` its bullet ids (`IS-n`, `AC-n`) (AssaySystem.md § Intents as the criteria source) |
| `check_set` | `{version, source}` | `version` is the sha256 of the checks as run. `source` is the checks file's absolute path, or null |
| `evaluators` | map of name to version | At least one entry, for example the Proof engine's version and the judgment-layer model that answered |
| `destination` | `handoff`, `send`, `publish`, `deploy`, `isa-close`, `none` | Where the output was going when it was checked. It sets the severity of some safety findings |
| `verdict_at_boundary` | `{verdict, counts, findings, at}` | The verdict frozen when the boundary run finished. `findings` counts how many findings existed then, `at` equals `ran_at` |

### A finding

| Field | Type | Meaning |
|---|---|---|
| `check` | string | The check id, for example `word-count`, `safety-secret`, `glance:intent` or `review:blocker:<where>` |
| `tier` | `code`, `glance`, `judge` | Which tier made the finding |
| `severity` | `fail`, `flag`, `unavailable` | `fail` blocks. `flag` is recorded and never blocks. `unavailable` means it could not be measured |
| `message` | string | A plain statement, with secret values masked |
| `t`, `bbox`, `crop` | optional | For a visual finding: the time, the bounding box, and a crop image with the defect outlined, stored in `<key>.crops/` beside the receipt |
| `derived_from` | string, optional | The line of the ask the check quotes |
| `probability` | number, optional | The judgment-layer probability behind the finding |
| `earned` | boolean, optional | True only when the check has earned the right to decide. Only on `assay-receipt/1` |
| `unsure` | boolean, optional | A judgment-layer answer that was confident neither way. A flag, never a pass |
| `added_at`, `source` | optional strings | Set on a finding appended after the boundary run: when, and by what |

### What the validator enforces

The same function checks a receipt before every write and on every read. A receipt that fails reads as no receipt.

- The verdict and the counts must equal what the findings derive. A receipt cannot claim a pass its findings contradict.
- A `proof-receipt/1` finding on the glance or judge tier may flag and never fail, and nothing in it is `earned`.
- On `assay-receipt/1`, a glance or judge finding may fail only when it is `earned`, and an earned "no" is a `fail`, never a `flag`.
- `verdict_at_boundary` must be derivable from the first `findings` findings. Any finding after that prefix must carry `added_at` and `source`.
- A `reference` receipt carries a reason, no findings and zero counts, and checks nothing.

Separately from the validator, the gate verdict treats a receipt that checked nothing (no passes and no findings) as not admitting the artifact. A receipt whose only passes are the always-on safety checks, with no findings, is admitted but named `unmeasured`, and the assistant says so when presenting the file.

### Append-only

Rewriting the same boundary run may only add findings and dismissals, and the schema, the boundary verdict and every earlier finding must stay as they were. A later catch (a post-delivery judge, the principal) is appended with a source, and the top-level `verdict` and `counts` move while `verdict_at_boundary` stays. A new boundary run for the same artifact replaces the file, and the replaced receipt, with anything appended to it, becomes one line of `<key>.history.jsonl`. The gap between `verdict_at_boundary` and the current `verdict` is what a false pass looks like.

### Who writes a receipt

| Writer | What the artifact is | `destination` |
|---|---|---|
| Proof | The file being delivered | As given (`--destination`), default `handoff` |
| Art critique | An image or film, appended to the Proof receipt for the same bytes when one is fresh | `handoff` |
| Deploy review | The stored diff, keyed by the diff's hash | `deploy` |
| Eval runner | The suite run's result file | `none` |

Privacy: a finding's message can quote text from the artifact, with secret values masked, and a crop is a picture of it. Receipts live under `LIFEOS/MEMORY/`, in the private data repo, and the public docs carry the schema only. The send gate keeps a content-addressed copy of each sent body in a private state directory so the exact bytes can be proofed and recorded, and it deletes the copy after the output line is written or after 24 hours.

## 4. The label

One line per human verdict, in `LIFEOS/USER/ASSAY/labels.jsonl`. This is the only place a verdict lands, and the only evidence that lets a check earn the right to decide.

"Earned" has one definition, `earnedStatus` in `LIFEOS/TOOLS/lib/LabelStore.ts`: the principal's own `right` and `wrong` labels for one check, at the label floor and agreement bar the registry names. A proxy label, an `unsure`, and a `pass` or `fail` ground-truth label never count. A judge's calibration reads this same definition. `Calibration.calibrationStatus` takes its `earned` from `earnedStatus` for the check `calibration:<suite>`, and every calibration run writes through one path (`recordCalibrationLabels`): a principal attestation lands as a principal `right`/`wrong` label on that check plus a `pass`/`fail` artifact label, and any other attester lands as a proxy label. The write is idempotent by label id. A calibration record's own agreement and kappa figures are diagnostics from that run. Only a changed judge, rubric or label file can revoke an earned status, because then the labels no longer describe the judge that runs. With no calibration record nothing reads earned, since labels alone are keyed by suite and could outlive a swapped judge. Where labels carry the true class, each class needs at least two labels at better-than-coin agreement (`CLASS_AGREEMENT_BAR`), so a one-answer judge cannot earn.

```json
{
  "v": 1,
  "id": "<uuid>",
  "ts": "2026-09-30T22:10:03.000Z",
  "source": "principal",
  "kind": "check",
  "receipt_id": "<store key>",
  "artifact_sha256": "<64 hex>",
  "check_id": "glance:intent",
  "verdict": "right",
  "note": "weekly label batch <batch-id>",
  "by": "principal"
}
```

| Field | Type | Rule |
|---|---|---|
| `v`, `id`, `ts` | `1`, uuid, ISO 8601 | Set by the writer |
| `source` | `principal` or `proxy` | `principal` is a verdict the principal gave, or a delegated attestation recorded as theirs. `proxy` is anything else: a dismissal, an agreement between models |
| `kind` | `check`, `artifact`, `reaction` | `check` is a verdict on one check. `artifact` is a verdict on the whole artifact. `reaction` is a reaction to a delivered output |
| `receipt_id` | string, optional | The receipt's store key |
| `artifact_sha256` | 64 hex, optional | The bytes the verdict is about |
| `check_id` | string, optional | The finding's `check`. Required for a `check` label, unless `caller` and `question` are given |
| `caller`, `question` | strings, optional | A judgment-layer caller and question, for labels that are not tied to a receipt |
| `verdict` | `right`, `wrong`, `pass`, `fail`, `unsure` | `right` and `wrong` judge the check's call and are allowed only on `check` labels. `pass` and `fail` are the human's own verdict on the artifact. `unsure` is recorded and counts for nothing |
| `truth` | `pass` or `fail`, optional | On a `right` or `wrong` label: the true class of the case, so `earnedStatus` can check each class |
| `engine` | string, optional | On a `check` label naming a caller and question: the engine whose verdict the label judged. Older rows read as their recorded model, else `unknown` |
| `from_label` | string, optional | On a label derived by the join: the id of the principal verdict it came from |
| `note` | string, optional | Trimmed free text |
| `by` | string | Who gave it. Required |

A label must name what it is about: a receipt id, an artifact hash, a check id, or a caller and question.

Earned status is computed from this store alone, and only from the principal's `right` and `wrong` labels on that check or question. A proxy label, an `unsure`, and a `pass` or `fail` ground-truth label never count. A check earns when its principal labels reach the label floor (the question's own floor, else the registry default, else 10) and the share marked `right` reaches the caller's bar (default 0.85).

Writers today:

| Writer | Label written |
|---|---|
| `Proof.ts dismiss` | `proxy`, `check`, verdict `wrong`, with the dismissal reason as the note |
| `LabelBatch.ts answer` | `principal`, `check`, verdict `right`, `wrong` or `unsure`, tied to the receipt and check |
| Art-direction calibration | `principal`, `artifact`, verdict `pass` or `fail` from a 0 to 10 score |
| `HaikuSwap.ts answer` | `principal`, `check`, verdict `right` or `wrong`, with `caller`, `question`, `truth` and the `engine` that answered |
| Errata capture (`writeReactionLabels`) | `principal`, `reaction`, verdict `pass` or `fail`, with `artifact_sha256`, the note being the erratum id |

`reaction` labels are written by Errata (`writeReactionLabels` in `LIFEOS/ERRATA/Capture.ts`): one principal label per output an erratum cites in `context.output_ids`, verdict `fail` for a complaint, bug, correction or incident and `pass` for praise, tied to the output's sha256 and receipt id. A hand-off the gate blocked gets none. A `reaction` label never counts toward earning.

Privacy: a label's note can quote the artifact or the principal's words. The file is mode 0600 in the private data repo. Under the test runner the store moves to a temporary directory, so a test can never write to the real one.

## The joins

| From | To | How |
|---|---|---|
| `output.run_id` | the run line | Equals the run line's `run_id`. This gives the skill, the session, the turn and the ask |
| `output.skill` | the skill | Taken from the run attribution when the line was written. The reconciler uses it per skill, and falls back to the run line when it is null |
| `output.receipt_id` | the receipt | Equals the receipt's file name without `.json`. The receipt is usable only when its `sha256` equals the output line's `sha256`, so a receipt for other bytes is never trusted |
| `output.sha256` | the receipt | The same bytes. Used when the receipt is filed under another name: a lookup by sha256 finds a valid receipt anywhere in the store. A reply's output line carries no `receipt_id` and joins to its receipt this way |
| `erratum.context.output_ids` | the output lines | Each id equals an `output_id`. Errata fills the list at capture with up to 20 outputs the session recorded since the previous typed prompt |
| `label.receipt_id` and `label.check_id` | the receipt and its finding | The key and the finding's `check`. `label.artifact_sha256` joins by the receipt's `sha256` |
| `label.caller` and `label.question` | a judgment-layer question | The registry's caller and question ids |

The two identifiers named `run_id` are different things. The run line's `run_id` identifies a skill run and begins with `run_`. A receipt's `run_id` identifies one boundary run of Assay and is a plain uuid. Joins from an output go to a run line by the first, and never to a receipt by the second.

Following the joins gives the chain the system learns from: complaint, output line, receipt, run, skill. Errata computes complaints per output delivered for each skill, and the false passes: complaints whose output carried a passing receipt. It also lists standing checks that were dismissed three or more times with no matching complaint, as retirement candidates.

## Related

- **Concept:** `../LifeOs/HillClimbing.md`
- **Feeds me:** `AssaySystem.md` (writes receipts and labels, and says when each tier runs), `AssaySystem.md` § Judgment layer (the questions and thresholds that labels calibrate), `../Bunker/BunkerSystem.md` (the ISA run ledger the close gate reads).
- **I feed:** `../Errata/ErrataSystem.md` (joins complaints to output lines and receipts), `../Upgrades/UpgradesSystem.md` (false passes and retirement candidates become queue items), `../Vigil/VigilSystem.md` (events raised when a record cannot be written or does not match).
- **ISA:** `../ISA/ISAFormat.md`, the criteria that a receipt's `ideal_state` points at.
