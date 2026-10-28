# ShowOpportunities

Analyze the current opportunities list and return prioritized, actionable recommendations for the speaker.

## Ideal State

- Every opportunity on the tracked list is bucketed into Immediate / High Priority / Worth Watching / Pass on fit × timing, where fit is topic-fit against `## Topics` in Config.md (SKILL.md § Data & Config) and timing is deadline urgency.
- The list is ranked by days-to-close, soonest first, and bucketed by the urgency windows in SKILL.md (Immediate, High Priority, Worth Watching).
- Each surfaced opportunity gets one concrete next step, a specific action carrying a URL or contact: the CFP/nomination form, the key contact, or the warm-intro path.
- The analysis lists paid speaking slots plus the very-high-prestige exceptions the list flags; each exception is marked unpaid or fee unknown on its Pay line, and every other unpaid slot is left out.
- The answer is a direct, strategic verbal analysis focused on what to do, in the output format below, ending with Analysis Notes on patterns noticed, suggestions for positioning, and gaps in the list to address.

## Anti-criteria

- Never gives generic advice: every recommendation is specific to its opportunity.
- Never leaves an opportunity in the analysis without its CFP/submission deadline.
- Never recommends an event listed under `## Excluded events` in Config.md.

## Output format

```
## 🎯 Immediate Action (Closes Within 14 Days or Rolling)

### [Conference Name]
- **Why:** [1-2 sentence fit explanation]
- **Action:** [Specific next step with URL/contact]
- **Deadline:** [Date]
- **Pay:** [Tier]

## ⚡ High Priority (Closes in 15-30 Days)

[Same format]

## 👀 Worth Watching (Calendar These)

[Same format with future action date]

## Analysis Notes

- [Any patterns noticed]
- [Suggestions for positioning]
- [Gaps in the list to address]
```

## Inputs

- The opportunities list (SKILL.md § Data & Config): the tracked opportunities.
- Config.md: topics, fee range and excluded events.
- `Sources.md`: what each kind of source yields.
