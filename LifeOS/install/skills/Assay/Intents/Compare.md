# Compare Intent

Paired A/B comparison of two configurations — prompts, agent levels, or a with/without ablation — on one suite.

## Ideal State

- The verdict is backed by a paired-difference 95% CI over the same cases, never two independent scores eyeballed side by side.
- Both arms ran the full suite, and the paired delta with its CI is reported.
- A falsifiable hypothesis and the meaningful-difference threshold were stated before the run: "B beats A" is refuted when the CI includes 0 or favors A.
- A TIE names the case count needed to detect the observed delta (power hint).
- The comparison JSON is persisted next to the suite's runs.

## Anti-criteria

- Calling a winner from two independent runs, or from means without the paired CI.
- A model-vs-model comparison pinned to a hardcoded model id.
- A conclusion shipped from a small, underpowered case set without the power hint.
- A hypothesis written after seeing the result.

## Tool contract

```bash
# Arm A = suite as-is; arm B overrides. Keys: system_prompt | system_prompt_file | agent_level
bun ${LIFEOS_SKILL_DIR}/Tools/Compare.ts -s <suite> --b '{"agent_level":"low"}'
bun ${LIFEOS_SKILL_DIR}/Tools/Compare.ts -s <suite> --a '{"system_prompt_file":"v1.md"}' --b '{"system_prompt_file":"v2.md"}' --label-a v1 --label-b v2
# Ablation (with/without a component): arm B's prompt file has the component removed —
# the delta IS the component's measured contribution.
bun ${LIFEOS_SKILL_DIR}/Tools/Compare.ts -s <suite> --b '{"system_prompt_file":"without-skill.md"}' --label-a with --label-b without [-t trials] [--json]
```

## Gotchas

- Model-vs-model comparison rides `agent_level` (tier alias → model via Inference), never a hardcoded model id — ids rot, aliases don't.
- A significant result on 4 cases is fragile; heed the power hint before shipping a conclusion.
- Duration is reported per arm; token counts are not available from the Inference envelope.
