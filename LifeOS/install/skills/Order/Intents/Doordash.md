# Doordash — Order food and goods via the official dd-cli

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract

A real DoorDash order (or a free search, menu or status answer) placed through the official dd-cli behind the purchase gate.

## Ideal State

- A submitted order at or under the ceiling, delivered to the intended address, with a terminal `order status` surfaced.
- Before submit, the principal saw `order preview --beautify` verbatim (items, fees, tax, credits, total) plus the tip, the named card (brand + last4) and the delivery address in one message, and gave an explicit yes on that total.
- The submit ran once per cart, only through `Tools/SubmitOrder.ts`, with the confirmation token echoed back by the principal in their own message.
- Every submit reply hands the principal the `Tools/WatchOrder.ts` command for that order, to run in a second terminal, so they are texted at `dasher_nearby`, `completed` and any problem state.
- A reorder's gate message names every item from the original order's `items[]` that is missing from the new cart, from a diff made before the gate.
- A bare "get me food" ends with two or three concrete store + dish picks, proposed from a `search` at the home address and the food preferences file Config.md names (if any), and the principal's own choice.
- Search, menus and status questions are answered with no gate; the gate fires only at the charge.

## Anti-criteria

- No submit on silence, no bare `dd-cli order submit`, and no confirmation token typed for the principal: the yes on the shown total and the echoed token are theirs.
- No second `order submit` on a cart that already returned: the cart is spent and a re-run places a duplicate order.
- No `address set` without the principal's explicit ok, since it changes the app too.
- Never pick the store or dish for the principal; a food order is a charge.
- No ids hardcoded in this file, and `order checkout-url` is never handed over by default or opened in Interceptor's profile.

## Inputs

- `dd-cli` installed and signed in (`Intents/Setup.md`). `dd-cli cart list --intent "..."` returning without an auth error proves both.
- Config loaded from `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Order/Config.md`: home address id, default card, ceiling, intent template, food preferences file.
- The purchase gate (`../SKILL.md` § The Purchase Gate, reasons in `../Safety.md`) governs every step that reaches `order submit`.
- With no food preferences file, ask what the principal is in the mood for.
- Tip: if preview returned a suggestion, offer it; otherwise ask.
- PIN handoff: if `quote.dropoff_options[].proof_of_delivery_type` is `PIN_CODE`, say so before the gate.

## Safety gates

- `order checkout-url --cart-uuid <id>` is the browser fallback only when the principal wants an edit the CLI cannot make (swap card, change address on this cart). If used, open it in their own Chrome with `open -a "Google Chrome" "<url>"`.

## Tool contract

Wraps `dd-cli` (`github.com/doordash-oss/doordash-cli`, v0.2.4 verified). Every command below was read from the installed binary's `--help`, not the README. Search, menus, carts, preview, submit, status, and reorder are all live.

### Flags and behaviour (verified from `--help`)

- **Every command except `login` requires `--intent "<text>"`.** Two lines: `Summary: <who and the goal>` then `user prompt/purpose: "<verbatim ask>"`. No personal details in it; DoorDash reviews it.
- **`--help` is gated behind sign-in.** An auth error on `--help` means log in, not a broken binary.
- **`--json-output` is a ROOT flag**: `dd-cli --json-output search ...`, never after the subcommand. The payload is under `structuredContent`; ignore any `widget_type` / "the widget above" text.
- **`--beautify`** on `cart list`, `order preview`, `order status` prints the consumer-facing summary. Show preview's `--beautify` output verbatim; it is the itemized total the gate needs.
- **Location:** pass `--address-id <home id from Config.md>` to `search` / `find-nearby-stores` / `menu`. Omitting it falls back to `DD_LAT`/`DD_LNG` or a Cupertino default.
- **Delivery goes to the account-wide default address**, not the search address. `order submit` has no address flag, and the default is not always the home address (an old or travel address can still be the default). Check `address list` for `is_default` before the gate; if the home address is not default, `address set --address-id <id> --yes` after the principal's explicit ok (it changes the app too).
- **Money flags are cents.** `--tip-cents 500` is $5.00. `--tip-cents 0` only on an explicit decline.
- **Submit only through `Tools/SubmitOrder.ts`.** The wrapper holds the configured ceiling (Config.md, default $75) and a confirmation token bound to the re-read preview, addresses and payment methods. It refuses when the request's total is not the preview total, or its address and card are not the account's defaults.
- **`order submit` and `address set` prompt `Proceed? [y/N]` and abort on a non-TTY.** `address set` takes `--yes` once the principal has said yes. SubmitOrder.ts deliberately does not pass `--yes` to `order submit`, so dd-cli's own prompt still applies. An `Aborted!` result means nothing was charged.
- **`order submit` is not idempotent and charges the default card immediately.** Re-running with the same `cart_uuid` places a duplicate order. Treat the cart as spent the moment it returns.
- **One open cart per store.** `cart add-items` without `--cart-uuid` appends to an existing cart at that store. Run `cart list --store-id <id>` first.
- **Restaurant vs grocery/retail:** restaurants use `search` → `menu` → `restaurant-item-details`; groceries and retail use `find-nearby-stores --vertical <grocery|retail|convenience|pets|alcohol|nv>` → `find-items` / `build-grocery-list` → `item-details`.
- **Shell:** the Bash tool runs zsh, which does not word-split `$var`. Build commands literally or with `eval`; `dd-cli $c` with `c="cart list"` fails with "No such command 'cart list'".

### The order flow

```bash
I='Summary: Help the account owner order dinner to their home
user prompt/purpose: "order me ramen"'

# 1. Find (free, no gate)
dd-cli --json-output search --query "ramen" --address-id <home> --intent "$I"
dd-cli --json-output menu --store-id <store_id> --address-id <home> --intent "$I"
dd-cli --json-output restaurant-item-details --store-id <store_id> --menu-id <menu_id> --item-id <item_id> --intent "$I"   # options/modifiers

# 2. Build the cart (free, no charge)
dd-cli cart list --store-id <store_id> --intent "$I"        # collision check first
dd-cli cart add-items --store-id <store_id> --menu-id <menu_id> \
  --items-json '[{"item_id":"<id>","item_name":"<name>","quantity":1,"nested_options":[{"id":"<option_id>"}]}]' --intent "$I"
dd-cli cart show --cart-uuid <cart_uuid> --intent "$I"

# 3. Price it (free) — this output IS the gate artifact
dd-cli order preview --cart-uuid <cart_uuid> --beautify --intent "$I"
dd-cli --json-output payment-method list --intent "$I"      # name the card: brand + last4 of default_payment_method_id
dd-cli --json-output address list --intent "$I"             # confirm is_default is the intended address

# 4. GATE — stop. Show the beautified preview, the card, the address, the tip. Get an explicit yes on that total.

# 5. Submit (real money, once) — submit only through SubmitOrder.ts
#    The request carries the reviewed cart, the tip in cents, the preview's grand total in USD (refused above the ceiling; the wrapper also re-reads the provider's own total and refuses if that is above it or unreadable),
#    the card named at the gate, the delivery address, and the same --intent text.
cat > <scratch>/order-request.json <<'JSON'
{"cartUuid":"<cart_uuid>","tipCents":<n>,"amountUsd":<preview total>,"card":"<brand last4>","address":"<address id>","intent":"<the $I text>"}
JSON
bun ~/.claude/skills/Order/Tools/SubmitOrder.ts <scratch>/order-request.json --issue-confirmation
#    → re-reads `order preview`, `address list` and `payment-method list`, prints {action, detail, token}. Show the principal the token;
#      they echo it back in their own message. That echo is the confirmation; never type it for them.
bun ~/.claude/skills/Order/Tools/SubmitOrder.ts <scratch>/order-request.json --confirmation-token <the principal's echo>
#    The wrapper keeps dd-cli's own Proceed? prompt. `Aborted!` means nothing was charged.
#    If a submit fails or aborts, issue a fresh challenge and have the principal run the
#    --confirmation-token step in their own terminal.
#    The wrapper takes no --priority / --scheduled-time / --fulfillment; an order that needs them is the principal's to place.

# 6. Track, immediately after every submit. Give the principal this command to run in a second terminal:
bun ~/.claude/skills/Order/Tools/WatchOrder.ts --order-uuid <order_uuid> --label "<what, from where>" --interval 45 --max-minutes 120
#    It texts the principal at dasher_nearby, completed, and any problem state, and exits on its own at a final
#    status or after --max-minutes. It stops if that terminal closes. Log: LIFEOS/MEMORY/OBSERVABILITY/order-watch.jsonl
dd-cli order status --order-uuid <order_uuid> --beautify --intent "$I"   # one-shot answer to "where is my food"
```

`order status` values: `pending` (keep checking), `placed`, `store_confirmed`, `dasher_assigned`, `picked_up`, `dasher_nearby`, `completed` (terminal), `action_required` (terminal, point to the app), `order_declined`, `cancelled`.

### Reorder ("my usual", "same as last time")

```bash
dd-cli --json-output order history --intent "$I"                   # pick orders[].order_uuid and store_id
dd-cli cart list --store-id <store_id> --intent "$I"               # collision check
dd-cli order reorder --order-uuid <order_uuid> --intent "$I"        # returns a new cart_uuid
dd-cli order preview --cart-uuid <cart_uuid> --beautify --intent "$I"
```

Reorder drops out-of-stock items silently, which is why the `items[]` diff runs before the gate.

### Intent-to-command mapping

| The principal says | Action |
|-------------|--------|
| "what can I get delivered" / "search for X" | `search --address-id <home>`; show results, no gate |
| "get me groceries / cat food / batteries" | `find-nearby-stores --vertical <grocery\|retail\|...>` → `find-items` / `build-grocery-list` → cart → gate |
| "reorder my usual" | `order history` → `order reorder` → `order preview --beautify` → gate |
| "order me X" | search → menu → cart → preview → **GATE** → submit |
| "how far away is my food" | `order status --order-uuid <id> --beautify`; the watcher, if running, is already texting at nearby/delivered |
| "what's in my cart" | `cart list --beautify` |
