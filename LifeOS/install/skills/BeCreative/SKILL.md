---
name: BeCreative
evals:
  manual:
    reason: "idea novelty and usefulness are specific to the supplied creative brief and require a reviewer judgment"
    falsifier: "the reviewer finds the candidates materially repetitive, off-brief, or unable to support the requested choice"
metadata:
  short-description: "Brainstorm diverse ideas in one pass, or expand seed corpora into synthetic examples and test sets. Multi-round evolution is HillClimb Ideate."
version: 1.3.1
description: "Single-pass divergent ideation via Verbalized Sampling: surfaces the strongest of several diverse candidates, or expands a seed corpus into an eval dataset. USE WHEN be creative, brainstorm, divergent ideas, creative solutions, maximum creativity, tree of thoughts, radically different, name this, creative angle, technical creativity, novel ideas, expand this corpus, synthetic data, generate diverse examples, create test set. NOT FOR evolving ideas over several rounds, multi-cycle ideation, breakthrough ideas, ideate or id8 (HillClimb Ideate), new causal explanations of a phenomenon (Novelty), or adversarial critique (RedTeam)."
---

# BeCreative

Ask a model for "a creative idea" and you get the most probable one: the safe, already-seen answer. This skill pushes past that. Single-pass intents use Verbalized Sampling (generate several low-probability candidates, surface the strongest; see `ResearchFoundation.md`). SyntheticDataExpansion grows a small seed set into a diverse corpus. Ideas evolved over several rounds (a population of proposers, recombination with lineage, measured or cross-vendor fitness) are HillClimb's Ideate intent (`skills/HillClimb/Intents/Ideate.md`).

## Ideal State

- Each run surfaces several genuinely distinct candidates, compared against each other rather than by self-reported probability, and names the strongest for the brief.
- The candidates differ in kind (different assumptions, framings, formats or domains), never one idea in five outfits.
- When diversity is load-bearing, candidates are generated or judged across a second vendor, the lane chosen by whether the brief is taste-judged (Anthropic) or correctness-judged (OpenAI).
- SyntheticDataExpansion returns a corpus measurably more diverse than its seed set: a higher diversity index from `Tools/Diversity.ts index` than the seed.
- A request to evolve ideas over several rounds reaches HillClimb Ideate, never a single pass here.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| StandardCreativity | "be creative", "think creatively", default creative tasks | `Intents/StandardCreativity.md` |
| MaximumCreativity | "maximum creativity", "most creative", "radically different" | `Intents/MaximumCreativity.md` |
| IdeaGeneration | "brainstorm", "ideas for", "solve this problem" | `Intents/IdeaGeneration.md` |
| TreeOfThoughts | "complex problem", "multi-factor", "explore paths" | `Intents/TreeOfThoughts.md` |
| DomainSpecific | "artistic", "business innovation", domain-specific | `Intents/DomainSpecific.md` |
| TechnicalCreativity | "technical creativity", algorithm or architecture ideas | `Intents/TechnicalCreativity.md` |
| SyntheticDataExpansion | "expand corpus", "synthetic data", "generate diverse examples", "create test set from these" | `Intents/SyntheticDataExpansion.md` |

"ideate", "id8", "evolve ideas", "breakthrough ideas", "multi-cycle ideation" and any request for several rounds route to HillClimb Ideate (`skills/HillClimb/Intents/Ideate.md`).

| File | Read when |
|------|-----------|
| `ResearchFoundation.md` | the Verbalized Sampling evidence base behind the single-pass intents |
| `Setup.md` | first-time setup: the OpenAI login TechnicalCreativity's second vendor needs, and a read-only check |

## Data & Config

User customizations, when present, live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/BeCreative/` (configRoot is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). Any PREFERENCES.md, configurations, or resources there override the defaults; when the directory does not exist, proceed with skill defaults.

First-time setup for the TechnicalCreativity vendor split is in [Setup.md](Setup.md).

## Gotchas

- **Verbalized Sampling adds nothing on tasks with one correct answer.** Use it where many answers are valid. A hill climb has one metric but many valid changes, so VS applies to its proposals (HillClimb Ideate), never to its keep decision (2026-10-11 analysis).
- **The model's self-reported probabilities are not evidence of novelty.** Compare the candidates to each other.
- **A single model's "diverse" set shares that model's defaults.** When diversity really matters (TechnicalCreativity, and HillClimb Ideate's rosters), generate or judge on a second vendor through `LIFEOS/TOOLS/Inference.ts --vendor`.
- **Taste-judged briefs (voice, naming, visual concepts) belong on the Anthropic lanes; correctness-judged ones (algorithms, architectures) on the OpenAI lanes.** Pick the `--vendor` accordingly when an intent calls a model directly.

## Examples

```
User: "Brainstorm products we could build from a patent portfolio"
→ IdeaGeneration
→ The most breakthrough of five approaches that rest on different assumptions, with why it beats the conventional answer
```

```
User: "Divergent scene concepts for a blog header illustration"
→ DomainSpecific
→ A scene concept that breaks a real editorial-illustration convention, chosen on that domain's criteria and justified against them
```

```
User: "Evolve ideas for a new featured content collection over a few rounds"
→ HillClimb Ideate (not this skill)
→ Generations from a code-drawn roster across bands and vendors, judge-scored with spread since there is no metric, the stopping condition named, each generation persisted
```
