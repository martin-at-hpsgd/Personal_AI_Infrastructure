# Guards — what the code checks behind § Safety gates

SKILL.md § Safety gates states the rule: nothing non-trivial is built without criteria in an ISA, and in a project that has an ISA no change of any size skips it. This file is what code enforces today, and where it does not.

**Code sync refuses (2026-10-24, ISASystem.md § Code sync).** In a project that has an ISA, every change starts and finishes with it, and three checks share one resolver (`LIFEOS/TOOLS/IsaGoverning.ts`):

- **Start:** the LifeOSHooks plugin refuses an Edit, Write or MultiEdit of a file governed by an ISA until that ISA was read or written in the session.
- **Finish:** `IsaCodeSyncGate` (first in StopGates, not advisory) blocks a turn that changed governed code with no successful Edit or Write of its ISA in the same turn. No reply wording clears it.
- **Ship:** `ReleaseRecord.ts prepare --isc "…"` refuses a release unless a named criterion changed in the ISA over its range, and `check`, run by every CfEnv deploy, refuses the same.

The two older Development guards below were advisory and were retired with PreToolGuard on 2026-10-24 (native-security); they are kept here as history.

- **`DevelopmentEditGate`** flags the first edit into a project repo until the main thread has called `Skill("Development")` (or the principal typed `/development`) or declared one file trivial through `DevGate.ts trivial`. It does not read the ISA, it exempts subagents, and it fails open on an unreadable transcript.
- **`DevelopmentBuildGuard`** is the ISA check. It applies only to builder agents, codex workers and Workflows aimed at a project tree, and flags them when the project has no ISA.md with criteria or a ladder.
- **Acceptance is checked at run end, not at deploy.** The session records it as `acceptance:` under the ISA's `## Status`. `IsaCheck.ts acceptance <isa> --since <date>` reads that line and exits 1 unless the newest dated verdict is pass or waived and not older than the date; Build and Modify run it before their report. `Review.ts` and the deploy path do not call it, so a deploy started outside a Development run ships without it.
