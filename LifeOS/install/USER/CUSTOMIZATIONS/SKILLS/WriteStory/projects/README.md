---
provenance: template
version: 1.0.0
---

# WriteStory projects

One directory per book, named by slug: `projects/<book-slug>/` (`skills/WriteStory/SKILL.md` § Data & Config). Each holds two files and both are the resume point: when they exist, the Interview re-reads them and continues instead of starting over (`Intents/Interview.md` § Ideal State).

```
projects/
└── my-first-novel/
    ├── interview.md   written by Interview
    └── ISA.md         written by BuildBible, updated by every later intent
```

## `interview.md`

Saved by `Intents/Interview.md` (§ Output format). It contains:

- The seed class (character, premise, plot, ...) and the derivation lens used, one line each with the reason
- The confirmed spine, every element labeled inferred-from-seed or offered, and ratified or redirected by you
- Per-layer state: each of the seven layers marked confirmed, partial, or open
- Favorites and reader target: 3-5 stories you love and why; what a reader should feel on finishing
- A one-page rough spine (Pressfield Foolscap: theme, dramatic question, hook, climax, three acts), marked disposable

## `ISA.md`

The Story Bible as a project ISA, created by `Intents/BuildBible.md` (§ Tool contract) through the ISA skill. It opens with its `## Ideal State` ladder seeded from the Foolscap spine (L3 the story in one sentence, L2 that sentence plus four bullets, L1 the full articulation), its `## Criteria` carry the character arcs, beats, and reveals that must land as `ISC-N` lines, and the body carries the beat map and layer detail. WriteChapter reads it before drafting; Revise and Explore update it. Nothing else in this directory is required: chapter drafts go wherever you keep your manuscript.

This directory ships empty. Real projects appear the first time you run the Interview.
