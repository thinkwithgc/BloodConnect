# Raktify — engineering lessons (post-mortems)

Relocated verbatim from `CLAUDE.md` on 2026-09-08 so they are read **on demand**
instead of being loaded into every agent session. Nothing here was edited: each
section is byte-for-byte what `CLAUDE.md` carried, including the gate counts and
schema heads that were current **when that section shipped**. For the *current*
gate counts, schema head and branch state, read `CLAUDE.md` — it is authoritative
and these snapshots are not.

Every section below is pointed at from `CLAUDE.md`'s **Lessons index**, which keeps
the one-line invariant. Read that first; come here for the reasoning behind it.

## Contents

- [Marathi i18n — Host a camp + the BB portal](#marathi-i18n--host-a-camp--the-bb-portal-shipped-2026-08-30-d657d8a)
- [A blank page is a render throw, and nothing gates it](#a-blank-page-is-a-render-throw-and-nothing-gates-it-fixed-2026-08-30-b422787)
- [OTP delivery failures are reported now, not swallowed](#otp-delivery-failures-are-reported-now-not-swallowed-shipped-2026-08-30-d5f518b)
- [A staff portal never knows its own institution](#a-staff-portal-never-knows-its-own-institution-shipped-2026-08-30-156eee0)
- [Camp branding — the organiser's own logo + tagline](#camp-branding--the-organisers-own-logo--tagline-shipped-2026-09-01-19e3ee3)
- [An uploaded camp logo came out BLACK](#an-uploaded-camp-logo-came-out-black---and-the-fix-was-to-stop-using-the-canvas-2026-09-02) (three passes)
- [A camp link previewed the GENERIC card, and the share URL cannot move](#a-camp-link-shared-on-whatsapp-previewed-the-generic-card-and-the-share-url-cannot-move)
- [Per-camp OG is a SWA managed function + a server-rendered PNG](#per-camp-og-is-a-swa-managed-function--a-server-rendered-png-built-2026-09-03)
- [The poster export IS the OG card](#the-poster-export-is-the-og-card-so-there-is-no-second-renderer-2026-09-03) (incl. the `?poster=1` variant)
- [A link-preview image is a CROSS-SITE subresource, and the card must be OPAQUE](#a-link-preview-image-is-a-cross-site-subresource-and-the-card-must-be-opaque-2026-09-03-c2362a4)
- [A precached SPA shell is a shell from a DIFFERENT BUILD](#a-precached-spa-shell-is-a-shell-from-a-different-build-2026-09-04)
- [Staff pick their OWN username at setup](#staff-pick-their-own-username-at-setup-shipped-2026-09-08-a11192b)
- [A camp application told NOBODY it needed reviewing](#a-camp-application-told-nobody-it-needed-reviewing-fixed-2026-09-01)
- [A camp can be hard-deleted, and the audit ledger is what makes that safe](#a-camp-can-be-hard-deleted-and-the-audit-ledger-is-what-makes-that-safe-shipped-2026-09-02)
- [English is the default language, Marathi is a CHOICE](#english-is-the-default-language-marathi-is-a-choice-shipped-2026-09-01-migration-320)
- [WhatsApp template pipeline — current state](#whatsapp-template-pipeline--current-state-aug-2026)
- [V2 WhatsApp templates (July 2026, historical)](#v2-whatsapp-templates-july-2026--task-77--historical)
- [V2 WhatsApp delivery-status hardening](#v2-whatsapp-delivery-status-hardening-july-2026--task-79)

---

## Marathi i18n — Host a camp + the BB portal (shipped 2026-08-30, `d657d8a`)

The two surfaces driven by people least likely to read English are now full
Marathi. Rules that must hold for anything added to them:

- **`useT()` reads a context now.** `i18n/LangProvider.jsx` is mounted in
  `main.jsx` inside `BrowserRouter`, outside `ScrollToTop`. Before this, every
  call site held its own `useState`, so `setLang` re-rendered only the component
  holding the picker. The returned shape `{ t, lang, setLang, supported }` is
  unchanged, and `useLocalLang()` survives as the outside-provider fallback. **If
  a language switch ever looks like a no-op again, check the provider first.**
- **Strings live in two domain packs**, spread into `strings.js` **first** so an
  existing literal always wins a collision: `i18n/camps.js` (`camp_*`, 277 keys)
  and `i18n/bloodbank.js` (`bb_*`, 384). Every key carries an English value too
  — it is what the `en` picker serves, what Hindi falls back to, and the
  reviewable reference for each Marathi line.
- **No Hindi keys, by decision.** A Hindi session falls back to clean English on
  these two surfaces rather than showing rushed, unreviewed Hindi. The structure
  takes a `hi` pack later with no refactor. Tracked follow-up, not an omission.
- **Clinical terms stay English, by decision.** Marker names (HIV, HBsAg, HCV,
  Syphilis, Malaria), the verdicts (Reactive / Non-reactive) and component codes
  are untouched; those tabs get Marathi headings and help text only. Inventing
  Marathi for a TTI verdict is a safety event, not a copy nit, and it is what
  Marathi BB staff say out loud. Same standing deferral as Phase 7.
  Donor-facing *educational* copy is deliberately different — `camp_pub_expect_4`
  does use Devanagari disease names while keeping `HIV`, because a village donor
  reading a bullet is not a technician entering a result.
- **`tFor` falls back silently** (`table[key] ?? dict.en[key] ?? key`), so a
  missing Marathi key renders English and never throws. **Coverage is verified by
  walking the screens or grepping, never by a green build.**
- **Month and weekday names are hardcoded pack arrays, never
  `toLocaleDateString('mr-IN')`** — Intl's Marathi data is not reliably present
  and its short weekday forms are unpredictable, which a calendar grid cannot
  absorb. `DateOfBirthInput.jsx` reuses the same arrays so the DOB picker and the
  camp calendar can never disagree on a month name.
- **Latin digits in every language** (10, 48, 2026). **Never markup inside a
  translation string** — mid-sentence `<strong>` becomes one key per fragment
  with the tag in JSX, and word-order inversion needs paired `_pre`/`_post` keys
  (Marathi puts the wordmark *before* द्वारे). **API error codes are never
  translated** — each maps to a pack key client-side, exactly as
  `institutionErrorText` maps `route_not_found` / `not_found`.
- **`donors.preferred_language` is the WhatsApp language and is now ASKED, not
  inherited** (`c9a8c85`). The column has existed since `008_donors.sql:33`
  (`CHAR(2) NOT NULL`, CHECK `mr`/`hi`/`en`; **the default is `'en'` since
  migration 320** — it was `'mr'` before) and every donor
  notification path already reads it — `dispatchDonorAlerts`, the three camp
  reminders, `services/matching/donors.js`, `routes/donorAlerts.js` — with
  `whatsappCloudProvider` mapping it to Meta's `language.code`. **It is NOT the
  UI language.** Registration used to post whatever `useT()` happened to hold,
  and `detectInitialLang()` falls back to the **browser's** language, so a
  Marathi donor on an English-locale phone was silently stored as `'en'` and got
  English WhatsApp for good. `DonorRegister` now asks (`personalSchema`
  `z.enum(['mr','hi','en'])`, defaulted to the language the page is being read
  in) and `DonorDashboard`'s *Edit profile* edits it via the long-standing
  `POST /donors/me/profile`. Both surfaces call `setLang` on change so the choice
  is visible immediately, and both render native script from the single exported
  `LANG_LABELS`. Keys `donor_lang_label` / `donor_lang_hint` are in the **main**
  dict, so they carry real Hindi — **the no-Hindi carve-out is `camp_`/`bb_`
  only**. No migration; schema head stayed 318.
- `lib/campStatus.js` still returns today's `{ label, cls }` and gained a `key`
  per entry plus `campStatusLabel(code, t)`, so untranslated admin surfaces keep
  working while the organiser and BB views translate.
- **Deliberately left English, not oversights:** `CoordinatorPortal.jsx`'s
  `heading` / `emptyHint` overrides on `<MyCampsSection>` (`/coordinator` is out
  of scope and self-consistently English), and `aria-label="Raktify home"` in
  `CampOrganizerDashboard.jsx` (matches the identical literal in `Landing.jsx`).
- **Still English, logged not fixed:** `lib/errorMessage.js` (24+ call sites, 21
  of them in the BB portal) and `DonorAlertResponse.jsx`'s private `STRINGS`
  island. `errorMessage` is a pure function, not a hook, so it would have to read
  `localStorage['rk.lang']` directly.
- Devanagari runs wider than Latin. The **11-tab BB strip** is the surface to
  watch; the scrollable-strip fix has been offered twice and **never
  authorised** — report overflow, do not fix it.

## A blank page is a render throw, and nothing gates it (fixed 2026-08-30, `b422787`)

`/register` — the **Become a donor** CTA, the pilot's primary funnel — served a blank
page from `c9a8c85` until `b422787`. `c9a8c85` added the "which language should WhatsApp
use" `<select>` inside `StepDetails` but destructured `t` / `setLang` / `supported` in
`DonorRegister`. **`StepDetails` is a sibling function component, not a closure over its
parent's scope**, so all three were free identifiers, step 1 threw `ReferenceError` on
first render, React unmounted the tree, and the donor got an empty screen.

- **Nothing in this repo could have caught it.** The frontend has **no ESLint config**,
  so `no-undef` never runs, and `npm run smoke:frontend` is only a Vite build — esbuild
  does not resolve free identifiers. A valid-but-throwing render passes the sole gate.
  There is also no error boundary, so a render throw is always a *blank page*, never a
  message.
- **Every component calls `useT()` itself.** `t` is never inherited — either call the
  hook (free: it reads a context, see the i18n section) or take it as a prop, the way
  `HeroCard({ t })` and `AvailabilityCard({ donor, t })` already do.
- **Do not read a blank SPA page as a missing translation key.** `tFor` falls back
  silently (`table[key] ?? dict.en[key] ?? key`) and can only ever render English or the
  raw key — it cannot crash. A blank page is a throw; go looking for one.
- **Verify with a throwaway `no-undef` pass**, not the build:
  `npx eslint --no-config-lookup --config <tmp>.mjs "frontend/src/**/*.jsx"` with a flat
  config of `parserOptions:{ecmaFeatures:{jsx:true}}` + browser globals +
  `rules:{'no-undef':'error'}`, then delete the config. Inline
  `eslint-disable react-hooks/exhaustive-deps` comments surface as "rule not found" —
  those are noise, not findings. On the broken file this reports `'t'` twice plus
  `'setLang'` and `'supported'` at the select's lines; on the fixed tree it reports zero
  across the whole frontend. A per-function scan found **no second instance**. **A
  permanent frontend ESLint config has not been authorised** — it would surface a
  backlog; offer it, do not add it.

## OTP delivery failures are reported now, not swallowed (shipped 2026-08-30, `d5f518b`)

WhatsApp is the only live OTP channel, and OTP gates **registration**, not just login
(`DonorRegister.jsx` chains `/donors/register` → `/auth/otp/send` → `/auth/otp/verify` →
`/donors/:id/consent`). A donor whose number is not on WhatsApp was told *"code sent"* and
left waiting for a message Meta had already rejected — and on the registration form the
failed send was caught by the same handler as a failed registration, so the donor saw a
bare error code, the OTP panel never rendered, and re-submitting answered
`mobile_already_registered`. Their row existed and was perfect; the screen offered no way
forward. Rules for anything touching this path:

- **There is no Meta pre-check for "is this number on WhatsApp."** A rejected send is the
  only signal there is. So `classifyFailure()` in
  `services/notifications/whatsappCloudProvider.js` may report `no_whatsapp` for
  **recipient-side codes only** — `131026` (undeliverable) and legacy `1013` (user is not
  valid); `131050` → `opted_out`. Everything else stays `provider_error` /
  `transport_error` / `template_not_configured` / `not_configured` / `no_recipient`.
  **Never widen that set to a transport or template code.** Telling a donor with working
  WhatsApp that they cannot register is the worse of the two failures, and an unapproved
  template or an unset `WHATSAPP_TEMPLATE_*` key looks exactly like a rejection from the
  outside.
- **`POST /auth/otp/send` can now answer non-200.** `422 whatsapp_not_reachable` (the two
  recipient codes) and `502 otp_send_failed` (everything else); it also **clears
  `otp_hash` / `otp_expires_at`** first, because a live hash for a code nobody received is
  a verify prompt that can never be satisfied. Both are gated on **`!env.otpEcho`**, so
  dev and demo keep their 200 — and `consoleProvider` returns `success:true` anyway.
- **The OTP goes out in `donors.preferred_language`**, looked up by mobile, falling back
  to `'en'` for a first-contact login with no `donors` row. It used to be a hardcoded
  `'en'`. See the `preferred_language` note under **Marathi i18n** — it is the WhatsApp
  language, not the UI language.
- **A confirmed rejection auto-routes the donor to SMS.** The chokepoint
  (`services/notifications/index.js`) persists `failure_reason` on the `notification_log`
  row (the column has existed since `034:49`) and, for `no_whatsapp` / `opted_out` on a
  known donor, clears `whatsapp_opted_in` and moves `preferred_contact_channel` `'WA'` →
  `'SM'`. **That flip is in app code on purpose:** `fn_notif_propagate_opt_out`
  (`034:70-95`) is `BEFORE UPDATE OF delivery_status`, so an `'OP'` written at INSERT never
  fires it — which is also why the provider keeps `deliveryStatus:'FA'` even for an
  opt-out. It runs on its own pooled client and is wrapped so bookkeeping can never break
  the send path. `donors.sms_opted_in` already defaults **TRUE** (`008:71`), so this
  quietly accumulates the SMS list while DLT registration is still pending.
- **Donor-facing OTP errors go through `frontend/src/lib/otpError.js`**, not
  `lib/errorMessage.js` — that one is English-only, staff-aimed, and a *pure function*, so
  it cannot read the language context. 15 keys × MR/HI/EN live in the **main** dict, so
  Hindi is genuine here (the no-Hindi carve-out is `camp_`/`bb_` only). The mapper covers
  server codes **and** the local literals the same `error` state holds, because mixing one
  translated sentence into a state that also renders raw snake_case looks broken.
  `otp_err_no_whatsapp` offers a phone number and deliberately **does not** promise a
  walk-in or staff-vouched path — that is not built.
- **On the register form the send has its own `catch`.** It sets `otpStage='send_failed'`,
  which renders a titled panel that says plainly the record was saved, plus a `resendOtp()`
  that calls `/auth/otp/send` **alone** — never a second `/donors/register`.

No migration; schema head stayed **318**. Gates: `smoke_test_phase2.js` 167,
`smoke_test_phase4.js` 17, `check_whatsapp_templates.js` 0 fail / 1 warn.

**Still open, founder-side:** SMS fallback needs the Foundation registered as a DLT
Principal Entity with header `RAKTFY` and templates. Staff-vouched enrollment for donors
with no WhatsApp at all was discussed and is **not authorised** — do not build it without
a fresh go-ahead.

## A staff portal never knows its own institution (shipped 2026-08-30, `156eee0`)

A hospital or blood bank logging in saw nothing but the Raktify wordmark and a generic
*Hospital portal* label — the screen never said **which** organisation the session
belonged to. That matters most for the one shape with two logins: a hospital with an
in-house blood bank, whose HO and BB admins differ only by an `_bb_admin` suffix on a
username nobody reads. `<InstitutionBanner>`
(`frontend/src/components/institution/InstitutionBanner.jsx`) now renders the applicant's
own `display_name` as the page `<h1>` on both `/hospital` and `/bb`.

- **The client has no institution UUID, and never will.** The JWT carries `inst`, but
  `AuthContext` persists only token / role / user_id. So the fix is a **session-addressed
  `/me` alias route**, exactly as the comment on `GET /institutions/me/users` already
  says — not a new localStorage field, which would only start working after every staff
  member re-logs in. **`GET /institutions/me` is declared BEFORE `GET /:id`**
  (`routes/institutions.js:86`, ahead of `:id` at ~118) or Express binds `id='me'` and
  Postgres throws `22P02` on the uuid cast. `/me/users` needs no such care — two segments.
- **It is deliberately NOT the `/:id` row.** Any member of an institution may already read
  that, but this fires on **every portal load**; shipping licence numbers and the primary
  contact's mobile to a technician's browser on every page view is a different thing from
  serving them on an explicit request. Identity only — `id`, `kind`, `shortname`,
  `legal_name`, `display_name`, state + district names. **Smoke §20f asserts the payload
  carries no licence and no contact mobile**; keep it that way.
- **`display_name` is the prominent one**, not `legal_name`. It is what the applicant typed
  into *"Public display name"* on the apply form (`routes/onboarding.js` `applySchema`), so
  it is their words. `legal_name` renders underneath **only when it actually differs** —
  for most applicants the two are near-identical and repeating it is noise. A paired
  in-house BB is created as `"${parent display_name} Blood Bank"`, so the child is
  self-describing and the two logins read as visibly different names (asserted in §20e).
- **`institutions.kind` is `CHAR(2)` — `'HO'` / `'BB'`** (`004_institutions.sql:19`).
  The first cut of the banner compared it against `'hospital'` / `'blood_bank'`, so the
  metadata line was always `''` and **would have shipped silently never rendering**. Nothing
  in the frontend can catch a comparison that is merely always false — the Vite build is
  the only gate and there is no ESLint config (see **A blank page is a render throw**). It
  was caught solely because smoke assertions were added for a frontend change; that is the
  second concrete argument for a permanent frontend lint config, still **not authorised**.
- **Deploy skew is handled by design, not by sequencing.** The banner query is
  `retry: false` with a fallback label, so during the ~60–90s window where the SPA is live
  and the API is not, it renders the portal label instead of an error. Same reason a
  coordinator or NGO admin who somehow lands there sees no shouting: `400
  session_has_no_institution` is a quiet fallback, not a toast (§20g).
- **Design system untouched.** The wordmark stays product chrome and the institution name
  is the `<h1>` beneath it — no co-branding, no monogram square (the locked icon treatment
  is *no letters*), no new tokens. `inst_kind_hospital` / `inst_kind_blood_bank` are in the
  **main** dict so they carry genuine Hindi — the no-Hindi carve-out is `camp_`/`bb_` only.

No migration; schema head stayed **318**. Gate: `smoke_test_phase2.js` **172** (was 167;
§20e–20g added).

## Camp branding — the organiser's own logo + tagline (shipped 2026-09-01, `19e3ee3`)

A village college or Rotary club hosting a camp was driving people to a page that
carried Raktify chrome and nothing of theirs. The organiser now uploads a logo and
writes a tagline from the **magic-link dashboard** (no login), an NGO admin approves
or rejects it, and only an approved pair renders publicly. Migration **319**.

- **The logo is a `data:` URI in its own table, NOT a storage key**, and 319's
  header records all four reasons. (1) **Nothing in this app can serve an uploaded
  file back** — `STORAGE_PROVIDER=local` writes to disk and no route reads it.
  (2) Signed MoU PDFs already share `LOCAL_STORAGE_DIR`, so a public logo path
  would sit beside them. (3) `storageDir` defaults to a **relative** path while
  only `/home` persists on App Service. (4) The social-post PNG export needs
  `drawImage`, and a cross-origin image **taints `<canvas>`** so `toBlob()` throws
  `SecurityError`. Do not "improve" this into a storage key without solving all
  four — (4) alone breaks the export.
- **`camp_branding_logo` is deliberately NOT audited and deliberately has NO `id`
  column.** `fn_audit_row()` (025) writes one audit row **per changed field
  carrying the full old and new value**, so auditing a 67 KB base64 blob puts it
  into an INSERT-only table twice per edit. The missing `id` is a **tripwire**:
  passing this table to `attach_audit_trigger()` throws migration 318's exact
  error (`record "new" has no field "id"`) instead of quietly working. That is the
  intended failure — do not "fix" it by adding an `id`.
- **The public gate is expressed in SQL, not a JS branch.**
  `GET /camps/public/:slug` selects
  `CASE WHEN c.branding_status = 'AP' THEN bl.logo_data_uri END` (and the same for
  `organiser_tagline`), so a future caller physically cannot forget it. `'PE'` and
  `'RJ'` both render as no branding. **`GET /camps/access/:token` returns it
  ungated on purpose** — the organiser has to be able to see their own rejection
  and the review note.
- **Any organiser edit resets `branding_status` to `'PE'` in the same UPDATE.**
  Approval attaches to the bytes that were reviewed, not to the camp; there is no
  path where an approved status survives new content.
- **The 50 KB decoded ceiling (`LOGO_MAX_BYTES`, `camps.js:2828`) lives in the
  route, not a CHECK.** It is a payload budget for rural 4G, not patient safety
  (hard rule 1), and it wants to be tunable. The CHECK is only a
  200 000-char backstop, plus `camp_logo_is_data_uri` and a content-type whitelist
  of `image/jpeg` / `image/png`. Tagline is 280 chars in both Zod and a CHECK.
- **The upload route takes raw bytes, not multipart** —
  `POST /camps/access/:token/logo-raw` with
  `express.raw({ type: ['image/jpeg','image/png'] })`, mirroring the MoU-scan
  route. The browser does the resize: canvas → `toBlob('image/png')` or
  `toBlob('image/jpeg', q)`, so a 4 MB phone photo becomes a few KB **before** it
  leaves the handset. Four routes total — `POST /:id/branding/approve`,
  `POST /:id/branding/reject` (note mandatory), `POST /access/:token/logo-raw`,
  `PATCH /access/:token/branding`.
- **The admin list carries `branding_status` only, never the blob** — 50 camps at
  67 KB is a 3 MB response (`camps.js:125` says so). The blob is fetched only when
  an admin opens the review panel.
- **An emptied tagline field clears the tagline and is never stored as `''`.**
  `CampOrganizerDashboard` holds `useState(null)` so the saved value shows until
  the organiser types — `''` would render an empty branded strip on the public
  page.
- **18 `camp_brand_*` i18n keys in MR + EN, no Hindi** — the standing `camp_`/`bb_`
  carve-out, not an omission. See **Marathi i18n**.
- **`poster_storage_key` (migration 033) is untouched.** It predates this and is a
  different thing (the generated poster PDF, not organiser identity).
- **Gate: `npm run smoke:camps` → 151** (branding took it 117 → 140; §17’s
  hard-delete gate took it to 151). Section 16 mints its own
  `camp_access_tokens` row and moves camp1 to `'PL'` **first**, because
  `GET /camps/public/:slug` filters `status IN ('PL','LV')` and a 404 body has no
  `logo_data_uri` — an "absent" assertion would otherwise pass for the wrong
  reason. **Any new "field is hidden" assertion on a public camp route needs the
  same care.**
- **319 was prod-safe by construction, and that was measured, not assumed.** Additive DDL
  only, and all 10 CHECK constraints came back `convalidated = true` against **152 real
  `donation_camps` rows** on Neon dev — NULL-row CHECK semantics validated against actual
  data rather than deferred with `NOT VALID`. **Validate a new CHECK against dev data
  before shipping it; do not reach for `NOT VALID` to dodge the question.**

## An uploaded camp logo came out BLACK - and the fix was to stop using the canvas (2026-09-02)

An organiser uploading a JPEG or PNG from the magic-link dashboard got a solid black
rectangle. **Black is never a colour this code picks** - `frontend/src/pages/camps/CampOrganizerDashboard.jsx`
resizes every logo through a canvas, and **a canvas that was never drawn on encodes to JPEG
as opaque black, because JPEG has no alpha channel.** So the symptom names the bug exactly:
a `drawImage()` that silently did nothing while the canvas was still sized correctly. Two
independent mechanisms produce it, and this file had both.

- **`loadImage()` revoked the object URL inside `img.onload`, BEFORE the draw.** `load`
  promises the metadata is parsed, **not** that the bitmap is rasterised, so on WebKit
  `drawImage` no-ops against a revoked `blob:` URL. The revoke now lives in a `finally` in
  `resizeLogo()`, after the draw, and `await img.decode()` runs first - `decode()` is the
  one that promises a drawable bitmap. **Never revoke an object URL in the handler that
  merely tells you the image loaded.**
- **iOS/WebKit caps the total SOURCE pixel area `drawImage()` accepts** (~16.7M px, less on
  older devices), so a 48MP phone photo draws **nothing** onto a correctly-sized canvas.
  That is who the magic link is for - a village organiser on a handset. New `drawScaled()`
  goes through `createImageBitmap(file, { resizeWidth, resizeHeight, resizeQuality,
  imageOrientation: 'from-image' })`, which downscales **in the decoder** so the canvas
  never sees a giant source. `imageOrientation:'from-image'` is required or EXIF rotation is
  lost (`<img>` + `drawImage` honours it natively, a bare bitmap does not). Older browsers
  reject the options object or ignore the hints - both land in the `<img>` fallback.
- **New `canvasIsBlank(ctx, w, h)` is the backstop, and it exists because the failure is
  otherwise INDISTINGUISHABLE from a deliberately dark logo.** Every real image leaves at
  least one non-transparent pixel; a blank draw now throws `decode_failed` and the organiser
  reads *"That image could not be read. Please try a different file."* (`camp_brand_e_decode`,
  MR + EN - the standing `camp_`/`bb_` no-Hindi carve-out). Cheap: the canvas is at most
  400x400, and a `blob:` source built from a user-picked `File` is same-origin, so
  `getImageData()` never taints.
- **`encodeBest()` is deliberately UNTOUCHED.** Its PNG-under-budget branch preserves alpha
  so a transparent logo gains no white box, and its `destination-over` white fill is correct
  for the JPEG path. An unconditional white base coat before `drawImage` was **considered and
  rejected**: it would put a white box behind a transparent PNG on the cream `#fdf8f4` public
  page, and it would swap a loud failure for a plausible-looking one.
- **NOTHING in this repo can catch this class of bug.** `smoke:camps` §16 POSTs real PNG
  bytes straight over HTTP and never runs the browser code; the frontend's only gate is the
  Vite build; there is no headless browser installed. Everything above rests on inspection
  plus the mechanism - and that turned out not to be enough.

### The canvas fix did not work, so the canvas left the common path (second pass)

`a710cab` shipped and the organiser's next upload failed OUTRIGHT - `canvasIsBlank()` fired
and the message became *"That image could not be read."* for both JPEG and PNG. So the
backstop did its job (a silent wrong output became a loud refusal) but the two mechanisms
above are **NOT confirmed as the cause of the original black rectangle**: something in the
canvas path fails on that device for a reason inspection has not pinned down, and there is
no device, no log and no headless browser here to narrow it further. Two changes followed,
and the first is the reusable one:

- **A file already under `LOGO_MAX_BYTES` is now uploaded RAW, with the canvas skipped
  entirely.** The client-side resize was never the enforcement - the route
  magic-byte-verifies the bytes and rejects `> 50000` itself (`camps.js:3073`, and
  `file.size <= LOGO_MAX_BYTES` is exactly aligned with it) - so for every normal small
  logo the resize was an **optimisation buying nothing and risking everything**. Bytes are
  the budget, not pixels: an unresized 40 KB photo renders at 56px on the public page. The
  canvas now runs only for oversized files that genuinely have to shrink. **When a
  conversion step is optional and it is the only thing that can fail, take it off the
  path.**
- **The three `decode_failed` sites carry distinguishable stages** - `_load` (the `<img>`
  never decoded), `_dims` (no `naturalWidth`), `_blank` (`canvasIsBlank` after both draw
  paths) - and the suffix is **deliberately shown to the organiser**, e.g. *"... (blank)"*.
  This failure only ever happens on someone else's device with someone else's file; a
  screenshot is the only diagnostic channel that exists, so it has to name the site.

No migration; schema head stays **320**. Gates for both passes: throwaway `no-undef` pass
clean (see **A blank page is a render throw**), `npm run smoke:frontend` builds clean.

### It was FIREFOX blocking canvas readback, and the resize moved to the server (third pass)

The founder ran the discriminating test: **the same file uploads correctly on Edge and fails
on Firefox, Windows 11.** That pins the cause the two passes above could only guess at, and
it is neither of the mechanisms `a710cab` fixed - **both of those are WebKit-only and cannot
occur on Windows/Firefox at all.** Firefox blocks **canvas readback** when
`privacy.resistFingerprinting` is on, under strict ETP, or with a CanvasBlocker-style
extension: `drawImage()` silently succeeds while `getImageData()` / `toBlob()` return a
**blank surface**. That produces both observed symptoms, in the order they were reported -
a blank canvas encoded to JPEG is **opaque black** (JPEG has no alpha), which was the
original rectangle; then `canvasIsBlank()` correctly caught the same blank surface and
turned it into *"That image could not be read."* **Nothing was ever wrong with the
organiser's file.** The second pass's own note that the cause was unconfirmed was the
correct call - it claimed no fix that had not held.

The fix is `CLAUDE.md`'s own rule taken one step further than the second pass took it:
**the client canvas is now best-effort and can no longer fail an upload.**

- **`normaliseLogo()` in `backend/src/services/images/logo.js` is where the resize lives
  now**, on `sharp`. `MAX_EDGE = 400`, `fit: 'inside'`, `withoutEnlargement`, `.rotate()`
  for EXIF (the server-side equivalent of the client's `imageOrientation: 'from-image'`),
  `limitInputPixels: 50e6` so an absurd input is refused **before** allocation - the API is
  a **B1 with 1.75 GB serving the whole platform**, so that cap is not decoration.
  `encodeBest()`'s reasoning is preserved exactly: PNG first when `metadata.hasAlpha` so a
  transparent logo gains **no white box** on the cream `#fdf8f4` page, else flatten onto
  white and step JPEG 85 -> 75 -> 65 -> 55 until it fits.
- **The budget is a PARAMETER, not a constant in that file** (`normaliseLogo(buf, maxBytes)`)
  so the route stays the single source of truth for the number. Every sharp throw becomes one
  typed `ImageUnreadableError` carrying a `stage` (`metadata` / `dims` / `budget`), which the
  route maps to **`422 image_unreadable`** and logs. That is the same diagnosis the second
  pass had to show the organiser as *"... (blank)"* - it is now server-side and in the logs,
  so the diagnostic channel is no longer a screenshot.
- **TWO ceilings, and they are NOT the same number. Do not collapse them.**
  `LOGO_MAX_BYTES = 50000` (`camps.js:3055`) is what is **STORED** - a payload budget for
  rural 4G, inlined into every public camp page load. `LOGO_UPLOAD_MAX_BYTES = 6000000`
  (`:3063`) is what is **ACCEPTED**, with `express.raw`'s own `limit: '6mb'` behind it. The
  stored budget is now met **by construction** - the server re-encodes - instead of by
  refusing the organiser.
- **`express.raw`'s `'6mb'` is 6,291,456 bytes, which sits BELOW a literal 7 MB.** A 7 MB
  test body is rejected by body-parser before the handler runs and proves nothing about our
  ceiling; §16 uses **6,100,000** so the refusal comes from `LOGO_UPLOAD_MAX_BYTES` itself.
- **The upload limiter is keyed on `req.ip`, and that is FORCED, not chosen.**
  `express.raw()` parses the body before `loadToken()` runs, so the token is not available
  where the limiter has to sit. 20/hour. It cannot trip during `smoke:camps` (9 uploads, and
  express-rate-limit's MemoryStore resets per process).
- **The client keeps the canvas only as an optimisation.** A file already under
  `LOGO_MAX_BYTES` still uploads raw; a larger one *tries* `resizeLogo()` inside a bare
  `try/catch` and **falls through to the original bytes on any failure**. `canvasIsBlank()`
  survives as the detector that triggers that fallback, no longer as an error. The three
  `decode_failed_*` messages are gone from the client because there is no longer a
  client-side failure to surface - `camp_brand_e_decode` is **repurposed** for the server's
  `422 image_unreadable`, where its existing copy is already exactly right (no i18n edit).
- **The honest cost:** on Firefox the organiser now uploads the original, up to 6 MB, instead
  of a few KB. Correctness beats bandwidth for the browser that cannot be trusted to resize.
- **The logo frame on the public page is 96px** (`h-24 w-24`, was `h-14 w-14`; row `gap-3` ->
  `gap-4`) - founder decision 02-Sep-2026, taken knowing it was the one change that could
  plausibly disturb visual primacy. It does not: primacy is carried by the **type** scale
  (camp name is the `text-2xl` `<h1>`, organiser name is `text-sm`) and the image sits
  **below** the heading, never beside it. `PublicCampPage.jsx`'s comment block now says so,
  because "at a smaller scale than the camp name" sitting above a 96px image reads like a
  bug to fix. The organiser-dashboard preview and the admin review panel are review
  surfaces and were deliberately left alone.

**`sharp` is a real backend dependency now, and the deploy path is why that is safe.**
`.github/workflows/main_raktify-api.yml` runs `npm ci --omit=dev --workspace=backend
--include-workspace-root` on **ubuntu-latest** and uploads the tree *including
`node_modules`* (OneDeploy bypasses Oryx), so the `linux-x64` prebuilt binary CI installs is
exactly what App Service Linux runs. `--omit=dev` does **not** drop `optionalDependencies`,
so `@img/sharp-linux-x64` comes with it - **verify that entry is in `package-lock.json` and
not dev-flagged**, because installing on this Windows box only pulls `@img/sharp-win32-x64`.
It also makes `scripts/build_og_image.js`'s lazy `require('sharp')` honest.

**Three things §16 taught that generalise to any test of a route that now DECODES bytes:**
1. **A fake image stops being a valid fixture.** A PNG signature followed by padding earned
   a 200 before and earns a **422** now; every success fixture has to be a real image, built
   with `backendRequire('sharp')` (the smoke script reaches backend deps through
   `createRequire`, not bare `require`).
2. **A dimension-cap assertion proves nothing unless the fixture exceeds the cap.** The
   first draft used a 300x300 source against a 400px cap and printed a green
   `(300x300)` - passing trivially. It is 600x600 now and measures 400x400 out.
3. **A flat-colour PNG compresses to almost nothing at any size**, so the over-budget
   fixture needs pseudo-random pixels **and** `compressionLevel: 0`, **and its own
   assertion** that it really is over budget - otherwise a future sharp that compresses
   better silently makes the resize test pass for the wrong reason.
   Also: alpha decides the stored type (4-channel -> PNG, 3-channel -> JPEG), which is why
   the oversized fixture has to be uploaded **before** the small PNG whose assertion is
   `data:image/png;base64,`.

**`scripts/` is covered by NEITHER `lint` NOR `format:check`** - both are
`npm --workspace backend run ...`, so `scripts/smoke_test_camps.js` cannot fail CI on
formatting and must not be run through prettier.

No migration; schema head stays **320**. Gates: `npm run smoke:camps` **155/1** (156
assertions, was 151 - the one failure is the documented `blood-bank-options` `LIMIT 25`
dev-state line), lint + `format:check` clean, `npm run smoke:frontend` clean, throwaway
`no-undef` pass clean.

## A camp link shared on WhatsApp previewed the GENERIC card, and the share URL cannot move

`frontend/index.html` carries **one** OG block with every value hardcoded to the site root,
and **WhatsApp's crawler does not execute JavaScript** - so an SPA can only ever serve that
one static card, whatever `/c/:slug` renders in a browser. Prod probes confirmed the markup,
the routing and the image are all fine; the gap is structural. Per-camp OG is **BUILT now** -
the implementation is the next section. What was settled first, and is expensive to re-derive,
is the constraint:

- **The share URL is PINNED by nine APPROVED Meta template buttons.** `https://raktify.
  choudhari.ngo/c/{{1}}` is baked into nine of them (`docs/Raktify_WhatsApp_Templates.md:181`,
  `:1036`, `:1163`; `scripts/submit_whatsapp_templates_v2.js` x9). Serving the preview from a
  subdomain would mean editing nine approved templates - **each drops to PENDING for 1-3 days,
  x3 languages** - or minting nine `_v3` names, and it would orphan the already-spec'd 130mm
  QR posters. So per-camp OG must be served **at the existing SWA URL**. That is what forces a
  Static Web Apps **managed function** (supported on the Free tier; a *linked* backend needs
  Standard, ~$9/mo), reached by a `staticwebapp.config.json` rewrite, recovering the slug from
  the **`x-ms-original-url`** header - SWA `rewrite` cannot target an external absolute URL and
  route rules cannot match a user agent.
- **The librsvg font trap.** `sharp` renders SVG `<text>` with whatever fonts the **host** has,
  and App Service Linux has neither Inter nor Noto Sans Devanagari - a **Marathi** camp name
  renders as boxes. Ship both `.ttf` files plus a `fonts.conf` under `backend/assets/` and
  point `FONTCONFIG_PATH` at it. **Verify on the deployed API, never locally** - this Windows
  box has the fonts and hides the problem entirely. Fallback is the generic `og-image.png`
  for that camp: degraded, never broken.
- **Setting `api_location` puts the SPA's only deploy path behind the function building.**
  Validate on the PR preview environment before `main`. And **WhatsApp caches previews per
  exact URL, failures included**, for days - test with a throwaway `?v=2`.

## Per-camp OG is a SWA managed function + a server-rendered PNG (built 2026-09-03)

The constraint above says the preview must be served **at the existing origin**. The
implementation is two halves that fail independently, and neither can take the SPA or the
share link down with it.

- **Half one — `frontend/api/camp-og/` (SWA managed function, Node 20).**
  `frontend/staticwebapp.config.json` declares `"platform": { "apiRuntime": "node:20" }`
  and rewrites `/c/*` to `/api/camp-og` as its **first** route. The function recovers the
  slug from **`x-ms-original-url`** (a rewrite erases the path; SWA route rules cannot match
  a user agent, so **every** `/c/*` visitor — human and crawler — goes through it), fetches
  the camp, then rewrites the shell: it **strips** the 12 single-value metas + `<title>` +
  canonical and re-injects after `<head…>`. **Every failure path returns `index.html`
  untouched**, so a broken function degrades to the generic card, never to a broken page.
  It caches the shell **by origin** (never in one variable — a PR preview must not be served
  prod's shell) and the camp by slug. `SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/i`,
  `NAME_MAX = 90`, `DESC_MAX = 200`. `formatCampDate` uses an anchored regex and **never
  constructs a `Date`** — a `'YYYY-MM-DD'` is a calendar label, and `new Date('2026-09-14')`
  is UTC midnight, which is the previous day in IST.
- **`api_location` is relative to the REPOSITORY ROOT. Only `output_location` is
  `app_location`-relative.** It was **`""`** on `main`, and an empty value packages **no
  function at all**; the correct value is **`frontend/api`**, never `"api"`, which would
  resolve to a non-existent `<repo>/api`. Both mistakes fail the same way — **the SPA
  deploys with no function and `/c/<slug>` silently keeps serving the generic card with
  nothing failing anywhere**. The silence is structural: the rewrite target 404s, and this
  repo's own `responseOverrides` maps `404` → `/index.html` with `statusCode: 200`, so the
  shell is served, React Router renders the right camp page, and **only the crawler is
  wrong**. No gate in this repo can catch it; the fix carries a comment saying why.
  **Setting `api_location` also puts the SPA's only
  deploy path behind the function building** — validate on the **PR preview environment
  before `main`**.
- **Half two — `GET /camps/public/:slug/og.png`.** Same visibility rule as the poster page
  (`status IN ('PL','LV')`) and the same migration-319 approval gate **expressed in SQL**
  (`CASE WHEN c.branding_status = 'AP' THEN bl.logo_data_uri END`), so this route physically
  cannot forget it. **IT NEVER FAILS TO RETURN AN IMAGE**, because a crawler handed a 500
  caches the **absence** of a preview for days, per exact URL, with no retry. Four TTLs, each
  chosen for what it means: cache hit or fresh render **86400**; unknown slug or a camp still
  at `'PE'` → generic **300** (the real card must appear when the NGO publishes, not a day
  later); `renderCampOgCard()` declining → generic **3600**; a throw → generic **300**. The
  only error response it can produce at all is a missing `og-image.png` on disk.
- **The render is cached in-process, and that is the real protection.** 1200×630 of pango +
  libvips on a **B1 with 1.75 GB serving the whole platform**, hit by a crawler fleet from
  many IPs seconds after one share. `OG_CACHE_TTL_MS` 1 h, `OG_CACHE_MAX` 50, FIFO eviction
  (a `Map` iterates in insertion order). `ogLimiter` is 120/15min per IP — a ceiling on
  abuse, not the capacity plan.
- **`services/images/campOg.js` returns `null` rather than a wrong card**, and the route
  reads that as "serve the generic one". It declines on: no camp name, a **Devanagari name
  with the Noto font unreachable**, or a wordmark it could not read. The wordmark is read
  **from the canonical vector at runtime** (`frontend/public/wordmark-tm.svg`,
  `WM_VB = {x:57,y:107,w:1185,h:378}`) — the locked design system's "always the vector" rule
  applies to a generated PNG exactly as it does to a print sheet.
- **`GET /camps/public/og/selftest` is data-free on purpose, and must be read on the
  DEPLOYED API.** Prod holds no camps to hang a check off, so the check takes no data. It is
  a **differential** test: render the Marathi sample in `Noto Sans Devanagari`, render it
  again in `RaktifyNoSuchFamily7913`, and compare buffers — both arms with `fallback: false`.
  Equal buffers mean pango fell back and the shipped font is **not** reachable, however
  plausible the pixel dimensions look. Read **`devanagari_font_reachable`**; `false` means
  Marathi camp names would be tofu and those cards serve the generic image. The payload is
  counts, booleans and two pixel sizes — no paths, no environment dump — which is why it is
  safe to leave public. It is declared **before** `/public/:slug/og.png` so no slug can
  shadow it. **Measured on the DEPLOYED API 2026-09-03: `ok:true`,
  `devanagari_font_reachable:true`, 8/8 files, latin `587x43`, devanagari `430x44`** — the
  trap is cleared, and the same reading is the only proof there is that sharp + libvips
  render at all in prod (the logo resize depends on the identical install).
- **A local `ok:false` on this Windows box proves NOTHING, in either direction.** pango's
  Windows backend resolves fonts through the OS and **ignores `FONTCONFIG_PATH` outright**.
  `services/images/fonts.js` sets `FONTCONFIG_PATH` at module load (only if unset) to
  `backend/assets/fonts`, whose `fonts.conf` declares `<dir prefix="relative">.</dir>` as the
  **whole font world** with deliberately **no `<include>`** of system config. Its load-bearing
  line is `<alias><family>Inter</family><accept><family>Noto Sans Devanagari</family></accept></alias>`
  — that alias is what makes a mixed Latin/Devanagari string render in one pass.
- **`hasDevanagari()` iterates codepoints numerically, and that is not a style choice.**
  U+0900 is itself a combining mark, so **any** regex character class containing it trips
  eslint's `no-misleading-character-class` — escaping does not help, the rule reads the
  codepoint. Iterating also catches **U+0964 DANDA**, which is `Script=Common` and would slip
  past a `Script=Devanagari` property escape.
- **`sharp` is a real backend dependency now** and the deploy path is what makes that safe —
  see the third-pass logo section above for the `npm ci --omit=dev` / `optionalDependencies` /
  `@img/sharp-linux-x64` reasoning. The same install serves the logo resize and this renderer.
- **WhatsApp caches previews per exact URL, failures included, for days.** Test with a
  throwaway `?v=2`; never conclude anything from re-sharing the same link.
- **A response from the SWA managed function is identifiable by its HEADERS.** `/c/*`
  carries `x-ms-middleware-request-id` and **no `ETag`** — a static-file response always
  carries `ETag` + `Last-Modified`, a function response does not. `Cache-Control` differs
  by outcome too: `max-age=60` on a slug the function could not resolve, `300` once it
  injects a real camp — **do not read one as the other**. The build log also carries an
  Oryx *function* block that is absent whenever `api_location` is wrong.
- **`415 unsupported_media_type` and `content_type_mismatch` are DIFFERENT checks, and
  both must survive.** 415 is the `express.raw` Content-Type filter on
  `POST /camps/access/:token/logo-raw`; `content_type_mismatch` is the magic-byte
  verification behind it. A probe that answers one does not prove the other is intact — a
  PDF header gets 415, while PNG bytes with a bad token get `403 invalid_token`.

No migration — schema head stays **320**, next new is **321**.

## The poster export IS the OG card, so there is no second renderer (2026-09-03)

The organiser asked for "marketing material to export" and `ShareToolkit` had none — a
copyable URL, five channel buttons, a QR code and `window.print()`, but nothing that
produces a file. **The answer was not to build a poster generator: the API already
renders one at 1200x630 for the WhatsApp crawler**, so the missing piece was a download
affordance over `GET /camps/public/:slug/og.png`. That choice is what makes the whole
feature small, and it has three consequences worth keeping:

- **The downloaded image and the link preview can never drift apart** — they are the same
  bytes from the same route. A second renderer would be a second thing to keep in sync
  with the design system, and the first one to go stale.
- **No canvas anywhere near it.** That image is cross-origin, which is the exact taint
  migration 319's header was written around, and canvas readback is what Firefox blocks
  outright (see **An uploaded camp logo came out BLACK**). Reaching for a canvas here
  would have reintroduced a bug this repo has already paid for twice.
- **`poster_storage_key` (migration 033) stays untouched and still unwritten.** It is
  SELECTed once (`camps.js:772`) and set nowhere; nothing in this app can serve an
  uploaded file back anyway. Do not read the new export as filling it.

Rules for the code itself:

- **`<a download>` is IGNORED for a cross-origin href** — the browser navigates to the
  image instead of saving it. So the bytes arrive through `fetch()` and leave as a
  `blob:` on a synthetic `<a>`. **The object URL is revoked on a timer, never straight
  after `click()`** — a synchronous revoke cancels the save in some browsers, the same
  class of mistake that made an uploaded logo come out black.
- **A blocked fetch falls back to `window.open()`, it does not surface an error.** On the
  handset this magic link is built for, long-press-save is the native gesture anyway.
- **`POSTER_STATUSES = new Set(['PL','LV'])` mirrors `og.png`'s own visibility filter.**
  Outside those two statuses that route serves the **generic** card, so offering it as
  "your poster" would hand the organiser Raktify's stock image and call it theirs. A
  pending camp gets `camp_od_card_pending` instead. (Pre-existing drift, deliberately
  **not** fixed inline: the surrounding share buttons gate only on `slug`, so a `'PE'`
  camp still gets links to a URL that 404s.)
- **The og.png URL is built from `import.meta.env.VITE_API_URL`**, because `api.js`'s
  `baseURL` is module-local and not exported. `/camps` is in the Vite dev proxy, so the
  empty-string fallback is correct in dev.
- 8 `camp_od_card_*` keys in **MR + EN**, the standing `camp_`/`bb_` no-Hindi carve-out.

No migration; schema head stays **320**. Gates: `npm run smoke:frontend` clean, throwaway
`no-undef` pass **0 findings** (the `no-console` "rule not found" lines are noise, and
`URLSearchParams` must be in the throwaway config's globals or it reports 20 false hits).

### The poster is a VARIANT of that same render — `?poster=1` (2026-09-04)

**An image carries no hyperlink.** A card forwarded onward with the caption stripped is a
dead end — the receiver can see the camp and has no way to RSVP. So the *download* variant
prints a **QR code plus the camp URL as readable text**, and the crawler's card is left
exactly as it was. It is **one boolean on one renderer**, which is the whole point of the
section above: a second poster generator would be a second thing to keep in sync with the
locked design system, and the first to go stale.

- **The flag is a query string and the cache key is COMPOSITE.** `ogCacheKey(slug, poster)`
  returns `'p:'+slug` / `'c:'+slug`. Keying on the bare slug would serve whichever variant
  rendered first to **both** audiences for the full hour — the crawler getting a QR, or the
  organiser downloading a card without one. `OG_CACHE_MAX` stays 50, so a shared camp now
  occupies two of those slots.
- **The crawler card deliberately does NOT get the QR.** The `og:image` injected by
  `frontend/api/camp-og` stays flagless: a QR is noise beside a preview that is already
  tappable, and it would take the width the camp name needs.
- **All THREE organiser affordances point at the poster** — the `<img>` thumbnail, the
  download button, and the open-in-a-new-tab link. A thumbnail showing a QR-less card above
  a button that saves one *with* a QR is the small dishonesty that gets filed as a bug.
- **The payload is `${env.frontendUrl}/c/${slug}?via=qr`.** `env.frontendUrl`
  (`config/env.js:19`) is the single source for the public origin — already behind
  `manage_url` and the organiser magic link — **never a second hardcoded copy**. `?via=qr`
  needs **no migration and no route change**: `camp_registrations.referral_channel` is free
  `TEXT` and `qr` is already one of migration 263's canonical values.
- **The printed URL strips the scheme and the query** (`raktify.choudhari.ngo/c/<slug>`). It
  exists to be *typed* by someone who cannot scan; `?via=qr` is attribution, not address.
- **`renderQr()` returns `null` on any failure and the caller falls back to the plain
  card.** Degrade the variant, never the download.
- **`QR_BOX = 185` is a CEILING, not a size.** `qrcode` floors the module scale, so a longer
  slug comes back **smaller**, never larger — which is why `renderQr()` **measures** the
  buffer it got instead of assuming 185, and the plate geometry is derived from that
  measurement. Measured: a ~56-char payload → version 4, 33x33 modules at 5px = 165px.
- **The opacity invariant survives the extra composite run** — both variants come back
  `ch3` / `hasAlpha false`. The raw-intermediate flatten described in **A link-preview image
  is a CROSS-SITE subresource** is what makes that hold with a QR layer present.
- **Verify a QR by comparing MODULE GRIDS, not by looking at it.**
  `QRCode.create(payload).modules.data` against the rendered pixels sampled at each module
  centre is a decode-equivalent proof in twenty lines, and it is the only thing that
  actually tests the flag parse, the `env.frontendUrl` derivation and the `?via=qr` suffix
  end to end. Measured **0 / 1089 module mismatches** against the live route. "It looks like
  a QR code" proves nothing about the payload.

No migration; schema head stays **320**. Gates: lint + `format:check` clean,
`npm run smoke:frontend` clean, both variants probed against a local API (two distinct
byte lengths on a first *and* second request, so the composite keys do not cross-serve).

## A link-preview image is a CROSS-SITE subresource, and the card must be OPAQUE (2026-09-03, `c2362a4`)

`/c/<slug>` served the correct per-camp metas, the SWA function was provably in the
path, and `og.png` returned a real 108 KB render in 0.4 s to both `WhatsApp/2.23.20.0`
and `facebookexternalhit/1.1`. Every part of the pipeline measured healthy and the
preview was still generic or blank. **The renderer was never the problem.** Three
things were, and the first two are the reusable ones.

- **helmet's `Cross-Origin-Resource-Policy: same-site` (`app.js:69`) made the card
  unloadable by design.** CORP is enforced by the *browser* on a **no-cors**
  cross-origin subresource load, and an `<img src>` is exactly that. The share page is
  `raktify.choudhari.ngo`; the image comes from `raktify-api.azurewebsites.net`, and
  **`azurewebsites.net` is on the Public Suffix List** — so those are different
  **sites**, not merely different origins, and `same-site` refuses it. That is correct
  for the ~220 routes of API JSON and wrong for the one response whose entire purpose
  is to be embedded somewhere else. **Overridden per-route only**, inside `og.png`'s own
  `serve()` helper — the single chokepoint every image response funnels through (cache
  hit, fresh render, generic fallback). **Never relax it globally**; `grep` should
  continue to find `crossOriginResourcePolicy` at `app.js:69` and nowhere else.
  - **Why it hid for a release:** every **browser-based** unfurler (WhatsApp Web +
    Desktop, Slack, Discord, LinkedIn) must honour CORP, while WhatsApp's **native
    phone app** fetches the bytes with a plain HTTP client and never sees the header.
    So "it works on my phone" and "it is broken" were both true at once.
  - **CORS is a different mechanism and was always fine** — with an `Origin` the route
    already answers `Access-Control-Allow-Origin: https://raktify.choudhari.ngo`, which
    is why the organiser's `fetch()`-based poster download worked throughout. **A
    working `fetch()` is not evidence an `<img>` will load.**
- **The card was 32-bit RGBA with a completely pointless alpha channel** — measured on
  prod: `channels: 4`, `minAlpha 255`, **0 of 756000** non-opaque pixels. librsvg/sharp
  hand back 4 channels even when every pixel is opaque, and some crawlers decline an
  RGBA `og:image` outright. Both cards are 3-channel now.
  - **The flatten needs an explicit raw intermediate whenever there is a composite.**
    sharp does not guarantee `flatten` ordering against `composite`, so a chained
    `.composite(runs).flatten()` can hit the **base** and leave the composited layer's
    transparency in the output. Two-stage: `.composite(runs).raw().toBuffer({
    resolveWithObject: true })`, then re-open with `{ raw: {...} }` and flatten.
  - Nothing is lost — each card paints its own full-bleed opaque `#fdf8f4` ground.
    **`app-icon.png` and `social-avatar.png` deliberately KEEP alpha** (rounded corners,
    circular crop), which is why `scripts/build_og_image.js` takes `{ opaque: true }`
    per call site rather than flattening everything.
  - Rebuilding `og-image.png` on Windows is safe despite its four `<text>` elements —
    verified **zero differing RGB bytes** against the copy pulled from prod. **Diff
    numerically after any rebuild; do not eyeball it.**
- **The layout left a large blank band under short content.** The content block is now
  **measured first and centred in a fixed band**, sacrificing lines from the bottom on
  overflow — the camp **name is never the line that gets dropped**. The date pill
  carries the date alone and the hours moved onto the venue line, where they read as
  part of the place instead of a second heading.

**A generic or stale preview is still, most often, the client's cache.** WhatsApp
caches per exact URL — failures included — for days, so a link shared before a fix
deployed keeps showing the old card forever. **Retest with a throwaway `?v=2` and never
conclude anything from re-sharing the same link.** Local renders remain useless for
judging fonts (pango's Windows backend ignores `FONTCONFIG_PATH`) — read
`GET /camps/public/og/selftest` on the **deployed** API.

No migration; schema head stays **320**. Gates: lint + `format:check` clean,
`npm run smoke:frontend` clean.

## A precached SPA shell is a shell from a DIFFERENT BUILD (2026-09-04)

The organiser's logo rendered correctly in a private window and was **missing on every
real handset**, which read as a mobile styling bug and was not one. `vite-plugin-pwa`
runs `registerType: 'autoUpdate'` with a Workbox **navigation fallback**: any navigation
not on `navigateFallbackDenylist` is answered from the **precache**, and `/c/` was not on
the list. So a device that had visited before was served the `index.html` of the build
that installed its service worker - referencing **that build's JS hash** - and the logo
block, added later, simply was not in the bundle the phone ran. A private window has no
service worker, which is exactly why it looked fine there.

- **The rule is not about `/c/` specifically.** Any path that a **managed function
  rewrites** must be on the denylist, because a precache hit never reaches the function:
  `frontend/api/camp-og` injects the per-camp metas into the shell, so a precached
  navigation would have carried the **generic** card even with everything else correct.
  Two independent bugs from one missing regex.
- **A real React Router route belongs on the denylist too, and that is not a
  contradiction.** The other nine entries are static HTML that must *not* get the SPA
  shell; `/c/` **does** want the shell - it just has to come from the **network**. The
  denylist controls where the shell comes from, not whether one is served.
- **Nothing in this repo can catch it.** The Vite build emits `sw.js` happily either way,
  and the defect only appears on a device that has the SW from a *previous* deploy - so it
  is invisible in dev, in CI, in a private window, and on any first visit. **When a
  shipped element is absent on returning devices and present in a private window, suspect
  the service worker before the CSS.**
- **`og:image:type` (`image/png`) is now declared on both cards** - the function's
  injection *and* `frontend/index.html`. It goes in `STRIP` as well: that array is
  "every single-value property this function replaces", so an injected property missing
  from it would ship twice the moment the root shell grows one.

No migration; schema head stays **320**. Gate: `npm run smoke:frontend` clean
(12 precache entries, `sw.js` regenerated).

## Staff pick their OWN username at setup (shipped 2026-09-08, `a11192b`)

**Status: BACKEND + FRONTEND + SMOKE ASSERTIONS ALL WRITTEN, all six gates
measured green, and UNCOMMITTED / UNPUSHED on `feat/paper-mou-onboarding`** — so
this is not in prod and there is deliberately no row for it in the commit table
above. 13 modified files plus the new untracked `frontend/src/lib/usernameRe.js`,
~690 insertions / 44 deletions; nothing has been committed. Approved plan:
`~/.claude/plans/wondrous-zooming-hummingbird.md`.

Founder ask: platform-derived staff usernames are *"really dificullt for the
hospital/bloodbank staff to remember and type again"*, so the person **claiming**
an account picks both username and password at the magic-link setup screen —
whether the row came from institution activation or from a team invitation.
Namespace decision (founder, same session): **global uniqueness with an
institution hint** — the single flat `idx_platform_users_username` stays, the
username-only staff login stays, and the setup screen **pre-fills the derived name
as a suggestion**. It already embeds the shortname, so pre-filling *is* the hint;
no composite index, no institution picker on login.

- **Activation and invitation are ONE seam, not two features.** Both minting paths
  already end at the same `/setup/:token` screen, so the whole change is
  `consumeSetupToken`'s new optional fourth parameter plus the route around it.
- **The derived name survives as a PROVISIONAL placeholder at INSERT time, and it
  must.** Three independent reasons: `auth_path_required` needs
  `username IS NOT NULL` for staff roles; `activate.js`'s idempotency key **is**
  the username (`SELECT id FROM platform_users WHERE username = $1`); and
  `institutions.bb_admin_pending_setup_token` surfaces the paired-BB link *before*
  setup happens. The chosen name **renames over it** at consume time. Do not try
  to defer naming to setup — `activate.js:76-77` and `deriveUsername()` are
  deliberately untouched, and `onboarding.js`'s `shortname_max_23_for_inhouse_bb`
  cap still exists to reserve the 9-char `-bb_admin` budget for that provisional.
- **A failed rename must NOT burn the token, and that property is FRAGILE.** The
  UPDATE that would stamp `setup_token_used_at` is the same statement that violates
  the unique index, so `used_at` stays NULL and the person simply retries with
  another name. **This only holds because the three public setup routes run on a
  bare pooled client with NO open transaction** — `pool.connect()` +
  `set_config('raktify.actor_role','system',TRUE)` and no `BEGIN`, so each
  statement autocommits. **Wrapping those routes in a transaction silently breaks
  it**, and a mistyped name would then consume the person's only link.
- **TWO complete constant SQL statements, not one assembled string.**
  `SQL_PASSWORD_ONLY` / `SQL_WITH_USERNAME` selected by a ternary, so nothing is
  interpolated and eslint's `no-restricted-syntax` needs **no `eslint-disable`
  anywhere** (`npm run lint` is clean). The fixed column list is also the proof
  this **public** route can never touch `institution_id` / `role` /
  `is_institution_admin` / `mobile` — the row's institution was fixed at creation
  from the inviting institution, so naming cannot move it. That is what answers
  *"can not see any other institution data"*, and it has to be enforced here
  because **RLS is inert at runtime**.
- **It closes a LIVE defect, not just a feature gap.** `POST /auth/setup/:token`
  had **no role guard**, while `routes/consent.js` reuses the same three
  `setup_token_*` columns for donor DPDP consent links and guards
  `wrong_token_scope` at three sites (`:51`, `:100`, `:151`). Harmless while the
  route only set a password; **material** once it sets a globally-unique username —
  a donor could POST their consent link here and squat a staff name. Both the POST
  and the new availability route now check `STAFF_ROLES` = `hospital`,
  `blood_bank`, `ngo_admin`, `super_admin`, `dho` (migration `268:54`).
- **`username` stays OPTIONAL on that route.** Migration 268 designates the same
  route as the staff **password-reset** path (`reissue-setup` issues the identical
  link), and a password reset must never force a rename. The client sends the field
  only when the value actually changed — setting a row's username to its own value
  is a no-op against a unique index anyway.
- **`RESERVED_NAMES` is EXACT-MATCH ONLY**, never a prefix or substring test.
  Nothing in the schema reserved anything before now, which was harmless while
  every name was derived. Every institution admin already in production is
  `<shortname>_admin`, so a substring rule would retroactively invalidate all of
  them.
- **The availability check needs its OWN limiter.** `setupLimiter` is 20/hour on
  `req.ip` and a debounced field spends a request per typing pause — it would
  exhaust the budget in one sitting and lock the person out of their own setup
  screen. `usernameCheckLimiter` is 120/15min. Token-gated either way, so it is not
  an open username oracle, and it returns `{ available, reason }` only — never who
  holds a taken name, nor whether the holder is staff or a donor.
- **`username_taken` / `username_reserved` → 409, `username_format` → 400, and
  NEVER 404/410.** `SetupPassword.jsx` treats those two statuses as terminal and
  replaces the whole screen with an `ErrorCard`, when in fact a rejected name
  leaves the link perfectly usable.
- **This INVERTS migration 268's own COMMENT** (*"the username belongs to the
  role/institution, not the person"*). Officer turnover still works — deactivate
  the leaver, re-invite the successor — it just no longer inherits the name. And
  `GET /institutions/:id/audit`'s `subject_label` resolves live from
  `platform_users.username` by `record_id`, so a rename relabels historical rows
  **in that view only**; the hash-chained `audit_log` rows are untouched (hard
  rule 2).
- **Renaming is safe because nothing live parses username SHAPE.** Login, lockout
  and `credential_state` all treat it as an opaque equality key, and the only
  `LIKE '%\_admin'` in the repo is migration 311's already-executed one-time
  backfill of `is_institution_admin`.
- **Frontend risk shape, before §4 is written:** `USERNAME_RE` is currently
  duplicated bare in four files and the plan moves it to `lib/usernameRe.js`
  consumed by five — exactly the free-identifier shape that blanked `/register` in
  prod. The throwaway `no-undef` pass is mandatory, not optional (see **A blank
  page is a render throw**).
- **Two questions in the same founder message needed NO work, and the answers are
  worth keeping:** universal donor lookup already works
  (`GET /donors/lookup?mobile=` runs under elevated `actor_role:'system'`
  *precisely because* the `donors_self` blood_bank policy only sees donors with
  prior `donation_history` at that BB), and donation + TTI results **append, never
  overwrite** — `donation_history` is one row per event,
  `donor_screening.donation_id` is `NOT NULL UNIQUE` (a strict 1:1, its own
  four-eyes verification per donation), and `bb_writer` holds only
  `UPDATE (is_invalidated, invalidation_reason)`, so a blood bank can invalidate a
  donation but never rewrite one. That append-only history is what makes lookback
  possible.

No migration; schema head stays **320**. Gates, all measured:
`smoke_test_phase2.js` **186 passed / 0 failed** (was 172 — §9 grew from 10 lines to
116 and executes 15 assertions; §13 adds the donor-token case), `smoke_test_phase4.js`
**17/0**, backend lint + `format:check` clean (the two-constant-SQL-statements design
needs **no** `eslint-disable` for `no-restricted-syntax`), `npm run smoke:frontend`
clean (12 precache entries, `sw.js` regenerated), throwaway `no-undef` pass **0
genuine findings** across the whole frontend. §9 covers the five availability cases,
the three refusals (`400 validation_failed` from Zod / `409 username_reserved` /
`409 username_taken`), the token-not-burned invariant, the chosen-name login, and
that the provisional name is **released** rather than left behind as a second row;
§11 POSTs the BB token with **no `username`**, which is what covers
`SQL_PASSWORD_ONLY` and proves the password-reset path never forces a rename; §13
proves a donor's DPDP consent token gets `409 wrong_token_scope`, so the role-guard
defect closure is asserted, not merely reasoned.

**Three findings from actually running those gates, each of which cost real time:**

- **`password_set_at` is NOT a "the person chose a password" marker**, and the first
  draft of the token-not-burned assertion wrongly required it to be NULL. Activation
  stamps it `NOW()` at **four** `activate.js` sites (`:190`, `:202`, `:280`, `:293`)
  alongside the *unusable placeholder* hash, so it is non-NULL from the moment the row
  exists. **`setup_token_used_at` is the only column that says whether the link was
  spent.** The product was fine; the assertion's premise about the schema was wrong.
- **The global limiter is 100 req/IP/min over a SIXTY-SECOND window**
  (`app.js:116-117`), so two `smoke_test_phase2.js` runs back-to-back inside one
  window make the tail sections fail with `rate_limit_global` — and since both runs
  spend the same budget the same way, **identical failure counts look like
  determinism** and were misread that way once. From a cold window the whole suite
  fits. **Leave ~60 s between consecutive runs; do not weaken the limiter and do not
  add an env escape hatch for the test.**
- **Classify the `no-undef` output; never `grep -v` the noise while reading the
  summary count.** `Definition for rule '<x>' was not found` is severity **error** in
  eslint, so filtering its text leaves a nonzero error count with no visible cause —
  exactly how a clean tree got misread as 10 findings.
  `grep -E "error" | sort | uniq -c` shows all 10 are that one class (inline
  `eslint-disable react-hooks/exhaustive-deps` comments). `URLSearchParams` must be in
  the throwaway config's globals or it reports ~20 false hits.

## A camp application told NOBODY it needed reviewing (fixed 2026-09-01)

A test camp was created in prod and **no NGO coordinator and no NGO admin got a
WhatsApp** — because `POST /camps/apply` contained no `sendNotification` call at
all, while its own 201 answers the organiser *"Our NGO coordinator will contact
you within 2 working days."* The whole review queue depended on a human
happening to open the `/admin` Camps tab.

- **The blood bank's silence on the same camp is CORRECT, not a second bug.**
  `CAMP_BB_REQUEST` fires at `POST /camps/:id/verify` (`camps.js:2274`) and at
  re-partner (`:2444`), never at apply — a camp at `'PE'` has nothing for the BB
  to answer yet. **Do not "fix" that by moving the send to apply.**
- **New: `notifyCampReviewPending()` in `camps.js`**, fired **fire-and-forget**
  right after the camp row is created. Recipients are the union of the two
  role-sets `POST /camps/:id/verify` already accepts, minus `super_admin`: the
  **camp district's** active coordinators with a mobile, then every active
  `ngo_admin` with a mobile — de-duplicated by mobile, capped at
  `CAMP_REVIEW_NOTIFY_LIMIT = 5`.
- **`on_duty` is deliberately NOT required.** It gates `COORD_CRITICAL_NEW`,
  where somebody must be at their phone *now*; a camp carries a two-working-day
  promise, so demanding a live shift would silently notify nobody most evenings.
- **`ngo_admin`s are always included** because a fresh district has no
  `coordinators` profile row at all — dev holds 27 coordinator `platform_users`
  against **2** `coordinators` rows. Keying only on `coordinators` would have
  reproduced the original silence in every new district.
- **`platform_users` has NO `is_active` column** — it uses `deactivated_at`
  (migration 311). A probe written against `is_active` errors outright, which is
  how this query got it right.
- **Never awaited, and wrapped.** The organiser's 201 must not wait on Meta, and
  a WhatsApp outage must never lose a camp application. **Zero recipients logs
  `logger.warn` loudly** — "nobody to tell" is an operational hole, not a
  non-event.
- **No migration.** `notification_log.template_type` is plain `TEXT` with no
  CHECK — verified against the DB, not assumed. Schema head stays **319**.
- **It is live end-to-end.** `camp_review_pending` (UTILITY, 5 body vars,
  **body-only — an admin link is constant, and a constant URL button is what got
  `community_leader_welcome` re-classified MARKETING**) is **APPROVED in `en`**
  (Graph id `2269421593808401`, confirmed 2026-09-01), and
  `WHATSAPP_TEMPLATE_CAMP_REVIEW_PENDING=camp_review_pending` is set on
  `raktify-api` (25 template appsettings, verified by re-`list`). Copy lives in
  `docs/Raktify_WhatsApp_Templates.md` **Template 23**. So a camp application now
  actually reaches a coordinator's phone. **`mr` + `hi` were submitted 2026-09-01
  once `en` was APPROVED** (house rule: let EN clear first) and are now **APPROVED
  as UTILITY too** — so this template is complete in all three languages. They buy
  nothing today (`notifyCampReviewPending()` passes `language: 'en'` explicitly) and
  are pre-positioning for whenever that call site localises.
- **Adjacent gap, CLOSED by decision (founder, 2026-09-01): do not build it.**
  A camp **auto-accepted** at apply (`auto_accept_within_capacity` stamps
  `bb_response='AC'`) still tells the blood bank nothing, and
  `camp_bb_request`'s *"accept or decline"* copy is the wrong message for it —
  it would need its own new template. It is **not a live problem**, because
  nothing will be auto-accepted before NGO verification: *"skip auto accept for
  now. we wont be autoaccepting untill the verification."* Revisit only if
  `auto_accept_within_capacity` is ever switched on.
- Gates: `smoke:camps` **139/1** (the failing line is the documented
  `blood-bank-options` `LIMIT 25` dev-state assertion — 25 rows returned),
  `check_whatsapp_templates.js` 0 fail / 1 warn (handlers 21, env keys 25),
  lint + `format:check` clean.

## A camp can be hard-deleted, and the audit ledger is what makes that safe (shipped 2026-09-02)

There was no delete path at all: `POST /camps/:id/cancel` only sets `status='CA'` and
keeps the row, so a stray test camp could only be cleaned up from the database — and
this repo has **no read/write path to prod's DB by design** (`.env`'s
`DATABASE_URL_PROD` is empty; the prod URL exists only as a Key Vault secret App
Service resolves). `DELETE /camps/:id` + a two-step confirm in the `/admin` Camps tab
close that. **No migration — schema head stays 320.**

- **"And the log is also recorded" needed NO new code, and that is the reusable
  insight.** `donation_camps` is audited (`099_attach_audit_triggers.sql:32`), and
  `fn_audit_row()` handles `TG_OP='DELETE'` by writing **one** `audit_log` row whose
  `old_value` is `to_jsonb(OLD)::text` — **the entire camp as JSON** — with
  `field_name = NULL`, the actor, and `change_reason` from the GUC
  (`025_audit_log.sql:135-137`, `:179-196`). `audit_log` is INSERT-only and
  hash-chained (hard rule 2), so a hard `DELETE` does not destroy the record: it
  **moves it to the immutable ledger, attributable and reconstructable**. Verified on
  dev — 1705 chars of camp JSON, `actor_role='super_admin'`, the admin's typed reason.
  **So a hard delete is only ever acceptable on a table `099` actually audits. Check
  that before adding another one.**
- **The `change_reason` is the only human explanation the ledger will ever hold**, so
  `reason` is a mandatory `z.string().min(3).max(1000)` and the delete runs through
  `withRlsContext(req, fn, { change_reason: \`camp deleted: ${reason.slice(0,200)}\` })`
  (`middleware/rlsContext.js:32`, `:48`). **Do not make it optional.**
- **Four guards, and DO NOT WIDEN THEM.** One pre-read, then a specific 409 each with
  the offending count so the modal can say *how many*: `camp_is_completed` (checked
  **first** — a camp that happened is a permanent record whatever its roster looks
  like), `camp_has_registrations`, `camp_has_donations`, `camp_recruited_donors`.
  Deletion is refused unless the camp has **nothing human attached**. The founder
  explicitly rejected the wider "anything except completed camps" option: cascading
  donor RSVPs away on a mis-click is precisely the failure this must not have.
  `/cancel` is the answer for a camp people engaged with.
- **The last two guards sit in front of NO ACTION FKs** —
  `donors.registration_camp_id` (`033:80`) and `donation_history.donation_camp_id`
  (`033:84`) would throw a raw `23503`, so the guards turn a 500 into a diagnosable
  409. `camp_registrations` (`260:14`), `camp_access_tokens` (`262:22`) and
  `camp_branding_logo` (`319:116`) are **ON DELETE CASCADE** — the organiser's magic
  link and any uploaded logo go with the camp, which is correct.
- **`coordinator` is deliberately NOT granted this**, unlike `/cancel` — the register
  is the NGO admin's. `requireRole('ngo_admin','super_admin')` plus the guards **are**
  the boundary, because RLS is inert at runtime. `CampsTab.jsx` mirrors the gate with
  `useAuth()`; client-side gating is honesty about who can click, never the boundary.
- **The Delete button sits OUTSIDE the `isPending` ternary on purpose.** The camp most
  likely to need deleting is a stray application still at `'PE'`, and the branch
  holding the Cancel action never renders for one — putting it "next to Cancel" would
  have hidden it from the exact case it was built for.
- **`donation_camps`' title column is `name`, not `camp_name`** (`033:14`) — a
  `RETURNING camp_name` would throw `42703`.
- **Gate: `npm run smoke:camps` → 151** (was 140). Section 17 asserts the role gate
  both ways, the mandatory reason, all four refusals, the CASCADE, a clean second-delete
  404, and — the assertion the whole feature rests on — that `audit_log` holds one
  DELETE row carrying both the typed reason and the whole camp as JSON. **If that one
  ever fails, the delete button is no longer safe to ship.** `'CO'` is asserted first
  because camp2 is both completed *and* rostered, so a registrations-first order would
  leave `camp_is_completed` unreachable from the fixtures. `node
  scripts/smoke_test_phase4.js` (17) is a required regression — the guard reads
  `donation_history`.

## English is the default language, Marathi is a CHOICE (shipped 2026-09-01, migration 320)

`preferred_language` defaulted to `'mr'` on three tables. Migration **320** moves all
three defaults to `'en'`. Read this before touching any language default.

- **`preferred_language` is the WHATSAPP language, not the UI language.** Nothing about
  320 changes what a screen renders. The UI default is a separate decision and is still
  Marathi-first (`frontend/src/i18n/strings.js:1`, Spec §7) — **deliberately unchanged**,
  because a rural-Maharashtra pilot should open in Marathi.
- **A `'mr'` default was a GUESS that becomes indistinguishable from a CHOICE.** Three
  write paths never ask — the vendor webhook, the admin bulk upload and the admin create
  form — so a stored `'mr'` could equally mean "this donor asked for Marathi" or "nobody
  asked". `'en'` is not a better guess about the donor; it is the one that **cannot make
  delivery depend on a per-language Meta approval**. Every template is APPROVED in `en`.
- **That coupling is not hypothetical — it is exactly what held the `camp_day_of_v2`
  appsetting flip** for a day. The job sends in `preferred_language`, the default was
  `'mr'`, so a `_v2` approved only in `en` would have been rejected for most donors. See
  **WhatsApp template pipeline**.
- **EXISTING ROWS ARE DELIBERATELY NOT BACKFILLED.** A stored `'mr'` cannot be told apart
  from a chosen `'mr'`, and rewriting a real donor's stated preference to English is the
  worse error. There is also no delivery benefit any more: `camp_day_of_v2` and
  `camp_review_pending` are APPROVED in all three languages. Dev holds `mr 266` / `hi 5`.
- **Three tables, all catalogue-only.** `donors` (`008:33`), `coordinators` (`006:24`),
  `community_leaders` (`271:35`). `ALTER COLUMN ... SET DEFAULT` in Postgres rewrites no
  rows and scans nothing — a brief ACCESS EXCLUSIVE lock only — so it is safe on a live
  `donors` table.
- **Write-time defaults changed (what is STORED when the caller is silent):**
  `routes/donors.js` (`z.enum(...).default('en')`), `routes/admin.js` x2,
  `routes/vendor-webhooks.js` x2, plus `DonorDashboard.jsx` and
  `CommunityLeadersTab.jsx`'s invite modal.
- **Send-time fallbacks changed too** — `|| 'en'` where it was `|| 'mr'`:
  `dispatchDonorAlerts.js`, the three camp reminder jobs
  (`camp-day-of-reminder`, `camp-donor-thankyou`, `camp-precheck-reminder-2d`) and
  `eligibility-reminder.js`. These fire only when the row holds no value at all
  (first contact), and `routes/auth.js:162`'s OTP lookup already fell back to `'en'`.
- **`DonorRegister.jsx:85`'s `preferred_language: lang` pre-fill is NOT a default and was
  left alone.** It is a visible, editable `<select>` seeded from the language the donor is
  actually reading the page in — a real signal, and the deliberate design of `c9a8c85`. A
  donor who registers in Marathi still gets Marathi WhatsApp; that is the whole point.
- **Grep gate:** `preferred_language || 'mr'` and `.default('mr')` must both return
  nothing in `backend/src`.

## WhatsApp template pipeline — current state (Aug 2026)

`docs/Raktify_WhatsApp_Templates.md` is the copy source of truth;
**`node scripts/check_whatsapp_templates.js` is the gate** — it walks
`TEMPLATE_HANDLERS` plus every `templateType:` literal in `backend/src` and
fails when one has no handler or no env key. It exists because this whole class
of bug is invisible: a missing `WHATSAPP_TEMPLATE_*` makes the chokepoint
`logger.warn` + return `{success:false, deliveryStatus:'FA'}` — the
`notification_log` row still persists, so **a scheduled job looks perfectly
healthy and sends nothing.** That is exactly how three shipped camp reminders
(`camp_precheck_2d`, `camp_day_of`, `camp_donor_thankyou`) ran for weeks
delivering zero messages before commit `dae92d8`.

**Measured 2026-09-01, AFTER `camp_day_of_v2` ×3 + `camp_review_pending` mr/hi —
trust this over any older claim in this file.** Graph API
(`GET /<WABA_ID>/message_templates`) returns **70 rows / 27 unique names**; App
Service `raktify-api` carries all **25** `WHATSAPP_TEMPLATE_*` appsettings
`env.js` expects (the count did not move — `camp_day_of_v2` reuses the existing
`WHATSAPP_TEMPLATE_CAMP_DAY_OF` key). Both halves of the old
gap are closed — keep the layering below, it is why the gap was invisible.

- **The gap was not Meta, it was App Service.** Approval and delivery are two
  different layers, and they fail differently — this table is why the outage was
  invisible for weeks, so keep it even though both halves are now fixed:

  | Layer | Where it lives | How it fails |
  |---|---|---|
  | Meta approval | the WABA, per **name × language** | the send is rejected at the API |
  | Template **name** | an App Service **appsetting**, plain literal | unset → silent `FA`, nothing ever leaves |
  | Meta **credentials** | Key Vault → appsetting `@Microsoft.KeyVault(...)` | shared by every template at once |

  **Template names are not secrets and are NOT in Key Vault** — all 24 are
  literal appsettings (`institution_link`, `camp_reminder`,
  `donor_alert_bb_routed_v2`, …). So "Key Vault is correct" and "OTP and staff
  invitations arrive" were both true *and* told you nothing about the then-missing
  camp keys: the credentials are shared, the names are per-template. Add or change
  one with `az webapp config appsettings set -g raktify -n raktify-api --settings
  KEY=name` — **batch every key into ONE call**, each invocation restarts the app
  (~30s), and the `set` output redacts values as `None`, so always re-`list` to
  verify rather than trusting what `set` printed.
- **All 8 camp keys are now set** (`ad84034`). Four were already APPROVED ×3 and
  only needed the appsetting: `CAMP_LINK`→`camp_organizer_link_v2`,
  `CAMP_PRECHECK_2D`→`camp_precheck_2d`, `CAMP_DAY_OF`→`camp_day_of`,
  `CAMP_DONOR_THANKYOU`→`camp_donor_thankyou`. `CAMP_LINK` was the highest-value
  one — `camps.js:2250` is the organiser's magic link, so an organiser used to be
  verified and never told.
  **All 8 were set, not just the 4 ready ones, deliberately:** a key naming a
  not-yet-approved template fails with a *diagnosable* Meta error, whereas an
  unset key is an invisible no-op — and approval then flips delivery on with no
  second `az` step for anyone to forget.
- **The other 4 now exist and are APPROVED in `en`** — `camp_announcement`
  (`CAMP_ANNC`), `camp_bb_request`, `camp_bb_accepted`, `camp_bb_changed`. They
  were authored in `dae92d8` but never actually created in the WABA; created
  2026-09-01. `mr`/`hi` are submitted and PENDING. **Every camp send site passes
  `language: 'en'` explicitly** (`camps.js:1353`, `:2261`, `:2284`, `:2454`), so
  EN approval is sufficient for delivery today and MR/HI are pre-positioning —
  do not read PENDING there as a live outage. `camp_bb_changed` carries the
  neutral line only — never a decline reason.
- **A template body may not START or END with a variable.** Meta answers HTTP
  400 `Invalid parameter`, and the only place the real reason appears is the
  nested error object — `error_subcode: 2388299`, *"Variables can't be at the
  start or end of the template"*. `submit_whatsapp_templates_v2.js` prints only
  `error.message`, so a bare `Invalid parameter` means **re-POST one payload by
  hand and print the whole error object**; do not guess at the copy. This
  rejected `camp_bb_request` / `camp_bb_accepted` / `camp_bb_changed` on first
  submission (all opened `*{{1}}*`) and cost a round trip. When rewording, the
  variable **order and count are load-bearing** — `buildComponents()` fills
  positionally from the caller's insertion order, so changing copy is free and
  changing an index silently sends the venue as the date. House fix: greet a
  person (`Hi` / `नमस्कार` / `नमस्ते` — six approved templates already do),
  restructure the sentence for an institution. **`camp_day_of` (all 3) and
  `coord_critical_new` (mr/hi) still open with a variable** — APPROVED only
  because they predate enforcement, and they *will* be rejected on resubmission.
- **`camp_day_of` is APPROVED but MARKETING** in all three languages — the only
  MARKETING template in the WABA. It is one template in 3 languages, **not three
  templates** (an easy misread of the Graph API listing, and one the founder hit
  and self-corrected on 2026-09-01). Its key is set, so it delivers — but a
  day-of camp reminder sitting in the MARKETING category is
  subject to per-user marketing frequency caps and marketing pricing, so a donor
  who has hit the cap silently gets nothing.
  **Reworded as `camp_day_of_v2`, now APPROVED as UTILITY in all three languages
  (`en` first, then `mr` + `hi` once `en` cleared — all 2026-09-01), and
  `WHATSAPP_TEMPLATE_CAMP_DAY_OF` HAS BEEN FLIPPED to it** (verified by
  re-`list`). **The flip deliberately waited for all three, and flipping early
  would have been a regression, not a head start** — keep this rule, it is the
  reusable part. `camp-day-of-reminder.js` sends in `donors.preferred_language`,
  so pointing the key at a `_v2` whose `mr`/`hi` were still PENDING would have
  made Meta reject the send outright for every donor holding those languages
  (guaranteed nothing), where v1 delivered to everyone who had not hit the
  marketing cap. **A capped MARKETING template beats an unapproved language.**
  Three things forced a new *name* rather than an edit or a
  delete-and-recreate, and all three are reusable rules:
  (1) editing an APPROVED template drops it back to PENDING, taking a live
  reminder out of service for 1–3 days; (2) **Meta locks a deleted template's
  name for weeks**, and the repo has already been burned by that —
  `reword_marketing_templates.js` tried a same-name recreate for
  `camp_organizer_link` (mr) and `env.js` still maps `camp_link` to
  `camp_organizer_link_v2`; (3) a `_v2` name gives **zero downtime** — the
  capped MARKETING record keeps delivering until v2 clears, then one appsetting
  flip switches it. **The env KEY name never changes, only its value** —
  `WHATSAPP_TEMPLATE_CAMP_DAY_OF=camp_day_of_v2`. That decoupling is what the
  key/value split exists for.
  The copy fix is two defects in one pass: v1 also **opens on `*{{1}}*`**, so it
  would have been rejected on resubmission regardless of category. v2 opens on
  literal text and is anchored on the donor's own registration (*"the blood
  donation camp you registered for on Raktify"*) instead of *"today is your
  donation day"*; `Doors open` → `Reporting time`, and the button `Get
  directions` → `View your registration` — record language, not an attendance
  nudge. **The meal / photo-ID / 45-minute prep line is kept verbatim from
  `camp_precheck_2d`, which Meta approved as UTILITY** — proof the instructions
  were never the problem, the framing was.
  **Same 4 variables in the same order plus the same slug button, so
  `whatsappCloudProvider.js` and `camp-day-of-reminder.js` need no code change**
  (comments only) — which is why the whole supersession is one `az` command once
  Meta clears `mr` and `hi`.
- **Two REJECTED rows, neither of them live:** `institutional_setup_link` (en)
  is **superseded** — `WHATSAPP_TEMPLATE_SETUP_LINK` holds `institution_link`,
  APPROVED in all three, which is why staff invitations arrive. `mou_esign_link`
  (hi) is on the **dormant** eSign path (removed Aug 2026). Delete neither in a
  hurry; just do not chase them as blockers.
- **`donor_alert_replacement` is now APPROVED in all three languages** — the
  28-char-button note that used to sit here is **stale**, nothing to resubmit.
- **Names in the WABA this file did not previously record:**
  `camp_organizer_link` (v1, en/hi — superseded by `_v2`),
  `donor_alert_bb_routed` (v1, en — superseded by `_v2`),
  `donor_alert_bb_routed_v2`, `donor_alert_community_first_v2`,
  `community_leader_mobilise_v2`, `institution_link`. The `_v2` ones **are**
  wired as appsettings. **Chase template state through the Graph API, never the
  Business Manager UI — and never `submit_whatsapp_templates_v2.js` either.**
  That script is the record of what we last intended to *create*, and it has
  measurably drifted: its `camp_day_of` (en) record says the button reads `Get
  directions` while the live WABA record says `Directions to venue`. A URL
  button needs a Graph API read for a second reason — a WABA can store a button
  URL with both an encoded and a literal `{{N}}`, which silently breaks
  substitution. `camp_day_of_v2` was verified clean
  (`https://raktify.choudhari.ngo/c/{{1}}`, one literal token) right after
  submission.
- **Submission order:** EN first for each template, let it clear, then MR + HI
  from the approved copy — a rejection is then caught once instead of three
  times. `node scripts/submit_whatsapp_templates_v2.js --lang en`
  (`--only name1,name2` narrows, `--dry-run` prints payloads).
- **Env keys nothing calls today** (harmless, but do not assume they are wired):
  `community_leader_mobilise`, `community_leader_welcome`, `coord_prefire_warn`,
  `cred`, `emg`, `thk`. `REM` has no explicit handler and falls through to the
  default positional builder — the gate's single WARN. It **is** set in prod
  (`camp_reminder`, APPROVED ×3), so the WARN is about a missing handler, not a
  missing key.
- **The gate cannot see prod.** `check_whatsapp_templates.js` proves every
  `templateType` has a handler and an env *key name*; it does not and cannot
  check that the appsetting is populated or that Meta approved the template.
  Those two need the `az` and Graph API reads above — **run them before
  believing any camp notification works.**
- **`BOT_REPLY` (6 sites in `services/whatsapp/bot.js`) is NOT a template
  problem.** It needs a free-form session-message path (legal inside Meta's
  24-hour customer-service window, since the bot only ever replies to an
  incoming message). Logged, deliberately not fixed.

## V2 WhatsApp templates (July 2026 — task 77 — historical)
Seven new templates for the donor-alert-gate architecture are now written up
in `docs/Raktify_WhatsApp_Templates.md` §8–14, with provider handlers +
env keys ready in code. **Meta submission is the bottleneck** (1–3 days per
template × language). Recommended submission order: `donor_alert_bb_routed`
(EN, MR, HI) → `bb_donor_incoming` (EN) → the community/coord/replacement
ones.

- **Wired to fire today:** `donor_alert_bb_routed` (from `donor-alert-gate`
  after `createAlerts()`), `donor_alert_community_first` (same site, when
  request has `attributed_community_id`), `bb_donor_incoming` (from
  `routes/donorAlerts.js` on donor accept).
- **Provider handlers ready, wire-up deferred:**
  `donor_alert_replacement`, `coord_prefire_warning`, `coord_critical_new`,
  `community_leader_mobilise` — each needs a small scheduler tick or
  coord-panel override button that doesn't exist yet.
- **Safe default:** if a `WHATSAPP_TEMPLATE_*` env var is unset, the chokepoint
  returns `success:false` cleanly (no throw); the notification_log row still
  persists as a `FA` so we can see the intent. So this code ships without any
  env change; setting the vars just flips delivery on.

## V2 WhatsApp delivery-status hardening (July 2026 — task 79)
Delivery-status webhook now captures `failure_reason` from Meta's
`errors[]` array and promotes known opt-out codes to `delivery_status='OP'`
so the existing `fn_notif_propagate_opt_out` trigger auto-flips
`donors.whatsapp_opted_in`. Only Meta code `131050` maps to opt-out today;
others (`131047` re-engagement, `131056` rate limit) stay as `FA` until we
have data to widen. Existing HMAC-signature enforcement is unchanged.

