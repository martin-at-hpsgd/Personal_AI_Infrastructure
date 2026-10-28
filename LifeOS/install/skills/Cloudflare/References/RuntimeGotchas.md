# Cloudflare Runtime Gotchas

Product- and runtime-specific failures that bite only some runs: Worker execution limits, static assets caching, D1 export and migrations, Durable Object containers, Astro, and when a Worker needs a Container at all. The gotchas every run needs stay in SKILL.md § Gotchas.

## Background work limits

**Post-response `waitUntil` work is capped at ~30 s; a cron tick gets 15 minutes.** A fetch-handler that answers fast and finishes a long job via `ctx.waitUntil()` dies about 30 seconds after the response, leaving any run row it opened stuck at `running`. Any job longer than that belongs on a cron trigger (or a Queue/Durable Object), with the HTTP trigger bounded to what fits inside 30 s; and every long runner needs a reaper for rows its predecessor left mid-flight. A Worker writing to D1 one statement per row pays a round trip per row (tens of milliseconds each), so a few hundred rows outlive a browser request; batch the writes (`db.batch([...])`) or move the job to a cron or Queue.

## Workers Assets bypass the worker

**Workers Assets bypass the worker — header rewrites need `run_worker_first`.** A request matching a static asset file is served by the asset layer directly; your fetch handler never runs for it, so worker code that sets headers on asset responses is silently dead. Asset default is `Cache-Control: public, max-age=0, must-revalidate` — for content-hashed files (e.g. `/_next/static/*`) that policy forces per-load revalidation and forbids stale-on-failure, which renders pages unstyled on flaky mobile networks. Fix: `"run_worker_first": ["/_next/static/*"]` in the assets block, then rewrite to `public, max-age=31536000, immutable` in the worker. Corollary: every deploy purges old hashed assets, so long-lived tabs 404 on their chunks — pair immutable caching with a client self-heal reload for SPA dashboards.

## D1 export

**D1 export chokes on FTS5 and can silently truncate a multi-`--table` export.** Both were observed with `wrangler d1 export`; check `cf d1 export` before relying on either. A DB with FTS5 virtual tables hard-errors: `cannot export databases with Virtual Tables (fts5)`. Passing `--table` per real table skips the virtual/shadow tables, but several `--table` flags in one call can return a schema-less dump of a few dozen bytes with exit 0. A robust pattern for exporting a DB with FTS tables: enumerate real tables (`sqlite_master` WHERE name NOT LIKE `%_fts%`/`sqlite_%`/`_cf%`), export one table at a time, verify each dump contains `CREATE TABLE` (retry once), concatenate under a single `PRAGMA defer_foreign_keys=TRUE;`. FTS indexes are derived — omit them and rebuild on restore (`INSERT INTO <t>_fts(<t>_fts) VALUES('rebuild')`). A D1 export also briefly locks the DB, so a back-to-back query can return partial — retry enumeration until count ≥2.

## R2 per-part checksums

**R2's bulk endpoint refuses a per-part SHA-256 on multipart UploadPart.** A presigned part URL that signs the SHA-256 checksum header gets 501 NotImplemented on the first real upload; R2's compatibility table marks that header and Content-MD5 unsupported on UploadPart. A local mock of the bucket accepts it, so only a live upload shows the gap (observed 2026-10-20). To make the server reject altered part bytes, send each part to a Worker URL you sign yourself: the Worker hashes the part, refuses a mismatch, and stores it through the R2 binding (`resumeMultipartUpload(key, id).uploadPart(n, bytes)`). The binding cannot list parts, so record each part's etag in D1 for resume. Keep parts well under the 128 MB isolate memory limit (32 MiB works well), and stream downloads with `(await bucket.get(key)).body`.

## D1 migration gotchas

- **Never rebuild a parent table in a D1 migration.** The `CREATE x_new / INSERT / DROP TABLE x / RENAME` recipe for widening a CHECK is fatal when other tables reference `x` with `ON DELETE CASCADE`: D1 runs with foreign keys on, `DROP TABLE` performs an implicit `DELETE FROM`, and every child row cascades away. `PRAGMA defer_foreign_keys = true` does not prevent it (a local SQLite run with the same pragmas also empties the child table), and `PRAGMA foreign_keys = OFF` is not available inside a D1 migration. Widen a constraint by adding a column (`ALTER TABLE x ADD COLUMN …`) or a new table; only tables with no referencing children may be rebuilt. Keep a test that greps the migration set for `DROP TABLE <parent>`.

## Durable Object containers

- **Durable Object containers need cf ≥ 1.0.0-beta.10 with its matching `@cloudflare/vite-plugin`.** beta.6 refuses every container-backed Durable Object export with "Container … must have exactly one Build Output config", whether the image is a Dockerfile or a registry reference. A project pinned to an older toolchain fails only on its container Workers; bump `cf`, `@cloudflare/vite-plugin` and `vite` together. CfEnv deploys with its own pinned cf (`CF_PACKAGE`, below beta.10 when this was written), so a container Worker also needs that pin moved (SKILL.md § How It Works).
- **A container application keeps the name it was created with.** Renaming a Worker in place leaves its container app and Durable Object namespace on the old name. cf names a container by the config's `defineContainer({ name })`, so a config that uses the new Worker's name creates a second application. Read the live names first (`GET /accounts/{id}/containers/applications`) and pin them in the config.

## Container vs isolate

A worker needs a Container only when it (a) needs raw socket access (e.g. SYN-style port scanning) or (b) executes untrusted or user-supplied code. Everything else — HTTP/DNS/API-only workloads, fetch + DoH patterns — runs in a native V8 isolate with no capability loss. A Cloudflare Container runs on Cloudflare itself; the Dockerfile only packages its image, and no separate Docker host is involved.

## Astro origin check

**Astro 5 on Workers enforces an origin check on POST.** A POST with no `Origin` header, such as a plain curl probe or a third-party webhook, gets a 403 before your handler runs. Send an `Origin` header matching the site, or use `security.checkOrigin: false` only on routes that verify their own signature.
