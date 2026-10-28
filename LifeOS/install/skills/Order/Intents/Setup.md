# Setup — Install dd-cli and sign in

Goal: a verified `dd-cli` on PATH and a signed-in session in the macOS Keychain, so `Doordash.md` runs end to end.

## Ideal State

- `dd-cli --version` prints the release version; the tarball's SHA256 matched the published `.sha256` asset.
- `dd-cli cart list --intent "..."` returns without an auth error (proves sign-in AND waitlist approval; `--help` alone is gated and proves nothing).
- `Config.md` under `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Order/` holds the home address id and the default card's brand + last4, read from `address list` and `payment-method list`.
- If the account default address is not the house, `Config.md` records that too.
- The Verify commands (`cart list --beautify` and a `search` from the home address id) run clean.

## Anti-criteria

- Never `npm i dd-cli`, which is an unrelated package; the binary comes from GitHub Releases on `doordash-oss/doordash-cli`.
- The principal's own browser is not opened without their say-so. The recommended path suppresses the CLI's browser launch with `BROWSER=<script>` and runs the sign-in in the Interceptor test profile; without Interceptor, the principal runs `dd-cli login` in their own terminal and browser.
- Do not test `order submit` as verification.
- The vendor `dd-cli-usage` skill is not installed; this skill owns the contract.
- Never commit an exported `DD_CLI_ACCESS_TOKEN`, and never switch the account default address without the principal's ok.

## Safety gates

Checkout is verified the first time the principal actually orders, through the full purchase gate.

## Tool contract

Verified against v0.2.4.

- Source: GitHub Releases on `doordash-oss/doordash-cli` (the `doordash-oss` org). The `dd-cli` on npm is an unrelated community package.
- Assets: `dd-cli-v<ver>-darwin-arm64.tar.gz` (macOS Apple Silicon) and `-linux-amd64` (glibc Linux). Each ships a `.sha256` sibling.
- The tarball's `install.sh` copies the binary to `~/.local/bin/dd-cli` and strips quarantine. Run it non-interactively (`</dev/null`) so its agent-skill prompt is skipped (see Anti-criteria on the vendor skill).
- Full functionality is waitlist-gated per account. Download is open; the gate shows up as an auth/authorization failure after sign-in.

### Install

```bash
cd <scratch dir>
gh release download --repo doordash-oss/doordash-cli -p 'dd-cli-v*-darwin-arm64.tar.gz*' --clobber
shasum -a 256 dd-cli-v*-darwin-arm64.tar.gz      # must equal the .sha256 asset
tar -xzf dd-cli-v*-darwin-arm64.tar.gz
bash dd-cli-v*-darwin-arm64/install.sh </dev/null
dd-cli --version
```

Add `~/.local/bin` to PATH in your shell profile; a fresh Bash tool call may still need `export PATH="$HOME/.local/bin:$PATH"`.

### Sign in (the one human step)

`dd-cli login` runs an OAuth PKCE flow: it prints an `identity.doordash.com/authorize` URL, listens on `localhost:4180/oauth2/callback`, and stores the token in the Keychain. The password is the principal's, so the browser leg is theirs.

**Plain path (no Interceptor).** The principal runs `dd-cli login` in their own terminal, opens the URL it prints in their own browser (the CLI may open it itself), and signs in. Done when the command prints `Successfully logged in`.

**Assistant-driven path (needs the Interceptor skill's test profile).** Recommended when the assistant runs setup, so the principal's own browser is not opened. Capture the URL instead of letting the CLI open a browser:

```bash
printf '#!/bin/bash\necho "$1" >> <scratch>/login-url.txt\n' > <scratch>/nobrowser.sh && chmod +x <scratch>/nobrowser.sh
```

Start `BROWSER=<scratch>/nobrowser.sh dd-cli login -v > <scratch>/login.log 2>&1` as a background task the session waits on (the harness's background mode, not a shell `&`). Once `<scratch>/login-url.txt` has a line, open it in the test profile:

```bash
URL=$(head -1 <scratch>/login-url.txt)
bash ~/.claude/skills/Interceptor/Tools/EnsureTestProfile.sh
interceptor open "$URL" --context "$INTERCEPTOR_TEST_CONTEXT_ID" --group ddcli --activate --no-wait
```

Then tell the principal to sign in in that window. Wait on the `dd-cli login` task, not on a timer: it exits 0 with `Successfully logged in` or with `Error: Authentication/Authorization failed`.

### Fill Config.md

```bash
I='Summary: Set up DoorDash ordering for the account owner
user prompt/purpose: "<verbatim>"'
dd-cli --json-output address list --intent "$I"         # find the home entry; note address_id and which entry is_default
dd-cli --json-output payment-method list --intent "$I"  # default = cards[] entry matching default_payment_method_id; record brand + last4
```

Write both into `Config.md` (USER tree, never shipped), along with the "Per-order ceiling" line. If the account default is not the home address, record that too: `order submit` delivers to the default, and switching it (`address set --address-id <id> --yes`) is account-wide, so it waits for the principal's ok.

### Verify

```bash
dd-cli cart list --beautify --intent "$I"
dd-cli --json-output search --query "coffee" --address-id <home> --intent "$I"
```

## Gotchas

- **The listener times out after a few minutes.** If the principal has not signed in by then, the process exits with the same "Authentication/Authorization failed" text as a real denial. Check the tab: an empty login form means timeout, so restart `login` and re-open the NEW URL (the `state` param changes).
- `BROWSER=<script>` is honored (the binary is PyInstaller-packed Python; `webbrowser` respects it). Without it the CLI opens the principal's default Chrome.
- A headless machine has no Keychain: run `dd-cli export-token` on a signed-in Mac and set `DD_CLI_ACCESS_TOKEN` there. Never commit that token.
