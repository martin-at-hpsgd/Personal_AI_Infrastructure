---
provenance: template
version: 1.0.0
---

# USStats — install config

Read at run time by `skills/USStats/Tools/UsStatsConfig.ts` (one `key: value` per line inside the block below). `USSTATS_DATA_URL` in the environment overrides `data_url`. Setup guide: `skills/USStats/Setup.md`.

```
data_url: https://stats.example.com/data/stats.json
site_name: stats.example.com
seed_source: the ExampleNet metrics repo's Data/US-Common-Metrics/ folder
seed_checkout_hint: a checkout of that repo's Data/US-Common-Metrics
```

- `data_url` (required for Analyze and SyncCheck): the JSON almanac endpoint, schema in `skills/USStats/SKILL.md` § Data Contract.
- `site_name` (optional): the name printed in CLI help.
- `seed_source` (optional): where the four US-Common-Metrics seed files come from, printed when the dataset is unseeded.
- `seed_checkout_hint` (optional): the checkout path hint printed beside `seed_source`.
