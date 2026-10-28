# SecureByDesignQuestions

The questions a builder must answer at design time to make a specific thing secure (a system, a feature, a physical structure, anything that can be built), grouped by theme and ordered by what matters most, under a short overview of what is being built and what is at stake.

Our ideal-state port of Fabric's `ask_secure_by_design_questions`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The questions are about what the principal actually wants secured, inferred from the input before a word is written and never asked for. A pasted artifact (a design doc, an architecture note, an ISA, code, a config, a diagram in text) means that design as written: its components, data, actors and trust boundaries. A URL or a file means the thing it describes, read in full. A bare topic or question ("a password reset flow", "how do I secure a webhook receiver") means a typical build of that thing, and the overview names the build assumed. "This", "that" or nothing at all means the system we have been discussing in this conversation. A typed hint ("focus on supply chain", "for a hospital", "auth only", "for a physical site") overrides the default read and shapes the themes and their order.
- The overview says in one paragraph of about 25 words what is being built and why securing it matters, naming the specific asset or harm at stake (what an attacker gains, or who gets hurt), never a generic line such as "security is important for any system".
- Every question is specific to this input. It names a component, data flow, actor, boundary or failure mode of the thing described, and a question that would fit most other systems as well ("Is sensitive data encrypted?") fails.
- Every question asks for a design decision the builder can answer and act on before building: it is phrased to force a concrete answer (which, where, how, what happens when, who can), not a yes that can be given without thought, and it is never an implementation-trivia or compliance-checkbox item unless the input is about that.
- No question asks what the input already answers. When the design states a control (it signs webhooks with HMAC, it uses OAuth with PKCE), the question moves to the decision behind or after that control (how the secret rotates, how a replay is rejected, how a refresh token is revoked).
- The themes come from where this thing can actually fail. A web service gets themes such as AUTHENTICATION or DATA HANDLING, a physical structure gets themes such as STRUCTURAL FAILURE or PHYSICAL ACCESS, and a theme that does not apply to the input is absent.
- The list is prioritized: themes run from the one whose failure does the most harm to the least, and within each theme the most consequential question comes first. The questions that would prevent the worst outcome for this input appear in the first theme.
- The output has the shape in § Output format: an OVERVIEW of 15 to 35 words (aim for about 25; naming an assumed build does not license a longer one), then SECURE BY DESIGN QUESTIONS with at least three capitalized theme headings, 15 to 50 questions in all, each a single question of 10 to 30 words, no question repeated.
- A source is read in full before any question is written (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube and URLs), and every detail a question relies on is in the source or the conversation.
- The words are plain and exact: the precise ordinary word wins over jargon, and a security term is used only where it is the clearest name for the thing.
- `bun skills/Fabric/Tools/SecureByDesignQuestionsCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a generic checklist (an OWASP top ten restated, "use strong passwords", "keep software updated") passed off as questions about this input.
- Never answers, recommendations, mitigations, risk ratings or commentary in place of or beside the questions. The whole output is the two sections.
- Never a component, technology, vendor or requirement the input does not state, presented as if it did. An assumption about a bare topic lives in the overview, stated as the assumed build.
- Never a theme heading padded with questions that belong to another theme, and never two bullets that ask the same thing in different words.
- Never a source summarized from its title or a fetched page summary instead of its full text.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-securebydesignquestions — code checks on the two sections, theme headings and question shape, plus judged checks on specificity, input-kind inference, the typed-hint override, not re-asking what the design answers, and prioritization.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted artifact, a URL, a YouTube link, a file path, a bare topic or question, or "this"/"that" or nothing at all, which means the system under discussion in the current conversation.
- An optional typed hint that narrows or redirects the read: a focus area, a deployment context, an audience or a threat to weigh first.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/SecureByDesignQuestionsCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

## Output format

```markdown
## OVERVIEW

{15 to 35 words: what is being built, and the asset or harm that makes securing it matter}

## SECURE BY DESIGN QUESTIONS

### {THEME IN CAPITALS, highest harm first}

- {one question of 10 to 30 words, most consequential first}?
- {question}?

### {THEME}

- {question}?

…
```

At least three themes and 15 to 50 questions in all. Each question is its own top-level `- ` bullet ending in one question mark.

## References

- Upstream: `Patterns/ask_secure_by_design_questions/system.md` (a 25-word OVERVIEW and 15 to 50 prioritized questions of 15 to 25 words under capitalized themes, reached through a "4 hours of virtual time" thinking script and a whiteboard persona).
- `Tools/SecureByDesignQuestionsCheck.help.md`: the checker's rules and exit codes.
