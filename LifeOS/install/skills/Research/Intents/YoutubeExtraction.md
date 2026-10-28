# YouTube Extraction

A YouTube video's content as clean text from Fabric, optionally run through a Fabric pattern.

## Ideal State

- The video's content comes back as clean text extracted by the Fabric CLI (`fabric -y`), which handles download, transcription and extraction itself.
- When analysis or summarization is asked for, the extracted content is processed through the matching Fabric pattern with `-p` (such as `extract_wisdom`, `summarize`, `extract_main_idea` or `create_summary`).

## Anti-criteria

- No yt-dlp or youtube-dl, no web scraping of YouTube, and no direct call to a transcription API: Fabric already does all three steps.

## Inputs

A YouTube URL with a request to extract, transcribe, analyze, summarize or process the video's text.

## Tool contract

```bash
fabric -y "YOUTUBE_URL"
```

With pattern processing:

```bash
fabric -y "YOUTUBE_URL" -p extract_wisdom
```

Common patterns: `extract_wisdom` (key insights), `summarize` (concise summary), `extract_main_idea` (core message), `create_summary` (detailed summary).

## Examples

```bash
# Extract raw content
fabric -y "https://www.youtube.com/watch?v=VIDEO_ID"

# Summarize video
fabric -y "https://www.youtube.com/watch?v=VIDEO_ID" -p summarize
```
