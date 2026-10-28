<!-- isa-example claims=69 probes=17 era=legacy -->
<!-- Fictitious example. "Beacon Health Alliance" is a teaching project name; any resemblance to real products or organizations is coincidental. The portal.beaconhealth.example.org domain is RFC 2606 reserved. -->

---
task: "Beacon Health Alliance — multi-region HIPAA patient portal"
slug: 20260108-070000_beaconhealth-portal-v1
project: BeaconHealthPortal
effort: comprehensive
effort_source: explicit
phase: execute
progress: 124/238
mode: interactive
started: 2026-01-08T15:00:00Z
updated: 2026-04-28T20:30:00Z
---

## Ideal State

### L3 · One sentence

Beacon Health Alliance's patients, clinicians, and auditors get one multi-region portal with a complete longitudinal chart across all 50 hospitals, live before the legacy portal reaches end-of-life on 2027-06-30.

### L2 · Summary

The new portal at `portal.beaconhealth.example.org` is a multi-region active-active replacement that unifies records without loosening any HIPAA control.

- Patients see one longitudinal chart across all 50 hospitals and all three source EHRs (Epic, MEDITECH, Cerner).
- Appointments and secure messaging work across every region for patients and clinicians.
- Auditors get an immutable, queryable audit log with six-year retention.
- Data residency, BAA, encryption, and session rules hold in normal operation and during regional failover.

### L1 · Full articulation

Beacon Health Alliance runs 50 hospitals across three regions on a patient portal forked from a 2014 vendor codebase that reaches end-of-life on 2027-06-30. The replacement is a multi-region active-active patient portal at `portal.beaconhealth.example.org` that unifies records across all 50 hospitals (Epic, MEDITECH, and Cerner) into a single longitudinal view, including the 14 hospitals of the acquired Cascade Care Group.

A patient logs in with SSO and step-up MFA, sees a complete chart regardless of which hospital generated which record, books an appointment with any in-network clinician in any region, messages their care team through a HIPAA-conformant inbox, sees lab results within four hours of resulting, and receives e-prescriptions handed off to their preferred pharmacy through Surescripts, with no portal-side copy of PHI persisted beyond the handoff window. Clinicians see one chart view independent of the source EHR. Auditors see an immutable, queryable audit log retained for six years that is authoritative for compliance attestation. The portal supports patient, clinician, admin, and auditor roles, provides authoritative read-only chart access, and stays inside the data-residency, BAA, encryption, and session-management constraints in normal operation and during regional failover.

The moment it is right: a patient who moved from the Pacific Northwest region to the Midwest region in 2025 is admitted at a Cascade Care hospital in 2026 and sees her unified chart on day one without faxing records, and her primary care physician at the originating hospital sees the encounter note within 20 minutes of discharge. The portal never shows a "your records from another region are unavailable" error.

## Problem

Beacon Health Alliance — a 50-hospital regional health system spanning the Pacific Northwest, Mountain, and Midwest census regions, with approximately 11,400 employed clinicians, 38,000 affiliated providers, and a covered patient population of ~3.2 million — currently operates a patient portal forked from a 2014 vendor codebase that is end-of-life on 2027-06-30. The legacy portal is a single-region monolith hosted on a tier-2 colo with no documented disaster recovery RTO better than 14 hours; auth is a homegrown OAuth 1.0a implementation with documented session-fixation issues; the audit log writes to a local Postgres instance with 90-day retention (HIPAA mandates a defensible 6-year retention floor in this organization's compliance posture); and the appointment-scheduling subsystem cannot honor the 2025 acquisition of the 14-hospital Cascade Care Group, whose existing records live in a MEDITECH instance that the legacy portal has no integration path to. Patients today see only their primary-region records; clinicians moving between regions cannot view a unified longitudinal chart; auditors run quarterly reports that require manual reconciliation against the source EHR because the portal's audit trail is not authoritative. The replacement is a 2026 Q1–Q4 strategic program with executive sponsorship, a Q1 2027 cutover deadline driven by the legacy vendor's hard end-of-life date, and a budget gate at the end of Q1 2026 that requires Phase 1 (identity + read-only chart access) live in a production canary by 2026-04-30.

## Vision

A unified patient portal at `portal.beaconhealth.example.org` serving all 50 hospitals across three regions, where a patient logs in with SSO + step-up MFA, sees their complete longitudinal chart regardless of which hospital generated which record, books an appointment with any in-network clinician in any region, messages their care team through a HIPAA-conformant inbox, views lab results within 4 hours of resulting (CMS Cures Act minimum), receives e-prescriptions handed off to their preferred pharmacy without a portal-side copy of PHI persisted beyond the handoff window, and never sees a "your records from <other region> are unavailable" error. Clinicians see a single chart view independent of source EHR. Auditors see an immutable, queryable, 6-year-retained audit log that is authoritative for compliance attestation. Euphoric surprise: a patient who moved from the Pacific Northwest region to the Midwest region in 2025, got admitted at a Cascade Care hospital in 2026, and saw her unified chart on day one without having to fax records — and her primary care physician at the originating hospital saw the encounter note within 20 minutes of discharge.

## Out of Scope

- **No native iOS or Android applications in v1.** Mobile experience is via responsive web (PWA install on iOS 17+ and Android 14+); native apps are a separate program scoped for FY28.
- **No telehealth video integration.** The portal links out to the existing telehealth vendor; in-portal video is not part of v1.
- **No patient self-pay billing UI.** Statements and receipts are read-only; payment processing remains in the existing patient-financial-services platform until v2.
- **No third-party API marketplace.** SMART-on-FHIR app launches are deferred to v1.1; no developer-portal, no app store, no third-party app reviews in v1.
- **No multi-language UI in v1.** English only at launch; Spanish ships in v1.1 (2027 Q3); additional locales evaluated in 2028.
- **No employer / wellness-program integrations.** Employer dashboards and population-health analytics are different products owned by the population-health line.
- **No research-cohort enrollment flows.** Research-data deidentification and export is a separate downstream system; the portal does not initiate research workflows in v1.
- **No coverage of skilled-nursing or behavioral-health subsidiaries.** Those EHRs are out of scope for v1; their patients use a legacy portal until v1.2.
- **No PHI persisted in the e-prescription handoff path.** Prescription objects are signed, transmitted to Surescripts, and the portal-side copy is purged within the handoff TTL window. The portal is not a long-term store for prescription content.

## Principles

- Compliance is not a layer; it is a property of the system. Every architectural choice is judged against whether it makes HIPAA, HITRUST, and state-level health-data laws easier or harder to attest to.
- The audit log is authoritative. If an action is not in the audit log it did not happen; if it is in the audit log it cannot be edited. Authoritativeness beats convenience every time.
- Zero-trust between subsystems. Inter-service auth uses short-lived SPIFFE-style identities; no service trusts another service because of network position.
- The patient is the principal. RBAC starts from "the patient owns their record"; clinicians and admins have access by virtue of relationship + role + business justification, not by virtue of being employees.
- Multi-region is a load-balancing concern AND a compliance concern. Data-residency rules, BAA boundaries, and cross-region failover semantics are part of the architecture, not an operational afterthought.
- Operability is a first-class deliverable. A feature is not done when it works; it is done when on-call can diagnose its failures from the dashboards and runbooks.
- Vendor consolidation is not a goal. Best-of-breed where the cost of integration is paid back; "single pane of glass" is a marketing phrase, not an architectural principle.

## Constraints

- **Hosting:** AWS three-region active-active (us-west-2, us-east-1, us-east-2) with primary read traffic served from the closest region; writes go to a regional primary with synchronous replication for compliance-relevant tables and asynchronous replication for the rest.
- **Data residency:** All PHI persists exclusively within US-region AWS accounts under signed BAAs; no PHI in any non-US region, edge cache, or non-BAA service.
- **Identity:** Enterprise SSO via the existing Okta tenant federated to Azure AD for Beacon employees; patient identity uses Auth0 with passwordless email + step-up MFA (TOTP or WebAuthn); no patient passwords in the system.
- **EHR integration:** FHIR R4 against Epic (40 hospitals), MEDITECH Expanse (10 hospitals from the Cascade acquisition), and Cerner (legacy contracts on the affiliated network). HL7 v2 only as a fallback when FHIR R4 is not yet stood up at a particular site.
- **Audit log:** Append-only, 6-year minimum retention, queryable for compliance reporting, hash-chained for tamper evidence, replicated to immutable S3 with object-lock in compliance mode.
- **Session management:** 15-minute idle timeout for clinician/admin/auditor roles (HIPAA minimum-implementation guidance); 30-minute idle timeout for patient role; absolute session lifetime 12 hours for any role.
- **Encryption:** TLS 1.3 in transit; AES-256-GCM at rest; PHI fields envelope-encrypted with KMS keys scoped per data domain (clinical, demographic, financial); rotated quarterly.
- **BAAs:** No vendor in the PHI data path operates without a signed BAA on file with corporate compliance. Vendor onboarding requires a documented BAA SHA reference in the architecture log.
- **Performance:** Patient-facing pages p95 ≤ 1.2s on 4G; clinician chart view p95 ≤ 1.8s on hospital LAN; appointment-search autocomplete p95 ≤ 250ms.
- **Accessibility:** WCAG 2.2 AA across all patient-facing surfaces; clinician surfaces meet WCAG 2.1 AA minimum.
- **Code base:** TypeScript on the application tier (Node 22); FHIR adapters in TypeScript with a Rust shim where parsing throughput dominates; infrastructure as Terraform; secrets via AWS Secrets Manager; no roll-your-own crypto.

## Criteria

### Identity and Authentication

- [x] ISC-1: Patient login at `/auth/patient` accepts an email, sends a 10-minute-expiry magic link, and creates a session on callback.
- [x] ISC-2: Patient step-up MFA is required before any chart-data action; MFA factor is TOTP, WebAuthn, or SMS (SMS only as fallback for patients without smartphones).
- [x] ISC-3: Clinician login at `/auth/clinician` redirects to Okta SAML, returns with a clinician-role session bound to the clinician's NPI.
- [x] ISC-4: Admin and auditor logins use Okta with a separate role-claim mapping; admin and auditor sessions cannot be promoted to clinician without a fresh login.
- [x] ISC-5: Session cookies are `HttpOnly; Secure; SameSite=Lax`; refresh tokens are stored server-side keyed on a session ID, never in the cookie.
- [x] ISC-6: Idle timeout is 15 minutes for clinician/admin/auditor and 30 minutes for patient; absolute session lifetime is 12 hours.
- [x] ISC-7: Failed authentication attempts are rate-limited per identifier (10 / 5min for patient email; 5 / 5min for SSO subject).
- [x] ISC-8: A logout invalidates the session in the session store within 1 second; the cookie is cleared client-side.

### RBAC and Authorization

- [x] ISC-9: Patient role can read only their own chart; queries scoped to `patient_id = session.subject`.
- [x] ISC-10: Clinician role can read a patient chart only when a documented clinician-patient relationship exists in the relationship service (encounter, scheduled appointment, referral, or break-glass with audit).
- [x] ISC-11: Admin role gates `/admin/*` routes; non-admin sessions receive HTTP 403.
- [x] ISC-12: Auditor role can read audit log queries via `/audit/*` but cannot read PHI directly.
- [x] ISC-13: Break-glass access (clinician without prior relationship) requires a one-line stated reason and writes a high-priority audit event flagged for compliance review.
- [ ] ISC-14: Role transitions in a session require re-authentication; a clinician who is also an admin must log in twice to use both surfaces in one day.

### Identity-Linkage and Patient Matching

- [x] ISC-15: Patient identity at the portal level resolves to a single longitudinal patient record across all 50 hospitals via the enterprise master patient index (eMPI).
- [x] ISC-16: When eMPI returns a probable-match below confidence threshold 0.95, the portal does NOT auto-merge; it surfaces a "we need to verify your identity" flow.
- [ ] ISC-17: Patient-initiated record-linking offers a verifiable challenge (DOB + last 4 SSN + DL number, or insurance card + verified phone) before merging across regions.

### Appointment Scheduling

- [x] ISC-18: Appointment search autocomplete returns ≥ 10 candidates in p95 ≤ 250ms across all 50 hospitals.
- [x] ISC-19: Booking an appointment writes to the source EHR via FHIR R4 `Appointment.create` and returns a confirmation with the EHR-issued appointment ID.
- [x] ISC-20: A booking failure (EHR rejection, slot taken) shows a recoverable error and offers the next 3 alternatives.
- [ ] ISC-21: Cancellation propagates back to the source EHR within 60 seconds; the patient sees the canceled state immediately.
- [ ] ISC-22: Multi-region availability: a patient in the Pacific Northwest can book at any of the 14 Cascade Care (Midwest) hospitals; cross-region booking carries a "this appointment is at <region>" disclosure.

### Lab Results and Chart Access

- [x] ISC-23: Lab results visible in the portal within 4 hours of EHR resulting (CMS Cures Act floor; the org's internal SLA is 1 hour).
- [x] ISC-24: Critical-flag results show an in-app banner and trigger a notification to the patient's preferred channel (push or email; never SMS for content).
- [ ] ISC-25: Chart view aggregates encounters across all source EHRs into a single timeline ordered by clinical-effective date.
- [ ] ISC-26: Patients can download a Continuity of Care Document (CCD/C-CDA) covering the last 5 years in p95 ≤ 8 seconds.

### Secure Messaging

- [x] ISC-27: Patient-initiated messages route to the addressed care team's shared inbox in the source EHR within 30 seconds.
- [x] ISC-28: Clinician replies appear in the patient's portal inbox within 60 seconds of EHR send.
- [x] ISC-29: Messages are end-to-end encrypted in transit and at rest; the portal stores ciphertext keyed to the patient session and the EHR thread ID.
- [ ] ISC-30: Messages older than 7 years are purged from the portal store; the EHR remains the long-term system of record for clinical communication.

### E-Prescription Handoff

- [ ] ISC-31: Prescription objects are signed by the prescribing clinician, transmitted to Surescripts, and the portal-side copy is purged within 24 hours of handoff.
- [ ] ISC-32: A patient can view their active prescriptions (read-only summary, sourced live from the EHR pharmacy module — not from a portal copy).
- [ ] ISC-33: Refill-request flow returns the patient to the EHR's pharmacy queue within 60 seconds of submission.

### Audit Logging

- [x] ISC-34: Every read of PHI by any role writes an audit event with `(timestamp, actor_id, actor_role, action, patient_id, data_class, justification, request_id)`.
- [x] ISC-35: Audit events are hash-chained; a tampered event breaks the chain and is detected by the integrity-check job within 1 hour.
- [x] ISC-36: Audit log retention is ≥ 6 years; daily snapshots replicate to S3 with object-lock in compliance mode (cannot be deleted before retention).
- [x] ISC-37: Auditor role can query audit events by patient, by actor, or by time window; query results render p95 ≤ 5 seconds for 30-day windows.
- [ ] ISC-38: Compliance attestation report (monthly) is generated automatically and stored at a defensible retrieval path with cryptographic signature.

### Multi-Region Failover

- [ ] ISC-39: Synthetic regional-failure drill quarterly: a single-region outage in us-west-2 drains traffic to us-east-1 within 5 minutes with zero clinical-data loss for committed writes.
- [ ] ISC-40: Read traffic during single-region outage maintains p95 latency within 1.5× of steady-state (no full SLO collapse).
- [ ] ISC-41: Cross-region replication lag p99 ≤ 60 seconds for compliance-relevant tables (audit, identity, RBAC); ≤ 5 minutes for non-compliance tables.
- [ ] ISC-42: A two-region simultaneous outage degrades to read-only mode in the surviving region; writes return HTTP 503 with a "service degraded" page; no PHI loss.

### Observability

- [x] ISC-43: Every request carries a correlation ID propagated to the EHR adapter and surfaced in support tooling.
- [x] ISC-44: Dashboards exist for: identity (login/MFA success/failure rates), authorization (403 / break-glass rates), EHR latency (per-source p50/p95/p99), audit log volume + integrity, regional health.
- [x] ISC-45: On-call runbooks cover the top 12 alerting scenarios with explicit "this is a false positive when …" notes.
- [ ] ISC-46: SLO dashboards visible to the patient ombudsman office show monthly availability against the 99.95% target with breach narratives.

### Build, Deploy, Release

- [x] ISC-47: Infrastructure provisioned exclusively via Terraform; click-ops in the AWS console is alarmed and reverted.
- [x] ISC-48: All deploys are blue/green per region; rollback completes in ≤ 90 seconds.
- [x] ISC-49: A failed canary in any region rolls back automatically and pages on-call within 60 seconds.
- [x] ISC-50: Production secrets live in AWS Secrets Manager; no secrets in env vars baked into images, no secrets in Terraform state.
- [ ] ISC-51: Release notes for every production deploy are auto-generated from PR descriptions and posted to the change-management ticket.

### Phase 1 Canary (2026-04-30 budget gate)

- [x] ISC-52: Patient identity and login work end-to-end against prod Okta + Auth0 tenants (non-HIPAA pilot data).
- [x] ISC-53: Session management follows the constraints; idle timeout and absolute lifetime enforced.
- [x] ISC-54: HITRUST validated assessor clears Phase 1 for launch (zero high-severity findings).
- [ ] ISC-55: Phase 1 postmortem published by 2026-05-07.

### Multi-Region Readiness (2026-06-30 phase 2 gate)

- [ ] ISC-56: Blue/green regional failover tested per region end-to-end; rollback ≤ 90s verified.
- [ ] ISC-57: Replication lag p99 ≤ 60s for compliance tables across all three regions.
- [ ] ISC-58: On-call has runbooks and dashboards for the top 12 multi-region outage scenarios.
- [ ] ISC-59: Load test: 50% of peak patient concurrency at p95 latencies ≤ 1.2s across regions.

### Full Launch Readiness (2026-09-30 phase 3 gate)

- [ ] ISC-60: URL query strings in edge-cache logs contain zero PHI (multi-7-day roll).
- [ ] ISC-61: Oldest retained audit event is within 6y - 7d of now (retention floor verified).
- [ ] ISC-62: Every vendor in the PHI data path has a recorded BAA SHA in the architecture log.
- [ ] ISC-63: Session config is 15 minutes idle for clinician/admin/auditor and 30 minutes idle for patient (ISC-6); absolute lifetime ≤ 12 hours for every role.
- [ ] ISC-64: Appointment search returns results in p95 ≤ 250ms under peak load (500 concurrent patients across 50 hospitals).
- [ ] ISC-65: Chart view renders in p95 ≤ 1.8s on hospital LAN (simulated via tc on staging).
- [ ] ISC-66: No password column exists in the identity database (SQL grep + code review).
- [ ] ISC-67: Anti: RoleTransition criterion ISC-14 ensures clinician/admin cannot use both roles without re-login (code review + manual test).
- [ ] ISC-68: Anti: Audit log table has no UPDATE or DELETE statements issued from app role (pg_stat_statements).
- [ ] ISC-69: Cerner and MEDITECH integrations pass parity-test (read 1000 records from each EHR, assert field-for-field match with legacy portal output).

## Test Strategy
| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-1 | bash | magic-link arrives + callback creates session | ≤ 60s end-to-end | bun run scripts/auth-magic-link.ts | |
| ISC-6 | bash | session expires after 15m idle for clinician role | 16th-minute request returns 401 | bun run scripts/session-idle-timeout.ts --role clinician | |
| ISC-15 | bash | same patient across 3 hospitals resolves to a single eMPI ID | 1 patient_id returned | bun run scripts/empi-cross-region-probe.ts --test-fixture mrn-set-A | |
| ISC-18 | bash | appointment-search autocomplete p95 | ≤ 250ms across 50-hospital corpus | k6 run load/appointment-autocomplete.js --vus 200 --duration 5m | |
| ISC-23 | bash | lab result publish-to-portal-visible latency | p95 ≤ 4h, internal SLA p95 ≤ 1h | bun run scripts/lab-latency-audit.ts --window 7d | |
| ISC-34 | bash | every PHI read produces an audit event | \|reads\| == \|audit_events\| within 60s window | bun run scripts/phi-audit-parity.ts --bucket 1m --window 60s | |
| ISC-35 | bash | hash chain verifies for full 30-day window | 0 chain breaks | bun run scripts/audit-chain-verify.ts --window 30d | |
| ISC-36 | bash | daily snapshot lands in S3 with object-lock compliance mode | lock_mode == COMPLIANCE && retain_until >= now+6y | aws s3api get-object-retention --bucket audit-logs --key "$(date -u +%F).parquet" --query Retention.Mode --output text \| grep -qx COMPLIANCE | |
| ISC-39 | bash | regional outage drains in ≤ 5 min with zero committed-write loss | drain_time ≤ 300s; data-loss-events == 0 | bun run scripts/regional-outage-drill.ts --target us-west-2 | |
| ISC-49 | bash | failed canary auto-rollback + page on-call | rollback ≤ 90s; pager fired ≤ 60s | bun run scripts/canary-failure-injection.ts | |
| ISC-54 | manual | HITRUST validated assessor returns zero high-severity findings on Phase 1 | 0 high; ≤ 3 medium with mitigation plans | external assessor report (manual evidence) | |
| ISC-60 | bash | URL query strings in edge logs do not contain PHI markers | 0 matches over 7-day rolling window | rg -q "patient_id=\|mrn=\|dob=\|ssn=" /var/log/cloudflare-edge/*.log; test $? -eq 1 | |
| ISC-61 | bash | oldest audit event retained | oldest_event_age ≥ 6y - 7d | test "$(psql "$DATABASE_URL" -tAc "SELECT MIN(timestamp) <= now() - interval '6 years' + interval '7 days' FROM audit_log_archive")" = "t" | |
| ISC-62 | bash | every vendor in PHI data path has a recorded BAA SHA | \|vendors_in_data_path\| == \|vendors_with_baa_sha\| | bun run scripts/baa-reconciliation.ts | |
| ISC-63 | bash | clinician/admin/auditor session config <= 15min idle | parsed config value ≤ 900s for those roles | bun run scripts/session-idle-preflight.ts --roles clinician,admin,auditor --max-idle 900 | |
| ISC-66 | bash | no password column exists in identity DB | 0 columns matching ^password | test "$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.columns WHERE column_name ~ '^password'")" = "0" | |
| ISC-68 | bash | no UPDATE or DELETE statements against audit_log table from app role | 0 occurrences in 30 days of pg_stat_statements | test "$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_stat_statements WHERE query ~ '(UPDATE\|DELETE).+audit_log'")" = "0" | |
