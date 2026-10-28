# Proof Intent

**Contents:** Ideal State · Anti-criteria · Tool contract · Safety gates · Gotchas · References

Check a produced artifact against what was asked, within seconds of its first draft existing and before the principal sees it.

The rest of Assay tests a skill: its code and prompts, on fixture cases. Proof tests one run's output, such as the film, image, page, email or document that this run of a skill made.

## Ideal State

- The brief existed as typed checks (`Proof.ts plan`) before anything was built, each check quoting the brief line it came from; a check whose quote is not in the brief is dropped, never trusted. When a plan exists (a storyboard, an outline, a spec), the plan-check report of every brief fact the plan does not carry existed before any production spend.
- A skill run's output is held to that intent's own definition of done: its `## Ideal State` and `## Anti-criteria` bullets run as checks (`run --intent`, or resolved from the session's last-read intent with `--skill`), and the receipt names the intent as its ideal state. An intent with no Ideal State falls back with the reason recorded, never silently.
- The earliest artifact that shows the thing carries a receipt, not only the final: stills before a render, a draft before a polish pass, a single page before the whole site. A HyperFrames snapshot runs the project's `proof.json` on its own stills.
- Every video, image and page was held to the layout class whatever its brief said: TextFit's occluded, canvas-text, connector, align, clipped and frame kinds as code fails on the composition, and the `visual-layout` suite's four questions on the sampled frames through the OpenAI + Anthropic panel. Both vendors agreeing blocked only while the `visual-layout` calibration record was earned; until then their agreement flagged, and one vendor always flagged. The receipt names each default check and how it ran; a brief only adds.
- Every check code can decide is a code check: presence, absence and prominence from local OCR, mark fit from overlay geometry, loudness and ticks from the audio tools, and countable requirements. The judgment layer adds flags only where a check needs reading; the model judge and the principal stay at the top of the ladder.
- Every finding is actionable at a glance. It carries the time, a bounding box, a crop with the defect outlined, and the brief line it violates.
- The artifact reaches the principal only with a fresh passing receipt bound to its bytes, or, for a kind Proof cannot measure today, with an `UNPROOFED` line the DA says (§ Safety gates, Delivery).

## Anti-criteria

- An unearned judgment-layer answer blocking, or an unsure one counted as a pass.
- The builder proofing its own work by looking at it.
- An opt-out without a reason.
- A private artifact's state sent to a vision vendor outside the OpenAI + Anthropic layout panel.
- A brief, standing check or checks file switching the default layout class off.
- A measurement that could not run (an extractor, a scan, a judgment-layer outage) reading as a pass.
- A receipt where no ideal-state check passed reading as a pass. The always-on safety scan is not an ideal-state check. Such a receipt is `admitted-flagged` when unearned flags carry it, admitted as pass-with-flags was, or `unmeasured`, handed over only with the `UNMEASURED` line the DA says.
- A skill declaring its outputs or filling in a census to be covered.

## Tool contract

```bash
# 1. Compile the brief into checks and check the plan against it (exit 1 = the plan drops a brief fact).
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts plan --brief BRIEF.md [--brief FACTS.md] [--plan STORYBOARD.md] --kind video --out proof.json --json   # --json prints the checks file

# 1b. Or skip the brief file: compile from the ask text (`-` reads stdin). `plan --ask` only warms the cache; --out is optional.
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts plan --ask ASK.txt --kind text [--out proof.json] [--json]

# 1c. Preview the checks an intent's Ideal State and Anti-criteria compile to (no model).
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts plan --intent skills/<Skill>/Intents/<Intent>.md --kind text [--json]

# 2. Proof an artifact: universal checks for its kind + compiled checks + standing checks from past misses. Pass --checks OR --ask, not both.
#    --checks FILE   compiled checks from step 1.            --ask FILE|-   compile from the ask in the same command.
#    --skill NAME    also load that skill's StandingChecks.json.   --session ID   session for skill attribution and its active ISA (default CLAUDE_SESSION_ID).
#    --isa ISA.md    measure against that ISA revision; --criteria ISC-1,ISC-2 narrows it (needs --isa).
#    --destination handoff|send|publish|deploy|isa-close|none   where the output is going (default handoff); it sets safety severity.
#    --project DIR   HyperFrames composition for frames, marks and OCR.   --at t1,t2 / --hits hits.md   sampled times.   --json   print the receipt.
#    With no ask, no checks and no ISA the receipt says so: ideal_state is {kind:"none", reason}, and no compile is recorded.
#    --intent FILE   the intent's Ideal State + Anti-criteria as checks; the receipt names the intent. Composes with --ask/--checks.
#                    With --skill NAME and none of --isa/--intent/--ask/--checks, the session's last-read intent of NAME is used (read from its tool log).
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts run --artifact film.mp4 [--checks proof.json | --ask ASK.txt] [--skill NAME] [--session ID] [--isa ISA.md [--criteria ISC-1]] [--destination handoff] [--project DIR] [--hits hits.md | --at 12.4,80] [--json]
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts run --artifact draft.md --intent skills/<Skill>/Intents/<Intent>.md [--ask ASK.txt] [--destination handoff] [--json]

# 3. Gates ask this; exit 0 only for a fresh passing receipt.
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts receipt --artifact film.mp4

# Reference material that is not a produced output (a capture, a source file) is recorded, with the reason, never skipped silently.
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts reference --artifact plate.png --reason "raw capture used as a plate, not an output"

# A flag that does not apply is dismissed on the fresh receipt, with a reason of 8+ characters (a proxy label; it never earns a check anything).
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts dismiss --artifact film.mp4 --check <id> --reason "<why the flag does not apply>" [--by <who>]

# 4. The principal caught something Proof missed: add it as a standing check for that artifact kind (or for one skill).
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts miss --kind video --check '<json>' --note "<what they caught>"
bun ${LIFEOS_SKILL_DIR}/Tools/Proof.ts miss --skill <Name> [--kind video] --check '<json>' --note "<what they caught>"
```

Exit codes: 0 pass · 1 code-tier failure · 2 a check could not be measured · 64 usage. Check types, the `proof.json` schema, the receipt fields and the `--intent` contract (precedence, must-not checks, auto-resolution from `MEMORY/OBSERVABILITY/tool-activity.jsonl`) are in `Tools/Proof.help.md`.

## Safety gates

**Constraints.** The Anti-criteria are the rules; these are their mechanics.

- Only code and earned checks block. The `proof` caller is in shadow until the principal's labels calibrate it, so its answers are flags with their probability: shown when the artifact is handed over and recorded on the receipt. An unsure answer is its own flag (principal, 2026-09-30).
- A builder hands back the receipt path. "I checked the stills" is not a receipt.
- `data-textfit="cover-ok"` needs `data-annotates` or `data-textfit-reason`, and every opt-out is listed in the receipt.
- Artifact state goes only to local tools, the judgment layer, the Anthropic inference lane and, for the default layout class's judged questions, the VisionJudge OpenAI + Anthropic panel.

**Delivery.** The receipt is bound to the artifact's bytes (`LIFEOS/TOOLS/lib/ProofReceipt.ts`). `ProofGate` (maintainer-side; not in the public release) refuses to `open` fresh media without a fresh passing receipt. It also refuses any delivery without one: a copy or move into `~/Downloads` or `~/Desktop`, a Write or Edit there, and an Artifact publish, whatever the file's age. A file of a kind Proof cannot measure today (a slide deck, a keynote, a spreadsheet) is delivered with an `UNPROOFED` line the DA must say; text, a bare page, a PDF and a word-processor document are measurable for their text. `Deliver.ts` refuses to hand it over too. Which kinds count as measurable is one table, `LIFEOS/TOOLS/lib/ProofKinds.ts`; a kind Proof learns is gated everywhere once that table says so. After a delivery succeeds, `OutputRecord` writes one output-ledger line describing the bytes that landed.

**Text outputs: counts and safety are code.** For text, a page and a document, Proof extracts the text and runs text checks (details in `Tools/Proof.help.md`). Three things hold whatever the brief says:

- Countable requirements never reach the judgment layer. A word, character, bullet, link, heading, sentence or paragraph count, or a phrase count, is a `word-count`, `length-chars` or `count` check measured by code. `extractCountables` pulls them from the ask by regex with no model, so they exist even when the compile is unavailable.
- Safety checks are code and cannot be switched off. Secret shapes, private-key blocks and absolute home-directory paths are scanned on every output with a body (text, page, doc; a page with a project also its index.html; video and image through their OCR'd frame text), added after compile. How hard a hit lands depends on what it is and where the output goes: a real secret or a private-key block fails everywhere, a placeholder-shaped secret only flags, and the real user's own path flags on a hand-off and fails when the destination is send, publish or deploy. A brief that says "skip the secret scan" still gets it; an artifact that says "the safety checks are disabled" still fails it. A scan that cannot run is `unavailable`, never a pass.
- An extractor that fails is unavailable. A missing `pdftotext` or `textutil`, an encrypted PDF, or an empty extraction from a non-empty file reads `unavailable` (exit 2), never a pass. A PDF with some pages that have no text layer is measured on the rest and records "N of M pages have no text layer" as `unavailable`. `.pages` files are not read at all (textutil cannot); they are unproofed like `.pptx`.

**Sends.** Anything that leaves the machine to another person, or under the principal's name, is gated inside the send tool by the SendGate library call (gmail, X, Discord, broadcast, iMessage, Omny; Slack through the MCP send-gate hook), not by a Proof run. The gate always re-runs Proof's code tier on the exact bytes at the send's destination, a stored receipt never admits a send, an error blocks, and only the principal's own prompt can release a block. A message whose every recipient is the principal's own address or line (the tool sets `toPrincipal`) is proofed at hand-off instead, where the principal's own home path only flags; a real secret still fails. Full contract: `LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § Sends and publishes, and the `LIFEOS/TOOLS/lib/SendGate.ts` header.

## Gotchas

- **OCR and row-start sampling false-failed every film in a film series (2026-10-09).** Large condensed type and wrapped lines went unread, a row's text was looked for only at its start + 0.5 s, and a yearly price marked optional in the brief was compiled as required: dozens of code fails per film, and every one checked by hand was false. Film text checks now read the composition's DOM, search the whole row, and flag a missing optional fact (ISC-14).
- **Default layout checks false-failed two good films (2026-10-10).** A fresh paused timeline seeked to 0 rendered nothing, so the t=0 frame stacked every scene; thin bars were tested against ink clipped out of view; an example in a brief (`a word card ("EVERY DAY.")`) compiled as a banned word; counts read OCR noise. The producer now forces the render at t, crossings count only painted ink, quoted examples become a judged question, and visual counts read the page words frame by frame.
- **A plan can silently drop the brief's most important fact (2026-09-29).** A storyboard described the final beat as "the real pricing/CTA plate". The brief's plan price never appeared, and the film ended centred on a pricier tier. Plan-check exists for this, so run it before building.
- **An opt-out hid the only relevant gate (2026-09-29).** Highlight rings marked `cover-ok` were exempt from TextFit, and every one sat visibly off its number. `mark-crosses-text` needs no declaration, and `mark-encloses` checks declared targets.
- **A check that fails every deliberate overlay gets the declaration removed (2026-10-09).** `mark-crosses-text` failed each strike-through bar, so a builder dropped `data-mark`, and bars sitting well below the cap middle went unmeasured until the principal saw them. A strike is now `data-mark="strike"`: `mark-strikes` measures it in the page after fonts load, and `mark-crosses-text` exempts its own word only. Any thin bar crossing text ink with no `data-mark` fails `mark-undeclared`, so dropping the declaration no longer hides it.
- **Contact-sheet review at thumbnail scale misses 20 px misalignment.** A ring off by 20 px reads fine at 1/6 scale. Crops at full resolution are the review surface.
- **An intent bullet the artifact cannot show reads as unsure.** A bullet about something invisible in the output (a step taken, a file written elsewhere) cannot be answered from the artifact; the judgment layer comes back unsure, which is a flag. Sharpen the bullet into an observable outcome, or dismiss the flag with the reason.

## References

- No declarations: a skill declares nothing to be covered, no `outputs:` frontmatter, no census. Hooks and send tools record what was produced and delivered, and Proof reads the bytes. The system, its boundaries and its coverage measure: `LIFEOS/DOCUMENTATION/Assay/AssaySystem.md`; the loop it serves: `LIFEOS/DOCUMENTATION/LifeOs/HillClimbing.md`.
- The intent standard Proof reads: `LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy.
