---
provenance: template
version: 1.0.0
---

# Order config for Alex Example

Settings for DoorDash ordering. The assistant reads this at the start of every order, and `Tools/SubmitOrder.ts` reads the ceiling line. The DoorDash token itself lives in the macOS Keychain (written by `dd-cli login`), never here.

## DoorDash (dd-cli)

- **Account:** Alex Example's own DoorDash consumer account, signed in with `dd-cli login`.
- **Home address id:** `1111111111` (the home entry from `dd-cli address list`). Used as the search location.
- **Account default address** (optional note): the home address. Re-check `is_default` before every order.
- **Other saved addresses** (optional): work (`2222222222`).
- **Default card:** Visa ending 4242. Name it in every confirmation.
- **Per-order ceiling:** $50 USD
- **Food preferences file:** `~/Documents/food-preferences.md`
- **`--intent` template** (required on every command; DoorDash reviews it, so keep it to the goal):
  ```
  Summary: Help the account owner order <what> to their home
  user prompt/purpose: "<the verbatim ask>"
  ```
