# Script.json — the exact shape

```jsonc
{
  "title": "Why Gardens Need Fences",
  "slug": "garden-fences",                  // kebab-case; the run directory name
  "targetMinutes": 7,
  "source": { "url": "https://…", "title": "…", "author": "…" },
  "links": [{ "label": "Further reading", "url": "https://…" }],
  "thumbnail": { "white": ["GARDEN"], "accent": ["FENCES"] },   // ≤3 words total, one per line
  "beats": [
    {
      "id": "open",                          // kebab-case, unique
      "chapter": "Why Gardens Need Fences",  // present on the first beat and at each turn
      "narration": "…15–70 words…",          // display text; also the whisper reference
      "tts": "optional spoken override",     // only when display text would be misread aloud
      "visual": { /* one of the shapes below */ }
    }
  ]
}
```

## Visual shapes

| type | class | fields |
|------|-------|--------|
| `title` | motion | `title`, `subtitle?` |
| `points` | motion | `heading?`, `points` (2–5) |
| `compare` | motion | `left: {label, text}`, `right: {label, text}` (right carries the accent) |
| `race` | motion | `from`, `to`, `lanes: [{label, result, gates?, resultAt?}]` (2–3 lanes; a gated lane stops at each gate and parks short of the finish; result pieces land on their spoken words unless `resultAt` cues them) |
| `stat` | motion | `value`, `label` |
| `quote` | motion | `text`, `attribution` |
| `diagram` | motion | `nodes: [{id, label}]` (2–8), `edges: [{from, to, label?}]` |
| `screenshot` | screenshot | `url`, `selector?` (crops to the element), `caption?` |
| `scroll` | scroll | `url`, `start?` (CSS px from the top), `travel?` (CSS px), `caption?` |
| `zoom` | zoom | `url`, `selector` (required; region from the DOM), `caption?` |
| `code` | code | `code`, `lang`, `highlight?` (1-based lines), `title?`, `caption?` |
| `read` | read | `paragraphs: string[]`, `caption?` (voice mode only) |

Rules the lint enforces: known type, required fields, http(s) URLs, no X/Twitter URLs, unique kebab ids, 4–90 words per beat (hard bounds; the authoring target is 15–70, `Intents/Script.md`), chapters present with one on the first beat, no four consecutive beats of one type, estimated runtime within ±25% of `targetMinutes`.

## timeline.json (written by Narrate.ts)

```jsonc
{ "fps": 30, "gap": 0.35, "total": 431.2, "narration": "narration.wav",
  "beats": [{ "id": "open", "start": 0, "end": 12.4, "chunk": "<abs path>.wav", "words": [{ "w": "I", "s": 0.05, "e": 0.12 }] }] }
```

Beat `start` values are measured from the chunk files (ffprobe), never estimated. The composition places each beat's `Sequence` at `start * fps` and extends it through the gap.

## Voice runs

`run.json` sets `mode: "voice"` and `narrator: "recorded" | "clone" | "da"`. `Source/post.json` contains `{title,url,slug,links:[{label,url,p}],paragraphs:[{id,text,heading?}]}`. `heading` belongs to the following paragraph. Local markdown URLs use the user config's `blogBaseUrl` and frontmatter slug.

`Align.ts` writes `Narration/words.json` as `{words,total,coverage,unmatched}`. Each word is `{w,s,e,p?,i?}`; `i` is the zero-based whitespace word index within paragraph `p`. Unmatched inserted words have no post position. Coverage counts normalized matches, excluding substitutions.

`PlanBeats.ts` writes the same timeline envelope with `fps:30`, `gap:0`, `narration:"narration.wav"`, and `chunk:""` on every beat. Beats tile the waveform exactly from zero to its measured duration. Interior boundaries are pause midpoints. Narration comes from the words in that span. A single long paragraph can exceed the usual beat length.

Optional `Plan.json` is `{inserts:[{paragraphs:["p2"],visual:{type:"stat",value:"3",label:"Steps"},chapter?}]}`. Insert paragraph lists must be ordered, contiguous, known, and nonoverlapping. They force paragraph boundaries before replacing visuals. Read beats may repeat; voice lint relaxes word count and runtime targets while retaining the other schema checks.

`Lib.sentencesOf(text)` returns `{i0,i1,text}` with inclusive whitespace word indices. Capture and composition use this same splitter. `Assets/post.sentences.json` stores `{pageWidth,pageHeight,sentences:[{id:"p3.s2",p:"p3",i0,i1,rects:[{x,y,w,h}]}]}` in image pixels, measured from the marked screenshot rather than DOM coordinates.
