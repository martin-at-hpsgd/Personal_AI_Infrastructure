# Post

A single tweet or a thread posted to X through `Tools/post.ts` and verified by reading it back.

## Ideal State

- Every tweet, single or in a thread, is at most 280 X-weighted characters as `Tools/TwitterText.ts` counts them (every HTTP(S) URL is 23), and a thread's tweets remain in logical order.
- The posted text is the exact input text, with full canonical URLs unchanged.
- A success report rests on a `Tools/read.ts` read-back of every returned tweet in which the author, the exact intended text and every displayed `expanded_url` (especially final canonical links) match.

## Anti-criteria

- Over-limit text is never sliced or ellipsized; it is rejected.
- The script output is never treated as proof of posting: a missing post, or a URL expanded to a truncated destination, means posting failed.
- Nothing is posted without the principal's confirmation; posting is irreversible.
- A `SEND BLOCKED` result or a video PII-gate finding is reported to the principal with its finding, never bypassed; `--pii-reviewed` is used only on the principal's word, and `--skip-pii` only for bytes the principal authorized with `VideoPiiGate.ts approve-skip`.

## Tool contract

```bash
# Single tweet
bun run ~/.claude/skills/X/Tools/post.ts "Your tweet content"

# Thread
bun run ~/.claude/skills/X/Tools/post.ts "Tweet 1" "Tweet 2" "Tweet 3"

# From JSON
echo '["Tweet 1", "Tweet 2"]' | bun run ~/.claude/skills/X/Tools/post.ts

# Media on a single tweet (up to 4 files, comma-separated)
bun run ~/.claude/skills/X/Tools/post.ts "Watch this" --media clip.mp4

# Composed post: a JSON spec on stdin is how media lands on tweet 1 of a chain
echo '[{"text":"Hook","media":["clip.mp4"]},{"text":"Article: …"}]' | bun run ~/.claude/skills/X/Tools/post.ts

# Quote or reply: attaches tweet 1 to an existing tweet
bun run ~/.claude/skills/X/Tools/post.ts "My take" --quote <tweet-id>
bun run ~/.claude/skills/X/Tools/post.ts "Reply text" --reply-to <tweet-id>

# Dry run (validate only)
bun run ~/.claude/skills/X/Tools/post.ts --dry-run "Test tweet"
```

Every check runs before any byte reaches X, so a stop means nothing was sent:

- **Length and media:** over-limit text (`--long` raises the cap for a Premium long post), a missing media file, or more than 4 files on one tweet exits 1.
- **Video PII gate:** every video attachment is scanned by `LIFEOS/TOOLS/VideoPiiGate.ts`, in `--dry-run` too. Findings exit 1 until the principal reviews them and the run repeats with `--pii-reviewed`; `--skip-pii` is for a scanner that is down, never routine, and passes only for the exact bytes the principal authorized beforehand in their own terminal with `bun LIFEOS/TOOLS/VideoPiiGate.ts approve-skip <video> --reason "<why the scan cannot run>"`; without that authorization it exits 1 like a finding. Every used skip is recorded.
- **Send gate:** every real post passes `LIFEOS/TOOLS/lib/SendGate.ts`, which checks the exact text and each media file. A block prints `SEND BLOCKED (x)`, the finding, a `Block <id>` line and `Nothing was sent.`, and exits 1. The fix is to remove what the finding names and run the same command again. `--dry-run` does not run this gate.

Media needs the OAuth 2.0 grant. The OAuth 1.0a fallback posts text only, so a media tweet without a grant stops with an error naming `Setup.md`; in a thread, tweets before it may already be live, so read back what was returned.

Read back every returned tweet:

```bash
bun run ~/.claude/skills/X/Tools/read.ts <tweet-id-or-url>
```

### Rate limits

Each tweet in a thread is its own `POST /2/tweets` call and counts against the posting limit separately. `post.ts` does not retry: a rate-limited call exits 1 with `X API error (429)`, and in a thread the tweets already printed as `Posted:` are live, so read those back before running the rest.
