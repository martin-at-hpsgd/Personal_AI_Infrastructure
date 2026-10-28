# LinkedIn

Content posted to LinkedIn.

## Ideal State

- The post is live on LinkedIn within the 3,000-character limit, written as markdown and converted by the adapter to what LinkedIn can render per the conversion table below.
- With `house_style = true` in Config.md, every post carries the house styling: a bold hook line (`**…**`, usually the first sentence), `# Header` lines for sectioned posts, one bold element for short posts, and 0–2 emoji. With the key absent or `false` (the default), the author's markdown is converted as written and nothing is added.
- When the user provided actual written prose, it is posted with the words verbatim, with only minor line-break formatting if needed for readability and hashtags only if they ask for them.
- Rough notes or bullet points are never posted or expanded here: they go to a copywriting skill for drafting, and only the approved draft comes back to post, because Broadcast does not write copy (SKILL.md § Ideal State).
- A post with a URL and no media shows LinkedIn's link-preview card for that URL, with the target page's `og:image` as its thumbnail and the raw URL gone from the body.

## Anti-criteria

- The user's original voice is never rewritten or "optimized" when they provided actual written prose.
- With `house_style = true`, unstyled LinkedIn content is never posted except plain text on purpose via `--linkedin-plain` (the tool refuses it).

## Tool contract

```bash
# Preview, then drop --dry-run to post
bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts post \
  --content "CONTENT_HERE" \
  --platforms linkedin \
  --dry-run
```

- **Link cards are automatic.** When a LinkedIn post has a URL and NO `--media` attached, the adapter posts it as an `article` (link-preview card): it fetches the URL's OpenGraph metadata, uploads the `og:image` as the card thumbnail, and strips the raw URL from the body so the card carries the link — the same card the web app shows. Attaching `--media` (image/video) takes precedence and posts media instead (the URL then stays plain text; LinkedIn allows one content object per post). For a big-image card, the target page's `og:image` should be landscape (~1200×630); a square og:image renders LinkedIn's compact card.
- **Editing a live post:** `bun src/index.ts edit --urn urn:li:share:<id> --file post.md [--dry-run]` replaces the text in place; the card or media stays, and bold, italic, headers and mention tags render as they do on a new post. Post URNs are in `LIFEOS/MEMORY/STATE/Broadcast-<date>.jsonl`.
- Auth (60-day token, automated renewal) is in the Auth intent.

## Gotchas

| Issue | Solution |
|-------|----------|
| Token expired | Re-authenticate via Auth intent |
| 401 Unauthorized | Run `bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts status`; Broadcast reads the token from `~/.broadcast/credentials.json`, so re-run `LinkedInAuth.ts login` if it has lapsed |
| Rate limited | Wait and retry |

## Output format

- Voice and structure belong to the copywriting skill that drafted the post; this intent only transports.
- Write markdown. `src/format/linkedin-formatter.ts` converts it to what LinkedIn can render. LinkedIn has no rich text: what readers see as bold and italic is Unicode Mathematical SANS-SERIF letters.

| You write | LinkedIn shows | Note |
|-----------|----------------|------|
| `**bold**` | 𝗯𝗼𝗹𝗱 | sans-serif Unicode; digits too |
| `*italic*` | 𝘪𝘵𝘢𝘭𝘪𝘤 | letters only; italic digits stay plain |
| `***both***` | bold italic | |
| `# Header` | 𝗛𝗘𝗔𝗗𝗘𝗥 | bold ALL-CAPS line, hashes dropped; URLs and mentions in the line stay as written (the type is small, so caps are what read as a header) |
| `- item` | • item | inline styling still applies |
| `> quote` | 𝘲𝘶𝘰𝘵𝘦 | italic line |
| `https://…` | auto-linked | first URL becomes the card when no `--media` |
| `[text](url)` | text: url | no anchor text on LinkedIn |
| `@[Name](urn:li:person:ID)` | profile link | text must match first/last/full name, case-sensitive, else it renders plain |
| `@[Name](urn:li:organization:ID)` | company link | text must match the full company name |
| `#Word` | hashtag link | `#42` stays literal |

- Blank lines survive. Emoji pass through unchanged.
- Math letters are invisible to LinkedIn search and spelled out by screen readers, so styling stays on a hook or header, never body prose.
- `--dry-run` shows the converted text; the wire form is escaped and gated by `assertLittleText()` before POST.
