# Update

Move herdr to the current stable release without losing work in its panes.

## Ideal State

- `herdr status` shows client and server on the new version with no restart pending.
- `Tools/Freshness.ts` reads fresh on all five checks after the restart.
- The release notes were read, and anything that touches this install's config, wrapper, key mirror or hooks was named to the principal.
- No agent lost work it had not saved: the principal saw the live `herdr agent list` and gave an explicit yes after seeing it.
- Two or three Helm key-mirror chords were pressed in a herdr pane after the restart, by me or by the principal. They are the check because a release that changes keyboard handling breaks those first.

## Anti-criteria

- The update never proceeds without an explicit yes given after the principal has seen who is live and in what state; an agent that is `working` or `blocked` is a reason to wait.
- Never change the update channel (`herdr channel set`) unasked.
- Never `herdr server stop` as a shortcut to pick up a new binary.
- A failed update is never retried with different flags; the error text is reported and the work stops.

## Safety gates

The server owns every pane. Updating restarts it, and every agent inside stops, this session included when it runs in herdr.

The yes comes after the principal has seen a fresh `herdr agent list`. If this session is inside herdr, say that the update will end it, and that the post-update steps below need a new session or a terminal outside herdr.

## Tool contract

- `herdr update` downloads and installs the stable release. `--handoff` attempts a live handoff; it is experimental, so leave it off unless asked. A failed update leaves the old server running.
- Preview builds (`herdr channel set`) have their own docs index.
- `herdr status` reports client version, server version, `restart_needed` and `server_binary_stale`.
- `release-notes.json` beside `config.toml` holds the notes for the newest release once the client has seen them; the docs index links the rest.
- Agent sessions come back through the integrations' session restore. `herdr integration status` must read current for that to work.

After the restart, run `bun ~/.claude/skills/Herdr/Tools/Freshness.ts` and answer each stale check per `Intents/Freshness.md` § Output format.
