<!-- isa-example claims=16 probes=6 era=legacy -->
<!-- Fictitious example. The CI pipeline and credential surfaces here are teaching placeholders. -->

---
task: "Rotate the production deploy credential in the CI pipeline"
slug: 20260208-103000_rotate-deploy-credential
effort: extended
effort_source: explicit
phase: execute
progress: 0/16
mode: interactive
started: 2026-02-08T18:30:00Z
updated: 2026-02-08T18:30:00Z
---

## Ideal State

### L3 · One sentence

Rotate `DEPLOY_API_TOKEN` end-to-end so the next production deploy succeeds on a new same-scope token and the old token is inactive within four hours of the new one going live.

## Problem

The production deploy credential (a long-lived API token stored in CI as `DEPLOY_API_TOKEN`) was provisioned 14 months ago, has never been rotated, and grants broad write scope on the deploy target. Per the org's quarterly rotation policy this is overdue. We need to rotate it without breaking the next deploy and without leaving the old token live longer than necessary.

## Criteria

### Pre-rotation

- [ ] ISC-1: New token provisioned via the deploy target's API with scope `deploy:write` only — no broader scopes (probe: `curl -H "Authorization: Bearer $NEW_TOKEN" /v1/me` returns scopes `["deploy:write"]` exactly).
- [ ] ISC-2: New token expires in 90 days (probe: `curl /v1/tokens/<id>` shows `expires_at` ≤ 90 days from now).
- [ ] ISC-3: New token's `created_by` is the rotation runbook service account, not an individual user (probe: token metadata).

### CI update

- [ ] ISC-4: `DEPLOY_API_TOKEN` secret in the CI provider is updated to the new value (probe: `gh secret list --repo <org>/<repo>` shows updated `updated_at` within last 5 minutes).
- [ ] ISC-5: No commit, log line, or artifact contains the new token value as a string (probe: `gh run view <run-id> --log | rg "$(echo $NEW_TOKEN | head -c 8)" | wc -l` returns 0).

### Verification

- [ ] ISC-6: A test deploy on a `rotation-test` branch using the new token completes successfully (probe: deploy job exit 0, deploy target's API confirms new artifact registered).
- [ ] ISC-7: The verification deploy creates an artifact tagged `rotation-test-<timestamp>` that is removable post-verify (probe: `curl /v1/artifacts?tag=rotation-test` lists the artifact).
- [ ] ISC-8: Post-verify cleanup removes the test artifact within 60 minutes (probe: `curl /v1/artifacts/<id>` returns 404 after cleanup).

### Old token revocation

- [ ] ISC-9: Old token is revoked via the deploy target's API ≤ 4 hours after new token activation (probe: `curl /v1/tokens/<old-id>` returns `revoked_at` populated).
- [ ] ISC-10: A deploy attempt with the old token returns 401 within 60s of revocation (probe: `curl -H "Authorization: Bearer $OLD_TOKEN" /v1/deploys -X POST` returns 401).
- [ ] ISC-11: The revocation is logged in the org's auth audit log with actor, time, reason (probe: SIEM query for `token_revoked` event in last hour).

### Documentation

- [ ] ISC-12: `docs/runbooks/credential-rotation.md` is updated with the new token's ID and the rotation date.
- [ ] ISC-13: The next-rotation reminder is scheduled in the team calendar for `now + 90 days - 14 days` (early warning).

### Anti-criteria

- [ ] ISC-14: Anti: privacy — neither token value appears in any commit message, PR description, Slack/email message, or CI log (probe: `git log --all -S "$(echo $NEW_TOKEN | head -c 8)" --oneline` returns empty; same for old).
- [ ] ISC-15: Anti: scope creep — new token does NOT have `admin:write`, `users:write`, or any scope beyond `deploy:write` (probe: token metadata scope-list comparison).
- [ ] ISC-16: Anti: rollback safety — old token stays active for ≥ 30 minutes after new token deploys to verify, so a failed rotation can re-pin the old token (probe: timestamps on activation/revocation events show ≥ 30 min gap).

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-1 | bash | new token's scope list is exactly [deploy:write] | exit 0 | test-new-token-scope.sh |  |
| ISC-5 | bash | new token value never appears in CI logs | 0 matches | check-token-in-logs.sh |  |
| ISC-6 | bash | test deploy with new token succeeds | exit 0 | gh workflow run deploy.yml --ref rotation-test && gh run watch --exit-status $(gh run list --workflow deploy.yml --branch rotation-test --limit 1 --json databaseId --jq '.[0].databaseId') |  |
| ISC-10 | bash | old token is rejected | HTTP 401 | check-old-token-rejection.sh |  |
| ISC-14 | bash | neither token's first 8 chars appear in any tracked surface | 0 matches | credential-leak-audit.sh |  |
| ISC-16 | bash | gap between new-token-active and old-token-revoked >= 30min | exit 0 | check-rotation-gap.sh |  |


<!--
E2 ops ISA. Required sections: Ideal State (L3 alone), Problem, Criteria, Test Strategy.
Demonstrates the ISA primitive applied to an ops/runbook task — the same shape as a code task. ISC count of 16 hits the E2 floor exactly. Anti-criteria (ISC-14, 15, 16) cover privacy, scope, and rollback safety — typical ops-task regression-prevention concerns. Note ISC-16 explicitly preserves a safety window — a real-world lesson learned from prior bungled rotations.
-->
