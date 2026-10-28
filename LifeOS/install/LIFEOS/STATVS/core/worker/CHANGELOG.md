# Changelog

## 0.15.1 — 2026-10-22
<!-- release: 86979a251d92c498da63e1895cdca440ed5fcb4a -->

A customer row with an unusual kind name such as constructor is refused on its own instead of failing the whole batch it came in.

## 0.15.0 — 2026-10-22
<!-- release: 1664c0767b5fafc9629ef7b5c11b2e95f0311b79 -->

GET /rows reads a page's stored files six at a time instead of one after another, so a cloud read of two weeks of rows takes seconds instead of a minute. A failed read reports the same error as before.

## 0.11.0 — 2026-10-18
<!-- release: fb35b9c02a1b1e7705ad4031dbd4941365cfde60 -->

Schema v4: a row can name the thing it is about (its subject) and what it did to it, so the record can show any thing's history and rebuild a past failure with everything connected to it. GET /rows?subject= returns one thing's rows. A subject is in the erasable text group, so a name that slipped into one can be cleared like a title.

## 0.6.0 — 2026-10-17
<!-- release: 32dc5a19b440af0b148cbedc0ce31a6fdfff1709 -->

Schema v3: every new row commits to its content through two hashes, so the record can erase a leaked secret or someone's personal data and every hash and checkpoint still verifies. The one erasure route: the erase credential plus {{PRINCIPAL_NAME}}'s typed approval clears a row's payload or text behind a signed tombstone.

## 0.4.6 — 2026-10-17
<!-- release: fe803f6a180f68f6dc95dd7a880c1d844f49aefa -->

A body refused under an earlier release's permanent note is judged again too.

## 0.4.5 — 2026-10-17
<!-- release: f42a82fb3e609ade79bd224ff952d14d7e1ceae7 -->

A row the core refuses for a reason a code fix can cure is no longer lost: the shipper stops at it and resends it, and a refused body is judged again on every upload. Masking settles on a token followed by query text. /health reports the real release version.

## 0.4.4 — 2026-10-16
<!-- release: 29bd6b13727bb11fdda8dea65e626911660df1c2 -->

Masking is linear on every input shape; build output ignored.

## 0.4.3 — 2026-10-16
<!-- release: 494834a616cb5778a5f373e0f21a45bd555e18f8 -->

Masking is linear on every input shape, so no transcript line can stall a request.

## 0.4.2 — 2026-10-16
<!-- release: f14d870f948612357d6d6f5a83cf959cdaacd097 -->

Build config for the Worker bundle.

## 0.4.1 — 2026-10-16
<!-- release: 98cbce03eda4d4d0798272dd436e1763811c2c84 -->

The Cloudflare config loader can follow the Worker's imports.

## 0.4.0 — 2026-10-16
<!-- release: b18e8b7d0886b1d26192188c0e6dfbc9107b3e61 -->

Masking closes the last review findings: strong-name values of any length, every curl and mysql credential flag, canonical JSON bodies, and a Worker bundle free of node modules.

## 0.2.0 — 2026-10-16
<!-- release: 604f1febef3e4bfb5bb34c1870f3c386e98cbcc1 -->

First release of the STATVS cloud core: append-only R2 segments, Merkle checkpoints, monthly D1 indexes, masked and provenance-checked intake.

