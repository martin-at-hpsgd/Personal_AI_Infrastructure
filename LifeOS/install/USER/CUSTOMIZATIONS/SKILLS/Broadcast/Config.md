---
provenance: template
version: 1.1.0
---

# Broadcast Config

Account-bound values for the Broadcast skill. Every key and what it means is in the skill's `Setup.md` § Fill in. The skill reads each `key = value` line below with a per-key match at the start of a line (first match wins), so write each key once and start no other line in this file with a key name. Posting to X, LinkedIn, Bluesky and Instagram needs nothing here; only podcasts, newsletter shares and the two optional posting preferences read this file. API keys are never stored here; their values live in `~/.claude/.env`.

The values below are made up. The placeholder GUIDs pass the tool's presence check and fail at the Omny API until you replace them.

## Podcast (Omny Studio)

omny_program_id = 00000000-0000-0000-0000-00000000a001
omny_playlist_ids = 00000000-0000-0000-0000-00000000b001, 00000000-0000-0000-0000-00000000b002
omny_rss_container_id = 00000000-0000-0000-0000-00000000c001
omny_episode_type = Full
omny_include_intro_outro = true
omny_auto_level_audio = false

## Newsletter share

newsletter_name = Example Weekly
newsletter_url = https://news.example.com
edition_label = Issue
share_sponsor_thanks = false
share_card = false
share_file_prefix = EW
share_highlight_own_writing = false
share_writing_audit = false

To turn the edition card on, set `share_card = true` and add `share_card_spec = <path relative to ~/.claude>` on its own line, pointing at your card's brand file (`Setup.md` has a worked example). Add `newsletter_share_overlay = <path relative to ~/.claude>` on its own line to apply a file of your own share rules on top of the ShareNewsletter intent.

## Posting preferences

Both default to `false`. `house_style = true` turns on the bundled style rules (an unstyled LinkedIn post is refused unless `--linkedin-plain`); `video_followup = true` follows a video-anchored post with the video link without asking.

house_style = false
video_followup = false

## Handles (reference only)

x_handle = example_writer
bluesky_handle = example-writer.bsky.social
instagram_handle = example_writer
linkedin_profile_url = https://www.linkedin.com/in/example-writer
