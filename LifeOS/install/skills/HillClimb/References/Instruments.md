# How the systems combine in one climb

HillClimb owns no instrument of its own. Each need in a climb is met by an existing system, and this table names which.

| Need | System | What it supplies |
|---|---|---|
| Which hill, and why it matters | Errata, Survey | Complaints per output, false passes, the most-broken rules, retire candidates |
| Where the top is | ISA | The ladder and criteria the target serves; new criteria are the standing checks a climb leaves |
| The altimeter | Assay | Suites, `EvalRunner` raw per-case rows, `Compare.ts` paired CIs, receipts from `Proof.ts` |
| The cheap judged tier | Assay's judgment layer | Typed questions over existing state, in shadow until labels earn them |
| Whether the judge is right | Labels, `Calibrate.ts`, `LabelBatch.ts` | Principal verdicts; the only thing that earns a judge |
| The experiment rules | `HillClimb.ts` | Seeded train/test split, noise floor, preflight, keep rule, stall categories |
| The record | Upgrades, the climb ledger | One record per climb; verified only when Errata shows complaints fell |
