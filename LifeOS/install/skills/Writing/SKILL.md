---
metadata:
  short-description: "Author and revise prose in the principal's voice; audit AI patterns and score with Pangram. Use DetectAI for detection only and WriteStory for fiction."
name: Writing
version: 1.3.1
evals:
  suites: [voice-principal]
  deterministic:
    - command: 'bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/ContextLoad.ts" Writing load assemble'
      falsifier: "the Assemble bundle cannot load its required instructions"
    - command: 'bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/ContextLoad.ts" Writing load principal'
      falsifier: "the principal-voice bundle cannot load its intent, data table or tools"
  manual:
    reason: "source fidelity depends on an editor comparing the assembled draft with the retained source"
    falsifier: "the editor finds invented meaning, an unjustified repair, or a missing unresolved gap"
description: Authors and assembles prose from the principal's material, audits AI patterns, and scores with Pangram. USE WHEN assemble a transcript, shape dictated notes, organize rough spoken material, write as me, write in my voice, sound like me, this does not sound like me, fix the voice, remove AI-isms, audit writing, clean up AI writing, check for AI patterns, sound less like AI, show me the draft, preview the article, open the draft properly. NOT FOR detection only (DetectAI), fiction (WriteStory), placing a finished blog post, or writing social posts.
---

# Writing

Author and revise prose in the principal's voice, audit confirmed AI-writing patterns, and report Pangram scores. The voice itself is data the install supplies: a measured corpus model under the configured voice directory, plus the style guide at `LIFEOS/USER/PRINCIPAL/WRITINGSTYLE.md`. The skill holds the tools that measure, gate and judge against it.

## Ideal State

- Every change to someone's text traces to a confirmed finding or a source span: facts, numbers, quotes, links and the writer's meaning survive, and nothing is added that the source or brief did not supply.
- Prose in the principal's voice aims at the measured corpus model and the anchor piece and clears `VoiceGate.ts` and `VoiceJudge.ts` without being degraded to pass; stripping AI-isms alone never counts as done.
- Every Pangram number comes from a real `PangramScore.ts` run and is reported as a signal with its caveats, never as a pass/fail gate.
- A check that could not run (no config, no key, no Interceptor) is reported as not run, never as passed.

## Intent Routing

| Intent | Trigger | File | Bundle |
|--------|---------|------|--------|
| **Rewrite** (default) | "deai this", "remove AI-isms", "clean up AI writing", "make this sound less like AI", "sound more human", "writing check" | `Intents/Rewrite.md` | `rewrite` |
| **Detect** | "detect", "flag only", "audit only", "just flag", "scan for AI", "detect AI tells", "detect mode" | `Intents/Detect.md` | `detect` |
| **ScoreAI** | "score AI", "test for AI writing", "how AI does this read", "AI detection score", "pangram", "is this AI-detectable" | `Intents/ScoreAI.md` | `score` |
| **WriteAsPrincipal** | "write as me", "write this in my voice", "sound like me", "make it sound like I wrote it", "this doesn't sound like me", "fix the voice", long-form authoring or repair in the principal's voice | `Intents/WriteAsPrincipal.md` | `principal` |
| **Assemble** | "assemble this transcript", "shape these dictated notes", "organize this rough spoken material", "turn this stream of consciousness into prose" | `Intents/Assemble.md` | `assemble` |
| **Preview** | "show me the draft", "preview the article", "open the draft properly", let me see it properly | `Intents/Preview.md` | `preview` |

Uncertain routing, or a request that needs every legacy instruction, loads the `full` bundle (the complete guide and every intent file). Standalone detection with no rewrite intent routes to the public **DetectAI** skill instead; ScoreAI stays here because the publication audit runs it inline.

| File | Read when |
|------|-----------|
| `References/CompleteGuide.md` | the patterns and voice references Rewrite and Detect audit against, the voice config and tool tables, the hard formatting rules, and the skill's gotchas and examples (the bundles load its sections) |
| `Setup.md` | configuring the voice model for an install: config keys, `voice_dir` files, secrets, a proof run |
| `EvalState.md` | checking the `voice-principal` suite's current scores; Assay writes it into your install after the first suite run, so it is absent from a fresh copy |
| `Tools/` | `WritingConfig.ts` flags (`WritingConfig.help.md`); the voice tools are described in `References/CompleteGuide.md` § Tools |

### Loading a bundle

Before executing, load the matching bundle with the deterministic loader:
`bun "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/TOOLS/ContextLoad.ts" Writing load BUNDLE`

It returns the selected instructions, their mandatory dependencies and source hashes; follow every returned requirement. Required external references and audits still apply. Skill-local paths resolve from the skill root, `LIFEOS/` paths from the install root. An unchanged section already in context needs no second read; after compaction or a source change, reload the relevant bundle.

For bundle reads, set the shell tool output budget to 30000 tokens, and a code-mode wrapper's output budget to 30000 too. A truncation warning anywhere, not only at the `END CONTEXTLOAD` marker, means the load did not succeed.

`list` shows sections and bundles; `search "query"` searches the preserved guide. A failed search does not establish absence: inspect the index, broaden the query, or load `full`. If the loader fails, read `References/CompleteGuide.md` and every relevant intent file directly. Never proceed on a partial load.

## Data & Config

The skill config is `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/Config.md`. It names the voice directory (`voice_dir`, holding `Corpus.md`, `Exemplars.md`, `PostExemplars.md`, `VoiceProfile.md`, `VoiceProfile.json`), an optional published-content index (`corpus_cli`), the preview browser, and the few example phrases the gate and judge quote. With no config, `VoiceGate.ts` and `VoiceJudge.ts` stop with exit 2 and point at the guide. First-time set-up, field tables and a proof run: [`Setup.md`](Setup.md). The full key and file tables are in `References/CompleteGuide.md` § Data & Config, loaded by the `principal` bundle. `bun Tools/WritingConfig.ts status` reports what is configured.

The env key is `PANGRAM_API_KEY` (ScoreAI only).

## Gotchas

The skill's gotchas live in `References/CompleteGuide.md` § Gotchas, a `required` section in `Context.json` that every bundle loads.

## Examples

```
User: "deai this draft"
→ Rewrite (rewrite bundle)
→ Profile named, findings listed, a minimal-diff rewrite and a clean second-pass audit
```

```
User: "write the intro to this post as me"
→ WriteAsPrincipal (principal bundle)
→ A draft anchored in the principal's published position, with VoiceGate and VoiceJudge exit codes and a reported Pangram score
```

More worked examples live in `References/CompleteGuide.md` § Examples, loaded by the `full` bundle.
