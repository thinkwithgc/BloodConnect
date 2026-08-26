# Raktify — Feature Reference

> **Snapshot date:** 26 May 2026 — for the 27 May 2026 donor / partner meeting.
> Authoritative source for *what is built*. The Master Prompt (`docs/Raktify_Master_Prompt.md`)
> remains the source for *what the product is supposed to be*. The Demo Guide
> (`docs/Raktify_Demo_Guide.md`) is the step-by-step runbook for live walk-throughs.

Raktify is a life-critical blood donation and emergency-request platform
operated by **Choudhari EduHealth India Foundation** (Amravati, Maharashtra).
The product is built across 8 sequential phases plus a post-Phase-8
gap-close + live-deploy pass. As of this snapshot all 8 phases **and** the
post-Phase-8 additions are **code-complete** and live on Azure staging at
**`raktify.choudhari.ngo`** (frontend) + `raktify-api-staging` (Azure App
Service, Central India). Current totals: **46 migrations** (latest `266`),
**104 route handlers** across 17 resource routers, **6** frontend role-portals,
**3** notification providers (console / MSG91 / WhatsApp Cloud).

---

## Contents

1. Architecture at a glance
2. Roles and what each one can do
3. Public surfaces (no login required)
4. Donor experience
5. Hospital portal
6. Blood bank portal
7. Coordinator portal
8. NGO admin portal
9. Camp lifecycle (host → verify → invite → roster → attendance)
10. Patient + rare-blood registries
11. Notifications & WhatsApp
12. Geographic data
13. Security & privacy invariants
14. API surface (104 route handlers)
15. Database (46 migrations)
16. Deployment & infrastructure
17. Build / lint / test / migrate commands
18. Deferred items (deliberate non-goals for the demo)

---

## 1. Architecture at a glance

| Layer | Technology | Hosted on |
|-------|------------|-----------|
| Database | PostgreSQL 17 with Row-Level Security on every table | Azure Database for PostgreSQL Flexible Server (B1ms, Central India) |
| Backend API | Node.js 22 LTS + Express + pg | Azure App Service (Linux B1) |
| Frontend | React 18 + Vite 5 + Tailwind 3 PWA + React Query 5 | Azure Static Web Apps (Free, Central India) |
| Auth — donors / coordinators | Mobile OTP delivered via **Meta WhatsApp Business Cloud API** (live primary channel). MSG91 SMS is the stubbed fallback; staging supports `OTP_ECHO=true` to echo the OTP in the API response for demos when no provider is wired. | — |
| Auth — institutions | Email + bcrypt + TOTP | — |
| Notifications | Provider abstraction: console / msg91 / **whatsapp_cloud** (Meta) — `whatsapp_cloud` is the live primary channel. | Backend service |
| Encryption | AES-256-GCM via the `local` provider; key material held in Azure Key Vault (prod) and injected as App Service settings. Two distinct keys (main + screening). An Azure Key Vault crypto provider in `services/encryption` is future work. | — |
| File storage | Local disk on App Service today (`STORAGE_PROVIDER=local`); Azure Blob Storage provider is future work. The original spec mentioned AWS S3 — superseded by the May 2026 Azure pivot. | — |
| Digital MoU | Leegality (Aadhaar eSign) — local provider works in dev | — |
| Geography | Local Government Directory (LGD) bulk importer | — |
| CI/CD | GitHub Actions with Azure OIDC federated identity | `.github/workflows/main_raktify-api-staging.yml` + Static Web Apps workflow |

**Key architecture decisions** (full discussion in `CLAUDE.md` and the
Master Prompt):

- **Patient-safety rules live in the database**, not application code. CHECK
  constraints, triggers, and RLS — application code has bugs, constraints
  don't.
- **`audit_log` is INSERT-only and hash-chained.** Only the `audit_writer`
  Postgres role can write to it. No application role has UPDATE or DELETE.
- **Donor PII is masked from hospitals.** Mobile numbers are never returned
  to the hospital role.
- **Self-reported blood group is never used in matching.** Only
  `donors.blood_group_verified` (writable solely by `blood_bank` role) is
  queried during the matching engine.
- **Migrations are immutable once applied.** The runner refuses to re-apply
  a migration whose checksum changed.

---

## 2. Roles and what each one can do

The system has 10 distinct roles (5 user-bearing + 4 special + 1 magic-link).
Every database table is gated by Row-Level Security keyed off
`raktify.actor_role` and `raktify.actor_user_id`.

| Role | Identity | Auth | What it can do | What it cannot do |
|------|----------|------|----------------|-------------------|
| **donor** | A person who donates blood | Mobile OTP | Register, set availability, update consent, view own donation history & TTI clearance (verdict only, never field-level results), RSVP to camps, raise a citizen-tier request | See other donors' PII, see inventory, see request matching engine internals |
| **coordinator** | NGO volunteer in a district | Mobile OTP | See district open-request queue, accept / claim assignment, verify Tier 3/4 requests, mark donor no-shows, close requests with bag IDs, post cross-role thread messages, enrol thalassemia patients, schedule camps | See another district's data, write to `audit_log`, modify clinical reference data |
| **hospital** | Institutional user at an onboarded hospital | Email + password + TOTP | Raise requests, see own request history, confirm crossmatch, see district inventory **counts** (never bag IDs) | See donor mobile numbers, see other hospitals' requests, modify inventory |
| **blood_bank** | Institutional user at an onboarded blood bank | Email + password + TOTP | Record donations, run TTI screening, dual-eyes verify TTI, manage inventory (recall, reserve, issue), respond to incoming requests via Raise-Hand, enrol rare-blood donors | Modify another bank's inventory, override TTI without 4-eyes |
| **ngo_admin** | NGO operations staff | Email + password + TOTP | Verify institution applications, send MoU eSign, verify coordinators, manage duplicates, review lookback investigations, query audit log, run scheduler jobs manually, view all reports | Write to `audit_log` directly, modify clinical reference data |
| **super_admin** | Platform super-user | Email + password + TOTP | Everything ngo_admin can plus suspend institutions, decommission coordinators | Bypass `audit_log` constraints |
| **dho** | District Health Officer (government governance) | Email + password + TOTP | Read-only district-scoped governance dashboard at `/dho` — KPIs, institutional compliance grades, shortage heatmap, critical-request timeline, hemovigilance summary, monthly report exports | See any individual donor / patient PII, see field-level TTI results, modify any data, see other districts |
| **system** | Service-account context for triggers, scheduled jobs, notification chokepoint | none (set by middleware) | Insert into `audit_log`, run cross-table reads for routing notifications, run match engine inside requests | Be authenticated as via API |
| **onboarding** | Synthetic role used by public apply endpoints (`/onboarding/apply`, `/camps/apply`, `/camps/host`) | none | Insert institutions / camp applications in `PE` (pending) state only | Read any data, write any other state |
| **camp_organizer** | Magic-link bearer for one camp | Token IS the credential | Read their camp's roster (name + blood group only, mobile masked), broadcast updates, mark attendance, see channel attribution | See any other camp, see donor mobiles, RSVP donors directly |

---

## 3. Public surfaces (no login required)

The platform is **donor-conversion-driven**, so several pages are public:

| URL | What it is |
|-----|------------|
| `/` | Landing page (Raktify wordmark, hero, three pillars, partner CTAs) |
| `/login` | Donor login (mobile + OTP) |
| `/register` | Donor registration wizard (4 steps: pre-screening → details → temporary deferral notice → consent + OTP + finalisation) |
| `/staff/login` | Institutional staff login (email + password + TOTP) |
| `/onboarding/apply` | Hospital / blood bank self-apply form |
| `/camps/host` | **Public camp-host application form** — Rotary clubs, schools, corporates, panchayats, NGOs, anyone |
| `/c/<slug>` | **Public camp landing page** — the URL camp organizers share. RSVP CTA branches on auth state. Carries `?via=<channel>` for attribution. |
| `/camp/<token>` | **Camp organizer magic-link dashboard** — no signup, scoped to one camp |

**Landing-page top nav (redesigned May 2026)** — organised into three clusters
with a divider between them: (1) brand wordmark; (2) primary public CTAs —
*Become a donor* (filled red) + *Host a camp* (outlined); (3) utility — a
language dropdown showing native scripts (मराठी / हिन्दी / English), a *For
hospitals & blood banks* dropdown (Sign in to your institution · Onboard your
hospital or blood bank), and *Log in*. On mobile the donor CTA stays visible and
the rest collapses into a hamburger drawer. Dropdowns close on click-outside +
Escape. Labels are i18n keys (`lp_nav_*`) in all three languages.

All public endpoints are rate-limited (100 req/IP/min global, 3/h/mobile on
OTP send, and on institutional login 10/15min per username plus a 60/15min/IP
sweep ceiling). A hospital reaches us through a single NAT'd address, so the
per-account key is what stops ten people signing in at shift change from reading
as ten guesses; the 5-attempt per-account lockout is the actual brute-force
defence. **Note:** the global limiter keys
on `req.ip`; a camp where many donors register from one WiFi can trip it — see
§18 deferred items.

---

## 4. Donor experience

### 4.1 Registration
4-step wizard at `/register`:

1. **Pre-screening** — DRAFT bank of permanent-deferral questions (loaded from `GET /donors/eligibility/questions`). Any "YES" produces a soft decline.
2. **Personal details** — full name, DOB, gender, self-reported blood group (display-only, never used in matching), village/taluka/district picker, preferred language.
3. **Temporary deferral notice** — informational; subsequent questions about recent illness / travel.
4. **Consent + OTP + finalisation** — submits to `POST /donors/register`, sends OTP via `POST /auth/otp/send`, verifies via `POST /auth/otp/verify`, posts `POST /donors/:id/consent`.

When the URL is `/register?camp=<slug>`, the camp slug is persisted in `sessionStorage` and the wizard finishes by redirecting to `/c/<slug>` where an auto-RSVP fires.

### 4.2 Login
`/login` — mobile OTP. Returns JWT.

In staging, `OTP_ECHO=true` is set so the OTP appears inline (`dev_otp echoed by backend: 123456`) for live demo without SMS.

### 4.3 Donor dashboard (`/donor`)
- **Pending-sync banner** when the IndexedDB outbox has queued writes (offline-capable availability toggle).
- **Availability card** — full-width red-on-cream toggle, the spec §7.6 "single big tap" UX. Optimistic update + outbox replay when reconnected.
- **Donor tier badge** — Bronze (1 donation) / Silver (5) / Gold (10) / Champion (25) progress bar with medal colour, plus an estimated-lives-saved counter.
- **4 stat cards** — verified blood group, total donations, next eligible date, reliability score.
- **Upcoming camps section** — district-scoped list with one-tap "I will be there" RSVP, "Cancel RSVP" toggle, deferral warning if applicable.
- **Donation history** — last 5 verified / pending donations with TTI clearance verdict per donation (PE / CL / IN — never field-level data).

### 4.4 Donor passport
`GET /donors/me` returns a comprehensive profile: identity, blood group (verified + self-reported separately labelled), eligibility (deferral status / until date / next-eligible date / eligible components), community, stats (total donations, units, reliability), location (district/taluka/village ids), donations history, overall clearance.

### 4.5 Privacy invariants
- Self-reported blood group is rendered as "Self-reported (unverified): O+" with visual distinction. Never queried in matching.
- TTI field-level results are NEVER in the passport response — only the overall verdict (`PE` pending / `CL` clear / `IN` investigation / `HD` held).
- Mobile is encrypted at rest; mask `+91XXXXX1234` (last 4 only) when hospital-facing.

---

## 5. Hospital portal (`/hospital`)

3 tabs:

### 5.1 Dashboard (default tab)
Source: `GET /requests/dashboard`. 90-day window.

- **5 KPI cards** — Open requests, Critical now, Fulfilled this month, Expired this month, Avg time-to-fulfilment (raised → fulfilled in `h m`).
- **District blood availability grid** — 8 blood groups × N components, district-wide counts. Bag IDs are never exposed.
- **Recent activity** — last 8 closed / expired / cancelled requests with urgency pill and date.
- **Raise request CTA** that jumps to the Raise tab.

### 5.2 My requests
Source: `GET /requests/mine`. Polls every 30 s.

- Per-request card: urgency pill (CR red / UR amber / PL grey), request number, status, fulfilled/required counts, raised time, needed-by, coordinator, matched blood bank.
- **Confirm crossmatch** CTA shown when status is FU/PF and `crossmatch_confirmed=FALSE`. Posts `POST /requests/:id/confirm-crossmatch`, flips status FU → CL.

### 5.3 Raise new request
Form maps to `POST /requests` (Tier 1 OH). Validates against the shared client Zod `requestSchema`. Fields: patient initials, age, gender, blood group, phenotype note (optional), component, units, urgency tier (PL/UR/CR), needed-by datetime, clinical indication, ward/bed.

On submit, the backend runs the matching engine synchronously and returns matched bag count + fallback flag.

---

## 6. Blood bank portal (`/bb`)

4 tabs (Dashboard is default):

### 6.1 Dashboard
Source: `GET /inventory/dashboard`.

- **5 KPI cards** — Available units, Expiring <48h (red), Pending TTI (amber), Issued this month, Donations today.
- **Inventory at a glance** — 8 blood groups × N components grid with available / total counts.
- **Incoming requests · your district** — top 10 open requests in this BB's district, urgency-sorted. The Raise-Hand candidate panel for matching.
- **Recent donations** — last 8 with donor name, component, volume, date.

### 6.2 Inventory
- Status filter (QA / AV / RE / IS / TR / EX / RC).
- Bag list with ISBT barcode, blood group, component, volume, status pill, **colour-coded expiry**:
  - > 7 days: green
  - 2–7 days: amber
  - < 48 hours: red.

### 6.3 Record donation
- **Donor lookup by mobile** (`GET /donors/lookup?mobile=`) auto-fills donor ID and shows verified blood group preview + deferral state.
- Posts `POST /donations`. Backend runs `validateDonation()`: deferral status, gap from last donation, Hb/gender thresholds, blood-group-verified requirement. Trigger creates a QA inventory bag.

### 6.4 TTI screening
- Opens any donation_id, accordion for HIV / HBsAg / HCV / Syphilis / Malaria with NR / RR / PE / ID pills.
- Posts `POST /donations/:id/screening` initially.
- **4-eyes verify** button posts `POST /donations/:id/screening/verify`. Backend rejects same-user verify. Flips overall clearance to CL or IN. Cascades trigger lookback + bag recall when any field is RR.

### 6.5 Opening stock
Form posts `POST /inventory/opening-stock` — repeating rows of blood group × component × units × volume. Bags created in source='WB' (legacy WhatsApp pattern). Skips TTI gating (no TTI record).

---

## 7. Coordinator portal (`/coordinator`)

2 tabs (Dashboard is default):

### 7.1 Dashboard
Source: `GET /coordinator/dashboard`. Polls every 20 s.

**Queue KPIs** (district-scoped):
- Open queue (red if > 0)
- Critical now (red)
- Awaiting accept (amber)
- Accepted by you (green)
- Closed this month

**Your impact** panel (from denormalised `coordinators` row):
- Donations facilitated
- Requests fulfilled
- Community donors
- Lives saved estimate (red)
- Reliability score: green ≥ 80 / amber ≥ 50 / red < 50, with median response-time in minutes

**District donor pool**:
- Verified donors count
- Available today (no deferral) — green

**Most urgent open requests** — top 5 with one-click jump to request detail.

**District blood availability** — same grid as hospital dashboard.

### 7.2 Queue
- District-scoped list, 15s refetch.
- Urgency colour-coded.
- Per-row Accept button if unassigned; "accepted" badge if claimed by self.

### 7.3 Request detail (`/coordinator/requests/:id`)
- Clinical card.
- **Action bar**: Accept / Claim / Verify (Tier 3/4 only) / Re-trigger match / Close with bag IDs.
- **Cross-role thread** — post messages with role-visibility scope picker. 20s refetch.

---

## 8. NGO admin portal (`/admin`)

10 tabs (Onboarding is the default landing tab):

### 8.1 Onboarding (default)
The pending-review queue for institution self-applies. Filter pills: Pending license review (PE) / License verified · awaiting MoU (VE) / Active (AC) / Suspended (SU).

- Per-row table: applicant legal name, type (HO/BB), masked contact mobile, applied date, license-verified date.
- **Verify license** action (PE → VE).
- **Send MoU for eSign** action (VE → AC). Returns Leegality doc ID + sign URL.
- Webhook `POST /onboarding/mou-signed` auto-provisions the institutional admin platform_user + flips status to AC.

### 8.2 Coordinators
Filter pills: Pending / Active / Suspended / All.
- Verify (id_verified_at + is_active = TRUE)
- Suspend with reason prompt.

### 8.3 Camps
Filter pills: Pending review (default) / Planned / Upcoming (PL+LV) / Completed / Declined.

For pending-review camps:
- "Review →" opens a panel with full submitter details (organiser, contact, role, mobile, email, host notes, training requested + expected volunteers).
- **Verify & approve** — flips PE → PL, mints a `camp_access_tokens` row, returns the **magic-link URL**, shows it inline with copy-to-clipboard + WhatsApp deep-link share + Preview button.
- **Decline** with mandatory 5+ char reason. PE → DC.

For other camps:
- "Roster →" opens an inline panel listing all RSVPs (donor name + blood group + RSVP date).

Plus a **Schedule a camp directly** form for staff-created camps (skips PE → goes straight to PL).

### 8.4 Thalassemia
List of thalassemia patients with overdue / due-soon colour coding (≤ 7 days amber, ≤ 0 days red).
- Enrol form (full name, DOB, gender, blood group, default component, interval days, default units, treating hospital UUID).
- "Record transfusion" one-click — bumps `last_transfusion_date`. Table trigger auto-recomputes `next_transfusion_due`.

### 8.5 Rare blood
List of rare-phenotype donors (Bombay / Rh-null / weak-D / partial-D / MNS / Kell / Duffy).
- Bombay rows highlighted with red badge.
- Enrol form supports **two modes**:
  - "Existing Raktify donor" — paste donor UUID.
  - "Shadow entry" — name + mobile of a known rare-phenotype person not yet on the platform.
- National-broadcast consent flag.

### 8.6 Duplicates
Suspected-duplicate donor pairs.
- Clear flag (false positive).
- Merge — 501 stub. Design notes in `services/donors/merge.js`. Blocked on medical-advisor confirmation of deferral-merge semantics.

### 8.7 Referrals
Institution-referral funnel summary (NE → CO → IN → ON / DC / DR). Conversion rate. Recent referrals list.

### 8.8 Lookback
Open lookback investigations (post-reactive-TTI recall workflow). Red highlight for cases > 14 days.

### 8.9 Audit
Filter form for the `audit_log_safe` view: table, actor UUID, event type, since, until, limit. Plus an on-demand **Run hash-chain integrity check** button (requires `audit_reader` grant which isn't applied yet — see deferred items).

### 8.10 Jobs
Scheduler view with super_admin-only "Run now" button per job:
- `auto_expire` — expire bags past expiry_date
- `stale_reservation_release` — release reservations idle > 4 hours
- `planned_request_upgrade` — auto-bump PL → UR after 24h
- `eligibility_reminder` — nudge donors at next-eligible date
- `escalate_overdue` — ring 2/3/4 widening for overdue requests
- `bot_session_cleanup` — drop WhatsApp bot sessions older than 1h

### 8.11 Reports (separate page `/admin/reports`)
Month picker + 3 report tabs:
- District summary
- Hemovigilance (DHO-eligible)
- Blood bank performance

Both JSON and CSV download supported.

---

## 8.12 DHO governance dashboard (`/dho`)

The **District Health Officer dashboard** is a read-only, district-scoped governance instrument introduced to support top-down adoption: when individual hospitals or blood banks resist onboarding, the foundation approaches the DHO with concrete district-level evidence, and the DHO can issue an official circular mandating platform use. Six sections, top to bottom:

### Top band
- District name, period picker (7 / 30 / 90 / 180 / 365 days)
- Link out to `/admin/reports` for multi-month exports

### KPI row (6 cards)
- Donations collected in window
- Emergency requests raised (with fulfilled + expired sub-counts)
- Critical-within-4-hours percentage (green ≥ 80 / amber ≥ 50 / red below)
- Lives saved estimate (units × 3)
- Wastage rate percentage (green ≤ 5 / amber ≤ 15 / red above)
- Active institutions (hospitals + blood banks)

### Camp band (3 cards)
- Camps held in window · Upcoming camps · Units from camps

### Compliance matrix
Per-institution row with: name, kind, last donation, donations in window, 4-eyes verification %, requests in window, licence expiry date, and a computed compliance grade (A / B / C / Flag).

### Live blood availability heatmap
8 blood groups × N components, district-wide. Numbers colour-coded (red = none, amber < 3). "↘N" indicator for units expiring within 48 hours.

### Critical request timeline
Last 30 critical-tier requests in the district with fulfilment time and status. Useful for proving the platform responds within target time.

### Hemovigilance summary
Lookback investigations (opened, closed, overdue, avg resolution time) + reactive TTI counts (HIV, HBsAg, HCV, syphilis, malaria). One-click CSV export for the monthly DGHS / State Blood Transfusion Council filing.

### Backend endpoints
- `GET /dho/dashboard` — KPI bundle
- `GET /dho/compliance` — institution rows with grade
- `GET /dho/shortages` — inventory heatmap
- `GET /dho/critical-timeline` — recent critical requests
- `GET /dho/hemovigilance` — district-scoped lookback + reactive TTI summary

All endpoints elevate to `actor_role='system'` internally for the aggregate reads (permitted by migration 240) and explicitly aggregate before returning — no donor / patient PII flows to the DHO role.

### Auth model
- Email + password + TOTP (same as other institutional staff)
- New `dho` role in `platform_users.role` enum (migration 265)
- `platform_users.district_id` binds the DHO to one district; enforced by `dho_must_have_district` CHECK
- DHOs can use either a foundation-provided email (`dho.<district>@choudhari.ngo`) or their own gov email (`@gov.in`, `@nic.in`) — both are equally supported

### Supporting documents in `/docs`
- `Raktify_DHO_Circular_Template.html` — A4 print-ready template for the DHO to circulate to district hospitals + blood banks mandating Raktify adoption (8 numbered directives, reference clause, copy-to list, signature block)
- `Raktify_DHO_LoC_Template.html` — 2-page Letter of Cooperation template between the DHO Office and the Foundation. Lightweight (non-binding), with explicit data-handling boundaries table.

---

## 9. Camp lifecycle

A 5-stage flow with multiple entry surfaces and a magic-link organizer
dashboard. This is one of the most demoable features for May 27.

### 9.1 Apply (public)
URL: `/camps/host`. No login.

Form: organiser type (Corporate / Educational / NGO / Community / Medical college / Other), legal name, cascading state→district→taluka, venue, address, pincode, date, start/end time, target donor count, **volunteer training opt-in with expected volunteer count**, host contact (name, role, mobile, email).

Submit → `POST /camps/apply` → row in `donation_camps` with `status = 'PE'`. Camp slug, QR token, and submitter PII captured.

### 9.2 NGO review
NGO admin opens `/admin` → Camps tab → Pending review (default). Reviews submitter details, then:
- **Verify & approve** → PE → PL. System mints a unique `camp_access_tokens.token`, expires 30 days after `scheduled_date`. Best-effort WhatsApp send to organizer (uses notification chokepoint; falls back to console outbox).
- **Decline** with 5+ char audit-logged reason.

The verify success panel surfaces the **magic-link URL** inline with copy-to-clipboard, WhatsApp share deep-link (pre-filled friendly message), and Preview Dashboard buttons.

### 9.3 Organizer dashboard (magic link)
URL: `/camp/<token>`. **No Raktify login.** Token IS the credential.

The page:
- Header card with camp status, partnered blood bank line, expiry warning.
- **4 KPI cards** — Registered / Attended / No-shows / Units collected.
- **Invite donors share toolkit**:
  - Copy URL button for the `/c/<slug>` public link.
  - **QR code** rendered in Raktify red, with Print button.
  - 4 channel share buttons — WhatsApp (wa.me) / Facebook (sharer.php) / X (intent) / Email (mailto). Each appends `?via=<channel>` for attribution.
  - **Instagram (copy text)** — Instagram has no share API, so the button copies a ready-to-paste message for Story / bio.
- **Where RSVPs came from** — bar list grouped by `referral_channel`.
- **Broadcast box** — 500-char message sent to all RG/AT donors via the notifications chokepoint.
- **Roster table** — donor name + blood group + RSVP date + deferral warning. **Mobile is never exposed.** One-tap Attended / No-show buttons for camp-day attendance.

### 9.4 Public camp landing
URL: `/c/<slug>` (used in share links). Carries `?via=<channel>` for attribution.

- Hero card: date, weekday, time window, venue + address, register count vs target, partnered blood bank.
- **Register CTA** — branches on auth state:
  - Logged-in donor → instant RSVP with attribution.
  - Logged-in non-donor → "you can't RSVP from this seat".
  - Not signed in → `/register?camp=<slug>&via=<via>` for new donors, `/login?return=/c/<slug>?via=<via>` for returning donors.
- After login/registration, the donor lands back on `/c/<slug>` and an effect hook auto-fires the RSVP using sessionStorage marker.
- Educational footer: bring ID, eat normally, donation takes ~10 minutes, TTI testing applies, **mobile never shared with organiser**.

### 9.5 Day-of attendance + post-camp
Organizer opens magic-link dashboard on phone, taps Attended / No-show per donor as they arrive/skip. Blood bank records actual donations against the camp via `donation_history.donation_camp_id`. Trigger keeps `units_collected` denormalised on the camp row.

### Magic-link security properties
- Token = `crypto.randomBytes(24).toString('base64url')` — 32 chars, unguessable.
- Scoped via RLS to ONE camp; a leaked DB connection can't enumerate other camps' rosters.
- Tracks `last_used_at`, `last_used_ip` (TEXT for proxy-mangling tolerance — migration 264), `use_count`.
- Admin can `POST /camps/access/:token/revoke` with audit-logged reason.
- Auto-expires 30 days after camp end.
- Donor mobile is NEVER returned in roster responses.

### Attribution model
The `?via=<channel>` parameter rides every share button. On RSVP, the backend stamps:
- `camp_registrations.source` — coarse bucket: `WB` (web), `QR`, `WA` (WhatsApp bot, distinct from "shared via WhatsApp"), `CO` (coordinator-added).
- `camp_registrations.referral_channel` (TEXT) — fine-grained: `whatsapp` / `facebook` / `instagram` / `twitter` / `email` / `qr` / `direct` / `web`.

Aggregated as a `channel_mix` array in the organizer-dashboard payload.

---

## 10. Patient + rare-blood registries

### 10.1 Thalassemia patients
Schema (`thalassemia_patients`):
- Identity: full_name, DOB, gender, guardian_name, guardian_mobile (paediatric), abha_id (optional).
- Clinical: blood_group_id, diagnosis_subtype, treating_hospital_id, transfusion_interval_days (default 21), last_transfusion_date, next_transfusion_due (trigger auto-computed), default_units, default_component_id.
- Geography: state_id, district_id, village_id.
- Donor pairing: `paired_donor_ids UUID[]` (no separate join table; GIN-indexed).
- Lifecycle: is_active, inactive_reason ('BMT successful', 'deceased'), registered_by_coordinator.

Endpoints:
- `GET /registries/thalassemia` (admin / coord / hospital)
- `POST /registries/thalassemia` (enrol)
- `POST /registries/thalassemia/:id/transfusion` — bumps `last_transfusion_date` (trigger auto-recomputes `next_transfusion_due`).

### 10.2 Rare blood registry
Schema (`rare_blood_registry`):
- `donor_id` (UNIQUE, nullable) — preferred. NULL = "shadow entry".
- Phenotype: phenotype_code, phenotype_description, abo_type, rh_factor, is_bombay.
- Verification: verified_by_institution_id, verified_method ('IAT' / 'Genotyping' / 'Reference panel'), verified_at, verification_doc_storage_key.
- Shadow contact (when donor_id is NULL): contact_name, contact_mobile (encrypted), contact_state_id, contact_district_id, contact_notes.
- Broadcast: broadcast_consent, broadcast_consent_at, national_alert_pause_until.

Endpoints:
- `GET /registries/rare-blood` (admin / coord / BB)
- `POST /registries/rare-blood` (enrol — either donor-linked or shadow)

Frontend tabs (admin):
- Bombay phenotype rows are highlighted with a red `BOMBAY` badge.
- Curated phenotype picker (BOMBAY / RH_NULL / WEAK_D / PARTIAL_D / MNS / KELL_NEG / DUFFY_NEG).

---

## 11. Notifications & WhatsApp

### 11.1 Provider abstraction
`backend/src/services/notifications/index.js` exposes one function:

```js
sendNotification({
  recipientId,     // UUID or +91 mobile
  templateType,    // 'OTP','EMG','THK','REM','CRED','CAMP_LINK','CAMP_ANNC'
  variables,
  channel,         // 'WA' | 'SM' | 'CA' | 'EM'
  language,        // 'mr' | 'hi' | 'en'
  emergencyOverride
})
```

Resolves the recipient (donor UUID → mobile; user UUID → mobile; institution UUID → primary_contact_mobile; or external mobile string). Writes a `notification_log` row with provider code + delivery status. Provider codes:
- `M9` — MSG91 (BSP, DLT-registered)
- `LO` — local console outbox (dev / staging fallback)
- `WC` — **Meta WhatsApp Cloud API direct** (no BSP, no DLT for WA)

Active provider is selected by `NOTIFICATIONS_PROVIDER` env (`console` / `msg91` / `whatsapp_cloud`). Provider is a one-env-var swap; no code change.

### 11.2 WhatsApp Cloud API integration
File: `backend/src/services/notifications/whatsappCloudProvider.js`.

Status: **scaffolded**, blocked on Meta WABA approval. The resubmission with the live `choudhari.ngo` URL is in progress. Once approved, flipping `NOTIFICATIONS_PROVIDER=whatsapp_cloud` and setting `WHATSAPP_*` env vars activates Meta-direct sends, including:
- OTP delivery (Authentication template with body + button copy-code)
- MoU eSign link
- Donor alerts on critical requests
- Camp magic-link delivery to organizers
- Camp broadcasts to roster

### 11.3 WhatsApp bot
File: `backend/src/services/whatsapp/bot.js`.

Two state machines:
- **Donor registration bot** — IDLE → NAME → DOB → GENDER → VILLAGE → CONSENT → COMPLETE. Persists in `bot_sessions` table with 1-hour TTL.
- **Blood-bank inventory parser** — interprets `UPDATE B+ 4 O+ 2` style messages, replies with an admin-confirm link (auto-apply is deferred until a synthetic legacy donor row exists).

Inbound webhook: `POST /webhooks/whatsapp/incoming`.

### 11.4 Notification log
`notification_log` table. One row per send. Tracks:
- recipient_donor_id / recipient_user_id / recipient_institution_id / recipient_external_mobile
- channel, template_type, language, provider
- delivery_status (SE sent / DR delivered / RD read / FA failed / OP opt-out)
- DND override flag for emergencies (post-launch enforcement)
- Provider-level message id + delivery-receipt timestamps

Delivery-status webhook: `POST /webhooks/msg91/delivery` (MSG91). For Meta, webhook lands in a separate route.

When `delivery_status='OP'` (opt-out), a trigger auto-flips `donors.{whatsapp,sms}_opted_in = FALSE`.

---

## 12. Geographic data

### 12.1 Schema
Four tables linked top-down: `states` → `districts` → `talukas` (sub-districts) → `villages`. All keyed by LGD numeric codes (idempotent re-imports). Each table has `is_active BOOLEAN` so the launch scope can be progressively widened without re-importing.

### 12.2 Bulk importer
`scripts/import_lgd.js` — production-ready loader for the Local Government Directory (Ministry of Panchayati Raj). Two modes:
- `--source=api` — live LGD API. Slow (rate-limited; ~600k villages).
- `--source=csv` — CSVs in `LGD_CSV_DIR`. Recommended for production.

Post-import, the script activates Maharashtra (state 27) + Amravati district by default. Activating additional states / districts is a one-line `UPDATE`.

### 12.3 Demo coverage
The demo seed (`scripts/seed_demo.js`) creates Maharashtra + Amravati (501/AMRA) and Pune (502/PUNE) districts, plus a sample taluka and village. Enough for all dropdowns in the onboarding + camp flows.

### 12.4 Public lookup endpoints
- `GET /geography/states` — active states only
- `GET /geography/districts?state_id=27` — active districts
- `GET /geography/talukas?district_id=501` — all (no `is_active` on talukas yet)

Powers the cascading dropdowns in donor registration, institution onboarding, camp host registration, and the admin Schedule-a-Camp form.

---

## 13. Security & privacy invariants

### 13.1 Row-Level Security
Every table has RLS enabled with role-keyed policies:
- `fn_actor_role()`, `fn_actor_user_id()`, `fn_actor_institution_id()`, `fn_is_admin()` — helpers backed by `raktify.*` GUCs.
- Policy bodies kept short; full audit table in `database/migrations/100_rls_phase1.sql` and `200_rls_phase1_extra.sql`.

### 13.2 Audit chain
`audit_log` is INSERT-only, hash-chained (`row_hash` = sha256 over salient fields + previous row_hash). Only the dedicated `audit_writer` Postgres role can INSERT. No application role has UPDATE or DELETE on `audit_log`.

The `audit_log_safe` view masks `row_hash` and `previous_row_hash` so the safe view can be queried by `audit_reader` (and the admin Audit tab). The hash-chain integrity check needs SELECT on the raw columns; a one-line GRANT migration is staged but not yet applied — flagged as a deferred item.

### 13.3 PII handling
**Storage:**
- Fixed-width identifiers (CHAR(N)) — mobile, abha_id, aadhaar_last4 — plaintext in column. Protected by **Azure Postgres Flexible Server disk-level encryption** (service-managed key; customer-managed key via Azure Key Vault optional) + RLS + column-level GRANTs.
- Free-text PII (TEXT) — full_name, address, deferral_reason, screening notes — column-encrypted with AES-256-GCM via the `local` provider. Ciphertext format `v1:<provider>:<keyKind>:<base64url>`.

**Two distinct encryption keys for hybrid encryption** (kept in Azure Key Vault, injected as App Service settings):
- `LOCAL_ENCRYPTION_KEY_HEX` — general PII (key kind `main`).
- `LOCAL_SCREENING_ENCRYPTION_KEY_HEX` — TTI screening data only (key kind `screening`).

A compromised app server with main-key access cannot decrypt screening data without separately compromising the screening key. (The original spec named these `KMS_MAIN_KEY_ARN` / `KMS_SCREENING_KEY_ARN` under AWS KMS — superseded by the May 2026 Azure pivot; an Azure Key Vault crypto provider that wraps the key material with a KV-hosted KEK is future work.)

**Logger redaction:** `backend/src/config/logger.js` redacts known-sensitive paths. Extend the redact list when adding new fields.

### 13.4 Defence-in-depth
- **Helmet CSP** tightened: `default-src 'none'; frame-ancestors 'none'`. We're an API, not an HTML server.
- **CORS whitelist** — `FRONTEND_URL` + `ALLOWED_ORIGINS` only; no wildcard.
- **Global rate limit** — 100 req/IP/min. Stacks under per-route limits (OTP, institutional login).
- **`sanitizeInput` middleware** — strips ASCII control chars, script/iframe bookends, caps strings at 8 KiB. Type coercion stays with Zod, SQL escaping with parameterised queries.
- **ESLint `no-restricted-syntax`** blocks any `c.query(\`... ${userInput} ...\`)`. Five sites have justified `eslint-disable` (Zod-validated whitelists / constant fragments).
- **`app.set('trust proxy', 1)`** so `req.ip` keys correctly behind ALB / Front Door.
- **`cleanClientIp()` helper** (`backend/src/routes/camps.js`) sanitises raw IP strings before Postgres writes (introduced after a 22P02 in the camp magic-link path).

---

## 14. API surface (104 route handlers across 17 routers)

> The table below enumerates the endpoints by group. The raw count of
> `router.{get,post,put,patch,delete}(…)` handlers is **104** (some endpoints
> appear under multiple verbs); the grouped list is the canonical reference.

| Group | Endpoints |
|-------|-----------|
| **Auth** | `POST /auth/otp/send`, `POST /auth/otp/verify`, `POST /auth/institutional/login`, `POST /auth/institutional/setup-totp`, `POST /auth/institutional/confirm-totp`, `POST /auth/logout` |
| **Donors** | `GET /donors/eligibility/questions`, `POST /donors/register`, `POST /donors/:id/consent`, `POST /donors/:id/availability`, `POST /donors/:id/blood-group/verify`, `GET /donors/:id/passport`, `GET /donors/me`, `GET /donors/lookup` |
| **Onboarding** | `POST /onboarding/apply`, `GET /onboarding/applications`, `POST /onboarding/verify/:id`, `POST /onboarding/generate-mou/:id`, `POST /onboarding/mou-signed` |
| **Institutions** | `GET /institutions/`, `GET /institutions/:id`, `POST /institutions/` |
| **Donations + screening** | `POST /donations`, `GET /donations/:id`, `POST /donations/:id/screening`, `POST /donations/:id/screening/verify` |
| **Inventory** | `GET /inventory`, `GET /inventory/availability`, `GET /inventory/dashboard`, `POST /inventory/opening-stock`, `POST /inventory/:id/recall` |
| **Requests** | `POST /requests`, `POST /requests/guest`, `POST /requests/community`, `POST /requests/citizen`, `GET /requests/mine`, `GET /requests/dashboard`, `GET /requests/:id`, `POST /requests/:id/match`, `POST /requests/:id/cancel`, `POST /requests/:id/confirm-crossmatch` |
| **Coordinator** | `GET /coordinator/requests`, `GET /coordinator/dashboard`, `POST /coordinator/requests/:id/accept`, `POST /coordinator/requests/:id/claim`, `POST /coordinator/requests/:id/verify`, `POST /coordinator/requests/:id/noshow`, `POST /coordinator/requests/:id/close`, `POST /coordinator/requests/:id/thread`, `GET /coordinator/requests/:id/thread` |
| **Camps (public + organizer)** | `POST /camps/apply`, `GET /camps/public/:slug`, `GET /camps`, `GET /camps/:id`, `GET /camps/:id/registrations`, `POST /camps`, `POST /camps/:id/verify`, `POST /camps/:id/decline`, `POST /camps/:id/register`, `DELETE /camps/:id/register`, `GET /camps/access/:token`, `POST /camps/access/:token/registrations/:regId/status`, `POST /camps/access/:token/broadcast`, `POST /camps/access/:token/revoke` |
| **Geography (public)** | `GET /geography/states`, `GET /geography/districts`, `GET /geography/talukas` |
| **Registries** | `GET /registries/thalassemia`, `POST /registries/thalassemia`, `POST /registries/thalassemia/:id/transfusion`, `GET /registries/rare-blood`, `POST /registries/rare-blood` |
| **Lookback** | `GET /lookback`, `GET /lookback/donor/:donor_id`, `GET /lookback/:id`, `POST /lookback/:id/contact-hospital`, `POST /lookback/:id/dho-notify`, `POST /lookback/:id/close` |
| **Webhooks** | `POST /webhooks/msg91/delivery`, `POST /webhooks/whatsapp/incoming` |
| **Admin** | `GET /admin/coordinators`, `POST /admin/coordinators/:id/verify`, `POST /admin/coordinators/:id/suspend`, `GET /admin/duplicates`, `POST /admin/duplicates/:id/clear`, `POST /admin/duplicates/:id/merge` (501 stub), `GET /admin/referrals`, `GET /admin/audit`, `GET /admin/audit/integrity`, `GET /admin/jobs`, `POST /admin/jobs/run` |
| **Reports** | `GET /reports/district/:district_id/summary`, `GET /reports/hemovigilance`, `GET /reports/blood-bank/:id/performance` |
| **DHO governance** | `GET /dho/dashboard`, `GET /dho/compliance`, `GET /dho/shortages`, `GET /dho/critical-timeline`, `GET /dho/hemovigilance` |
| **Health** | `GET /health` |

---

## 15. Database (46 migrations)

Sequential, immutable. Numbered with prefix groups:
- `001–035` — schema (geographic, reference, platform_users, institutions, mou_versions, coordinators, communities, donors, institution_referrals, donation_history, donor_screening, screening_audit_log, blood_inventory, thalassemia_patients, rare_blood_registry, blood_requests, request_assignments, request_documents, donor_alerts, escalation_log, request_threads, donation_camps, notification_log, lookback_registry, audit_log)
- `099` — attach audit triggers
- `100, 200` — RLS phase 1 + extra
- `210, 211, 212` — bug fixes
- `220, 221, 240` — system-role RLS exceptions for routing
- `230` — `bot_sessions`
- `250` — notification provider WC
- `260` — `camp_registrations` join table + count triggers
- `261` — public camp applications (PE/DC statuses, submitter fields)
- `262` — `camp_access_tokens` (magic-link)
- `263` — `referral_channel` on camp_registrations
- `264` — relax `last_used_ip` from INET → TEXT
- `265` — `dho` role + `district_id` on `platform_users` + helper
- `266` — allow `dho` in the institutional-staff CHECK constraint

**46 migration files total, latest `266`.** All migrations end with a `-- ROLLBACK` block. The runner refuses to re-apply a migration whose SHA-256 checksum changed.

---

## 16. Deployment & infrastructure

### 16.1 Azure resources (staging)
- **DB** — Azure Database for PostgreSQL Flexible Server, B1ms (1 vCPU, 2 GB), Central India. SSL required. Firewall whitelist (current dev IP + App Service outbound).
- **Backend** — Azure App Service Linux B1 (Central India). Hosted at `raktify-api-staging-hsdxfzhrg5a7ekes.centralindia-01.azurewebsites.net`. Oryx build with `SCM_DO_BUILD_DURING_DEPLOYMENT=true`. Startup command: `node backend/src/server.js`.
- **Frontend** — Azure Static Web Apps Free. Default hostname `jolly-bay-08008c700.azurestaticapps.net`. Custom domain **`raktify.choudhari.ngo`**.
- **DNS** — Cloudflare proxy on `choudhari.ngo`, CNAME for `raktify` → SWA default hostname.

### 16.2 CI/CD
- **Backend** — `.github/workflows/main_raktify-api-staging.yml`. Triggered on push to main. Builds + deploys via Azure-issued OIDC token (federated identity `oidc-msi-bdbb` with Contributor role on the resource group). No SCM Basic auth required.
- **Frontend** — `.github/workflows/azure-static-web-apps-jolly-bay-08008c700.yml`. Triggered on push to main. Builds with `VITE_API_URL` baked in at build time so the SPA calls the App Service backend directly.

### 16.3 Environment variables (production)
See `docs/DEPLOYMENT.md` for the full matrix. Key flags:
- `NODE_ENV=production`
- `DATABASE_URL` — postgres connection string (sslmode=require)
- `JWT_SECRET` (≥ 32 random bytes)
- `ENCRYPTION_KEY` (32-byte hex)
- `FRONTEND_URL=https://raktify.choudhari.ngo`
- `ALLOWED_ORIGINS` — comma-separated CORS whitelist
- `NOTIFICATIONS_PROVIDER` — `console` / `msg91` / `whatsapp_cloud` (live primary is `whatsapp_cloud`)
- `STORAGE_PROVIDER` — `local` today (Azure Blob provider is future work; the original spec's `s3` is a leftover from the pre-Azure scaffold)
- `ENCRYPTION_PROVIDER` — `local` (keys held in Azure Key Vault, referenced as App Service settings; an Azure-native crypto provider is future work)
- `LOCAL_ENCRYPTION_KEY_HEX`, `LOCAL_SCREENING_ENCRYPTION_KEY_HEX` — 32-byte hex AES-256-GCM keys (main + screening)
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WABA_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATE_*` — Meta Graph API
- `OTP_ECHO=true` — staging-only; echoes OTPs in API response for demos when no WhatsApp / SMS provider is wired. **Never enable in production.**

---

## 17. Build / lint / test / migrate commands

```bash
# Local development
npm run dev:backend                   # API on :3000
npm run dev:frontend                  # Vite on :5173, proxies API

# Verification before commit
npm run lint                          # ESLint on backend
npm run smoke:frontend                # Production Vite build
npm run format                        # Prettier write

# Migrations
npm run migrate:status                # Show applied + pending
npm run migrate                       # Apply pending
node scripts/run_migrations.js dry-run

# Data ops
node scripts/seed_demo.js             # Seed staging demo data (idempotent; --reset wipes + reseeds)
node scripts/seed_demo.js --reset     # 6 months of realistic activity for dashboards
node scripts/import_lgd.js --source=csv
node scripts/build_og_image.js        # Render brand PNGs (og-image, app-icon, social-avatar) from SVG via sharp

# Production smoke tests (run during phase work)
node scripts/smoke_test.js                # Phase 0
node scripts/smoke_test_phase1_full.js    # Phase 1 (schema, triggers, RLS — see CLAUDE.md for live counts)
node scripts/smoke_test_phase2.js         # Phase 2
node scripts/smoke_test_phase3.js         # Phase 3
node scripts/smoke_test_phase4.js         # Phase 4
node scripts/smoke_test_phase5.js         # Phase 5
node scripts/smoke_test_phase6.js         # Phase 6
```

---

## 18. Deferred items (deliberate non-goals for the demo)

These are scoped and partially stubbed; the CSR deck lists them as
roadmap items. None are blockers for the 27 May demo.

1. **WhatsApp Cloud API — final live activation.** Provider is written + wired;
   the WABA is created, the number `+91 98505 41412` is **Connected**, templates
   are **approved** (donor_otp auth + donor_alert_critical / camp_reminder /
   camp_organizer_link / mou_esign_link utility), and **Business Verification is
   done (21 May 2026)**. Two Meta-side prerequisites remain before messages
   actually deliver: (a) a **payment method** on the WABA (Graph API returns
   `accepted` + a `wamid` but Meta drops delivery until billing is set), and
   (b) until WABA maturity, sends only reach **allow-listed test recipients**
   (≤5). The Official Business Account / green-tick request is greyed pending
   WABA maturity + brand notability (4–12 months). `institutional_credential`
   template was rejected as Utility — Meta wants it as Authentication; deferred.
2. **Pan-India geographic activation** — LGD importer ready, only Maharashtra + Amravati + Pune are active.
3. **WebSocket / Socket.io live queue** — coordinator queue currently polls (15 s). Real-time updates are the next-major-feature.
4. **Workbox BackgroundSync** — offline outbox replays on `online` + on hook mount; doesn't yet leverage the SW BackgroundSync API.
5. **Donor merge endpoint** — 501 stub. Design notes in `services/donors/merge.js`. Blocked on medical-advisor confirmation of deferral merge semantics.
6. **`audit_reader` SELECT grant on raw `audit_log`** for the integrity-check endpoint — one-line migration.
7. **Adverse-transfusion-reactions table** — hemovigilance report returns `{ reported: 0, note: 'adverse_reaction_table_pending' }`.
8. **PDF generation** for DHO submission — CSV exports work; PDF needs Puppeteer / wkhtmltopdf.
9. **DHO contact** (ring 4 escalation) — schema ready; the WhatsApp template send works on the live WhatsApp Cloud channel once the WABA payment-method blocker clears. The voice-call fallback is still deferred (requires MSG91 voice-API DLT registration on the SMS-fallback path).
10. **Synthetic legacy donor for opening-stock** — opening-stock currently piggybacks on the BB's first verified donation_id. A clean per-institution synthetic donor is staged.
11. **Distance-based donor sort** — `services/escalation/index.js` sorts by reliability_score; the spec calls for `ST_Distance` once PostGIS is enabled.
12. **NMC registry check** for Tier 2 GH requests — stored as `guest_nmc_check_status='PE'`.
13. **Multi-language deepening** — clinical copy in coord / hospital / BB tabs is English; donor-facing copy is in MR/HI/EN.
14. **Devanagari design pass** — proper type scale + Noto Sans Devanagari + motion / microinteractions.
15. **Camp Captain** (Phase B) and **Coordinator graduation** (Phase C) for camp organizers who want recurring access.
16. **Dynamic Open Graph tags** on `/c/<slug>` for WhatsApp / Facebook share previews.
17. **Camp poster upload** — schema has `poster_storage_key`, UI to upload is pending.
18. **Map view + GPS donor search** — needs PostGIS or managed tile provider.
19. **Aadhaar XML KYC** — needs UIDAI AUA/KUA licence.
20. **Insurance integration** (Ayushman Bharat / PMJAY) — needs state-health-mission MoU.
21. **IoT cold-chain integration** — schema and notification chokepoint are ready; needs hardware partner + MQTT broker.
22. **Camp QR registration rate-limit trap** — the global 100 req/IP/min limiter
    keys on `req.ip`. 50+ donors registering from one camp WiFi (shared egress IP)
    will trip it after ~25 registrations/min. Fix before any real camp: key the
    `/donors/register` + `/auth/otp/send` limiters on `mobile`, not IP (~30 min).
23. **Concurrency headroom** — DB pool is `max: 10` (`backend/src/config/db.js`);
    bump to ~30 before a second district (Postgres allows ~75 conns). No PM2
    cluster yet, so vertical scale past 1 vCore is wasted until it's wired.
    Matching runs **synchronously** inside `POST /requests`; an async queue
    (BullMQ + Redis) is the right shape past ~1k requests/day.

---

*For the live demo runbook with test accounts and click-by-click flows, see
`docs/Raktify_Demo_Guide.md`. For deployment and ops, see
`docs/DEPLOYMENT.md`.*
