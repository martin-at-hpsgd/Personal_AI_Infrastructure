# ShareNewsletter

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format

A published newsletter edition turned into an emoji-forward LinkedIn share post (and X or Instagram shares when asked), approved by the principal, and posted via Broadcast. Four optional house features switch on from Config.md: a sponsor thank-you block, a designed edition share card, a required link to the author's own writing, and a writing audit before the draft is shown.

## Ideal State

- Edition resolved: the edition URL the principal gave; or, when Beehiiv is configured, the edition number the principal named or by default the latest `confirmed` post. With no Beehiiv credentials and no URL, ask for the edition URL once.
- The post is drafted to the Format Contract (LinkedIn) below and anchored in the edition's own prose and one-line summaries, with no invented takes.
- With `share_sponsor_thanks = true`, every sponsor the edition credits gets one thank-you line in the Sponsor block below, drawn from what the edition itself says about that sponsor, with the sponsor's link exactly as the edition printed it; an edition with no sponsors omits the block.
- With `share_card = true`, a designed edition card exists in both sizes (1600×838 wide, 1080×1350 4:5), built to the Share card contract below and to the brand file `share_card_spec` names, and reached `~/Downloads/<share_file_prefix><NNN>-share-card-{wide,4x5}.png` through ArtDirection's `Deliver.ts` with a passing critique bound to those exact bytes, staged for approval alongside the drafts.
- With `share_highlight_own_writing = true`, at least one highlight line links to the author's own writing (a blog post or project) when the edition carries one.
- With `share_writing_audit = true`, the draft cleared the writing audit (Safety gates) before it was shown.
- When Config.md sets `newsletter_share_overlay`, every rule in that file is met on top of this contract.
- The draft was shown to the principal and got an explicit go before it posted.
- Posted via Broadcast to LinkedIn, with the post URL or CLI success output as evidence.
- Any X or Instagram share of the edition matches its Format Contract (X) or Format Contract (Instagram) below.

## Anti-criteria

- Never posts without the principal's explicit go; doing so violates the external-content approval boundary.
- Story links never keep the newsletter platform's UTM params.
- No take, quote or summary in the share that the edition does not contain.
- A sponsor line never says more than the edition says about that sponsor, never appears in the "Some of what's inside" list or reads as the author's own endorsement, and a sponsor link is never altered.
- The share card is never a raw screenshot conversion, never AI-generated art, and a first draft never ships unjudged.
- A switched-on feature whose required key is missing never runs on a guess: the run stops and names the file and the key.

## Inputs

From the skill's Config.md (`LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/Config.md`; fields in `Setup.md`):

| Key | Used for |
|-----|----------|
| `newsletter_name` | the hook line and the X share |
| `newsletter_url` | the full-edition link, `<newsletter_url>/p/<slug>` |
| `edition_label` | how editions are numbered in the hook, e.g. `No.` or `Issue` (default `No.`) |
| `share_sponsor_thanks` | `true` adds the Sponsor block (default `false`) |
| `share_card` | `true` makes the designed edition card (default `false`) |
| `share_card_spec` | path, relative to `~/.claude`, to the card's brand file: mark image, wordmark, fonts, palette, layout system. Required when `share_card = true` |
| `share_file_prefix` | prefix for the card files, `<prefix><NNN>-share-card-{wide,4x5}.png` (default `edition-`) |
| `share_highlight_own_writing` | `true` requires a highlight line linking the author's own writing (default `false`) |
| `share_writing_audit` | `true` runs the writing audit before the draft is shown (default `false`) |
| `newsletter_share_overlay` | optional path, relative to `~/.claude`, to a file of further house rules applied on top of this intent |

When `newsletter_name` or `newsletter_url` is absent, ask for it once before drafting. When `share_card = true` and `share_card_spec` is absent or names a missing file, stop and report `Broadcast Config.md: share_card_spec` before building any card.

The edition itself comes from one of two places:

- **An edition URL** (any newsletter platform): the user passes the public URL of the published edition. Read its page text, keeping hrefs and headings. This needs no credentials and works for every platform.
- **Beehiiv** (optional): with `BEEHIIV_API_KEY` and `BEEHIIV_PUB_ID` in `~/.claude/.env`, the latest edition or a named edition number resolves through the Beehiiv API below. Without them, only the edition-URL path is available.

## Safety gates

- **Audit passed (with `share_writing_audit = true`):** `Writing` detect mode clean (zero P0/P1) and a real `PangramScore.ts` run, with the `✍️ WRITING-AUDIT:` line presented with the draft.
- **The principal approved:** the draft is shown first, always, with a `--dry-run` preview, and nothing posts without an explicit go.

## Tool contract

**From an edition URL:** fetch the page's raw HTML (`curl -s <edition-url>`) and strip it to text, keeping hrefs and headings.

**From Beehiiv (optional).** Each call loads the two keys into one `bun` process only; never `source` the env file, which puts every secret in it into your shell.

Resolve the latest edition:
```bash
bun --env-file ~/.claude/.env -e 'const r = await fetch(`https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUB_ID}/posts?status=confirmed&limit=1&order_by=publish_date&direction=desc`, { headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}` } }); console.log(JSON.stringify(await r.json(), null, 2))'
```

Fetch its full content (then strip HTML to text, keeping hrefs and headings), with the post id from the call above:
```bash
bun --env-file ~/.claude/.env -e 'const r = await fetch(`https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUB_ID}/posts/${process.argv[1]}?expand[]=free_web_content`, { headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}` } }); console.log(JSON.stringify(await r.json(), null, 2))' <postId>
```

**Post (after approval; dry-run first):**
```bash
bun ${LIFEOS_SKILL_DIR}/src/index.ts post --file /path/to/draft.md --platforms linkedin --dry-run
bun ${LIFEOS_SKILL_DIR}/src/index.ts post --file /path/to/draft.md --platforms linkedin
```

Add `--media <card.png>` when the share carries an edition image.

**Writing audit and share card (when switched on):**
```bash
bun ~/.claude/LIFEOS/TOOLS/PangramScore.ts /path/to/draft.txt
bun ~/.claude/skills/ArtDirection/Tools/Critique.ts --image <png> --brief <Brief.json>
bun ~/.claude/skills/ArtDirection/Tools/Deliver.ts --artifact <png> --critique <Critique.json> --to ~/Downloads
```

## Gotchas

- **Strip the newsletter platform's UTM params from story links.** Beehiiv's web content decorates every href with `?utm_source=newsletter...`; share the clean canonical URLs.
- **Sponsor links are copied exactly while story links lose their UTM params.** A sponsor's link carries the sponsor's attribution, so it ships byte-identical, redirects and params included.
- **Don't end a line with URL+period.** Keep bare URLs terminal on their line or mid-sentence with no trailing punctuation; a trailing period can become part of the link and 404.
- **An unescaped parenthesis once cut a numbered share mid-hook** ("(No. 42) is out"). `escapeLittleText()` and `assertLittleText()` close that class (SKILL.md § Gotchas).
- **Story summaries come from the edition's own one-liners**, lightly compressed. Rewriting them from the source articles loses the author's take.
- **An attached image replaces LinkedIn's automatic link card**; the edition URL then rides as plain text. With the share card on, that is intended.
- **Em dashes are closed** (`word—word`) when the writing audit runs; a spaced em dash is a P1 flag.

## Output format

### Format Contract (LinkedIn)

```
**[emoji] This week's [newsletter_name] ([edition_label] NNN) is out.**

One-line theme observation in the author's voice, from the edition's own prose.

Some of what's inside:

[emoji] Highlight sentence with story link (4-6 of these; each emoji matches the story's topic)
...

Plus [one tease line of 3-4 more topics], and more.

Full edition: [newsletter_url]/p/[slug]
```

- 4-6 highlight lines.
- Bare URLs only; LinkedIn auto-links. The bold hook line is part of this format; with `house_style = true` the tool also refuses unstyled LinkedIn content.
- Target ≤1400 characters (LinkedIn caps at 3000; shorter wins).
- Emoji lead each highlight line as visual structure, never scattered mid-sentence. This format carries emoji on LinkedIn even where a copywriting skill's default says none.

### Sponsor block (LinkedIn, with `share_sponsor_thanks = true`)

Appended after the "Plus …, and more." tease line and before the full-edition link:

```
🙏 Thanks to this week's sponsor[s]:

[emoji] SponsorName — one line from what the edition says about them. Their link, as the edition printed it, on the same line.
```

- One line per sponsor the edition credits, its link byte-identical to the edition's.
- Length target: ≤1400 characters before the sponsor block; ≤1800 with it.
- Instagram carries a one-line sponsor thank-you by name, with no links.

### Share card (with `share_card = true`)

Two sizes, staged to `~/Downloads/<share_file_prefix><NNN>-share-card-{wide,4x5}.png` for approval alongside the drafts.

- Left side lists the edition's main topics: the same emoji + highlight lines as the post's "Some of what's inside" block (4-6 rows, emoji on the left), plus the "Plus …, and more." tease line.
- A brand block above the topics: the mark, the newsletter wordmark in caps, an accent rule, `<edition_label> <NNN>` large, the date under it. Mark, fonts, weights, palette and layout system all come from the `share_card_spec` file; the skill carries none of them.
- Right (wide) or bottom (4:5): a slightly rotated screenshot panel of the edition's web page top, captured through Interceptor and cropped to the post header and hero.
- Built as real HTML/CSS through `Skill("Webdesign")` DirectDesign, fonts loaded through a fonts `<link>` (never fontconfig-name guessing or system fallbacks), rendered with `Interceptor/Tools/VerifyViewport.ts shot --width W --full`, cropped to exact dimensions, and read back as pixels. Browser rendering gives color emoji natively.
- The card runs the ArtDirection loop: critique each size, fix the ranked defects, re-render until it passes, then hand it over with `Deliver.ts`, the only path to Downloads for an artistic artifact.

### Format Contract (X)

Weighted ≤280 via `X/Tools/TwitterText.ts` (`assertValidTweetText`). Shape: `[emoji] [newsletter_name] [edition_label] NNN is out.` + one line of 3-5 comma-joined topic teasers + the clean edition URL. Edition image attached when there is one.

### Format Contract (Instagram)

Media-required; links are not clickable. Shape: hook line naming the edition, theme line from the edition's prose, `Some of what's inside:` emoji-led topic lines (no URLs), `Full edition: [newsletter domain]/p/[slug]` as plain text. ≤2,200 chars. A 4:5 edition image as the media.
