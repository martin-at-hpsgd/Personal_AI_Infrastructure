---
task: "Build BeanLine — peer-to-peer specialty-coffee bean marketplace"
slug: 20260901-090000_beanline-v1
project: BeanLine
phase: climbing
progress: 22/39
started: 2026-08-31T00:00:00-07:00
updated: 2026-04-25T03:14:00Z
---

<!-- isa-example claims=39 probes=39 era=current -->

<!-- Fictitious example. "BeanLine" is a teaching project name; any resemblance to real products or organizations is coincidental. The beanline.example.com domain is RFC 2606 reserved. -->

## Ideal State

### L3 · One sentence

BeanLine is where a verified roaster lists a small green-coffee lot on Wednesday and a verified buyer receives and confirms it on Friday, with neither side trusting the other beyond what the platform enforces.

### L2 · Summary

BeanLine is a two-sided escrow marketplace for green-coffee lots between 5 and 50kg, where identity, money, and condition are each enforced by the platform instead of taken on trust.

- Both sides are verified, so no listing and no purchase is ever anonymous.
- Payment is captured at purchase and released only when the buyer confirms receipt.
- Every lot ships with a QR handoff card, and a dispute path exists when the buyer does not confirm.
- It stays narrow: search by region, process, and harvest window, messaging only inside a transaction, and no auction, logistics, roasted-coffee, or social features.

### L1 · Full articulation

BeanLine is a two-sided escrow marketplace for green coffee lots too small for the commodity chain and too large for retail. The seller side is verified roasters and importers holding 5–50kg lots — overbought samples, festival remainders, micro-lot splits — who today move them through Reddit DMs, Discord servers, and festival tables, with no payment protection and no condition guarantee on either side. The buyer side is home roasters and small cafes who want single-origin lots at that scale and currently can't reach them at all.

The product is three promises made mechanical. First, identity: both sides are verified (business registration for sellers, payment-method verification for buyers), so a listing is never anonymous. Second, money: payment runs through Stripe escrow — captured at purchase, released on confirmed receipt — so neither side extends trust the platform doesn't hold. Third, condition: every lot ships with a QR handoff card; the buyer scans on receipt to confirm condition before escrow releases, and a dispute path exists when they don't. Search is by what buyers actually shop on — region, process, harvest window — not free text. Messaging exists only inside a transaction; BeanLine is not a social network, a forum, or a discovery feed, and it refuses every feature that would make it one. Reviews attach to completed transactions only.

What it refuses to be: an auction house (fixed listing prices), a logistics provider (sellers ship), a roasted-coffee shop (green only), and a content site. The one-sentence test of done: a roaster lists a lot on Wednesday and a cafe receives and confirms it Friday, with neither party having trusted the other beyond what the platform enforced.

## Problem

Specialty-coffee roasters with small-batch lots (under 50kg) and home-roasting hobbyists with green-bean surplus have no good place to find each other. Existing marketplaces (eBay, Etsy, Reddit's r/coffee) either don't support food-safe shipping logistics, charge consumer-marketplace fees that eat the margin on a 5kg lot, or have zero buyer trust signals for "is this bean stored properly?" Most lots end up sold at coffee festivals (one weekend a year) or composted. The supply exists. The connective tissue does not.

## Vision

A small focused marketplace at `beanline.example.com` where a verified roaster lists a 5–50kg lot with origin, processing, harvest date, moisture content, and tasting notes; a verified buyer (home roaster or small cafe) browses by region and process, pays via escrow-Stripe, and the lot ships with a QR-coded handoff card the buyer scans on receipt to confirm condition. Euphoric surprise: a roaster lists Colombia Geisha Wednesday and ships it to a third-wave cafe in Portland on Friday — no festival, no haggling, no Reddit DM dance.

## Out of Scope

- **No retail-bag pricing.** Minimum lot 5kg. Below that, the unit economics break for both sides.
- **No green-bean futures or pre-harvest contracts.** Existing physical lots only.
- **No roasted-bean retail.** Green coffee only; once it's roasted, the freshness window collides with shipping speed.
- **No multi-currency.** USD only in v1; international expansion requires a real customs and excise story we don't have.
- **No social-graph features.** No follow / friend / DM. Buyer-seller messaging is per-listing, not per-user-relationship.
- **No machine-only quality verification.** Listings carry seller-supplied data + buyer-confirmation handoff card; no third-party assay until v2.
- **No mobile native apps.** Web + PWA install. The buyer is at a desk pricing lots, not in line for boba.

## Principles

- Buyer trust beats catalog size. A verified-buyer + verified-seller marketplace with 200 lots beats an open marketplace with 20,000 lots and one fraud incident.
- The handoff card is the product, not the website. A clean post-shipment confirmation flow is what makes the next listing land.
- Roaster economics are non-negotiable: under 8% all-in fees or it doesn't beat festival sales.
- Defaults teach. If a buyer's first three searches return relevant lots, they convert; if the first three return junk, they leave.
- Editorial signals beat algorithmic personalization at this scale. Curation by humans (an in-house quality lead reviewing every new listing) is cheaper than building a recommendation engine.

## Constraints

- Edge SSR on Cloudflare Workers + D1 + R2. No third-party hosting in the user path.
- Auth via magic-link email only in v1. No password, no SSO. Verified-status (roaster vs buyer) gated by manual review of submitted business proof.
- Stripe Connect for escrow + split payments. No homegrown payment.
- All-in fees ≤ 8% (Stripe ~2.9% + 30¢ + BeanLine margin ≤ 5.1%).
- Bundle budget: ≤ 100KB JS gzipped on the listing page; ≤ 60KB CSS gzipped.
- p95 cold load on cellular ≤ 1s for browse pages, ≤ 1.5s for the listing detail page.
- Image storage in R2 with eager WebP transcoding; no original JPEGs ever served.
- Public read API rate-limited at 60 req/min/IP via Cloudflare WAF.
- All buyer-seller messaging logged for dispute resolution; retention 12 months minimum.
- HTTPS-only; HSTS preload-listed.

## Features

### F0 · Cross-cutting
Why: The marketplace ships as one current, strict-typed build, and never grows the social features it refuses.

- [x] ISC-1: Production serves the current commit: the live page's version meta matches `git rev-parse --short HEAD` after `bun run deploy`.
- [x] ISC-2: TypeScript strict-mode build emits 0 errors.
- [x] ISC-3: `beanline.example.com` returns HTTP 200 with `text/html`.
- [x] ISC-4: Deployed version string in HTML head matches local git short-sha.
- [ ] ISC-36: Anti: out of scope — `/api/follow`, `/api/dm`, and any social-graph endpoint return 404 (probe: curl).
- [ ] ISC-39: The harness runs end to end: launch, ready and doctor pass, a buyer browses `/browse` through F2's `Reach:` entry, evidence is captured, teardown stops only the server it launched, and the evidence is still in `./.harness/evidence` afterward.
- [ ] ISC-38: Anti: regression — first-page browse load makes zero third-party network requests (no analytics beacon, no font CDN, no ad-tech) (probe: Interceptor network-panel screenshot, 0 third-party requests).

### F1 · ListingPipeline
Why: A lot is only public after a person has reviewed it, because buyer trust is the product.
Reach: /account/listings/new → form "New listing" ; /admin/review → table "Pending lots"

- [x] ISC-5: A roaster can submit a new listing with origin, process, harvest date, moisture %, lot weight (kg), price ($/kg), tasting notes, ≥ 1 photo (probe: form submission test).
- [x] ISC-6: Submitted listings enter `status: pending_review` and are not publicly visible (probe: `curl /listings/<id>` returns 404 for anonymous; visible to roaster + admin).
- [ ] ISC-7: Quality lead can approve or reject a pending listing in ≤ 10 minutes per lot (probe: ops-tool timing telemetry, p95 ≤ 600s).
- [x] ISC-8: An approved listing appears at `beanline.example.com/lots/<slug>` within 60 seconds of approval (probe: `curl` after approval).
- [ ] ISC-9: A sold-out listing is hidden from the browse page within 60 seconds of the final unit selling.
- [ ] ISC-31: `roaster_verified` users see their own listings in `/account/listings` regardless of status; never see other roasters' pending listings.

### F2 · BrowseAndSearch
Why: Buyers find lots by region, process, and harvest, inside a cellular-load budget.
Reach: /browse → list "Lots" ; /browse → searchbox "Search lots"

- [x] ISC-10: `beanline.example.com/browse` paginates available lots, 20 per page, sorted by newest-listed (after: ISC-8).
- [x] ISC-11: `beanline.example.com/browse?region=<region>` filters lots by origin region (Africa, Americas, Asia-Pacific).
- [x] ISC-12: `beanline.example.com/browse?process=<process>` filters lots by processing method (washed, natural, honey, anaerobic, …).
- [ ] ISC-13: Browse page p95 cold load on simulated 4G ≤ 1000ms (probe: Lighthouse mobile).
- [ ] ISC-14: Listing detail page p95 cold load ≤ 1500ms.
- [ ] ISC-15: Search query `?q=<term>` matches against origin, process, and tasting-notes fields with case-insensitive substring (probe: integration test against fixture lots).

### F3 · AuthAndVerification
Why: Every action is gated by a verified role, with magic-link sign-in and no passwords.
Reach: /auth/magic-link → textbox "Email" ; /account/verification → button "Submit business proof"

- [x] ISC-16: `/auth/magic-link` accepts an email and emails a 15-minute single-use link.
- [x] ISC-17: Magic-link callback creates a session cookie (`HttpOnly; Secure; SameSite=Lax`).
- [x] ISC-18: A new user starts as `role: buyer_unverified`. Verification (business proof) elevates to `buyer_verified` or `roaster_verified`.
- [ ] ISC-19: Only `roaster_verified` users can submit listings (probe: `POST /listings` from `buyer_unverified` session returns 403).
- [ ] ISC-20: Only `buyer_verified` users can purchase (probe: `POST /checkout` from `buyer_unverified` returns 403 with "verification required" message).
- [x] ISC-30: Anonymous users can browse and view listings but cannot purchase or message (probe: each protected endpoint returns 401).
- [ ] ISC-32: Admin role gates `/admin/*` routes; non-admins receive 403.

### F4 · PaymentsEscrow
Why: Money moves only when the buyer confirms receipt, or on day 8 when they never answer.
Reach: /lots/<slug> → button "Buy" ; /account/payouts → button "Set up payouts"

- [x] ISC-21: Stripe Connect onboarding flow lives at `/account/payouts` for `roaster_verified` users (after: ISC-18).
- [x] ISC-22: Stripe Checkout creates an escrow charge: funds are held until handoff-confirm (after: ISC-8, ISC-17).
- [ ] ISC-23: BeanLine platform fee ≤ 5.1% of lot price; total all-in (BeanLine + Stripe) ≤ 8% (probe: post-checkout fee breakdown JSON includes both, sum ≤ 8%).
- [ ] ISC-24: Stripe webhook `payment_intent.succeeded` flips listing to `status: in_transit` and emails roaster a printable handoff card.
- [ ] ISC-25: Buyer-confirm handoff (QR scan) flips status to `status: delivered`, releases escrow to the roaster, and emails buyer a receipt.
- [ ] ISC-26: If buyer does NOT confirm within 7 days of carrier-tracking-delivered, escrow auto-releases on day 8 with a Decisions-logged audit entry.

### F5 · MessagingAndDisputes
Why: Buyer and roaster talk only inside one listing, and a dispute leaves a retained record.
Reach: /lots/<slug> → button "Message roaster" ; /lots/<slug> → button "Open dispute"

- [ ] ISC-27: Buyer can message the roaster from the listing page; messages are scoped to that listing only (after: ISC-8, ISC-17).
- [ ] ISC-28: Messages are retained for 12 months (probe: SELECT against retention policy).
- [ ] ISC-29: A "Open dispute" button on the listing page (visible only after purchase) creates a `dispute` row with status `open` and notifies both parties.

### F6 · ImageEdge
Why: Photos reach buyers only as transformed WebP, never as camera originals.
Reach: /lots/<slug> → img "Lot photo"

- [ ] ISC-34: All R2 image fetches go through a transform Worker that delivers WebP (probe: `Content-Type: image/webp` on every `/img/...` URL).
- [ ] ISC-37: Anti: privacy — image originals (raw camera JPEGs) are NEVER served from R2 (probe: every image URL returns WebP).

### F7 · HealthAndRateLimit
Why: Operators can see the deployed version, and the public API cannot be scraped at will.
Reach: GET /health → field "version" ; GET /api/lots → header "RateLimit-Remaining"

- [ ] ISC-33: `/health` returns `{status, version, last_deploy_at}` in ≤ 50ms.
- [ ] ISC-35: Public read API at `/api/lots` rate-limits to 60 req/min/IP via Cloudflare WAF (probe: 61st request in 60s returns 429) (after: ISC-8).

## Test Strategy

<!-- ISAGate parses THIS table with LIFEOS/TOOLS/lib/IsaTestStrategy.ts, which ships with the runtime. The header row names the columns, in this canonical order:
     isc | type | check | threshold | tool | anchors_to, then the optional
     severity | tier | stage, each written as an empty cell when unused (ISC-39's
     tier cell puts it on the `build` lane, run only by `bunker test --deep`).
     `type` MUST be one of the real PROBE_TYPES: bash | bun-test | bun-property |
     curl | manual | screenshot | eval. An invented type or a non-table (YAML)
     block parses to ZERO probes — the exact zero-probe-green defect this example
     used to teach. Every criterion needs ≥1 row of any type (v2.24.0 H8): runnable
     types (bash/bun-test/bun-property/curl) execute, eval dispatches to
     EvalRunner, and manual is the visible, ledgered exception that satisfies
     the gate — a criterion with zero rows is what H8 blocks. -->
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

| isc | type | check | threshold | tool | anchors_to | severity | tier |
|-----|------|-------|-----------|------|------------|----------|------|
| ISC-3 | curl | home page serves HTML | 200 + text/html | `curl -sfI https://beanline.example.com \| grep -qi 'content-type: text/html'` | literal |  |  |
| ISC-13 | bash | browse-page p95 cold load on simulated 4G | ≤ 1000ms | `bash scripts/lighthouse-p95.sh /browse 1000` | derived: responsiveness |  |  |
| ISC-23 | bun-test | total fees on a $250 lot within cap | ≤ $20 (8%) | `bun test test/checkout.test.ts -t "fee cap"` | derived: fee-transparency |  |  |
| ISC-25 | bun-test | QR handoff scan releases escrow | stripe transfer fires | `bun test test/handoff.test.ts -t "escrow release"` | literal |  |  |
| ISC-26 | bun-test | auto-release fires on day 8 | transfer within 60s of cron | `bun test test/auto-release.test.ts -t "day-8"` | derived: escrow-timeout |  |  |
| ISC-36 | curl | social-graph endpoints do not exist | 404 | `test "$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://beanline.example.com/api/follow)" = "404"` | literal |  |  |
| ISC-37 | bash | every image URL returns WebP | 100% image/webp | `bash scripts/image-format-audit.sh` | derived: image-policy |  |  |
| ISC-38 | screenshot | zero third-party requests on browse page | 0 | Interceptor network panel at /browse | derived: privacy |  |  |
| ISC-7 | manual | quality-lead approval time per lot | p95 ≤ 600s | ops telemetry weekly aggregate (recognize-on-encounter) | derived: ops-sla |  |  |
| ISC-1 | bash | live version meta matches HEAD | match | `curl -sf https://beanline.example.com \| grep -q "content=\"$(git rev-parse --short HEAD)\""` | literal |  |  |
| ISC-2 | bash | strict TypeScript build has no errors | exit 0 | bun run build | literal |  |  |
| ISC-4 | bash | deployed HTML version matches local short SHA | exact match | bash scripts/version-sha-check.sh | derived: deploy-integrity |  |  |
| ISC-5 | bun-test | roaster submits a complete coffee lot | listing is pending_review | bun test test/listings.test.ts -t "submit complete lot" | literal |  |  |
| ISC-6 | bun-test | pending lot remains private to anonymous users | anonymous response is 404 | bun test test/listings.test.ts -t "pending visibility" | literal |  |  |
| ISC-8 | bun-test | approved lot becomes public promptly | visible within 60 seconds | bun test test/listings.test.ts -t "approval publication" | derived: listing-freshness |  |  |
| ISC-9 | bun-test | final sale removes lot from browse results | hidden within 60 seconds | bun test test/listings.test.ts -t "sold out visibility" | literal |  |  |
| ISC-10 | bun-test | browse returns newest available lots in pages | 20 lots per page | bun test test/browse.test.ts -t "pagination sort" | literal |  |  |
| ISC-11 | bun-test | region filter returns only matching origins | all fixtures match region | bun test test/browse.test.ts -t "region filter" | literal |  |  |
| ISC-12 | bun-test | process filter returns only matching methods | all fixtures match process | bun test test/browse.test.ts -t "process filter" | literal |  |  |
| ISC-14 | bash | listing detail p95 cold load stays within budget | ≤ 1500ms | bash scripts/lighthouse-p95.sh /lots/fixture 1500 | derived: responsiveness |  |  |
| ISC-15 | bun-test | search matches origin process and tasting notes case-insensitively | all fixture fields found | bun test test/search.test.ts -t "substring search" | literal |  |  |
| ISC-16 | bun-test | magic-link request sends expiring single-use link | 15 minute expiry | bun test test/auth.test.ts -t "magic link request" | literal |  |  |
| ISC-17 | bun-test | magic-link callback sets secure session cookie | HttpOnly Secure SameSite=Lax | bun test test/auth.test.ts -t "session cookie" | literal |  |  |
| ISC-18 | bun-test | new account begins unverified and review assigns verified role | correct role transitions | bun test test/verification.test.ts -t "role elevation" | literal |  |  |
| ISC-19 | bun-test | unverified buyer cannot submit listing | response 403 | bun test test/authorization.test.ts -t "listing role gate" | literal |  |  |
| ISC-20 | bun-test | unverified buyer cannot start checkout | response 403 with verification message | bun test test/authorization.test.ts -t "checkout role gate" | literal |  |  |
| ISC-21 | bun-test | verified roaster can open Connect onboarding | payout route returns onboarding URL | bun test test/payouts.test.ts -t "connect onboarding" | literal |  |  |
| ISC-22 | bun-test | checkout holds funds until handoff confirmation | escrow charge created | bun test test/checkout.test.ts -t "escrow hold" | literal |  |  |
| ISC-24 | bun-test | successful payment webhook starts shipment and sends handoff card | status in_transit and email queued | bun test test/webhooks.test.ts -t "payment succeeded" | literal |  |  |
| ISC-27 | bun-test | buyer message is scoped to its listing | no cross-listing visibility | bun test test/messages.test.ts -t "listing scope" | literal |  |  |
| ISC-28 | bun-test | message retention policy preserves records for one year | retention is at least 12 months | bun test test/messages.test.ts -t "retention policy" | literal |  |  |
| ISC-29 | bun-test | post-purchase dispute creates open record and notifies parties | open dispute and two notifications | bun test test/disputes.test.ts -t "open dispute" | literal |  |  |
| ISC-30 | bun-test | anonymous visitor can browse but cannot purchase or message | protected routes return 401 | bun test test/authorization.test.ts -t "anonymous access" | literal |  |  |
| ISC-31 | bun-test | roaster account lists only its own lots across statuses | own lots only | bun test test/account-listings.test.ts -t "roaster visibility" | literal |  |  |
| ISC-32 | bun-test | admin routes reject non-admin accounts | response 403 | bun test test/authorization.test.ts -t "admin gate" | literal |  |  |
| ISC-33 | curl | health endpoint reports deployment metadata quickly | 200 JSON within 50ms | curl -sf --max-time 0.05 https://beanline.example.com/health | literal |  |  |
| ISC-34 | bash | transformed lot images are always WebP | 100% image/webp | bash scripts/image-format-audit.sh | derived: image-policy |  |  |
| ISC-35 | bash | public lot API rejects the 61st request in one minute | 61st response is 429 | bash scripts/rate-limit-check.sh /api/lots 61 | literal |  |  |
| ISC-39 | bash | one full harness pass, evidence still present after teardown | exit 0 | bash scripts/full-pass-check.sh | derived: harness | | build |

## Harness

```yaml
surface: web
targets:
  local: http://localhost:5173
  preview: https://preview.beanline.example.com
  prod: https://beanline.example.com
launch: bun run dev --port 5173
ready: curl -sf http://localhost:5173/health
ready_timeout: 60s
doctor: bun scripts/doctor.ts --target local
drive: interceptor
identity: test buyer and test roaster; sign-in recipe in scripts/test-login.ts; credentials in the project .env
seed: bun scripts/seed-test-data.ts
isolation: serial
evidence: ./.harness/evidence
teardown: bun scripts/stop-dev.ts
```

## Decisions

- 2026-02-01 17:00: Cloudflare-only stack chosen over a Vercel/Postgres path because edge-co-location wins at the cellular-load budget, D1's row-flat shape fits the listing schema, and the platform-fee math only works with low compute cost.
- 2026-02-08 11:30: Magic-link auth chosen over password+OAuth because v1's user base is small and known; password-reset flow would be the highest-cost auth surface for the verification-team load.
- 2026-02-22 14:00: ❌ DEAD END: Tried buyer-self-attested verification (upload a business license image, accept on submission). Three of the first eight attestations were retail bag-shop owners trying to source for resale, not the wholesale-buyer profile. Reverted to manual quality-lead review of every verification. Don't retry without an automated business-database cross-check.
- 2026-03-04 09:00: refined: ISC-7 sharpened from "quality lead can approve listings quickly" to "≤ 10 minutes per lot at p95" — the first phrasing was unfalsifiable; the second became a staffing-model input.
- 2026-03-15 22:00: ❌ DEAD END: Tried open-graph + Twitter-card image generation for listings. Pulled in 40KB JS for the meta-tag generator, broke the bundle budget. Reverted to server-rendered static OG meta. Don't retry the dynamic generator path.
- 2026-04-01 10:00: refined: ISC-23 split into ISC-23 (BeanLine fee) and an implied "all-in" check that combined the two — the original ISC let the all-in pass while BeanLine's slice silently crept past the principle's 5.1% ceiling.
- 2026-04-12 16:30: refined: ISC-26 added the auto-release timer (day-8) after the first three deliveries had buyers who never scanned the handoff QR — escrow sat indefinitely. The timer + audit log is the safety net.
- 2026-04-22 22:00: refined: the "p95 ≤ 1s on cellular" and "all-in fees ≤ 8%" budgets, which had lived only as Constraints, became explicit criteria (ISC-13, ISC-23) — the ideal state was domain-correct but the budgets it depended on were operationally fuzzy. L3 stays a destination and the criteria carry the numbers.

## Learning

- 2026-02-22 | conjectured: Buyer self-attestation will scale verification at low ops cost
  refuted by: 3 of 8 attestations turned out to be the wrong buyer profile (retail, not wholesale)
  learned: verification is the load-bearing trust signal; attestation without ops review degrades the buyer-pool quality, which kills roaster trust, which kills supply
  criterion now: ISC-18 added the quality-lead manual-review step explicitly; "buyer_verified" role is gated on it

- 2026-03-15 | conjectured: Dynamic OG/Twitter card generation will improve social sharing CTR
  refuted by: bundle exceeded the 100KB JS budget (ISC-13/14 broke); social CTR uplift was undetectable in A/B
  learned: bundle-budget Constraints outrank social-meta features; static OG is good enough at this scale
  criterion now: ISC-13 unchanged but Decisions logs the dead end as a bundle-creep canary

- 2026-04-12 | conjectured: Buyers will reliably scan the handoff QR; escrow release flows from buyer action
  refuted by: 3 of the first deliveries had buyers who never scanned (busy shop, lost card); escrow sat
  learned: shipment-confirmation must have a buyer-action AND a timeout fallback; relying on either alone breaks the merchant cash-flow story
  criterion now: ISC-26 added (auto-release on day 8 with audit entry)

- 2026-04-22 | conjectured: A performance Constraint stated as a vibe ("fast on cellular") is operational enough
  refuted by: bundle creep of 8KB went undetected for two sprints; nothing failed an ISC because no ISC named a number
  learned: every Constraint that maps to a budget needs a numeric ISC, not a vibe; the ideal state names the destination and the criteria carry the numbers
  criterion now: ISC-13 enforces "p95 ≤ 1s on cellular" and ISC-23 enforces "all-in fees ≤ 8%"

## Verification

- ISC-1: `curl -sf https://beanline.example.com` after `bun run deploy` — version meta `a3b4c5d` matches HEAD
- ISC-3: `curl -i https://beanline.example.com` — `HTTP/2 200 / content-type: text/html; charset=utf-8`
- ISC-4: HTML head shows `<meta name="version" content="a3b4c5d">` matching `git rev-parse --short HEAD` output `a3b4c5d`
- ISC-5: Listing form integration test 2026-04-22 — submitted listing returned `id: lst_TestXXXX` + status `pending_review`
- ISC-8: `curl -i https://beanline.example.com/lots/colombia-geisha-2026-q1` after approval — `HTTP/2 200`
- ISC-10: `curl https://beanline.example.com/browse | rg "<article" | wc -l` — `20`
- ISC-13: Lighthouse mobile run 2026-04-25 — `Performance 92 / FCP 624ms / LCP 891ms` on `/browse`
- ISC-22: Stripe-sandbox checkout test 2026-04-15 — `payment_intent_TestXXXX` created with `transfer_group: lst_TestYYY`
- ISC-30: `curl -i https://beanline.example.com/checkout` (no session) — `HTTP/2 401`
- ISC-36: `curl -i https://beanline.example.com/api/follow` — `HTTP/2 404`
- ISC-37: Image-format audit 2026-04-22 — 100% of 247 image URLs returned `Content-Type: image/webp`
- ISC-38: Interceptor network panel at `/browse` 2026-04-25 — 0 third-party requests on initial load


## Articulation Log

### 2026-01-08 10:00 · discuss — initial discovery
Q: Who is the seller, precisely? → A: "Verified roasters first. Importers maybe later. Not farms — customs is a different product."
Q: Auction or fixed price? → A: "Fixed. Auctions optimize for scarcity theater; this is a liquidity product." (Recommended: fixed — accepted)
Q: Who ships? → A: "Sellers. The moment we touch logistics we're a freight company."
Open flag: dispute-resolution flow — needs the Stripe escrow docs read before it can sharpen.

### 2026-01-15 14:30 · interview — condition-guarantee deep-dive
Q: What proves the lot arrived as listed? → A: "Buyer scans the QR card and confirms. No scan, no release — auto-release after 7 days as the backstop."
Q: What would make a cafe tell another cafe? → A: "The Wednesday-to-Friday story. Speed plus zero trust required."
(Pasted from the escrow spec, heading demoted per the log convention:)
> ## Escrow release conditions
> Capture at purchase; release on buyer confirm or T+7 auto-release; dispute freezes the clock.


<!--
Canonical showpiece. Marketplace pattern (auth + Stripe escrow + RBAC + listings + search + reviews + messaging) at E5 scale, every section populated and the Ideal State ladder (L3, L2, L1) written first, real-feeling Decisions with two ❌ DEAD ENDs and four refinements, four-piece C/R/L Changelog entries spanning the 4-month build. ISC count 38 is below the E5 floor of 256 — show-your-math: the work surface is genuinely smaller than enterprise scope; the marketplace pattern is well-bounded and over-decomposing into 256 ISCs would manufacture probes that don't reflect real verification needs. Anti-criteria (ISC-36, 37, 38) cover scope, privacy, and regression. Antecedents (none) — the goal is verifiable, not experiential, so antecedents aren't required at this gate. The euphoric-surprise prediction in Vision is principal-falsification but not gated as an ISC because the marketplace's success is measured by transactions completed, not by any single user's reaction.
-->
