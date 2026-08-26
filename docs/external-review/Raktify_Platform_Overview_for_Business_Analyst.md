# Raktify — Platform Overview

**For:** External review by a Business Analyst
**Production URL:** https://raktify.choudhari.ngo
**Built by:** Choudhari EduHealth India Foundation (CIN U88900MH2025NPL447942, NGO-Darpan MH/2025/0643345)
**Status:** Live on Azure (Central India region) · institutional onboarding starts ~July 2026

---

## 1. The Problem

India has 12-15% national blood deficit. ~3 lakh deaths/year are linked to unavailability of compatible blood units at the right hospital at the right time. Existing systems (e-Raktkosh, individual blood bank software) are **inventory-oriented** — they track bags in a fridge, not the matching of patients in need to donors who can help.

Specific operational gaps Raktify targets:

| Gap | Today | With Raktify |
|---|---|---|
| Hospital raises emergency request | Phone calls to known bloodbanks; trial-and-error | Tier 1-4 routed request engine; auto-match against verified donor pool |
| Donor pool maintenance | Each blood bank keeps its own paper/Excel list, never refreshed | Per-donor self-managed profile + WhatsApp opt-in; deferral state machine; cross-institution discoverability |
| Donor consent + KYC | Paper forms, never digitised | Online consent + ABHA hook + Aadhaar last-4 + DPDP-compliant audit trail |
| Camp organisation | WhatsApp groups + spreadsheets | Public camp page + QR-coded donor signup + organiser dashboard via magic-link |
| Cross-institution visibility | None — each bloodbank is an island | NGO admin sees district + state aggregates; DHO governance role for read-only district insight |
| Auditability (regulator-facing) | Manual report generation | Hash-chained audit_log; one-click district + hemovigilance reports for SBTC/DGHS |

---

## 2. Platform Architecture (one-pager)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Public web — raktify.choudhari.ngo                │
│   React PWA (Vite + React Query + Tailwind), offline-capable         │
│   Hosted on Azure Static Web Apps (free tier, Central India edge)    │
└──────────────────────────────────────────────────────────────────────┘
                                 │ HTTPS (CORS-whitelisted)
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                Backend — raktify-api.azurewebsites.net               │
│   Node.js 22 + Express + Zod (input) + pg (Postgres client)          │
│   Azure App Service Linux (B1 plan, Always On, custom domain ready)  │
│   Auth: JWT (HS256, role-based TTL 8h/30d) + Helmet CSP + rate limit │
└──────────────────────────────────────────────────────────────────────┘
        │                       │                       │
        │ env vars (KV refs)    │ DB queries            │ external integrations
        ▼                       ▼                       ▼
┌────────────────┐  ┌──────────────────────┐  ┌───────────────────────────┐
│   Azure Key    │  │ Azure DB for         │  │ WhatsApp Business Cloud   │
│   Vault        │  │ PostgreSQL Flexible  │  │ API (Meta Graph v21.0)    │
│   raktify-kv   │  │ Server v16, B1ms,    │  │ - donor_otp (auth)        │
│   ~12 secrets  │  │ Central India        │  │ - institution_link (mou)  │
│   incl DB pwd, │  │ - 287 migrations     │  │ - community_leader_signin │
│   WA token,    │  │ - 35 tables, 100+    │  │ - critical alert (MR/EN)  │
│   Leegality    │  │   triggers, 75+ RLS  │  │ - camp_reminder           │
│   creds, JWT   │  │   policies, hash-    │  │ - 6 templates approved    │
│   secret       │  │   chained audit log  │  └───────────────────────────┘
└────────────────┘  │ - Encryption at rest │
                    │ - 7-day PITR backup  │  ┌───────────────────────────┐
                    └──────────────────────┘  │ Leegality (Aadhaar eSign) │
                                              │ - Workflow KH4DMOi for MoU│
                                              │ - HMAC-SHA1 webhook verify│
                                              │ - Production endpoint     │
                                              │   app1.leegality.com      │
                                              └───────────────────────────┘
                                              
┌──────────────────────────────────────────────────────────────────────┐
│   CI/CD — GitHub Actions                                             │
│   Push to main → lint+build → DB migration → backend deploy → SWA    │
│   Azure auth via OIDC federated identity (no secrets in workflow)    │
└──────────────────────────────────────────────────────────────────────┘
```

**All data resides in Azure Central India (Pune).** Critical for DPDP Act 2023 compliance on personal + sensitive health data.

---

## 3. User Roles (Capability Matrix)

| Role | Auth | Primary surface | Can do |
|---|---|---|---|
| **donor** | Mobile + WhatsApp OTP | `/donor` PWA | Manage own profile, blood-group, availability toggle, receive critical-request alerts, RSVP to camps, see donation history |
| **community_leader** | Mobile + OTP (separate role-bucket) | `/community-leader` | Create + manage donor communities (e.g. "Marwadi Yuva Manch Amravati"), recruit donors via shareable referral link/QR, host blood-donation camps, see roster (name + blood group + last-donation date — no mobile) |
| **coordinator** | Username + password + TOTP | `/coordinator` (NGO-employed) | Accept Tier 1-2 hospital requests, verify Tier 3-4 community/citizen requests, route donor alerts, close requests with bag IDs, cross-role thread |
| **hospital** | Username + password + TOTP | `/hospital` | Raise blood requests (Tier 1), confirm crossmatch, see own institution's request history |
| **blood_bank** | Username + password + TOTP | `/bb` | Manage inventory, record donations + TTI screening (4-eyes verify), opening-stock entry, bulk-import legacy donors (silent until next donation) |
| **ngo_admin** | Username + password + TOTP | `/admin` | Onboard institutions, manage coordinators + community_leaders, view duplicates queue, lookback investigations, audit log, district + hemovigilance reports, bulk-import donors |
| **super_admin** (director) | Username + password + TOTP | `/admin` (full) | Everything ngo_admin can + manage admin accounts + scheduler control + emergency overrides |
| **dho** (District Health Officer) | Username + password + TOTP | `/dho` | Read-only governance — district aggregates, blood availability heatmap, compliance matrix, critical-request timeline, hemovigilance summary. **Never sees donor PII or patient PII.** |

**Mobile uniqueness is per-role-bucket** — the same mobile can hold a donor row AND a community_leader row in parallel (the founder Gaurav, for instance, is registered as a donor on his personal mobile + has a separate super_admin account). The auth flow disambiguates via the `?role=` URL parameter on the login page.

---

## 4. Core Workflows (end-to-end)

### 4a. Donor lifecycle

1. **Discovery** — donor lands on Raktify via (a) public landing page (b) community leader's referral link (`/community/<slug>`) (c) QR code at a blood donation camp (d) hospital staff referral
2. **Registration** — 4-step web wizard: pre-screening Q&A → personal details → temporary deferral notice → consent. WhatsApp OTP verifies mobile. Backend duplicate-detection on ABHA + name+DOB + Aadhaar-last-4.
3. **Verification** — donor's blood group is "self-reported" until a blood bank verifies it on first physical donation. Self-reported group is **never used** for matching (clinical safety constraint enforced at DB level).
4. **Steady state** — donor toggles availability + manages opt-in. Receives alerts only when matching engine finds them as a candidate for a real request.
5. **Critical-request response** — donor gets WhatsApp template: hospital name + blood needed + travel distance. Donor either accepts (one-tap reply) or ignores (no penalty; reliability_score adjusts based on opt-in commitments).
6. **Donation** — at the blood bank, staff looks up donor by mobile, records donation, runs TTI screening (HIV/HBsAg/HCV/Syphilis/Malaria), supervisor 4-eyes-verifies any reactive result. Donor's `next_eligible_date` auto-computed; `total_donations` counter bumps.
7. **Post-donation** — automatic WhatsApp `thankyou` template fires within minutes.

### 4b. Hospital / Blood Bank onboarding (the critical first-touch)

1. Hospital/BB applies at `/onboarding/apply` (public form — Schedule 1 details, primary contact, CDSCO license number, district).
2. NGO admin reviews in `/admin` → Onboarding tab → verifies license number (currently manual; future: NMC registry API check).
3. NGO admin clicks **"Send MoU"** → backend calls Leegality (Workflow KH4DMOi) → Leegality sends Aadhaar eSign link to signatory's mobile.
4. Signatory completes eSign (Aadhaar OTP) → Leegality fires webhook to `/onboarding/mou-signed` → backend verifies HMAC-SHA1, creates `mou_versions` row, marks institution `AC` (Active).
5. Backend creates institutional admin platform_users row with auto-derived username (`<institution_shortname>_admin`) + sends `institution_link` WhatsApp with activation magic link.
6. Institution's signatory taps the WhatsApp button → lands on `/activate/<token>` → sets password (≥8 chars, letter + digit) → redirected to `/staff/login`.
7. Signs in as `<username>` + password + (optional) TOTP → lands on `/hospital` or `/bb` portal.

### 4c. Community leader recruitment flow (Phase 1-3 of Raktify, all live)

1. NGO admin in `/admin` → Community leaders tab → "+ Invite leader" → fills name + mobile + region.
2. Backend inserts platform_users + community_leaders profile + sends `community_leader_signin` WhatsApp (Utility-class, per-recipient URL).
3. Leader taps "Sign in" → lands on `/login?role=community_leader&m=<their-mobile>` (mobile pre-filled) → enters mobile → receives OTP → signed in.
4. Leader creates a community: name + slug + region + co-leader picker (required — schema-enforced via deferred constraint trigger).
5. Leader gets a personal referral URL `https://raktify.choudhari.ngo/community/<slug>` + QR PNG to share in their WhatsApp group.
6. Donors who sign up via that URL are auto-tagged to the community + crediting the leader as the recruiter (donors.referred_by_community_leader_id).
7. Leader sees their roster (name + blood group + last-donation-date only — **never mobile** because they already have it in their own WhatsApp group; we don't intermediate their communication channel).
8. Leader can host a blood-donation camp from the community detail page → NGO coord verifies → camp goes live for public RSVP.

### 4d. Critical request matching (the life-saving moment)

1. Hospital staff at `/hospital` → "Raise new request" → fills patient initials + blood group needed + units + urgency.
2. POST `/requests` runs the matching engine **synchronously** in a transaction:
   - Compatibility lookup from `compatibility_matrix` (HCV/HIV/group rules — DRAFT pending haematologist sign-off)
   - Inventory search: same-group preferred, then ABO-compatible fallback, FIFO by expiry
   - Bag reservation: status `RE` with `reserved_for_request_id`
   - If inventory short: matching engine selects donors by district + reliability_score + opt-in status; creates donor_alerts
   - Ring 1 escalation_log row stamped
3. Donor alerts dispatched via WhatsApp `donor_alert_critical` template (approved in MR + EN).
4. If no response within thresholds, scheduler job `escalate_overdue` widens rings (district → adjacent → state → DHO at ring 4) per spec §6.
5. Coordinator at `/coordinator` sees the request in their queue, can accept, claim, verify, or no-show donors, and closes with bag IDs.
6. Hospital confirms crossmatch via "Confirm crossmatch" button → status flips `FU` → `CL`.

---

## 5. Integrations (the 5 external services we rely on)

| Integration | Purpose | Why this one |
|---|---|---|
| **Microsoft Azure** (Central India) | Hosting, DB, secrets, identity, CI/CD | DPDP compliance (India data residency), enterprise SLA, free credit for NGOs |
| **WhatsApp Business Cloud API** (Meta) | Donor alerts, OTP delivery, eSign + activation links, camp reminders, post-donation thanks | India's de-facto comms channel (~500M users); template approval gives delivery rate >95%; no India DLT needed (unlike SMS) |
| **Leegality** | Aadhaar eSign for MoU between Foundation and each onboarded institution | Court-admissible eSign per IT Act 2000 §3A; native UIDAI integration; Workflow API (`/v3.0/sign/request`) with HMAC-SHA1 webhook verification |
| **GitHub** | Source-of-truth repo + CI/CD via Actions | Mature OIDC federated identity to Azure (no long-lived secrets); free for open-source / small orgs |
| **Cloudflare DNS** (presumed) | DNS for choudhari.ngo + raktify subdomain | (Whatever DNS provider the foundation uses — not Raktify-specific) |

**Deliberately NOT using:**
- Twilio / MSG91 SMS — SMS via Indian telecoms requires DLT template registration (slow + bureaucratic). WhatsApp is faster + cheaper.
- AWS / GCP — DPDP residency would require AWS/GCP Mumbai region anyway; Azure Central India is functionally equivalent and we got the NGO credit.
- Stripe / Razorpay — Raktify doesn't take payments. Donations are blood, not money.

---

## 6. Compliance & Safety

### Clinical safety (life-critical)

- **All clinical rules live in the database** — CHECK constraints + triggers + RLS, not in application code. Reason: app code has bugs, constraints don't.
- **`audit_log` is INSERT-only** — hash-chained (each row's `previous_row_hash` chains to the prior row's `row_hash`). Tampering detectable via `/admin/audit/integrity` endpoint that recomputes the chain.
- **Two blood-group fields per donor** — `blood_group_self_reported` (display only, never matched) + `blood_group_verified` (matched only; writable solely by `blood_bank` role via column-level GRANT).
- **TTI screening verification is 4-eyes** — supervisor can't be the same user who entered the result. DB trigger refuses INSERT.
- **Lookback registry is mandatory for reactive HIV/HBsAg** — DHO notification within 24h is enforced; close-without-DHO returns 409 from the API.

### DPDP Act 2023 compliance

- **Data residency:** All resources in Azure Central India (Pune). Encryption at rest is Azure-managed (AES-256). Encryption in transit (TLS 1.3) enforced.
- **Consent:** Explicit donor consent captured at registration + revocable via `/donors/:id/consent` (trigger enforces donor-self-only writes; nobody else can modify consent state).
- **Right to access:** Donor sees own data via `/donors/me` + `/passport`. PII-masked for hospital role (mobile shown as `+91XXXXX1234`).
- **Right to delete / erasure:** Hard delete deferred to v2 (current pattern is soft suspend + anonymise). Donor merge endpoint stubbed pending haematologist sign-off on deferral merge semantics.
- **Field-level encryption** for sensitive TEXT fields (full_name, address_line, deferral_reason, TTI screening notes) using AES-256-GCM with a separate key for screening data — provider-prefixed `v1:<provider>:<keyKind>:<base64url>`. The screening-key-only path means an app-server compromise without separately compromising the screening key cannot decrypt TTI data.

### Security hardening

- Helmet CSP `default-src 'none'`, CORS whitelist (no wildcards), global rate limit 100 req/IP/min, per-route rate limits (OTP 3/h/mobile; institutional login 10/15min per username plus a 60/15min/IP sweep ceiling).
- ESLint rule blocks `c.query(\`...${userInput}...\`)` — every SQL site is parameterised.
- All secrets in Azure Key Vault, App Service references via `@Microsoft.KeyVault(SecretUri=...)` so no secrets in env-as-plaintext.

---

## 7. Things to evaluate (BA lens)

### Functional completeness
1. Run through donor registration end-to-end at `https://raktify.choudhari.ngo/register` with a real mobile (you'll get a real WhatsApp OTP — note: prod, not staging).
2. Try the public community page: `https://raktify.choudhari.ngo/community/<slug>` (any active slug — ask Gaurav for one)
3. Try institutional onboarding apply form (no commitment): `https://raktify.choudhari.ngo/onboarding/apply` — you can submit a test institution that NGO admin can decline.
4. Open `https://raktify.choudhari.ngo/sitemap.xml` to see the public surface.

### Director-login things to try (with the credentials Gaurav gives you)
1. `/admin` → **Onboarding** tab → see incoming applications (yours from #3 above will be here)
2. `/admin` → **Coordinators** tab → click "+ Invite coordinator" — full form, sends WhatsApp activation
3. `/admin` → **Community leaders** tab → list of existing leaders + invite flow
4. `/admin` → **Communities** tab → flat view of every community across owners. Filter pills.
5. `/admin` → **Import donors** tab → upload a CSV (sample download button included)
6. `/admin` → **Camps** tab → see camp applications pending verification
7. `/admin` → **Reports** tab → district summary, hemovigilance, BB performance (JSON + CSV download)
8. `/admin` → **Audit** tab → run the hash-chain integrity check

### Architectural questions to probe
- "What happens when free Azure credit expires (July 17)?" → answer: ~₹3000/mo recurring, ledger built into roadmap
- "What's the disaster recovery story?" → 7-day Postgres PITR backups; haven't tested restore yet (TODO before first onboarding)
- "What's the multi-tenant story?" → single-DB multi-institution via RLS. Each blood_bank user only sees their own institution's bags via RLS policies. ngo_admin has cross-institution view.
- "Localisation?" → Marathi (default) + Hindi + English in UI. WhatsApp templates currently English-only; MR + HI templates pending Meta approval batch.
- "Mobile-first?" → Yes, but progressive web app (no native iOS/Android). Works offline (Workbox service worker) for donor availability toggle + last-known data.

### Gaps / honest limitations (intentional surface for review)
- **Pre-screening question bank** is DRAFT — pending medical-advisor sign-off. Currently informational, not blocking.
- **MoU template** is currently a SAMPLE PDF — legal-reviewed final version pending lawyer.
- **WebSocket live queue** for coordinator dashboard is polling (15-20s refresh) — Socket.io upgrade deferred.
- **Workbox BackgroundSync** for offline writes is not wired — relies on IDB outbox + manual retry on online event.
- **Devanagari typography pass** deferred to post-onboarding design polish.
- **Donor merge** endpoint is 501 stub — blocked on medical-advisor confirmation of deferral merge semantics.
- **adverse_reaction table** not yet in schema — hemovigilance report returns `0` with a note.
- **TOTP** is allowed-on-first-login (not enforced) for institutional staff — should harden post-onboarding.

---

## 8. Code + deployment maturity (what BA reviewers usually want to know)

- **Lines of code:** ~25K backend + ~18K frontend (excluding migrations + tests)
- **Migrations:** 287 sequential SQL files, immutable post-apply (runner refuses re-apply on checksum mismatch)
- **Test coverage:** smoke tests per phase (`scripts/smoke_test_phase{1..6}.js`) + frontend build smoke (`npm run smoke:frontend`). Unit-test coverage is intentionally low — clinical correctness is enforced at the DB layer (CHECK + trigger + RLS) which is harder to bypass than mocked unit tests.
- **CI/CD pipeline:** push to main → lint + build (verify) → DB migration (auto) → backend deploy (Azure App Service, OIDC auth, no secrets in workflow) → SWA deploy. Three workflows, all green on every push.
- **Observability:** App Insights enabled (auto via App Service); Postgres slow-query logs to Log Analytics; structured JSON logging via pino with PII redaction.

---

## 9. What's NOT in the platform (deliberate exclusions)

- Inventory across institutions ≠ shared — each blood bank's bags are private to that institution. NGO admin sees aggregates only.
- No global donor "Tinder" — donors are not browsable; matching is one-way (engine selects, donor accepts/declines).
- No financial transactions, no payment integration. The Foundation runs on grants.
- No clinical decision support beyond compatibility matching. Doctor still decides.
- No EHR integration in v1. Patient data is request-scoped (initials + age + sex only).

---

## 10. Quick links for the review

| What | URL |
|---|---|
| Public landing | https://raktify.choudhari.ngo |
| Donor registration | https://raktify.choudhari.ngo/register |
| Institution onboarding apply | https://raktify.choudhari.ngo/onboarding/apply |
| Public community example | https://raktify.choudhari.ngo/community/<ask-Gaurav> |
| Staff login (for director credentials) | https://raktify.choudhari.ngo/staff/login |
| Donor login | https://raktify.choudhari.ngo/login |
| Community leader login | https://raktify.choudhari.ngo/login?role=community_leader |
| Sitemap (for crawl review) | https://raktify.choudhari.ngo/sitemap.xml |
| robots.txt | https://raktify.choudhari.ngo/robots.txt |
| API health | https://raktify-api.azurewebsites.net/health |
| GitHub repo | https://github.com/thinkwithgc/Raktify (access on request) |

---

**Questions / feedback:** route to Gaurav. Documentation suite (Master Prompt, Feature Reference, Deployment, Demo Guide) available on request.
