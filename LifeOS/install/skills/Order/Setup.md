# Order

Status: command -v dd-cli >/dev/null && dd-cli --version && test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Order/Config.md && echo ok · optional

## What it does

Order turns a plain request such as "order me ramen" or "reorder my usual" into a real DoorDash order through DoorDash's official command line tool, `dd-cli`. Searching and browsing menus are free and happen without asking. Spending money never does: before any charge the assistant shows the full itemized cart (items, fees, tax, tip, total), the card and the delivery address, and waits for your explicit yes on that total. Every order has a per-order ceiling (default $75) enforced in code, and the skill submits only through a wrapper that needs a confirmation token you type back yourself. After each order, a watcher you run in a second terminal texts you when the driver is nearby and when it lands. Amazon is a designed stub and not built. It needs a DoorDash account approved for the CLI (the CLI is waitlist-gated) and a Mac, since the login token lives in the macOS Keychain.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Order/Config.md`. Smallest working example:

```markdown
# Order config for Alex Example

## DoorDash (dd-cli)

- **Home address id:** `1111111111`
- **Default card:** Visa ending 4242
- **Per-order ceiling:** $50 USD
- **Food preferences file:** `~/Documents/food-preferences.md`
- **`--intent` template:**
  Summary: Help the account owner order <what> to their home
  user prompt/purpose: "<the verbatim ask>"
```

| Field | Meaning |
|---|---|
| Home address id | The `address_id` of your home entry in `dd-cli address list` |
| Account default address | Which saved address DoorDash delivers to; `order submit` has no address flag, so check it before every order |
| Default card | Brand and last four from `dd-cli payment-method list`; named in every confirmation |
| Per-order ceiling | The code reads the first line that contains "Per-order ceiling" and a dollar amount such as `$50`. With no such line it uses $75. A line it cannot read as a positive amount stops the order |
| Food preferences file | Optional. A file of cuisines and dislikes so "get me food" can propose real picks |
| `--intent` template | DoorDash reviews this text on every command; keep it to the goal and leave out personal details |

With no `Config.md` the submit wrapper refuses to run and says to set the skill up.

## Accounts and secrets

- A DoorDash consumer account, approved for the CLI waitlist. Waitlist approval shows up only after you sign in.
- `dd-cli` itself, installed from GitHub Releases on `doordash-oss/doordash-cli` (never from npm, where an unrelated package shares the name). The install and sign-in steps are in `Intents/Setup.md`; `dd-cli login` stores the token in the macOS Keychain. The install puts the binary at `~/.local/bin/dd-cli`, the path the submit wrapper and the watcher call, so keep it there.
- No DoorDash key goes in `~/.claude/.env`. On a machine with no Keychain, `dd-cli export-token` on a signed-in Mac prints a token you can set as `DD_CLI_ACCESS_TOKEN` there; never commit it.
- **Twilio, for the order status texts.** The watcher sends them with `LIFEOS/TOOLS/NotifyPrincipal.ts`, which texts only you and reads these from `~/.claude/.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_TO_NUMBER` (your mobile, required), and `TWILIO_FROM_NUMBER` (optional; without it the tool uses the first number on your Twilio account). Create a Twilio account, buy or verify a sender number, and copy the account SID and auth token from the Twilio console. Without them orders still work, but no status texts arrive.
- **For the assistant-driven sign-in only: the Interceptor skill's test browser profile.** `Intents/Setup.md` opens the DoorDash sign-in page there. Without Interceptor, sign in yourself: run `dd-cli login` in your own terminal and open the URL it prints in your own browser.

## Prove it works

```bash
command -v dd-cli && dd-cli --version
dd-cli cart list --beautify --intent "Summary: Check setup"
```

Success: a version number, then a cart listing (possibly empty) with no authentication error.

Then check that the submit wrapper reads your ceiling. Write a request far above any ceiling to a scratch file and ask for a confirmation; the wrapper refuses before it calls DoorDash, so nothing is ordered:

```bash
printf '{"cartUuid":"setup-check","tipCents":0,"amountUsd":100000,"card":"setup check","address":"setup check","intent":"Summary: setup check"}' > /tmp/order-setup-check.json
bun ~/.claude/skills/Order/Tools/SubmitOrder.ts /tmp/order-setup-check.json --issue-confirmation
```

Success: exit code 2 and `Order refused: ... at or below $<your ceiling> required`, with the ceiling from your `Config.md` ($75 if it names none). `No order config at ...` means `Config.md` is missing. Never test a real `order submit`; checkout is verified by your first real order through the full confirmation step.
