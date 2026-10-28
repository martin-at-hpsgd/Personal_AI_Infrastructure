# DesignDocument

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

A security-minded design document for a specific system or idea: its business posture, its security posture, three C4 views (context, container, deployment) each drawn in Mermaid and described in a table, a risk assessment, and the open questions with the default each one assumes.

Our ideal-state port of Fabric's `create_design_document`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The document describes the system the principal actually wants designed, inferred from the input before a word is written and never asked for. A pasted artifact (a design note, a README, an architecture description, an ISA, code, a compose file or other infrastructure config) means that system as written: every component, actor, data store and integration it names appears in the design, and nothing it does not name is presented as part of it. A URL or a file means the system it describes, read in full. A bare idea or topic ("a URL shortener with click analytics") means a typical build of that idea at the stage the request implies, and the business posture names the build assumed. A question ("how should we design a webhook relay into our private network?") means the design that answers it. "This", "that" or nothing at all means the system we have been discussing in this conversation. Rough notes, meeting minutes, a chat thread or a half-made plan mean the system as the notes leave it, and every statement keeps the status the notes give it: what is built, running or decided is existing; what someone proposed, suggested, planned, wants or is still weighing is proposed; what is TBD, disputed, waiting on someone or unanswered is open. A typed hint ("for a hospital", "AWS only", "startup MVP", "focus on deployment") overrides the default read and shapes the posture, the choices and the depth.
- Thin input still gets the complete document: every section and all three views are filled for this system, with the gaps the input leaves carried as marked assumptions and questions rather than as missing sections or generic filler.
- The business posture states the system's purpose, who it serves, and the risk appetite that fits its stage and setting (a three-person startup can accept what a regulated enterprise cannot), and the priorities and business risks follow from that posture rather than from a generic list.
- The security posture keeps four things apart. Existing security controls are only the ones the input states, each prefixed `security control:`; for a bare idea they are the assumed build's baseline and each ends `(assumed)`. Accepted risks are only the trade-offs the input states as accepted or decided, or that follow directly from a choice the input states as made, each prefixed `accepted risk:`, or the single line `accepted risk: none stated`. A proposed waiver, exception, deferral or skipped safeguard that nobody has signed off is never an accepted risk: it is a question under SECURITY POSTURE, and the document says what that acceptance would cost. Recommended security controls are high-priority controls the input does not already have, most important first; a control the input only proposes or plans belongs here, and its line may say it was proposed, but it is never listed as existing. Security requirements cover what this system must enforce (authentication, authorization, input validation, cryptography and whatever else this system needs), each tied to this system.
- Each C4 view is a Mermaid diagram that renders, followed by a table with the columns Name, Type, Description, Responsibilities and Security controls. The context view puts the system at the centre with its users and the external systems it talks to; the container view shows the deployable parts, the major technology choices and how they communicate; the deployment view shows where those containers run in one named environment. Every element named in a table appears in its diagram, and the Security controls cell names what that element enforces, never a filler such as "standard controls" repeated down the column.
- The risk assessment answers both of the upstream's questions for this system: which business processes are critical to protect, and which data needs protecting, each item with its sensitivity (for example public, internal, confidential, regulated) and the reason.
- Every open question sits under the area it concerns (business posture, security posture or design) and carries the default the document assumed in its absence, so the reader can see exactly which answers would change the design. Every item the input leaves open (an undecided requirement, a pending security decision, a question waiting on legal or an owner) appears as one of these questions, and the design never quietly settles it: where the default shapes a view or a control, that line says it rests on the assumption.
- Facts the security conclusions hinge on come from the input or are stated as conditional. When the input does not say how a key or credential is scoped, who holds it, whether customers share storage, or what faces the internet, the document does not pick an answer and build its headline risks on it; it names the risk for the case that matters, says in the same line that it depends on that answer, and asks the question with its default.
- Numbers and dates come from the input. User counts, capacity, throughput, latency, availability targets, retention periods, costs and timelines the input does not give are never stated as facts about the system; where the design needs one, it is a question with an assumed default. Any phase, deadline or certification timeline the document recommends fits inside the goals and dates the input states.
- Every line is specific to this input. A control, risk, requirement or element that would fit most other systems as well ("Use strong passwords", "Encrypt sensitive data", "Users" with no role) fails unless it names this system's part, data or failure.
- A source is read in full before the document is written (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs), and every stated fact the document relies on is in the source or the conversation.
- The words are plain and exact: the precise ordinary word wins over jargon, and an architecture or security term is used only where it is the clearest name for the thing.
- The reply is the document and nothing else: its first line is the title and its last line is the last question. `bun skills/Fabric/Tools/DesignDocumentCheck.ts` passed on the exact output before it was delivered, Mermaid rendering included, run through a real tool call when a shell tool is available. The commands, file writes and checker results stay in those tool calls and never appear in the reply. Where no tool is available, the shape is checked by hand and nothing stands in for the tools: no command, no tool-call markup, no simulated output, no note that a check ran or would run.

## Anti-criteria

- Never a control, component, vendor, technology or requirement the input does not state presented as existing. Anything assumed is marked `(assumed)` or sits in the assumptions.
- Never a proposal, suggestion, plan item or pending decision from the input presented as an existing control or an accepted risk, and never an item the input leaves open resolved without a question.
- Never a capacity, scale, performance, cost or timeline figure the input does not give stated as a fact, and never a headline risk or recommendation that rests on an unstated guess about the system without saying so.
- Never a generic template filled in with the system's name: boilerplate controls, a Security controls column of "N/A" or "standard security", a risk assessment that would fit any web app.
- Never a diagram that does not render, a diagram and table that describe different elements, or a table missing one of the five columns.
- Never bold or italic markdown (no asterisks or underscores for emphasis), and nothing before the title or after the last question: no preamble, sign-off or commentary on the document.
- Never a shell command, heredoc, file-save step, tool-call markup or checker output anywhere in the reply, and never a simulated tool call when no tool exists.
- Never a source summarized from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-designdocument — code checks on the section order, the three Mermaid blocks, the five-column tables, the control and risk prefixes and the assumed defaults, plus judged checks on input-kind inference, fidelity to a pasted design, keeping proposed and open items in rough notes apart from decided ones, specificity, risk appetite and the typed-hint override.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact (rough notes and meeting minutes included), a URL, a YouTube link, a file path, a bare idea, topic or question, or "this"/"that" or nothing at all, which means the system under discussion in the current conversation.
- An optional typed hint that narrows or redirects the read: an industry or regulator, a cloud or platform, a company stage, or a view to go deepest on.

## Tool contract

For a session that has a shell tool. Run from `~/.claude` through that tool: save the draft, check it, and deliver only on exit 0. None of this appears in the reply, and with no shell tool it is skipped, never written out:

```bash
bun skills/Fabric/Tools/DesignDocumentCheck.ts <file|-> [--no-render] [--json]
#   exit 0: shape holds and every Mermaid block renders through mmdc
#   exit 1: prints each failed rule; exit 2: bad usage, unreadable input, or mmdc missing
```

### Intent-to-Flag Mapping

| Situation | Flags |
|-----------|-------|
| Before delivery (the default) | none: shape checks plus Mermaid rendering |
| Re-checking shape after a text-only fix to a draft whose diagrams already rendered unchanged | `--no-render` |
| Reading the result in code | `--json` |

## Output format

```markdown
# Design Document: {system name}

## BUSINESS POSTURE

{one or two paragraphs: purpose, who it serves, stage, risk appetite; the assumed build for a bare idea}

### Business priorities

- {priority}

### Business risks

- {risk, most important first}

## SECURITY POSTURE

### Existing security controls

- security control: {control stated in the input, or the assumed baseline ending (assumed)}

### Accepted risks

- accepted risk: {trade-off}

### Recommended security controls

- {control, highest priority first}

### Security requirements

- {requirement}

## DESIGN

### C4 CONTEXT

(a fenced mermaid block)

| Name | Type | Description | Responsibilities | Security controls |
|------|------|-------------|------------------|-------------------|
| {element} | {type} | {description} | {responsibilities} | {controls} |

### C4 CONTAINER

(a fenced mermaid block, then the same five-column table)

### C4 DEPLOYMENT

{one line naming the environment shown}

(a fenced mermaid block, then the same five-column table)

## RISK ASSESSMENT

### Critical business processes

- {process}

### Data to protect

- {data}: {sensitivity}. {why}

## QUESTIONS & ASSUMPTIONS

### BUSINESS POSTURE

- {question}? Assumed: {default}

### SECURITY POSTURE

- {question}? Assumed: {default}

### DESIGN

- {question}? Assumed: {default}
```

Each `(a fenced mermaid block)` is a code fence opened with three backticks and the word mermaid. The diagrams may use Mermaid's C4 syntax (`C4Context`, `C4Container`, `C4Deployment`) or a `flowchart`, whichever renders the view more clearly. Every table row has five non-empty cells. Every list item outside the tables is a top-level `- ` bullet, the priority-ordered lists included: order alone carries the priority, never `1.` numbering or sub-bullets. A question may carry one sentence of context between its question mark and `Assumed:`.

## References

- Upstream: `Patterns/create_design_document/system.md` (BUSINESS POSTURE, SECURITY POSTURE with `security control` and `accepted risk` prefixes, DESIGN with C4 CONTEXT, CONTAINER and DEPLOYMENT as Mermaid plus five-column tables, RISK ASSESSMENT, QUESTIONS & ASSUMPTIONS, no bold or italics, reached through a "28 hours and 12 minutes" thinking script, a virtual whiteboard and an architect persona).
- `Tools/DesignDocumentCheck.help.md`: the checker's rules and exit codes.
