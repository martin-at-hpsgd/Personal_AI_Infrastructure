# Harvest

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: test -f ~/.config/workflows/config.yaml && grep -q '^auth_token:' ~/.config/workflows/config.yaml && echo ok · required

## What it does

Harvest takes one piece of content (an article, a YouTube video, an X post, a PDF, an image, an audio file, or pasted text), reads it properly, and files it as a note in your Cortex memory with its source URL and links to related notes. A small cloud service does the classifying; the local tool fetches the content, calls the service, and hands the result to the local note writer. So a first-time user needs that service, a token for it, and a few command-line programs for the formats.

## Fill in

### 1. The service address

Put the base URL of your harvest service in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Harvest/Config.md` under your config root, as one line. The environment variable `HARVEST_API_BASE` wins over it if set:

```markdown
# Harvest — Config

harvest_api_base: https://harvest.example.com
```

Your config root is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`; the tool reads the file there and finds its sibling tools (`HarvestExecutor.ts`, `Inference.ts`, the X read tool) under the same root. It reads the value from the key's own line only and strips trailing slashes, so it must be a single `http(s)://` URL on the same line as the key; a blank or non-URL value counts as unset. With neither the file nor the variable set, the tool stops at start-up with `HARVEST_API_BASE not configured` and names the file and key it looked for, including for `--help`. Importing the module does not need it, so the maintainer-side fixture tests (not in the public release) pass before this step is done.

### 1b. Report preferences (optional)

`LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Harvest/PREFERENCES.md` holds plain-prose bullets the Mine intent applies on top of its default report shape (analysis, then the LifeOS upgrade pass); a preference can add a section, such as the DA's own commentary, or change how much weight each one carries. Leave the file out to keep the default:

```markdown
# Harvest — Preferences

## Harvest report

- Keep the analysis to three short paragraphs and lead the commentary with the strongest objection.
```

### 2. The token file

The bearer token comes from `~/.config/workflows/config.yaml`, not from `.env`:

```yaml
auth_token: replace-with-a-long-random-string
```

The line must start at the left margin as `auth_token: <value>`. Generate a long random value and set the same value as a secret on the service.

### 3. Build the service

A Worker with one D1 database (for example `harvest-db`) and two routes. Every route needs `Authorization: Bearer <auth_token>` and answers 401 otherwise.

| Route | Request | Returns |
|---|---|---|
| `POST /ingest-and-classify` | `{source, external_id, url?, title, body}`. `source` is `manual` for hand-fed content. `url` is omitted, never `null`, for text with no source page. | `{success, output:{status, id, items:[item]}, error?}` |
| `GET /items?limit=N` | none; also accepts `source=` and `external_id=` to look one up | `{success:true, items:[item]}` |

An item has: `id` (number), `source`, `external_id`, `title`, `url` (string or null), `classification`, `confidence` (0 to 1), `reasoning`, `routed_actions` (a JSON array of verbs as text), `ingested_at`, `routed_at`.

How it should behave:

- Store each signal once, under a unique key on `(source, external_id)`. A repeat returns `output.status: "duplicate"` with the existing id instead of a second row.
- After storing, classify with a model: pick a class such as `knowledge`, `learning` or `blog_seed`, give a confidence and a one-line reason, and choose the actions to run, from `create_knowledge_idea_entry`, `create_knowledge_source_entry` and `create_learning_queue_entry`. Write them to `routed_actions`.
- Judge relevance against your goals file (the TELOS summary) so the routing reflects what you care about, not generic topics.
- The body can be long; the local tool sends the full text and the service must accept it. The service does not return the body from `/items`, which is why the local tool passes it to the writer through a file.

The local writer (`LIFEOS/TOOLS/HarvestExecutor.ts`) polls `/items`, runs the routed actions, and writes the note under `LIFEOS/MEMORY/KNOWLEDGE/` (`Ideas`, `People`, `Companies`, `Research`, `Blogs`). You do not build that part.

### 4. Programs for each format

| Format | Needs | Install |
|---|---|---|
| YouTube | Gemini watch pass on the public URL | needs the key below |
| Audio files and X post video | `mlx_whisper` for audio (Apple Silicon; the `whisper` CLI is the fallback, model set by `HARVEST_WHISPER_MODEL`, default `small`; `HARVEST_MLX_WHISPER_MODEL` sets the mlx model); `yt-dlp` to stage an X post's video for its watch pass | `uv tool install mlx-whisper`; `brew install yt-dlp` |
| PDF | `pdftotext` | `brew install poppler` |
| Image | `tesseract` for OCR | `brew install tesseract` |

Plain articles and pasted text need nothing extra.

## Accounts and secrets

- A Cloudflare account for the service (see `skills/Cloudflare/Setup.md`), and a model for the classifier, either Workers AI or a key set as a Worker secret.
- `auth_token` in `~/.config/workflows/config.yaml` (above), mode 0600.
- `GOOGLE_API_KEY` in `~/.claude/.env` (a Google AI Studio key) for the Gemini watch pass on YouTube links and X post video; without it those two types fail and everything else works.
- Optional: `HARVEST_USER_AGENT` replaces the declared client name (`LifeOS-Harvest/1.0`) that every fetch sends. If your install seals the env file, re-seal after editing: `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.

## Prove it works

The dry run fetches and parses the content, then stops before any call to the service:

```bash
bun ~/.claude/skills/Harvest/Tools/harvest.ts "A paragraph of plain text long enough to pass the 200-byte floor for a text capture. It talks about a small experiment in filing notes, so there is something for a classifier to read. No link in it." --type text --dry-run
```

Success is exit 0 and a `--- HARVEST DRY RUN ---` block showing `type: text`, an `external_id` of the form `text-<16 hex>`, the body size and its first characters, then `(no Workflows POST, no executor)`. A missing address prints `HARVEST_API_BASE not configured`. For a URL, swap the text for `https://example.com/some-article --dry-run` and the block shows the fetched title and body length.

Once the service is up, drop `--dry-run` to run for real. Success is a summary block with a `workflows.id`, a `classification`, the `routed_actions` and an `executor.paths_written` list naming the note file, which should now exist under `LIFEOS/MEMORY/KNOWLEDGE/`. Running the same input again reports `duplicate`.
