---
provenance: template
version: 1.0.0
---

# Webdesign — USER customizations

Declared in `skills/Webdesign/SKILL.md` lines 44-55. The skill reads one file from here.

| File | Read by | How |
|------|---------|-----|
| `PREFERENCES.md` | `Intents/DirectDesign.md` line 126 (after Step 0, biases the Step 1 register choice); `SKILL.md` line 55 (tokens passed into every brief, DirectDesign or NativeDesign); `References/FrontendDesignPhilosophy.md` line 217 | Prose, read by the model. No tool parses it. |

`SKILL.md` line 52 also shows an `EXTEND.yaml` in this directory. That manifest format is only understood by `LIFEOS/TOOLS/LoadSkillConfig.ts`, which nothing in the Webdesign skill imports, so no `EXTEND.yaml` is shipped. `Tools/VerifyDesign.ts` reads nothing from here.

Brand marks and fonts belong in `CUSTOMIZATIONS/SKILLS/Art/brand/`, not here; point at them from `PREFERENCES.md`.
