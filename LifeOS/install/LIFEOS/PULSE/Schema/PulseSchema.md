# Pulse Schema

> **Status:** v1.0.0 · 2026-05-03
> **Source of truth:** `LIFEOS/PULSE/Schema/PulseSchema.ts`
> **Companion:** `LIFEOS/DOCUMENTATION/LifeOs/LifeOsSchema.md`
>
> **Data Plane retired 2026-10-14.** The Pulse Data Plane that built pages in this schema (page manifests, `AdapterRunner`, `RebuildAll`, the `PULSE_DATA/` writer and the v2 renderer) is gone: nothing had rendered its output since Pulse's pages moved to the Next app on 2026-07-04. Nothing produces data in this schema today. The schema and `ValidateSchema.ts` remain, and the LifeOS doctor (`skills/LifeOS/Tools/PulseHealth.ts audit`) checks only that the validator runs.

The Pulse Schema is the typed contract between USER/ files and the Pulse v2 UI. It formalizes the four render contracts from `LifeOsSchema.md` (collection, narrative, reference, index) as a Zod-validated discriminated union, plus shared `PageMeta` for adapter-run telemetry.

## The Four Kinds

Every Pulse page renders as one of four kinds — same as LifeOs. The kind is the discriminator on the union.

### `kind: collection` → `<CollectionView>`

Sortable list of items with optional creator, rating, notes, private flag. Used for: Books, Movies, Music, Restaurants, Podcasts, Meetups.

```ts
{
  kind: "collection",
  title: "Books",
  category: "taste",
  description?: string,
  items: CollectionItem[],
  meta: PageMeta
}
```

`CollectionItem`: `{ name, creator?, rating?: 1–10, notes?, private: boolean }`.

### `kind: narrative` → `<NarrativeView>`

Prose card with section nav and optional pull-quotes. Used for: Beliefs, Wisdom, OurStory, Rhythms, WritingStyle, Mission.

```ts
{
  kind: "narrative",
  title: "Beliefs",
  category: "mind",
  lede?: string,
  sections: NarrativeSection[],
  pullQuotes: string[],
  meta: PageMeta
}
```

`NarrativeSection`: `{ heading, body (markdown), level: 1–6 }`.

### `kind: reference` → `<ReferenceView>`

Key/value table, optionally grouped. Used for: Contacts, Pronunciations, Definitions, Architecture.

```ts
{
  kind: "reference",
  title: "Pronunciations",
  category: "voice",
  description?: string,
  entries: ReferenceEntry[],
  meta: PageMeta
}
```

`ReferenceEntry`: `{ key, value, notes?, group? }`.

### `kind: index` → `<IndexView>`

Tile grid linking to children. Used for domain directory roots: `Health/README.md`, `Telos/README.md`.

```ts
{
  kind: "index",
  title: "Health",
  category: "domain",
  description?: string,
  children: IndexChild[],
  meta: PageMeta
}
```

`IndexChild`: `{ path, title, kind, preview?, category? }`.

## PageMeta (shared)

Every page carries a `meta` block, which the retired `AdapterRunner` wrote to track build provenance and cost.

```ts
{
  schemaVersion: "1.0.0",
  pageId: string,
  lastBuildAt: ISO-8601,
  sourceHashes: Record<sourcePath, sha256>,
  adapterVersion: string,
  model: string,
  costUSD: number,
  latencyMs: number,
  provenance: "template" | "customized" | "mixed",
  warnings: string[]
}
```

`provenance` mirrors the source files' frontmatter — `template` if all sources are template, `customized` if any are customized, `mixed` if some of each.

## Categories

Categories follow LifeOs verbatim — `identity`, `voice`, `mind`, `taste`, `shape`, `ops`, `domain`. Users may extend with their own string values; Pulse auto-groups by the literal value.

## Validation

The CLI validates a JSON file against `PageDataSchema`:

```bash
bun LIFEOS/PULSE/Tools/ValidateSchema.ts <path-to-json>
```

returns exit 0 on valid output and exit 1 with `(field path) → message` lines on invalid output.

## Versioning

`SCHEMA_VERSION` is a string constant in `PulseSchema.ts`. Adding a new page kind, removing a field, or changing field types bumps the version.

## Adding a New Kind

The four kinds are intentionally stable. New rendering needs go through composition (a `narrative` page with a `pullQuotes` block, a `collection` page with grouped items) before they motivate a fifth kind. Adding a fifth kind requires:

1. Add the schema under `PulseSchema.ts` and append it to `PageDataSchema` discriminated union.
2. Add the schema export to `ALL_PAGE_SCHEMAS`.
3. Add a UI component under `LIFEOS/PULSE/Observability/src/components/`.
4. Bump `SCHEMA_VERSION`.
5. Update this doc.
