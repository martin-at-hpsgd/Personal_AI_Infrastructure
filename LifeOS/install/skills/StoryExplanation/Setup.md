# StoryExplanation

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryExplanation/Config.md && echo ok · optional

## What it does

StoryExplanation turns a source (a YouTube video, an article URL, a file, or pasted text) into a narrative explanation written in your own first-person voice. It tries several framings, commits to the one with the strongest hook, and renders it in the format you ask for: a three-part narrative, a version with a source link after each sentence, a five-line abridged version, or a numbered list of standalone points (CSE) that you can lift straight to social media. It needs the `fabric` command-line tool to pull YouTube transcripts and URL text, and a short description of how you write so the result sounds like you.

## Fill in

Create `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryExplanation/Config.md`. Smallest working example:

```markdown
---
version: 1.0.0
---

# StoryExplanation — Config

## Voice

- **Voice file:** LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryExplanation/Voice.md
- **Voice notes:** dry, short sentences, no exclamation marks

## Integrations

- **Opinion lookup:**
- **Save directory:** ~/Documents/explanations/
- **Explainer MCP tool:**
```

| Field | Meaning |
|---|---|
| `Voice file` | A file describing how you write; the explanation is written in that voice. Blank means first person, plain and conversational |
| `Voice notes` | One or two lines on your register, applied on top of the voice file |
| `Opinion lookup` | A command that prints your published position on a topic; when set, the explanation is grounded in it first. Blank skips grounding |
| `Save directory` | Where the links version is saved, in `YYYY-MM` subfolders. Blank saves nothing |
| `Explainer MCP tool` | Name of an MCP tool that returns a five-point explanation. Blank uses the built-in prompt |

Then create the voice file named above, for example `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/StoryExplanation/Voice.md`:

```markdown
# My writing voice

## Register

- Person and tense: first person, present tense
- Tone: dry and matter-of-fact
- Sentence length: mostly short

## Words I use and words I avoid

- Use: plain verbs
- Avoid: "game-changer", "revolutionary"

## Samples

1. I read the report twice. The second time I noticed what it left out.
```

## Accounts and secrets

No account for this skill. It needs the Fabric CLI (`fabric`), an open-source tool whose source and install guide are at github.com/danielmiessler/fabric. Install it with any one of:

```bash
curl -fsSL https://raw.githubusercontent.com/danielmiessler/fabric/main/scripts/installer/install.sh | bash
go install github.com/danielmiessler/fabric/cmd/fabric@latest
brew install fabric-ai   # Homebrew names the binary fabric-ai; add: alias fabric='fabric-ai'
```

Then run `fabric --setup` once and pick a model provider. Fabric keeps its own model keys in its own config, so nothing for this skill goes in `~/.claude/.env`. The intents fetch a YouTube transcript with `fabric -y <URL>` and any other web page with `fabric -u <URL>`. `fabric -u` scrapes through the Jina AI service; if it prints an `AuthenticationRequiredError` instead of the page, Jina is refusing anonymous requests from your network, and you can paste the article text instead of the URL. An explainer MCP tool, if you name one, is configured in your MCP settings, not here.

## Prove it works

Two free checks first. Neither calls a model:

```bash
fabric --version
printf '%s\n' "1. Riverton moved its bus departures by three minutes." "2. The two busiest routes now meet at the downtown transfer." "3. Ridership on both routes rose twelve percent in four months." "4. The city bought no new buses to get that result." "5. A schedule change can do the work that a budget usually does." | bun ~/.claude/skills/StoryExplanation/Tools/CheckFormat.ts --format cse5
```

The first prints a version such as `v1.4.479`; `command not found` means Fabric is not installed. The second runs the skill's format checker on a made-up five-line sample and prints `ok: cse5 format` with exit code 0. The same checker, given a malformed sample, exits 1 and lists the violations.

Then check the model path. This one makes a small model call. It runs the skill's own shipped prompt through Fabric on a short invented paragraph, which checks that Fabric's model provider answers and that the prompt produces a story explanation:

```bash
{ cat ~/.claude/skills/StoryExplanation/Patterns/create_story_explanation/system.md; echo "Riverton moved its bus departures by three minutes so the two busiest routes met at the downtown transfer. Ridership on both rose 12 percent in four months, with no new buses."; } | fabric
```

Success is a short first-person narrative about the bus change, one sentence per line, ending on what it means. A `command not found` means Fabric is not installed; an authentication error from a model vendor means `fabric --setup` needs a working key.

Then ask the assistant: "/cse5" followed by the same paragraph. Success is exactly five numbered lines, one complete sentence each, with no commentary around them. If `Config.md` is missing the assistant says so once, points you at this file, and still answers in a plain first-person voice.
