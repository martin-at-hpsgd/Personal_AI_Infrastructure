# Review

LifeOS reviewing itself on a daily, weekly and monthly cadence. It is recommend-only: it writes its own state under `LIFEOS/USER/REVIEW/`, emits Vigil events when Vigil is installed, and files one Upgrades record when the principal says yes to a recommendation. Nothing else in the system changes because of it.

| Command | What it does |
|---|---|
| `bun LIFEOS/REVIEW/Review.ts daily [--json]` | Instrument health, control chart, new clusters, due watches |
| `bun LIFEOS/REVIEW/Review.ts weekly [--json] [--dry-run]` | Pools every generator, ranks them, asks for at most three decisions |
| `bun LIFEOS/REVIEW/Review.ts monthly [--json]` | Scores predictions, writes the scorecard and a label batch |
| `bun LIFEOS/REVIEW/Review.ts list [--json]` | Open recommendations |
| `bun LIFEOS/REVIEW/Review.ts decide <id> y\|n [--note "…"]` | The principal's yes or no |
| `bun LIFEOS/REVIEW/Review.ts status --json` | Everything the Pulse `/review` page shows |

The Pulse module `LIFEOS/PULSE/modules/review.ts` serves the same data at `GET /api/review` and accepts decisions and labels over `POST /api/review/decide` and `POST /api/review/label`.
