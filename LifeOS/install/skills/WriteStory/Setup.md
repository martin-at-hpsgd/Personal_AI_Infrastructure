# WriteStory

Status: test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/Corpus/StoryProfile.json && test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/Corpus/Exemplars.md && echo ok · required

## What it does

WriteStory helps you build a story from your own notes: interview, story bible, scenes, revision. The planning half works from the first message. The prose half is gated: before it writes a word it needs a fiction voice model built from a corpus of published human short fiction, and it checks every draft against that model. Without the model, `StoryGate.ts` and `StoryJudge.ts` stop with "not configured" and the skill declines to draft. This guide builds the model once.

## Fill in

Everything lives under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/Corpus/` in your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Three steps.

**1. Corpus.json** names the collections to learn from. Use public-domain story collections from Project Gutenberg whose text starts with a `Contents` list of the stories. A made-up example:

```json
{
  "root": "~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/Corpus",
  "anchor": "the-lantern-keeper",
  "books": [
    { "id": 12345, "author": "A. Example", "title": "Example Stories" },
    { "id": 67890, "author": "B. Sample", "title": "Sample Tales", "skip": ["INTRODUCTION", "PREFACE"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `root` | Where the corpus is written. Keep it at the path above, because the gate and judge read the profile from there. |
| `books[].id` | The Project Gutenberg book number; the plain text is fetched as `pg<id>.txt`. |
| `books[].skip` | Contents entries to drop (prefaces, introductions). |
| `anchor` | Optional slug of the story you consider the model case. |

Stories under 900 words are dropped, so the corpus is long-form fiction.

**2. Build the model.** Run these three in order. The first downloads the books; the other two measure them:

```bash
cd ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/Corpus
bun ~/.claude/skills/WriteStory/Tools/BuildFictionCorpus.ts --config Corpus.json --fetch
bun ~/.claude/skills/WriteStory/Tools/BuildVoiceProfile.ts --manifest Corpus.md --out VoiceProfile.json
bun ~/.claude/skills/WriteStory/Tools/StoryGate.ts --build --manifest Corpus.md --voice VoiceProfile.json --out StoryProfile.json
```

**3. Exemplars.md** is yours to write: a markdown file of verbatim passages copied from the corpus, each with a short note on the move it makes (a scene carried by speech, a paragraph that ends on the last thing that happened). The assistant reads it in full before drafting, and the judge reads it as the reference. Ten to fifteen passages is enough.

Optional: a `PREFERENCES.md` in the skill's customization folder holds your standing choices; every section is optional and each book's own interview overrides it. `## Default genre` takes `Genre` and `Typical length` (short story, novella, novel or series). `## Aesthetic profile` takes `Profile`, a built-in name from `AestheticProfiles.md`, or a `### Custom profile` block (signature, characteristics, rhetorical figure emphasis, sentence length, descriptive density, pacing, sample register). `## Voice anchors` takes `Favorites` (3-5 stories you love and why), `Sample of your own prose` (a path to your writing) and `Reader target` (what a reader should feel on finishing). `## House rules` adds your own banned phrases to the anti-cliche sweep. Its `## Voice-profile bans` section feeds step 2: `- hard_zero: a, b` lists pattern names held at zero whatever the corpus does, and `- house_style_only: c` lists formatting habits fixed on sight; `BuildVoiceProfile.ts` refuses a section missing either key and uses empty lists when the file or the section is absent. Each book you start becomes a folder under `projects/<book-slug>/` with its interview notes and story bible; the skill creates those as you go.

## Accounts and secrets

No account and no key of your own. The only network call is the Project Gutenberg download in step 2. `StoryJudge.ts` grades through the Assay judge, which runs on the model access your LifeOS install already has.

## Prove it works

Write any short made-up draft to a file (a few lines with some dialogue is enough) and run the gate on it:

```bash
bun ~/.claude/skills/WriteStory/Tools/StoryGate.ts ~/draft.md
```

Success is a first line of `PASS` or `FAIL` followed by the draft's word count, then one line per measure that falls outside the corpus bands. A tiny draft will list many measures as "outside the band, not in the machine direction" and still pass. If the model is missing, the command exits 2 with `StoryGate: not configured — no profile at …`: redo step 2. For the judge half, `StoryJudge.ts` exits 2 with `not configured — no exemplars` until step 3 is done. Then ask your assistant "I have an idea for a story" to start the interview.
