# HarvestYoutube

A YouTube video harvested into Cortex: transcript from a Gemini watch pass on the public URL, then Workflows classify, then HarvestExecutor write.

## Ideal State

- The Cortex note is built from a full transcript of what the video says, not its captions or page HTML, and lands through the canonical pipeline (Workflows classify, HarvestExecutor write).
- The note body names the transcript's source: the Gemini watch pass and its model, or the install's own transcript lane when one is present, with the watch pass as that lane's fallback.
- The reply reports the printed summary: source, classification, confidence, paths written.
- A transcript under 500 bytes ends in the tool's refusal to POST, surfaced as an error; a `duplicate` from Workflows is reported with the existing entry's path and not re-written.

## Anti-criteria

- Never tries to extract the transcript by `WebFetch` on the YouTube URL. The page is JS-rendered nav; the transcript is not in the HTML.
- Never POSTs to Workflows with the URL alone. Workflows' classifier needs the actual transcript text to score against TELOS.

## Inputs

Input host is `youtu.be` or `youtube.com`. The tool auto-detects this and routes here from `harvest.ts` even if `--type` is omitted.

## Tool contract

```bash
bun ~/.claude/skills/Harvest/Tools/harvest.ts "<YouTube URL>"
```

Internally the tool extracts the video ID, gets the transcript (per SKILL.md § Gotchas), then:

- POSTs to Workflows `/ingest-and-classify` with `source: "web"`, `external_id: "<videoId>"`, `body: <transcript>`, `title: <title — channel from YouTube oEmbed>`
- shells out to `bun ~/.claude/LIFEOS/TOOLS/HarvestExecutor.ts --item <id>`

## Gotchas

- **A transcript under 500 bytes is refused.** The likely cause is a video with no speech, or a watch pass that returned too little.

## Output format

The printed summary (fields in SKILL.md § Tool contract): source, classification, confidence, paths written.
