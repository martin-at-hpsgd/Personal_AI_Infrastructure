# Send

A piece of feedback about LifeOS itself, recorded locally and, on the person's yes, filed upstream as a clean GitHub issue under their own account.

## Ideal State

- The feedback exists in the local ledger as an erratum with `target: lifeos-product` and `channel: feedback-command` before anything else happens.
- The issue text was written fresh from the person's own words, their kind tag, the component and the LifeOS version, with a short summary drafted in this session; nothing was copied from the erratum's context fields.
- Before the yes was asked, the person saw the exact issue title and body, its sha256, and a list of everything the scrubber removed (secret-shaped strings, home paths, their username, lines quoting `USER/` files).
- On yes, a duplicate search using only the approved title ran first and offered a comment on a matching open issue instead; then the issue or comment was filed under the person's own `gh` login, its URL was shown, and the URL was linked back onto the erratum.

## Anti-criteria

- Never forwards the erratum: nothing in the draft, the search or the filed issue is copied from its `cwd`, `requested`, `response_preview`, `session_id` or `instance`. When one of those values turns up in the person's own complaint or summary, it is struck: `cwd`, `session_id` and `instance` at 6 characters or more, `requested` and `response_preview` at 24 or more. Shorter values are left alone so a phrase the person typed is not mangled, and the person sees that text in the draft before saying yes.
- Never contacts GitHub, or any network service, before the person's yes on the exact text's hash; the draft and the scrub are local.
- Never files under any account but the person's own `gh` login, and never with text that differs from what they approved.
- Never files feedback whose target is this install rather than LifeOS itself; that stays in the local ledger.

## Safety gates

- **Approval is bound to the bytes.** `file` takes the sha256 the person just saw; if the rebuilt draft hashes differently, nothing is filed and the draft is shown again.
- **The yes is the person's message, never the hash.** `file` runs only after a principal message that arrives after the `draft` output, never in the same turn as `draft`. A session that ran `draft` can read the hash, so the hash alone proves no one said yes (`Tools/Send.help.md` § Approval boundary).

## Tool contract

```bash
bun skills/Errata/Tools/Er.ts --product --channel feedback-command <text>     # records; prints the erratum id
bun skills/Errata/Tools/Send.ts draft <id> [--summary-file <path>] [--comment-on <n>] [--json]   # local only: target, title, body, sha256, removed[]
bun skills/Errata/Tools/Send.ts file <id> --confirm <sha256> [--comment-on <n>] [--json]   # dedupe on the approved title, then gh
```

### Intent-to-Flag Mapping

| The person says | Flag | Effect |
|---|---|---|
| "/feedback <text>", "report this to LifeOS" | `Er.ts --product --channel feedback-command`, then `draft` | Records locally, shows the draft and what was removed |
| "yes, file it" | `file <id> --confirm <sha256>` | Duplicate search on the approved title, then files under their gh |
| "add it to that existing issue" | `draft <id> --comment-on <n>`, show it, then on yes `file <id> --confirm <new sha256> --comment-on <n>` | Comments on issue n instead of opening a new one; the target is inside the hash, so a hash approved for a new issue never authorizes a comment |
| "just keep it local" | (stop after `draft`) | The erratum stays in the local ledger only |
