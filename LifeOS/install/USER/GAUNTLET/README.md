---
provenance: template
---

# Gauntlet — your question library

The Pulse `/gauntlet` page reads `catalog.json` and `runs/` in this
directory. With no catalog it shows an empty library.

## catalog.json

```json
{
  "version": 1,
  "updatedAt": "1970-01-01T00:00:00Z",
  "questions": [
    {
      "id": "example-question",
      "revision": 1,
      "title": "<short title>",
      "question": "<the question you want models to answer>",
      "domain": "<topic area>",
      "criterion": "<what a good answer must do>",
      "why": "<why this question matters to you>",
      "collection": "new",
      "visibility": "private",
      "relatedIds": [],
      "origin": { "title": "<where the question came from>", "url": "https://example.com/source" }
    }
  ],
  "context": []
}
```

- `id`: lowercase letters, digits and hyphens, unique.
- `collection`: original, new, or private. A private collection requires `"visibility": "private"`.
- `visibility`: private or public-candidate. Only public-candidate questions can be exported.
- `origin` and every `context` entry need an http(s) URL with no credentials in it.

`runs/` is written by the Gauntlet tools, one file per run. Set
`GAUNTLET_DATA_DIR` to keep the library somewhere else.

## Privacy

Private questions stay private: the export path refuses them. The library
never ships in a release.
