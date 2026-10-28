---
provenance: template
---

# Google credentials

The calendar and mail integrations read one credential file per Google account here. Each file holds `client_id`, `client_secret` and `refresh_token`.

A file Google Cloud Console downloads is an OAuth client, not a credential: it has no refresh token. Make the first credential with `LIFEOS/TOOLS/GoogleMailboxAuth.ts`, following "First mailbox credential" in the inbox skill's Setup.md or "First credential, step by step" in the calendar skill's Setup.md. The flattened client file is kept as `client_secret.json`, which the mailbox scan skips.

Which credential a tool uses when none is named on the command line, in order:

1. `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`.
2. `integrations.google.credentialsFile` in `LIFEOS_CONFIG.toml`.
3. `credentials.json` in this directory, if it exists.
4. The only credential file here. With several and none of the above set, the tool stops and asks you to name one. A scheduled job must carry the variable in its own launchd plist.

Nothing in this directory ships; it is yours alone.
