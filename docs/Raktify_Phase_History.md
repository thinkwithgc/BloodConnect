# Raktify — phase history and migration ledger

Relocated verbatim from `CLAUDE.md` on 2026-09-08 so it is read **on demand**
instead of being loaded into every agent session. Nothing here was edited: each
section is byte-for-byte what `CLAUDE.md` carried, including gate counts, schema
heads and "current totals" that were accurate **when that section was written**.
For the *current* branch, schema head and gate counts, read `CLAUDE.md`.

Two standing caveats that apply to everything below:

- **`npm run migrate:status` is the source of truth for migrations.** The
  `## Migration numbering` table at the end of this file is incomplete — rows
  **267–309 are missing** — and it lists 320 before 319. It is kept for the trap
  notes in the rows it does document, not as an inventory.
- **`node scripts/smoke_test_phase3/5/6.js` must NOT be run.** They carry pre-268
  staff-auth drift and fail for reasons unrelated to whatever you changed. The live
  gates are listed in `CLAUDE.md`.

## Contents

- [Phase status](#phase-status)
- [Post-Phase-8 status (live on Azure)](#post-phase-8-status-live-on-azure--may-2026-single-env-since-jun-2026)
- [Phase 3 handoff](#phase-3-handoff-where-the-scaffold-leaves-off)
- [Phase 4 status](#phase-4-status-core-done-deferrable-items-remain)
- [Phase 5 status](#phase-5-status-core-done)
- [Phase 6 status](#phase-6-status-core-done)
- [Phase 7 status](#phase-7-status-core-complete--design--websocket--cloud-blob-upload-deferred)
- [Phase 8 status](#phase-8-status-code-complete--at-the-time-aws-infra--external-accounts-were-deferred-both-supplanted-by-the-may-2026-azure-deploy--see-post-phase-8-status-above)
- [Migration numbering — divergence from spec](#migration-numbering--divergence-from-spec)

---

## Phase status

| Phase | Status | Smoke test | Notes |
|-------|--------|------------|-------|
| 0 — Infrastructure | ✅ done | `node scripts/smoke_test.js` | commit `1a8ee3e` |
| 1 — DB foundation  | ✅ done (18/18) | `node scripts/smoke_test_phase1_full.js` | 30 migrations *at Phase 1* (46 total now — see summary below), 34 tables, 100 triggers, 71 RLS policies — commit `1a8ee3e` |
| 2 — Auth + onboarding | ✅ done (172/172) | `node scripts/smoke_test_phase2.js` | OTP, TOTP, **paper MoU** (eSign removed Aug 2026) |
| 3 — Donor reg + passport | ✅ scaffold (18/18) | `node scripts/smoke_test_phase3.js` | See **Phase 3 handoff** below |
| 4 — Inventory + TTI | ✅ core (17/17) | `node scripts/smoke_test_phase4.js` | See **Phase 4 status** below |
| 5 — Request engine + matching | ✅ core (20/20) | `node scripts/smoke_test_phase5.js` | See **Phase 5 status** below |
| 6 — Notifications + WhatsApp + Lookback | ✅ core (19/19) | `node scripts/smoke_test_phase6.js` | See **Phase 6 status** below |
| 7 — Frontend (React PWA) | ✅ core | `npm run smoke:frontend` (vite build) | See **Phase 7 status** below |
| 8 — Admin + reporting + deploy | ✅ core (code-complete) | `npm run lint && npm run smoke:frontend` | See **Phase 8 status** below |
| Post-8 — Live deploy + feature gap-close | ✅ live on Azure (single-env `raktify` RG) | `npm run lint && npm run smoke:frontend` | See **Post-Phase-8 status** below |

> **Current totals (2026-09-01):** 99 migrations (latest
> `320_default_language_english`; 319 applied to **prod** 2026-09-01),
> **221** route handlers across 22 resource routers (measured:
> `grep -rhoE "^\s*router\.(get|post|put|patch|delete)\(" backend/src/routes/*.js | wc -l`
> — the older "215" here was not reproducible, so prefer the command), 6 frontend role-portals + public
> surfaces, 3 notification providers (console / MSG91 / WhatsApp Cloud). Phases 0–8
> **and** all post-Phase-8 additions are code-complete and live on Azure
> (`raktify.choudhari.ngo` + `raktify-api` App Service). Single environment
> — the old staging tier was deleted 2026-06-28 (commit `610a5c7`) to save
> free-tier credit; there is no separate prod/staging split today.

## Post-Phase-8 status (live on Azure — May 2026, single-env since Jun 2026)

Everything below shipped **after** the 8-phase build and is deployed. Grouped by area.

### Deployment is real (Azure) — single environment

The staging tier was deleted **2026-06-28** (commit `610a5c7`) to save
free-tier credit. Live Azure infra today (RG `raktify`, Central India):

- **Frontend** → Azure Static Web App `raktify-web`
  (`zealous-plant-0981aed00.7.azurestaticapps.net`) serving `raktify.choudhari.ngo`,
  workflow `.github/workflows/azure-static-web-apps-raktify-web.yml`. `VITE_API_URL`
  is baked into the Vite build at deploy time so the SPA calls the live API origin.
- **Backend** → Azure App Service Linux `raktify-api`
  (`raktify-api.azurewebsites.net`), workflow `.github/workflows/main_raktify-api.yml`.
- **Both workflows trigger only on push to `main`.** The working pattern in this
  worktree is `git push origin <local-branch>:main` (fast-forward) — that single
  push fans out to both deploys. DB migrations run automatically on backend deploy
  (see commit `e80ef50`); seeds are run manually against the live `DATABASE_URL`
  (`node scripts/seed_demo.js`).
- **DB (prod)** → `raktify-db` — Azure Database for PostgreSQL Flexible Server
  (Standard_B1ms Burstable, PG 16), host
  `raktify-db.postgres.database.azure.com`, in the `raktify` RG. App Service
  reads `DATABASE_URL` as a `@Microsoft.KeyVault(...)` reference.
- **DB (dev)** → Neon Postgres (external, free tier) — used for local dev + the
  demo seed script, **not** the live prod DB.
- **Key Vault** `raktify-kv` holds all `WHATSAPP_*`, `JWT_SECRET`, `LEEGALITY_*`,
  `DATABASE_URL`, and encryption keys. App Service reads them via
  `@Microsoft.KeyVault(...)` references + managed identity.
- Azure free-trial credit (~₹18,900) expires **17 Jun 2026**; subscription
  auto-deletes **17 Jul 2026** unless upgraded to Pay-As-You-Go. Steady-state cost:
  PAYG + App Service B1 + Static Web Apps free + Flexible Server Standard_B1ms
  Burstable. Neon free tier stays for dev only, no ongoing cost.

**Do NOT reference** (deleted, gone): `raktify-api-staging`,
`raktify-api-staging-hsdxfzhrg`, `jolly-bay-08008c700` SWA, workflow files
`main_raktify-api-staging.yml` / `azure-static-web-apps-jolly-bay-08008c700.yml`.
If you see those anywhere, the doc is stale.

### WhatsApp Business Cloud API — now the primary notification channel
- **New provider** `backend/src/services/notifications/whatsappCloudProvider.js`
  (`NOTIFICATIONS_PROVIDER=whatsapp_cloud`). Sends template messages **directly via
  the Meta Graph API** (`POST graph.facebook.com/<ver>/<phone-number-id>/messages`)
  — **no BSP, no India DLT** (WhatsApp clears Meta's own template review, not the
  telecom DLT system this is the key divergence from the MSG91/SMS path).
- **Migration 250** widens `notification_log.provider` CHECK to allow `'WC'`
  (alongside `'M9'` MSG91, `'LO'` local-console).
- Env surface (`backend/src/config/env.js` → `env.whatsapp`): `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WABA_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`,
  `WHATSAPP_APP_SECRET`, `WHATSAPP_API_VERSION` (default `v21.0`), plus per-template
  IDs `WHATSAPP_TEMPLATE_{OTP,EMERGENCY,THANKYOU,REMINDER,CRED}`.
- **OTP templates are Authentication-category** — the code goes in BOTH the body
  param and the URL/copy-code button param (`buildComponents()` in the provider).
  All other templates are Utility-category, positional `{{1}}…{{n}}` filled from
  `variables` **in insertion order** (caller order MUST match the approved template).
- `provider.isConfigured()` returns a clean failure (not a throw) when the WABA /
  token / templates aren't set, so dev + CI keep working on the console provider.
- **`OTP_ECHO` flag** (`env.otpEcho`, default `false`) — when `true`, the OTP is
  echoed in the API response body so the site can be demoed without a working
  SMS/WhatsApp send. **Never enable when real users are on the platform.**
- Approved Meta templates: `donor_otp` (auth, MR/HI/EN), `donor_alert_critical`
  (utility, MR/EN), `camp_reminder`, **`camp_organizer_link_v2`** (utility,
  EN/MR/HI — 2 body vars; the 3-var original was read as MARKETING by Meta's
  Marathi classifier and was reworked), `mou_esign_link` (utility, EN),
  `institution_activation_link` (utility, EN), `community_leader_signin`
  (utility, EN). All send + deliver end-to-end; Business Verification is done and
  **WABA payment method is on file** — no silent-drop of live sends.
  `community_leader_welcome` is **DEPRECATED** (re-classified MARKETING after a
  dynamic URL carried a *constant* button value) and is superseded by
  `community_leader_signin`, whose `?m={{1}}` per-recipient URL preserves
  Utility. Template copy is the source of truth in
  `docs/Raktify_WhatsApp_Templates.md`.
- **`env.whatsapp.templates` (`env.js:88`) holds 24 lower_snake keys.** Careful:
  `env.js` has **two** `templates:` maps — `msg91.templates` at line 67
  (camelCase) and `whatsapp.templates` at 88. Tooling must anchor on
  `whatsapp: {`. The provider exports only `{ send, providerName }`, so
  `TEMPLATE_HANDLERS` is module-private and can only be read as source text.
- **Meta constraints that have each already cost a resubmission:** URL-button
  text ≤ **25 characters**; a *parameter* may not contain a newline, tab, or >4
  consecutive spaces (body text may); every URL button must take a
  **per-recipient** variable or Meta re-classifies the template MARKETING; each
  language is a **separate** review (1–3 days). Handler component shapes are
  lower-case (`{type:'body'…}`); the submit script's creation shapes are
  UPPER-case (`{type:'BODY'…}`).
- **Webhook**: `POST /webhooks/whatsapp/incoming` verifies Meta's
  `X-Hub-Signature-256` HMAC against `WHATSAPP_APP_SECRET`; `POST /webhooks/msg91/delivery`
  remains for the MSG91 path.

### Camps — full lifecycle (public host → verify → organizer dashboard → attendance)
Migrations **260–264**, router `backend/src/routes/camps.js`, frontend public +
organizer + admin surfaces. **This section covers the original 2026 lifecycle
only** — attendance derivation (312–314) and BB capacity + `bb_response`
(315–318) are documented in their own sections near the top of this file, and
`camps.js` has grown well past the 14 endpoints described here.
- **260 camp_registrations** — donor sign-ups attached to a camp.
- **261 public_camp_applications** — anyone can apply to host a camp; NGO verifies.
- **262 camp_access_tokens** — magic-link tokens for the organizer dashboard (no
  login; token in URL). Single-purpose, scoped to one camp.
- **263 camp_referral_channel** — attribution: which share channel (WA/SMS/poster
  QR/etc.) drove each registration.
- **264 camp_token_ip_text** — fixed a `22P02` (token IP stored as text, not inet).
- Flow: public **apply** → NGO **review/verify** in `/admin` Camps tab → organizer
  gets a **magic-link dashboard** (roster, attendance, share toolkit with per-channel
  links) → **public camp landing** page → day-of **attendance** marking → post-camp
  roster export. See Feature Reference §9 for the click-path.

### DHO (District Health Officer) governance role
Migrations **265** (role + `platform_users.district_id`) + **266** (staff CHECK allows
`dho`), router `backend/src/routes/dho.js` (5 endpoints), frontend `/dho` dashboard.
- DHO is a **governance, read-only** user: district-scoped **aggregates only** —
  never donor PII, patient PII, or field-level TTI.
- Auth: email + password + TOTP (same as institutional staff).
- **PII boundary by design**: DHO endpoints query under `actor_role='system'`
  (permitted by migration 240 for routing reads) and **aggregate before returning**.
  Deliberately **no new direct-table RLS grants for DHO** — that would risk a PII
  leak if a future endpoint forgets to aggregate.
- Dashboard: adoption KPIs, compliance matrix, live blood-availability heatmap,
  critical-request timeline, hemovigilance summary, camp band. Supporting docs:
  `docs/Raktify_DHO_Circular_Template.html`, `docs/Raktify_DHO_LoC_Template.html`.

### Role dashboards (overview tabs added to existing portals)
- **Blood bank** `/bb` — at-a-glance overview tab (inventory health, expiry buckets).
- **Hospital** `/hospital` — KPIs, district availability, recent activity.
- **Coordinator** `/coordinator` — queue KPIs, impact metrics, district donor pool.

### Institution self-apply onboarding — MoU signed OFFLINE ON PAPER
Router `backend/src/routes/onboarding.js`, service
`backend/src/services/onboarding/activate.js`, frontend `/onboarding/apply` +
`/admin` Onboarding tab. Migration **310** (`signing_mode`).
- A hospital / blood bank applies for an account themselves; NGO admin reviews in
  `/admin` Onboarding tab. Funnel tracked in `institution_referrals.funnel_status`.
- State machine `PE → VE → AC`, **two admin clicks**: `POST /onboarding/verify/:id`
  (licences) then `POST /onboarding/activate/:id` ("Approve & activate"), clicked once
  the admin is holding the physically-signed MoU.
- **Aadhaar eSign (Leegality) was removed from this path in Aug 2026.**
  `POST /onboarding/generate-mou/:id` and the public `POST /onboarding/mou-signed`
  webhook are **gone** (both now 404). The eSign provider (`services/esign/*`), the
  `LEEGALITY_*` env block, `scripts/test_leegality_send.js` and migration 306's
  `current_esign_*` columns are **dormant on disk, not deleted** — nothing in the
  running app reaches them. `activateInstitution()` still takes `signingMode:'ES'`,
  so re-enabling eSign is a new caller, not a rewrite.
- The paper MoU is filed as a real `mou_versions` row with `signing_mode='PA'`,
  admin-entered signed date + signatory name/designation, and an **optional** scanned
  original uploaded via `POST /onboarding/:id/mou-scan` (route-level `express.raw`,
  magic-byte-verified PDF/JPEG/PNG ≤ 10 MB, stored through `services/storage`, key
  `mou/<shortname>/v<N>-scan.<ext>`, sha256 recorded in `pdf_sha256`).
  `effective_from` = the **signing** date (not today); validity = +1 year.
- Activation is the ONLY path that provisions institution admin logins: idempotent-on-
  `username` `platform_users` upserts + magic-link setup tokens. A hospital with
  `has_inhouse_blood_bank=true` gets its paired child BB flipped to `AC` by the same
  UPDATE and a second `-bb_admin` user, whose token is surfaced from
  `institutions.bb_admin_pending_setup_token` on the HO dashboard. **The BB admin is
  created with `mobile = NULL`** — `idx_platform_users_mobile_staff_cluster`
  (migrations 269 + 282) makes mobile unique across staff roles, and the HO admin
  already holds the applicant's number; the BB link is never WhatsApp'd.
- Acceptance gate: `node scripts/smoke_test_phase2.js` (47 assertions, covers the
  paired HO+BB path end to end).

### Patient + rare-blood registries
Router `backend/src/routes/registries.js` (5 endpoints), `/admin` Thalassemia + Rare
blood tabs. Migrations 024 (thalassemia_patients) + 026 (rare_blood_registry) were
always present; the **API + UI** landed post-Phase-8.

### Public surfaces + brand/marketing artifacts
- **Public geo lookup** endpoints (`backend/src/routes/geography.js`) — state →
  district → taluka → village cascade for the donor village picker, no auth.
- **Landing page** (`frontend/src/pages/Landing.jsx`) — hero, how-it-works, trust,
  CTA. **Top nav redesigned (this session)** into 3 clusters: brand · primary CTAs
  (Become a donor / Host a camp) · utility (language dropdown showing native scripts
  / "For hospitals & blood banks" dropdown / Log in), with a mobile hamburger drawer.
  New i18n keys `lp_nav_*` in `frontend/src/i18n/strings.js` (MR/HI/EN).
- **Brand assets** in `frontend/public/`, generated by `node scripts/build_og_image.js`
  (uses `sharp`): `og-image.png` (1200×630 link preview), `app-icon.png` (1024×1024
  rounded-square w/ "R", for PWA/stores), and **`social-avatar.png`** (640×640
  full-bleed droplet, no "R" — for WhatsApp/FB/IG/LinkedIn circular-crop avatars;
  added this session). SVG sources sit beside each PNG.
- **Narrative docs**: `docs/Raktify_System_Overview.html` (16-page illustrated),
  `docs/Raktify_CSR_Budget.html` (2-year budget + roadmap), 3 legal pages, shared
  `Footer.jsx`, full OG / Twitter-Card meta. Public-facing email is `contact@choudhari.ngo`.

### Demo seed
- `node scripts/seed_demo.js` (`--reset` to wipe + reseed) populates the live
  DB with **6 months of realistic activity** so every dashboard renders with
  data: donors across blood groups + districts, donations + TTI, inventory
  with varied expiry, blood requests across all 4 tiers + statuses, camps with
  rosters/attendance, notifications, lookback cases, registries. Run manually
  against `DATABASE_URL` — it is **not** part of any deploy workflow.

### Post-Phase-8 deferred items (still open)
1. **MSG91 SMS path** — DLT registration still pending; SMS fallback (WA→SM→CA on
   Critical) not wired. WhatsApp Cloud covers the primary channel today.
2. ~~**Camp QR registration rate-limit trap**~~ — ✅ fixed 2026-07-02
   (task 78). Global limiter now skips `/donors/register` + `/auth/otp/send`;
   both routes have mobile-keyed per-route limiters. Camp WiFi safe.
3. **DB pool = 10** (`backend/src/config/db.js`) — bump to ~30 before second-district
   rollout (Postgres allows ~75 conns). **PM2 cluster** not wired — vertical scale
   past 1 vCore buys nothing until it is.
4. **Synchronous matching** — `POST /requests` runs the matcher inline inside a
   `withTransaction`. Async queue (BullMQ + Redis) is the right shape past ~1k
   requests/day; deferred until post-CSR-funding.
5. **WhatsApp template approvals** — **closed as of 2026-09-01.** All 25
   appsettings are populated; the four `ad84034` camp templates and
   `camp_review_pending` are APPROVED in `en` (the language every camp send site
   passes), `camp_review_pending` is APPROVED in **all three**, and
   **`camp_day_of_v2` is APPROVED as UTILITY in all three — the appsetting has
   been flipped** (`WHATSAPP_TEMPLATE_CAMP_DAY_OF=camp_day_of_v2`, verified by
   re-`list` 2026-09-01), so the day-of reminder is out of the MARKETING
   frequency cap. Only leftover, blocking nothing: the `mr`/`hi` records of the
   four `ad84034` templates are PENDING, and every camp send site passes
   `language: 'en'` explicitly. See **WhatsApp template pipeline** above.
6. **Institution-users Stage 2 (staff capabilities)** — not started; begins at
   migration **319**. Stage 1 (staff CRUD, magic-link setup, 2FA reset,
   deactivate-with-reason) is live.
7. **`BOT_REPLY` free-form session path** — 6 call sites in
   `services/whatsapp/bot.js` currently cannot reply. Needs a non-template send.
8. Carried over: WebSocket live queue, Workbox BackgroundSync, Devanagari design
   pass, donor-merge endpoint (still 501), `audit_reader` grant for integrity check,
   adverse-reaction table, PDF report generation, **legal review of the MoU
   template** (medical sign-off is done, 10-Jul-2026).
9. **Known smaller drift, logged not fixed:** `PUT /institutions/:id`'s
   authorization pre-read (`institutions.js:265-272`) uses a bare `pool.query`
   while its sibling `GET /:id` reads under `withRlsContext` — a consistency
   wart, **not** a live bug (RLS is inert at runtime and 60 raw `pool.query`
   sites across 11 route files behave identically, `auth.js`'s login reads
   included); deliberately left alone rather than touched without a
   demonstrated defect. `GET /donations/:id`
   (`donations.js:194`) has no institution scoping; `CampsTab.jsx` and
   `CommunityDetail.jsx` each keep a private camp-status palette instead of the
   shared `campStatus.js`; `applySchema` accepts a `community_id` the INSERT
   ignores; `smoke_test_phase3/5/6.js` carry pre-268 staff-auth drift;
   `institutions.is_active` defaults to `false` (a footgun); this file claims a
   `database/triggers/` directory that does not exist.

> **Moved:** this section's `### WhatsApp template pipeline — current state`,
> `### V2 WhatsApp templates` and `### V2 WhatsApp delivery-status hardening`
> subsections now live in `docs/Raktify_Engineering_Lessons.md`.

## Phase 3 handoff (where the scaffold leaves off)

**Working in Phase 3 today:**
- `GET  /donors/eligibility/questions` — returns DRAFT bank
- `POST /donors/register` — web flow, validates, runs duplicate detection, creates donor + platform_user
- `POST /donors/:id/consent` — donor-self only (DB trigger enforces)
- `POST /donors/:id/availability` — donor-self only
- `POST /donors/:id/blood-group/verify` — `blood_bank` role only; writes the only field used in matching
- `GET  /donors/:id/passport` — assembles profile + donations + clearance verdict (no field-level TTI)
- `GET  /donors/me` — convenience self-passport
- `POST /donors/merge` — returns 501 (stubbed)

**TODO before Phase 3 is "done":**
1. **WhatsApp bot registration** (`registration_source='WAB'`) — needs MSG91 DLT templates + bot conversation state machine. Defer to Phase 6 (notifications) since both depend on MSG91.
2. **QR-code camp registration** (`registration_source='QRC'`) — wire `registration_camp_id` → look up camp + pre-fill location. Schema is already there, only the route handler is missing.
3. **Donor merge** (`POST /donors/merge`) — `services/donors/merge.js` documents the design. Blocked on medical-advisor confirmation of deferral merge semantics (worst-case vs strictest deferral_until).
4. **Pre-screening enforcement** — `services/donors/eligibility.js` is now medically signed off (`DRAFT_PENDING_REVIEW=false`, 10-Jul-2026) and `/donors/register` soft-checks it (returns `soft_decline` on a permanent block). Deliberately kept as a soft, donor-facing filter — the binding gate is the DB (component gap via the gender-aware trigger, Hb/deferral in `validate.js`). A hard decline path is optional, not required.
5. ~~**Donor mobile re-verification**~~ — ✅ done in `auth.js` POST /auth/otp/verify (Phase 4 batch).

## Phase 4 status (core done, deferrable items remain)

**Working today:**
- `POST /donations` — blood_bank only; runs `validateDonation()` (deferral, gap, Hb/gender, blood-group-verified) before INSERT; trigger creates QA bag.
- `GET  /donations/:id` — full donation+screening+bag join
- `POST /donations/:id/screening` — TTI panel; sets `verification_required=TRUE` when any RR
- `POST /donations/:id/screening/verify` — 4-eyes (different user from `entered_by`); flips clearance to CL or IN; cascades trigger lookback + bag recall
- `GET  /inventory` — bag list, blood_bank-scoped or admin
- `GET  /inventory/availability` — district-scoped counts (hospitals + coordinators see counts, never bag IDs)
- `POST /inventory/:id/recall` — manual recall by blood_bank or admin
- `POST /inventory/opening-stock` — legacy WB stock entry (currently rides on a seed donation; see TODO)

**Deferrable items for Phase 4 wrap-up:**
1. **Synthetic legacy donor** — opening-stock currently piggybacks on the BB's first verified donation_id. A clean implementation creates a per-institution synthetic donor (mobile `+91-LEGACY-<inst>`, hidden from matching, `is_legacy_synthetic` flag). Schema needs a boolean column on donors or a tag on donation_history.
2. **Scheduled jobs** (spec §6 jobs table): `expiry_alert_job`, `auto_expire_job`, `o_negative_conservation`, `stale_reservation_release`, `eligibility_reminder_job`, `planned_request_upgrade`, `dho_alert_job`, `annual_donor_checkup`. Need a cron runner — `node-cron` or external scheduler. Defer to Phase 6 (notifications) since most of these emit notifications.
3. **WhatsApp opening-stock parser** — depends on MSG91 + DLT (Phase 6).
4. **Volunteer-guided screening UI** — Phase 7 (frontend).

## Phase 5 status (core done)

**Working today:**
- `POST /requests`              Tier 1 OH — auto-assigns coordinator, runs matching synchronously, returns matched bag count + fallback flag.
- `POST /requests/guest`        Tier 2 GH — coordinator on behalf of non-onboarded hospital. Same auto-assign + match flow.
- `POST /requests/community`    Tier 3 CR — gated; max URGENT; awaits coordinator verify before donor activation.
- `POST /requests/citizen`      Tier 4 CI — donor self-service. Same gating as Tier 3.
- `POST /requests/:id/match`    Re-trigger match (coordinator/admin). 409 if Tier 3/4 unverified.
- `POST /requests/:id/cancel`   Releases reservations and marks CA.
- `GET  /coordinator/requests`  District-scoped queue, ordered by urgency.
- `POST /coordinator/requests/:id/accept|claim|verify|noshow|close`
- `POST /coordinator/requests/:id/thread` + `GET /coordinator/requests/:id/thread`

**Matching engine (`services/matching`):**
- compatibility lookup pulls allowed donor groups from `compatibility_matrix` (medically signed off 10-Jul-2026 — confirmed as-drawn, see `docs/medical-review/`)
- inventory selection: same-group preferred → fallback group → FIFO by expiry
- bag reservation under `RE` status with `reserved_for_request_id`
- donor alert creation when inventory insufficient AND `donor_activation_required=TRUE`
- ring-1 escalation_log row stamped on every match attempt
- the whole orchestrator runs under elevated `system` actor_role so audit_log records the system as the side-effect actor (RLS migration 220/221 permits)

**Escalation engine (`services/escalation`):**
- ring 2/3/4/5 widening logic implemented; the SCHEDULED job that calls escalateRequest() lands in Phase 6 (cron)
- ring 4 DHO contact + ring 5 ngo_admin voice call rely on MSG91 (deferred)

**Deferrable for Phase 5 wrap-up:**
1. **Adjacent-states table** — `services/escalation/index.js` ring 3 currently approximates "adjacent" by union of all active states. Needs a real adjacency table or a polygon-based query for production.
2. **NMC registry check** — Tier 2 GH stores `guest_nmc_check_status='PE'`. Wire async NMC API check in Phase 6.
3. **Distance-based donor sort** — `findActivatableDonors` sorts by reliability_score; spec calls for `ST_Distance` when both donor and hospital have lat/lng. Add when PostGIS is enabled (post-go-live decision).
4. **Hospital-self-service crossmatch flow** — POST /requests/:id/confirm-crossmatch from hospital role (currently bundled into coordinator close).

## Phase 6 status (core done)

**Working today:**
- `GET  /lookback`                       open-cases queue (ngo_admin)
- `GET  /lookback/donor/:donor_id`       all rows for a donor
- `GET  /lookback/:id`                   detail
- `POST /lookback/:id/contact-hospital`  records hospital contact
- `POST /lookback/:id/dho-notify`        records DHO notification (mandatory for HIV/HBsAg)
- `POST /lookback/:id/close`             closure with outcome notes; HIV/HBsAg blocked w/o DHO notify
- `POST /webhooks/msg91/delivery`        delivery-status webhook → updates `notification_log.delivery_status`; `delivery_status='OP'` propagates to `donors.{whatsapp,sms}_opted_in` via the existing trigger
- `POST /webhooks/whatsapp/incoming`     bot dispatcher (registration state machine + BB inventory parser)
- `GET  /admin/jobs`                     list registered scheduler jobs
- `POST /admin/jobs/run`                 super_admin manual trigger

**Notification chokepoint** (`services/notifications/index.js`):
- now persists ONE `notification_log` row per send (real bug fixed mid-Phase-6 — outbox-only previously)
- resolves recipientId (UUID or +91 mobile) to `recipient_donor_id` / `recipient_user_id` / `recipient_institution_id` / `recipient_external_mobile`
- elevates to `system` actor_role for the log INSERT so RLS permits

**Scheduler** (`services/scheduler/`):
- `node-cron` registration; `SCHEDULER_ENABLED=true` to enable in dev (default off so smoke tests don't fight a parallel tick)
- 7 jobs implemented: `auto_expire`, `stale_reservation_release`, `planned_request_upgrade`, `eligibility_reminder`, `escalate_overdue`, `bot_session_cleanup`, `data_retention_purge` (DPDP §8(7) — scrubs `notification_log` PII older than `PII_LOG_RETENTION_DAYS`, default 90)
- Manual run via `POST /admin/jobs/run` (super_admin) for ops + tests

**WhatsApp bot** (`services/whatsapp/bot.js`):
- registration state machine: IDLE → NAME → DOB → GENDER → VILLAGE → CONSENT → COMPLETE
- BB staff: parses `UPDATE B+ 4 O+ 2` messages (intent only — does not auto-apply WB stock yet; replies with admin link)
- session state in `bot_sessions` table (1h TTL, cleanup job included)

**Migrations added:** 230 (bot_sessions), 240 (RLS allows `system` to SELECT donors+platform_users for delivery routing).

**Deferrable for Phase 6 wrap-up:**
1. **MSG91 provider live wiring** — DLT auth key + templates pending. Console provider works for dev/CI; flipping `NOTIFICATIONS_PROVIDER=msg91` is a one-env change.
2. **Opt-in / DND enforcement** — chokepoint accepts `emergencyOverride` and writes `was_dnd_overridden`, but doesn't yet check `donors.{whatsapp,sms}_opted_in` or DND hours window. Wire when MSG91 lands.
3. **Fallback chain** (WA → SM → CA on Critical) — schema + parent_notification_id column ready; logic deferred.
4. **WhatsApp bot WB inventory auto-apply** — currently logs intent + replies with admin-confirm link. Auto-apply needs the synthetic-legacy-donor work from Phase 4 deferrables.
5. **DHO contact** (ring 4 escalation) — `escalate_overdue` job stamps the row but the WhatsApp+voice send is deferred to MSG91 wiring.
6. **Annual donor checkup** + **expiry alert** + **o_negative conservation** + **dho_alert** jobs — schemas exist, jobs not implemented yet (mostly notification-emitting; defer with MSG91).

## Phase 7 status (core complete — design + WebSocket + cloud blob upload deferred)

**Stack:** Vite 5 + React 18 + Tailwind 3 + React Query 5 + react-router-dom 6 + axios + zod + vite-plugin-pwa. Plain JS (no TS) to match backend conventions. Run `npm run dev:frontend` (Vite proxy forwards `/auth`, `/donors`, `/coordinator`, `/requests`, etc. to `http://localhost:3000`); `npm run smoke:frontend` compiles a production bundle and emits the service worker (~389 KiB precached).

**Working today:**
- `frontend/src/lib/api.js` — axios client with JWT interceptor; 401 dispatches `rk:auth-expired` and AuthContext clears the token.
- `frontend/src/lib/outbox.js` + `useOutbox.js` — IndexedDB-backed outbox; FIFO replay on `online` event + on hook mount; React Query keys re-invalidated after a successful flush.
- `frontend/src/lib/schemas.js` — shared client Zod schemas mirroring backend `requestSchema`, `donationSchema`, `openingStockSchema`. Hospital + BB forms validate against these before POST and surface field-level errors inline.
- `frontend/src/auth/AuthContext.jsx` + `RequireAuth.jsx` — token persisted in `localStorage` (`bc.jwt`, `bc.role`, `bc.user_id`); guards routes by role.
- `frontend/src/i18n/strings.js` — Marathi (default) / Hindi / English string bank with `useT()` hook + browser-detect + persisted preference (spec §7.1). `tFor` supports `{n}`-style placeholders. Tab labels + outbox banner + role-pick land in MR/HI; deep clinical copy intentionally still English (translation needs medical-advisor review).
- **Donor:** `/login` (mobile → OTP → JWT). `/register` (4-step wizard: pre-screening → details → temporary deferral notice → consent. Chains `POST /donors/register` → `POST /auth/otp/{send,verify}` → `POST /donors/:id/consent` end-to-end). `/donor` (large availability toggle, blood-group badge, next-eligible, donation history). **Availability toggle is offline-capable**: optimistic update + IDB outbox replay on reconnect. A pending-changes banner surfaces the queue and offers a manual Retry.
- **Staff:** `/staff/login` (email + password + TOTP via `POST /auth/institutional/login`).
- **Coordinator:** `/coordinator` (queue, urgency colour-coding, accept, 15s refetch). `/coordinator/requests/:id` (detail panel: clinical card, action bar (accept / claim / verify / re-trigger match / close-with-bag-IDs), cross-role thread with visibility-scope picker; 20s refetch).
- **Hospital:** `/hospital` (2 tabs: **My requests** with `GET /requests/mine` list + per-request **Confirm crossmatch** CTA → `POST /requests/:id/confirm-crossmatch`; **Raise new** form posts `/requests` and validates against `requestSchema` first).
- **Blood bank:** `/bb` (4 tabs).
  - **Inventory** — `GET /inventory` with status filter; expiry colour: >7d green / 2–7d amber / <48h red.
  - **Record donation** — donor mobile lookup (`GET /donors/lookup?mobile=…`, see backend note below) auto-fills donor id + previews verified blood group + deferral state; rest of form validates against `donationSchema` then posts `/donations`.
  - **TTI screening** — opens any donation_id, accordion HIV/HBsAg/HCV/Syphilis/Malaria with NR/RR/PE/ID pills, posts `/donations/:id/screening`; 4-eyes verify button posts `/screening/verify` (backend rejects same-user verify).
  - **Opening stock** — repeating-row form posts `/inventory/opening-stock` (per-row blood_group × component × units × volume). Validates against `openingStockSchema`.

**Backend additions in Phase 7 wrap-up:**
- `GET /donors/lookup?mobile=` (blood_bank, ngo_admin, super_admin) — donor lookup by mobile for BB donation recording. Runs under elevated `system` actor (migration 240 permits) so first-time donors at a new BB are visible; the existing `donors_self` blood_bank policy only sees donors with prior donation_history at this BB. The route only exposes id + name + verified blood group + deferral/eligibility flags — never returns mobile or address.
- `GET /requests/mine` (hospital) — list of the authenticated hospital's own requests (matched BB, coordinator, status, fulfilled/required, crossmatch_confirmed). Declared **before** `GET /:id` so Express doesn't bind `'mine'` to the `:id` param.
- `POST /requests/:id/confirm-crossmatch` (hospital) — sets `crossmatch_confirmed=TRUE` and flips status `FU → CL` if applicable. Hospital-side close (spec §7); coordinator close still owns bag-state writes.

**Deferrable for the next pass:**
1. **WebSocket / Socket.io live queue** (spec §7.10) — coordinator queue + request detail still poll (15s + 20s). Blocked on backend Socket.io server.
2. **Document upload via cloud-blob signed URL** — pending the Azure Blob Storage provider wire-up in `services/storage` (the spec originally said S3 — superseded by the May 2026 Azure pivot); backend route still emits local-disk URLs in dev. Request detail panel surfaces no document UI today.
3. **Blood-bank incoming-request alerts** — "Raise Hand" panel that shows open requests matching this BB's available inventory (spec §7). Needs a new endpoint that joins `blood_requests` against `blood_inventory.blood_bank_id = me`.
4. **Workbox `BackgroundSyncPlugin`** — the IDB outbox replays on `online` + on hook mount, but doesn't yet leverage the SW's BackgroundSync API (which can wake the SW even when no tab is open). Current implementation degrades gracefully — replay just waits until the user reopens the tab.
5. **i18n widening** — clinical copy + form labels in coord/hospital/BB tabs are English. Translate after medical-advisor review of the donor-facing copy lands.
6. **Design pass** — Tailwind utilities only, single brand colour, system font. A Devanagari-friendly font (`Noto Sans Devanagari`), proper type scale, spacing tokens, and motion/microinteractions are intentionally deferred until full screen inventory exists (post Phase 8).

## Phase 8 status (code-complete — at the time, AWS infra + external accounts were deferred; both supplanted by the May 2026 Azure deploy — see Post-Phase-8 status above)

**What landed in this pass:**

### Security hardening (`backend/src/app.js` + `middleware/sanitize.js` + `eslint.config.js`)
- **Helmet CSP** tightened: `default-src 'none'; frame-ancestors 'none'`. We're an API, not an HTML server.
- **CORS whitelist** — `FRONTEND_URL` + `ALLOWED_ORIGINS` (comma-separated) only; no wildcard. Origin-less requests (curl, same-origin) still allowed.
- **Global rate limit** — 100 req/IP/min on every route; `/health` exempt. Stacks under the OTP (3/h/mobile) and institutional-login (10/15min per **username** + a wider 60/15min/IP sweep ceiling — a hospital is one NAT'd IP, so an account-keyed budget is what keeps a shift change from locking the ward out) per-route limits already in `routes/auth.js`.
- **`sanitizeInput` middleware** — recursively strips ASCII control chars + script/iframe/object/embed bookends + caps string fields at 8 KiB. Type coercion stays with Zod; SQL escaping stays with parameterised queries.
- **ESLint `no-restricted-syntax`** rule blocks any `c.query(\`... ${userInput} ...\`)`. Five existing dynamic-SQL sites where the interpolation is a Zod-validated whitelist or constant fragment carry justified `eslint-disable-next-line` comments. Two sites (rlsContext, auth lockout interval) were rewritten to use parameter placeholders instead.
- `app.set('trust proxy', 1)` so `req.ip` keys correctly behind ALB.

### Backend admin endpoints (`routes/admin.js`)
- `GET /admin/coordinators?status=pending|active|suspended` — derived from `id_verified_at`, `is_active`, `suspended_at` (no synthetic status column needed).
- `POST /admin/coordinators/:id/verify` — sets `id_verified_at` + `id_verified_by` + flips `is_active=TRUE`.
- `POST /admin/coordinators/:id/suspend` — sets `suspended_at` + clears `is_active`/`on_duty`.
- `GET /admin/duplicates` — pairs from `donors.suspected_duplicate_of` JOIN canonical row.
- `POST /admin/duplicates/:id/clear` — clear false-positive flag.
- `POST /admin/duplicates/:id/merge` — **501** stub. See `services/donors/merge.js` design notes; blocked on medical-advisor sign-off.
- `GET /admin/referrals` — funnel summary (`institution_referrals.funnel_status`) + recent rows + conversion rate (onboarded / total).
- `GET /admin/audit` — filterable read of `audit_log_safe` view (`table_name`, `actor_user_id`, `event_type`, `since`, `until`, `limit`).
- `GET /admin/audit/integrity?limit=N` — pulls last N audit rows in event-time order, recomputes hash chain, reports any breaks. **Requires** `audit_reader` membership to SELECT `audit_log` directly (only `audit_log_safe` is granted today) — currently returns 500 with a clear "audit_read_denied" message until a small grant migration lands.

### Backend DHO + hemovigilance reports (`routes/reports.js`)
- `GET /reports/district/:district_id/summary?month=YYYY-MM` — requests raised/fulfilled/expired, avg response/match seconds, shortages by blood group, donor pool, camps, wastage. Coord/admin only.
- `GET /reports/hemovigilance?month=YYYY-MM` — lookback opened/closed, reactive TTI counts (HIV/HBsAg/HCV/syphilis/malaria/NAT), donation source breakdown. ngo_admin/super_admin only. Adverse-reaction count returns 0 with `note: 'adverse_reaction_table_pending'` (post-launch table).
- `GET /reports/blood-bank/:id/performance?month=YYYY-MM` — inventory accuracy %, fulfilment counts, avg TTI entry latency. BB users restricted to their own institution.
- All reports support `?format=json` (default) and `?format=csv` (RFC4180-quoted, multi-section). PDF generation deferred (needs Puppeteer/wkhtmltopdf).

### Frontend NGO admin dashboard (`/admin`)
- `pages/admin/AdminDashboard.jsx` — tabbed shell, ngo_admin / super_admin only.
- **Coordinators** tab — filter pill bar (Pending / Active / Suspended / All), one-click Verify, Suspend with reason prompt.
- **Duplicates** tab — paired suspected/canonical cards with Clear-flag and Merge buttons (Merge surfaces the 501 message).
- **Referrals** tab — 6-column funnel grid with conversion %, recent referrals table.
- **Lookback** tab — open investigations queue with red highlight for cases >14 days (spec §10).
- **Audit** tab — filter form (table, actor UUID, event type, since/until, limit) + on-demand "Run hash-chain integrity check" button.
- **Jobs** tab — scheduler view with super_admin-only "Run now" button.

### Frontend reports viewer (`/admin/reports`)
- Month picker, three report tabs (district / hemovigilance / BB performance), JSON-driven stat blocks + tables, "Download CSV" button that fetches `?format=csv` with the JWT.
- Linked from the AdminDashboard nav so admins/coordinators don't have to remember the URL.

### Routing + redirects
- `App.jsx` `HomeRedirect` now sends `ngo_admin` / `super_admin` to `/admin`.
- `StaffLogin` routes those roles to `/admin` instead of `/coordinator`.

### Deployment doc (`docs/DEPLOYMENT.md`)
- **Azure Database for PostgreSQL Flexible Server** recipe (Central India, zone-redundant HA, PITR, encryption at rest, VNet integration).
- **Azure App Service Linux** backend with Always-On + `/health` probe; **Azure Static Web Apps** frontend with custom domain + free managed TLS.
- **Azure Key Vault** for all secrets; managed identity on App Service references `@Microsoft.KeyVault(...)` values.
- Production `.env` template covering current provider switches (`ENCRYPTION_PROVIDER=local`, `STORAGE_PROVIDER=local`, `NOTIFICATIONS_PROVIDER=whatsapp_cloud`, `MAIL_PROVIDER=console`) plus the full `WHATSAPP_*` env block + `OTP_ECHO`.
- New **§2.1 "Live deployment (current reality)"** documenting the workflow: `raktify-db` Flexible Server (prod) with Neon reserved for dev, the two GitHub Actions, `git push origin <branch>:main` fast-forward pattern, Azure free-trial expiry, cost guidance.
- Monitoring matrix (Application Insights, Azure Monitor alerts, Sentry).
- Security-hardening verification checklist matching the spec §10 items.
- Excerpted go-live checklist; full version stays in the Master Prompt.
- (The original spec called for AWS RDS Mumbai / EC2+ALB+ACM / S3+CloudFront / `ENCRYPTION_PROVIDER=kms` / `STORAGE_PROVIDER=s3` — superseded by the May 2026 Azure pivot.)

**What's deferred (out of scope for code work):**
1. ~~**Azure DB cutover**~~ — ✅ done. Prod runs on `raktify-db` (Azure Database for PostgreSQL Flexible Server, PG 16). Neon is dev-only now. (The original spec required AWS RDS / EC2 / S3 — those line items are obsolete post-Azure pivot. Azure Key Vault + App Service + Static Web Apps + Flexible Server + the WhatsApp Cloud setup are all done.)
2. **External accounts + keys** — Meta WABA payment-method on file (live blocker for delivery), MSG91 DLT templates (only needed for the SMS fallback channel), LeegAlly e-sign, Google Workspace admin, Sentry, Better Uptime / UptimeRobot. Each is a vendor signup with KYC.
3. **PDF generation** for DHO submission — `routes/reports.js` returns CSV; PDF needs Puppeteer or wkhtmltopdf wired into the storage abstraction. CSV is acceptable for hemovigilance interim filings.
4. **`audit_reader` SELECT grant on `audit_log`** for the integrity check — currently the role only has SELECT on `audit_log_safe` (which masks `row_hash` / `previous_row_hash`). One-line migration: `GRANT SELECT (id, event_time, table_name, record_id, row_hash, previous_row_hash) ON audit_log TO audit_reader;`. Endpoint already returns a clear diagnostic 500 in the meantime.
5. **Adverse transfusion reactions table** — referenced in spec §10 hemovigilance; not in the schema yet. Hemovigilance report returns `{ reported: 0, note: 'adverse_reaction_table_pending' }` so the DHO PDF template can render the section.
6. **Merge endpoint** for duplicate donors — still 501; design notes in `services/donors/merge.js`. Blocked on medical-advisor confirmation of deferral merge semantics (worst-case vs strictest `deferral_until`).
7. **WebSocket live queue** + **Workbox BackgroundSync** + **Devanagari design pass** — carried over from Phase 7 deferrables.
8. ~~**Medical-advisor sign-off**~~ — ✅ done 10-Jul-2026 (haematologist; answers transcribed in `docs/medical-review/Raktify_Clinical_Questions_Answers.md`, applied via migration 297 + seeds 002b/002c + `eligibility.js`). **Only the legal review of the MoU template now remains** before onboarding institutions. Clinical follow-ups surfaced by the review (non-blocking): model leukodepleted/irradiated/CMV-neg as separately-licensed products (Q5/Q6), SDP ≤2/week + ≤4/month rate cap (Q3), weight→draw-volume 45 kg/350 ml at the chair (Q1), seed KEM-Mumbai rare-blood reference lab (Q19a), MTP uncrossmatched-release acknowledgement toggle (Q14).

## Migration numbering — divergence from spec

The Master Prompt assigns numbers 001–025 to schema migrations. To avoid colliding with already-applied infrastructure migrations on the dev DB, we use the following mapping. **Use spec numbers in conversations and CLAUDE.md references; use the file numbers in the repo.**

| Spec | This repo | Table |
|------|-----------|-------|
| 001 | 001 | geographic |
| 002 | 002 | reference (blood_groups, components, compatibility_matrix) |
| 003 | 003 | platform_users |
| 004 | 004 | institutions |
| 005 | 005 | mou_versions |
| 006 | 006 | coordinators |
| 007 | 007 | communities (+ community_moderators) |
| 008 | 008 | donors |
| 009 | 009 | institution_referrals |
| 010 | **020** | donation_history (010 reserved for grant_helper_roles) |
| 011 | **021** | donor_screening (011 reserved for grant_schema_to_helpers) |
| 012 | **022** | screening_audit_log |
| 013 | **023** | blood_inventory |
| 014 | **024** | thalassemia_patients |
| 015 | **026** | rare_blood_registry |
| 016 | **027** | blood_requests |
| 017 | **028** | request_assignments |
| 018 | **029** | request_documents |
| 019 | **030** | donor_alerts |
| 020 | **031** | escalation_log |
| 021 | **032** | request_threads |
| 022 | **033** | donation_camps |
| 023 | **034** | notification_log |
| 024 | **035** | lookback_registry |
| 025 | 025 | audit_log (placed early so feature triggers can attach via 099) |

Internal-only repo migrations: `010_grant_helper_roles`, `011_grant_schema_to_helpers`, `099_attach_audit_triggers`, `100_rls_phase1`, `200_rls_phase1_extra`. Patches: `210`, `211`, `212`.

**Post-Phase-8 migrations (220 → 266):** RLS + feature migrations added after the
8-phase build. Use file numbers in the repo.

| File | What it does |
|------|--------------|
| `220_rls_allow_system_auto_assign` | RLS: `system` actor may auto-assign coordinators during matching |
| `221_rls_allow_system_donor_alerts` | RLS: `system` actor may create donor alerts during matching |
| `230_bot_sessions` | WhatsApp bot conversation-state table (1h TTL) |
| `240_rls_system_read_for_routing` | RLS: `system` may SELECT donors + platform_users for delivery routing + donor lookup |
| `250_notif_provider_whatsapp_cloud` | Widen `notification_log.provider` CHECK to allow `'WC'` (WhatsApp Cloud) |
| `260_camp_registrations` | Donor sign-ups attached to a camp |
| `261_public_camp_applications` | Public "host a camp" applications (NGO verifies) |
| `262_camp_access_tokens` | Magic-link tokens for the organizer dashboard |
| `263_camp_referral_channel` | Per-registration share-channel attribution |
| `264_camp_token_ip_text` | Fix: camp token IP stored as text (was `22P02` on inet) |
| `265_dho_role` | DHO role + `platform_users.district_id` |
| `266_staff_constraint_allow_dho` | Allow `dho` in the institutional-staff CHECK |
| `310_mou_paper_signing_mode` | `mou_versions.signing_mode` (`ES`/`PA`) + `institutions.mou_signing_mode`; drops NOT NULL on `leegally_doc_id`/`pdf_storage_key`/`pdf_sha256` and re-imposes the old invariant as `esign_requires_doc_id` CHECK. Enables the paper-MoU path |
| `311_platform_user_lifecycle` | `platform_users.deactivated_at`/`deactivated_by`/`deactivation_reason` + `institutions.onboarding_status='AR'` (archived). Staff and institutions are retired with a mandatory reason, never hard-deleted; reversible by `super_admin` |
| `312_camp_registration_deferred` | `camp_registrations.status` gains `'DF'` (came, could not donate) + `donation_camps.deferred_donor_count`. **`DF` is an attendance fact only** — it must never write `donors.deferral_until` or `next_eligible_date` (hard rule 1) |
| `313_camp_counts_derived` | One `AFTER INSERT/UPDATE OF status/DELETE` trigger recomputes all three camp counts from the roster (`registered` = `status <> 'CN'`, `attended` = `'AT'`, `deferred` = `'DF'`). Backfills every camp, wrapping attended in `GREATEST(derived, existing)` **on the backfill only** so hand-typed totals survive |
| `314_camp_attendance_from_donation` | **Attendance derives itself.** `AFTER INSERT OR UPDATE OF donation_camp_id ON donation_history` upserts a `'AT'` roster row when `donation_camp_id IS NOT NULL AND trust_level IN ('V','R')`; adds roster `source='WI'`. A trigger, not route code, because there are three donation-insert paths (`POST /donations`, the vendor webhook, bulk upload). Self-reported (`S`) donations never create attendance, and `is_invalidated` never unwinds it — the person still came |
| `315_camp_requested_blood_bank` | `donation_camps.requested_blood_bank_id` — the organiser NAMES a preferred BB on the public form; `POST /camps/:id/verify` promotes request → partner via `COALESCE`. The organiser asks, the NGO admin decides |
| `316_bb_camp_capacity` | `bb_camp_settings` (per-BB parent: `staff_total`, `staff_per_camp`, `default_max_camps`, `weekly_closed_days`, `auto_accept_within_capacity`) + `bb_camp_capacity` (per-day child, `UNIQUE (blood_bank_id, capacity_date)`). **`max_camps=0` IS the holiday; no row means NOT PUBLISHED, never closed.** Header records that RLS is inert at runtime, so the handler `WHERE` is the boundary |
| `317_camp_bb_response` | `donation_camps.bb_response` (`PE`/`AC`/`DC`) + `_at`/`_by` + `bb_decline_reason` (`NC`/`ND`/`DT`/`VE`/`OT`, extending 287's vocabulary) + `bb_decline_note`. **An axis ORTHOGONAL to `status`, which gains no value.** Two CHECKs: `bb_response_needs_partner`, `bb_decline_reason_needs_decline` |
| `318_bb_camp_settings_audit_id` | Fix: `fn_audit_row()` (025) hardcodes `NEW.id`, and `bb_camp_settings` is keyed on `blood_bank_id` — so 316's own audit trigger threw `record "new" has no field "id"` on every write. 316 was already applied and migrations are immutable, hence a new file. **Any table passed to `attach_audit_trigger()` needs a column literally named `id`** |
| `320_default_language_english` | `preferred_language` defaults `'mr'` -> `'en'` on `donors` / `coordinators` / `community_leaders`. Catalogue-only (`SET DEFAULT`) — no rewrite, no scan. **Existing rows deliberately NOT backfilled**: a stored `'mr'` cannot be told apart from a chosen `'mr'`. See **English is the default language** above |
| `319_camp_branding` | `donation_camps` + `organiser_tagline`, `branding_status` (`PE`/`AP`/`RJ`), `branding_reviewed_at`/`_by`, `branding_review_note`; new `camp_branding_logo` holding the logo as a **`data:` URI**, one row per camp. **Deliberately unaudited and deliberately without an `id` column** — the missing `id` is a tripwire that makes `attach_audit_trigger()` throw 318's error rather than silently store a 67 KB blob in an INSERT-only table twice per edit. See **Camp branding** above |

> **⚠ This table is INCOMPLETE — 267–309 are missing.** It lists 220–266 plus
> 310–320, but the repo holds **99 migration files, latest
> `320_default_language_english`** (next new one is **321**). The undocumented
> span 267–309 includes the vendor webhook (307/308), blood-group HITL (309),
> citizen-raise (303), community-leader served-districts (304), donor-alert
> horizon (305), institution eSign state + paired BB (306), staff-cluster mobile
> uniqueness (269/282), open-request BB declines (287, whose `NS`/`NC`/`ND`
> reason codes 317 extends), staff 2FA enforcement (296), the medical sign-off
> promotion (297), case-chat scope (299/300) and bag chain-of-custody (301/302).
> **`npm run migrate:status` is the source of truth.** Backfilling the missing
> rows is a separate cleanup task, deliberately not done inline.

**Run `npm run migrate:status`** for the applied/pending/drift view.

