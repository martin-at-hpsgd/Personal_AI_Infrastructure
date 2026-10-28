# Guard calibration corpus

Ground truth for the three SystemFileGuard questions, authored rather than harvested. The maintainer corpus is excluded from public releases. Supply your authored corpus using the calibration tool’s --fixtures option.

## Why it exists

The live cohort labels every question with the same scalar: one deterministic block becomes a
positive for identity, secret_in_prose AND user_data at once, and one pass becomes a negative for
all three. So tuning against it optimises agreement with the guard we already have, blind spots
included. It also carries three positives per question, which calibrates nothing.

This corpus labels each question independently, at authoring time, and reaches the 30-positive
floor on purpose instead of waiting ~33,000 production calls for it.

## Safety

Every case is **synthesized**. No real credential, no real person's data, no real file content.
Secrets are credential-SHAPED strings that were never valid anywhere. Two tests enforce it:
`corpus no real secret` runs the live salted-hash scanner over every case, and `corpus no real
identity` checks each case against the principal's actual identity fields read at test time.

## Labelling

A label answers what the content CONTAINS, not what a perfect oracle would conclude about the
world. `identity` is true when the content carries data of the kind that pins down one specific
person — a full name beside an address, a phone number, a personal handle. It does not require the
person to be real, because nothing reading the file can tell. The guard's job is the shape.

- `identity` — names a specific person with contact, address, or handle data
- `secret_in_prose` — contains an actual credential VALUE, not a reference to one
- `user_data` — personal or install-specific data that has no business in a shippable system file

The three are independent. A file can be true for all three, none, or any mix.

## Shape

One JSON object per line:

    {"id":"GC-001","rel_path":"LIFEOS/TOOLS/IscTier.ts","content":"...","labels":{"identity":false,"secret_in_prose":true,"user_data":false},"note":"why this case exists"}

`note` is for the human reading a disagreement later. It never reaches the engine.
