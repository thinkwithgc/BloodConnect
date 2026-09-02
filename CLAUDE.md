# Claude / coding-agent instructions

This is a **life-critical** healthcare system. Read this whole file before touching code.

> **Product name:** the platform is **Raktify**. The Postgres GUC namespace is
> `raktify.*` (e.g. `raktify.actor_role`); the Tailwind/CSS design-system prefix
> is `rk-*` / `.rk-*`. Use these consistently — no other brand prefix exists.

## Where things stand (updated 2026-08-30) — READ THIS FIRST

The rest of this file is accreted history. This section is the resume point: the
last commit, what is live, and what is genuinely blocked. Trust it over any
older section it contradicts.

**Branch / commits.** Working branch `feat/paper-mou-onboarding`; deploy is
`git -c credential.helper='!gh auth git-credential' push origin feat/paper-mou-onboarding:main`
(fast-forward → fans out to CI + `raktify-api` + `raktify-web` **and
auto-applies migrations to prod**). Last twenty-two commits, newest first:

| Commit | What |
|---|---|
| `a710cab` | `fix(camps)`: an uploaded organiser logo came out **black** - a canvas that was never drawn on encodes to JPEG as opaque black. See **An uploaded camp logo came out BLACK** below |
| `1a940cc` | `docs`: the commit table pointed at a pre-amend hash — corrected, plus the prod-state claims for the 2026-09-02 push |
| `420a84d` | `feat(camps)`: an NGO admin can **hard-delete** a camp nobody has touched, from `/admin` — recoverable because `fn_audit_row` files the whole row as JSON. See **A camp can be hard-deleted** below |
| `e42b32b` | `feat(i18n)`: **English is the default WhatsApp language** (migration **320**), Marathi is a choice. See **English is the default language** below |
| `3eb8963` | `docs(whatsapp)`: `camp_day_of_v2` `mr`+`hi` submitted — the appsetting flip **waits for all three languages** |
| `27b2e37` | `docs(whatsapp)`: `camp_day_of_v2` + `camp_review_pending` `mr`/`hi` submitted |
| `93c07c3` | `feat(whatsapp)`: `camp_day_of` reworded as **`camp_day_of_v2`** so Meta files it UTILITY, not MARKETING |
| `1cd3eee` | `docs`: `camp_review_pending`'s appsetting is set and `en` is submitted |
| `2c66ccf` | `feat(camps)`: a camp application now **TELLS the NGO side** it needs reviewing. See **A camp application told NOBODY** below |
| `65ad800` | `docs`: camp branding is in prod — migration 319 applied, all four routes verified |
| `9e4b7cf` | `docs(whatsapp)`: the camp template gap is closed — 24/24 appsettings, 4 templates APPROVED in `en` |
| `ad84034` | `fix(whatsapp)`: a Meta template body may not **start** with a variable — 9 records reworded. See the leading/trailing-variable bullet under **WhatsApp template pipeline** |
| `19e3ee3` | `feat(camps)`: an organiser's **own logo + tagline** on the public camp page, NGO-approved (migration **319**). See **Camp branding** below |
| `b898503` | `docs(brand)`: the QR poster prints the wordmark **vector** (18 positions, one `<symbol>`), one poster per A4 at 130mm |
| `156eee0` | `feat(portals)`: a hospital / blood bank sees **its own name** on its dashboard, via the session-addressed `GET /institutions/me`. See **A staff portal never knows its own institution** below |
| `b422787` | `fix(donor)`: **`/register` was blank in prod** — `c9a8c85` put the language select in `StepDetails` but destructured `t`/`setLang`/`supported` in `DonorRegister`. See **A blank page is a render throw** below |
| `d5f518b` | `fix(otp)`: a rejected WhatsApp OTP send is no longer reported as "code sent", and the OTP goes out in `donors.preferred_language`. New `frontend/src/lib/otpError.js`. See **OTP delivery failures** below |
| `c9a8c85` | `fix(donor)`: the DOB picker could never be completed (its selects read the `value` prop, which is `''` while partial); donor registration now **asks** which language WhatsApp should use. See **Marathi i18n** below |
| `d657d8a` | **True Marathi** for Host a camp + the whole BB portal. Also fixes a real bug: `useT()` held per-call-site state, so switching language translated the header and nothing else. New `i18n/LangProvider.jsx` + packs `i18n/camps.js` / `i18n/bloodbank.js` (661 keys per language). See **Marathi i18n** below |
| `31c5767` | `feat(bb-camps)`: repair a whole month of capacity, not one day at a time - bulk bar, *All planned days*, *Take off the plan* |
| `9415954` | `feat(camps)`: the date question comes first on Host a camp, with a browsable BB slot calendar |
| `70ac9ba` | `fix(api)`: a missing **endpoint** and a missing **row** no longer share the code `not_found`. The catch-all now answers **`route_not_found`**; `institutionErrorText` splits one sentence into three; smoke §22 asserts they differ. See **Deploy skew** below |
| `bdf363d` | Staff logins are editable — `POST /institutions/:id/users/:userId/contact` (username / mobile / email), the in-house-BB admin captured on the hospital apply form, `reissue-setup` accepts a mobile |
| `dae92d8` | `fix(notifications)`: three shipped camp reminders could not send a single message — 8 new WhatsApp templates authored + submitted, `CAMP_LINK` wired, `scripts/check_whatsapp_templates.js` gate added |
| `9b0a59f` | BB camp capacity + `bb_response` (migrations 316/317/318, `services/camps/capacity.js`, BB Camps tab, results worklist, roster-PII fix, DOB picker, bounded date inputs) |
| `3c4d235` | Camp organiser names a blood bank; NGO admin confirms it (migration 315) |

**Schema head.** **99 migration files, latest `320_default_language_english`.
Next new migration is `321`.** 320 went to **prod** 2026-09-01
(`✓ 320_default_language_english (960ms)`) — a catalogue-only
`ALTER COLUMN ... SET DEFAULT 'en'` on three tables, no table rewrite, no scan,
and **no backfill of existing rows** (see **English is the default language**
below). 319 went to **prod** at 2026-09-01T08:59:49 UTC
(`✓ 319_camp_branding (1426ms)`, `Done. Applied 1 migration(s)`); 315–318 went at
2026-08-28T17:12 UTC. `/health` → 200 `db: ok`, and `GET /camps/public/:slug`
answers 404 rather than 500, which is what proves the new `camp_branding_logo`
join actually resolves in prod. Everything `≤319` is
immutable (hard rule 5). **`npm run migrate:status` is the source of
truth — the numbered table further down this file is incomplete.**

**Gates, with their real assertion counts** (the phase table below understates
two of them):

| Command | Count | Notes |
|---|---|---|
| `npm run smoke:camps` | **151** | The camp gate. Attendance derivation + capacity + `bb_response` + the PII scoping + the branding approval gate + the hard-delete guards. **One assertion is dev-state-dependent — see below** |
| `node scripts/smoke_test_phase4.js` | 17 | **Required regression** for anything touching `donation_history` / `donor_screening` |
| `node scripts/smoke_test_phase2.js` | **172** | Institution onboarding / paper MoU / staff-login editing / the two-404 split / the portal's own-name banner |
| `node scripts/check_whatsapp_templates.js` | 0 fail, 1 warn | Every `templateType` in `backend/src` must have a handler **and** an env key |
| `npm run lint && npm run format:check` | — | `format:check` is a hard CI gate in all three workflows, **backend only** |
| `npm run smoke:frontend` | — | Vite build. Frontend has no ESLint config, so this is its only gate. **Run from the repo root** |
| `node scripts/smoke_test_phase3/5/6.js` | — | **Do not run.** Pre-268 staff-auth drift; they fail for unrelated reasons |

**`smoke:camps` reports 139/1 on a well-used Neon dev DB, and that is not a
regression.** The failing line is *"the public picker needs NO token and lists
active onboarded BBs"*: `GET /camps/blood-bank-options` is
`ORDER BY i.display_name LIMIT 25`, and district 501 has accumulated **48**
active onboarded blood banks from repeated smoke runs, so the two BBs the run
just seeded sort off the end of the page. Count before touching anything — if
the district is over 25, the assertion is measuring the dev DB, not the code.
**That LIMIT is also real product drift**: a district with more than 25 blood
banks silently truncates the organiser's picker, with no search and no total in
the payload. Logged, deliberately not fixed.

### Deploy skew: the SPA goes live ~1 minute before the API

One push, three workflows, and they do **not** land together. On commit
`bdf363d` both started at `17:11:2x` but `raktify-web` finished in **2m26s**
while `raktify-api` took **3m31s**. **Every release therefore has a ~60–90
second window in which the new SPA is live against the old API**, so a button
shipped in that release calls a route prod does not have yet and the user gets a
404 from the Express catch-all.

That is exactly how the staff-contact editor was reported broken on 2026-08-28
— *"This no longer exists at this address. Go back to the register and re-open
it."* The record was fine; the route was 65 seconds from existing. It cost hours
because the catch-all answered the same bare `not_found` a dozen handlers use for
a missing row.

**When a 404 is reported right after a deploy, suspect skew before reading any
handler.** `gh run list --branch main --limit 3` for the timings, then probe prod
— one command tells you which of the three cases it is:

| Probe result | Means |
|---|---|
| `{"error":"missing_token"}` | The route **exists** (`verifyJWT` is per-route). Not skew |
| `{"error":"route_not_found"}` | The route is **not deployed yet**. Skew — tell the user to hard-reload |
| `{"error":"not_found"}` | A handler ran and could not find the **row** |

Commit `70ac9ba` is what makes that table possible: `app.js`'s catch-all answers
`route_not_found`, and `institutionErrorText`
(`frontend/src/components/institution/ReasonDialog.jsx`) gives the three cases
three sentences — `route_not_found` says *reload the page*, `not_found` says the
record is gone, `institution_not_found` names the register. **Never give
"endpoint missing" and "row missing" the same code again**; `smoke_test_phase2.js`
section 22 asserts they differ.

**Live in prod, code-complete, nothing outstanding:** everything in the phase
table below, plus per-day BB camp capacity publishing, per-camp
`bb_response` accept/decline, the BB **Camps** tab (calendar / requests /
brief), the post-camp results worklist, the `GET /camps/:id/registrations`
institution-scoping fix, `<DateOfBirthInput>` and bounded native date inputs.

**Everything on this branch is now in prod.** `e42b32b..1a940cc` went up
2026-09-02T08:05 UTC — the camp hard-delete (no migration: route + admin UI + smoke
only), all three workflows green (CI 24s, `raktify-web` 1m50s, `raktify-api` 3m36s).
`DELETE /camps/:id` verified live — it answers `missing_token` while
`/camps/:id/nope` on the same prefix still answers `route_not_found`, which is what
rules out a deploy-skew false positive rather than merely hoping the window had
passed. Before that, `9e4b7cf..e42b32b` went up 2026-09-01 (migration 320 applied,
`/health` 200 `db: ok`), and before that `30d6ef4..9e4b7cf` was pushed
2026-09-01T08:58 UTC — 5 commits, all three workflows green (CI 29s, `raktify-web`
1m47s, `raktify-api` 3m41s), migration 319 applied by the `migrate` job. All four
branding routes verified live against `raktify-api`: `/branding/approve` and
`/branding/reject` answer `missing_token`, `PATCH /access/:token/branding` answers
its own `nothing_to_update`, and `POST /access/:token/logo-raw` answers
`content_type_mismatch` on a fake PNG — so magic-byte verification is working in
prod, not just in dev. 319 was prod-safe by construction: additive DDL only, all
10 constraints `convalidated = true` against **152 real `donation_camps` rows** on
Neon dev (NULL-row CHECK semantics validated against data, no `NOT VALID`
deferral), and prod has **zero camps** so the scan was instant. Deploy skew was
benign here too — a new SPA against the old API just read `undefined` for
`logo_data_uri` and rendered nothing.

**Nothing has exercised camp branding in prod yet, because prod has zero camps.**
The manual walk-through below is still the outstanding verification.

**Blocked on other people, not on code:**
1. **MR / HI review for the four new camp templates** — the only Meta-side wait
   left on camps, and **it blocks nothing today**. Camp WhatsApp went from
   silent to delivering on 2026-09-01: all **24** `WHATSAPP_TEMPLATE_*`
   appsettings are now populated on `raktify-api`, and all four
   previously-absent templates — `camp_announcement`, `camp_bb_request`,
   `camp_bb_accepted`, `camp_bb_changed` — are **APPROVED in `en`**. Every camp
   send site passes `language: 'en'` **explicitly** (`camps.js:1353`, `:2261`,
   `:2284`, `:2454`), so the EN approval *is* the whole requirement; the `mr`
   and `hi` records are submitted and PENDING purely as pre-positioning for
   whenever those call sites localise. See **WhatsApp template pipeline** below.
   Two things worth keeping from the failure this replaced: **an unset
   `WHATSAPP_TEMPLATE_*` key is invisible** (`whatsappCloudProvider.js:574-583`
   warns, returns `{success:false, reason:'template_not_configured'}` and still
   writes the `FA` row, so a nightly job looks healthy and sends nothing), and
   **"OTP / staff invitations arrive" was never evidence the camp keys were
   set** — the Meta credentials in Key Vault are shared by every template,
   which is exactly what made it invisible.
2. **Legal review of the MoU template** — the last sign-off before onboarding
   institutions at scale. Medical sign-off is done (10-Jul-2026).
3. **Manual prod walk-through of the camp lifecycle.** Prod has **zero camps**,
   so the flow has never been exercised there: publish a month with a holiday
   and a reduced day → host against a full day (blocked, alternatives) and an
   open day → accept in the BB tab and confirm the organiser's mobile appears
   only then → record two donations and enter TTI from the worklist without
   seeing a UUID → decline after NGO verify and confirm the admin sees the
   reason and the organiser sees the neutral line.

**Deferred by decision (not blocked):** institution-users Stage 2 (staff
capabilities) — starts at migration **320**; `BOT_REPLY` free-form
session-message path (6 sites in `services/whatsapp/bot.js`) — needs a
non-template send, not a template; plus the standing list in
**Post-Phase-8 deferred items** below.

## Design system — LOCKED (read before touching any visual surface)

Full reference: `docs/Raktify_Design_System.md`. Canonical code:
`frontend/tailwind.config.js`, `frontend/src/index.css`,
`frontend/src/components/Wordmark.jsx`, `frontend/public/icon.svg`.
**Do not introduce new colours, fonts, icon variants, or wordmark
treatments without the founder's explicit sign-off.** Pull tokens from
those files; never invent a value. Repeated design churn = wasted
commit/deploy cycles — get it right the first time by following these:

- **Accent colour is `rk-700` = `#b8231a`** (warm red). Palette is the
  single `rk-50…900` scale + `cream #fdf8f4` + `sand #f5ece4`. Text uses
  warm `stone-*` on marketing surfaces. No blue/green/purple as brand
  colours (those are status-only: green=ok, amber=warning, red=danger).
- **Typography: Inter + Noto Sans Devanagari fallback, one family.** No
  serif, no second display font. Weight/size make hierarchy.
- **Wordmark: "Rakt" RED, "ify" BLACK — never reversed, and ALWAYS THE VECTOR.**
  Two sources, byte-identical artwork: **`frontend/public/wordmark-tm.svg`** (the
  file, for anything outside React) and `frontend/src/components/Wordmark.jsx` (the
  same paths as constants). *(`docs/trademark/`, cited by both this file and
  `Wordmark.jsx`, **does not exist** — stale reference, ignore it.)*
  **Never re-type the wordmark as text** — not `<span><i>Rakt</i>ify</span>`, not a
  styled `<b>`, not in an email, a doc, an OG image or a print sheet. A text
  approximation drifts with whatever font the renderer actually has, which is the
  literal reason the vector exists (`Wordmark.jsx`’s header comment says so), and
  static `docs/*.html` is opened **offline at a print shop** where the Google Fonts
  Inter link silently fails and the mark renders in Times. So:
  - **React → `<Wordmark/>`**, never anything else.
  - **Static HTML → one `<symbol id="rk-wordmark" viewBox="57 107 1185 378">`**
    holding the paths copied **verbatim** from `wordmark-tm.svg`, then
    `<svg><use href="#rk-wordmark" /></svg>` at every brand position. Same-document
    `<use>` prints exactly like it screens; an *external* `<use href="file.svg#id">`
    does not, and neither does an `<img src>` once the file is emailed elsewhere.
    Worked example: `docs/Raktify_QR_Posters.html` (18 positions, one sprite).
  - Aspect ratio is **1185 × 378 = 3.135 : 1** — size by height and derive the width
    (16mm tall → 50.2mm wide). Cap height lands ≈ 0.58 of the box.
  - **The wordmark stands ALONE.** All six app call sites render it with no icon
    square beside it — it already carries the droplet as the `i` tittle, so pairing
    it with the icon duplicates the droplet. Do not build a lockup.
- **™, never ® — and the glyph is the whole announcement.** The mark is
  **filed and PENDING**; printing ® is a §107 offence. `<Wordmark tm/>` on public +
  marketing surfaces and the landing hero (not authenticated portal chrome).
  **"trade mark", never "registered"**, and never ®, until registration actually
  lands. Do not enlarge or restyle the ™ glyph on one surface to make it louder —
  that forks the mark, which is the exact defect this rule exists to prevent.
  **A public print artefact carries an owner note, and it is FINE PRINT, not a
  claim** (founder, 30-Aug-2026: *"dont put trademark notice like we are screamng.
  just a gentel subtle note is sufficient. even the TM mark give the hint that its
  already trademarked."*). One muted line, the sheet's **last** element, below the
  footer rule, **smaller than the footer** (7pt vs 8.5pt in
  `docs/Raktify_QR_Posters.html`), in `--ink-3`, with **no ink-black bold on
  "Raktify™" and no prohibition clause**: *"Raktify™ · a trade mark of Choudhari
  EduHealth India Foundation (application pending)"*. It says who owns the name;
  the ™ riding on the vector already says the name is claimed. Two specific
  regressions to avoid: making it the same size as the footer (it then reads as a
  peer statement rather than fine print), and placing it directly above a footer
  that already bolds *Choudhari EduHealth India Foundation* (the same owner named
  twice running reads as a restated claim). A sheet that shouts about its trade
  mark reads defensive, not professional.
- **Icon (unified 16-Jul-2026): ONE flat brand-red square + white
  wordmark-droplet + red cell-dot, identical in `icon.svg` + `app-icon.svg`.
  Flat only — no gradient/rings/gloss; no letters/monogram. Edit `app-icon.svg`
  then `npm run og:build`; never hand-edit the PNG. Favicons point at
  `/icon.svg`.**
- Reuse `.rk-button*/.rk-card/.rk-input/.rk-label/.rk-legal` — don't
  restyle from scratch. Shadows `shadow-soft`/`shadow-lift` (warm-tinted).

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

## An uploaded camp logo came out BLACK, and black IS the blank canvas (fixed 2026-09-02)

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
  Vite build; there is no headless browser installed. The fix rests on inspection plus the
  mechanism - and on `canvasIsBlank()` making any residual failure loud instead of silent.

No migration; schema head stays **320**. Gates: throwaway `no-undef` pass clean (see **A
blank page is a render throw**), `npm run smoke:frontend` builds clean.

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

## Pilot scope — Donor + Camp modules only (Aug 2026)

PDMC (blood bank in-charge + Dean) agreed to run the **donor and camp modules
first**, prove the platform's robustness and reliability, and only then switch
blood requests on. Consequences for anyone touching the code:

- The donor-facing **"raise a blood request"** surface is **commented out, not
  deleted**. Four blocks, all carrying the literal marker
  `PILOT SCOPE (Aug 2026)` — grep for it:
  `frontend/src/App.jsx` (the `DonorRaiseRequest` import; the
  `<Route path="/donor/raise">`) and
  `frontend/src/pages/donor/DonorDashboard.jsx` (the `import { Link }`; the
  `<Link to="/donor/raise">` CTA). **Re-enabling is uncommenting those four
  — do not rewrite the feature.**
- `frontend/src/pages/donor/DonorRaiseRequest.jsx` and **`POST /requests/citizen`
  stay live**. Do **not** disable the endpoint: `scripts/smoke_test_phase5.js`
  covers it, and the ask was frontend invisibility only.
- Only the *donor self-service* entry point is hidden. Tier 1/2/3 request paths
  (hospital, coordinator-on-behalf, community) are untouched.
- Read this as a scope decision, not a defect — nothing behind the hidden CTA
  is broken, and the request engine, matcher and escalation ladder are all still
  exercised by their smoke tests.

### Camp attendance DERIVES ITSELF — nobody ticks a roster (Aug 2026)

Migrations 312–314 moved attendance out of human hands. Before touching camps:

- **`camp_registrations.status` `'AT'` is written by a trigger**, not by a route.
  Recording a donation with `donation_camp_id` set (and `trust_level IN ('V','R')`)
  upserts the roster row to `'AT'`. `POST /camps/:id/registrations/:regId/status`
  and its magic-link twin **reject `'AT'` and `'NS'` with `409
  attendance_is_derived`** — deliberately loud, so an old client says why.
  Settable statuses are `RG` (revert), `DF` (came, could not donate) and `CN`.
- **`'DF'` is an attendance fact only.** It must never write
  `donors.deferral_until` / `next_eligible_date` — a roster tap is not a clinical
  gate (hard rule 1). The clinical deferral stays on the BB's donation path.
- **No-show is derived too**, by the `camp_close_roster` job (02:10 IST) — `RG` →
  `NS` only once the camp is >48h past **and** either its status is `CO` or the
  roster already holds an `AT`/`DF`. The grace exists because blood banks
  batch-enter a camp's donations the next morning; 314's upsert overwrites `NS`,
  so a late entry self-heals.
- **`is_invalidated` (TTI-reactive) does NOT unwind attendance.** The donation is
  discarded; the person still came.
- **`units_collected`** derives from `COUNT(*)` over the camp's donations; the
  manual field at `POST /camps/:id/complete` only wins when larger, and an
  organiser-reported `attended_donor_count` is **filed into `review_notes` as a
  headcount rather than stored** — it must not overwrite the derived value.
- Every camp a person hosts — donor, coordinator or community leader — lists at
  **`GET /camps/mine`**, keyed on their **mobile** (not their session), which is
  what unifies the two auth clusters without bridging them. `PATCH /camps/:id`
  edits details only; verify / decline / complete / cancel stay behind
  password + TOTP.
- **Gate: `npm run smoke:camps`** (`scripts/smoke_test_camps.js`, 117 assertions)
  covers the whole derivation. `smoke_test_phase4.js` is the regression gate —
  314 adds a trigger to `donation_history`, the most safety-critical insert path
  in the system, so if phase 4 fails, the trigger is wrong.

### Blood banks publish camp capacity, and answer per camp (Aug 2026)

Migrations 315–318 + `backend/src/services/camps/capacity.js` + the BB **Camps**
tab. The NGO admin used to partner a blood bank by fiat and every question after
that click was a phone call. Now the BB **declares capacity a month ahead**, so
the organiser's hosting form pre-answers "can you do the 14th"; the per-camp
accept/decline is the exception path, not the normal one.

- **`bb_response` (`PE`/`AC`/`DC`, migration 317) is an axis ORTHOGONAL to
  `donation_camps.status`** — exactly as `crossmatch_confirmed` sits beside
  `blood_requests.status`. `status` gained no value: it is a CHECK-constrained
  enum (`PE`,`PL`,`LV`,`CO`,`CA`,`DC`) read by `campStatus.js`, the admin
  `CampsTab`, `MyCampsSection`, `PublicCampPage`, `GET /camps/collectable`,
  `camp_close_roster` and a long tail of `IN ('PL','LV')` predicates — a new
  value would make every one of them quietly wrong.
- **`bb_response` never changes `status`, and never changes what
  `GET /camps/collectable` returns.** A decline does not cancel the camp (200
  donors may have RSVP'd) and a BB that declined Monday must still be able to
  collect Saturday. **A decline also does not clear
  `partnered_blood_bank_id`** — that would erase who declined. Re-partnering
  resets to `'PE'` and **must clear all four decline/response columns**, or
  317's `bb_decline_reason_needs_decline` CHECK fails.
- **Two `DC`s, unrelated:** `status='DC'` = the NGO declined the application;
  `bb_response='DC'` = the blood bank declined to collect.
- **`bb_response` states:** `NULL` = organiser named this BB but the NGO has not
  promoted it (no Accept/Decline buttons) · `'PE'` = actionable · `'AC'`/`'DC'`
  = answered. Written `'PE'` in exactly two places (verify, re-partner) —
  **apply never writes `'PE'`**; only `auto_accept_within_capacity` writes a
  partner at apply, stamping `'AC'`.
- **Three day-states in capacity, and only one blocks.** No `bb_camp_capacity`
  row = **not published** (`published:false`, `slots_left:null`, `ok:true`,
  never blocks — absence-as-closed would have stopped camp hosting
  platform-wide on ship day, so **branch on `published`, never `max_camps`**);
  **`max_camps = 0` IS the holiday** (no blackout table — "closed" and
  "reduced" are the same edit); `n` = n bookable slots. `PUT /camps/bb/capacity`
  with `max_camps:null` withdraws a day.
- **Two counts:** `confirmed` = `status IN ('PL','LV') AND
  partnered_blood_bank_id = bb` **blocks**; `pending` = `status='PE' AND
  (partnered = bb OR requested = bb)` is a **warning that never blocks** — one
  abandoned application must not hold a day hostage.
- **Overbooking is enforced in `services/camps/capacity.js`, not the DB.** Staff
  misallocation is not patient safety (hard rule 1), it is a cross-row count a
  CHECK cannot express, and a trigger would remove the admin's emergency
  override. That file is the **single source of occupancy truth** — the BB's
  calendar and the organiser's booking gate read the identical structure, which
  is the whole reason it exists. `staff_total`/`staff_per_camp` are **advisory**
  (they suggest `max_camps`); `max_camps` is what binds.
- **Decline reasons `NC`/`ND`/`DT`/`VE`/`OT` go to the NGO admin, NEVER the
  organiser** — the organiser sees only "we're arranging a different blood
  bank", and `PublicCampPage` is deliberately untouched. **Organiser name +
  mobile are revealed to the accepting BB only** — redacted while
  `bb_response='PE'`, returned after `'AC'`, invisible to every other BB.
- **Migration 318 exists only because `fn_audit_row()` (migration 025)
  hardcodes `NEW.id`/`OLD.id`.** `bb_camp_settings` is keyed on
  `blood_bank_id`, so its own audit trigger threw `record "new" has no field
  "id"`; 316 was already applied and migrations are immutable. **Any table you
  pass to `attach_audit_trigger()` must have a column literally named `id`.**
- **Dates are calendar labels, not instants.** Every `date` in
  capacity/availability responses is a plain `'YYYY-MM-DD'` string. A raw
  `RETURNING scheduled_date` serialises as `…T00:00:00.000Z` — use
  `to_char(scheduled_date,'YYYY-MM-DD')`.
- **The roster PII leak that shipped with this fix:** `GET
  /camps/:id/registrations` granted `blood_bank` with **no institution
  scoping**, so any BB could read any camp's roster including mobiles and
  decrypted names. Now `403 not_your_camp`. RLS is inert at runtime, so the
  handler's own `WHERE` **is** the security boundary — 316's header says so
  verbatim.
- **Post-camp results worklist** `GET /camps/:id/donations` — `ScreeningEntry`
  previously had one way in: paste a donation UUID. The screening endpoints are
  reused byte-for-byte (4-eyes + the separate `screening` key kind untouched).
- **Date inputs:** `frontend/src/components/DateOfBirthInput.jsx` (three
  selects, year list mirroring the DB's `age_min`/`age_max` CHECKs at
  `008_donors.sql:105-106`) and `frontend/src/lib/dateBounds.js` (`todayISO()`
  reads **IST explicitly**). The picker mirrors the constraint, it does not
  become it — `donorSchema.date_of_birth` still validates format only, so a
  bulk upload or vendor webhook still hits the CHECK.
  **The three selects are driven by the component's OWN `{y,m,d}` state, never
  by the `value` prop — do not "simplify" that away** (fixed `c9a8c85`, after
  it shipped broken). `onChange` emits `''` for any incomplete triple, so
  `required` fires on a half-filled picker and the form can never post
  `'1998--07'`. That contract is right, and it is precisely why `value` cannot
  drive the selects: for two taps out of three `value` is `''`, so a
  `value`-derived select snaps back to its placeholder the instant the donor
  touches it and **the triple can never be completed**. `value` seeds the state
  and can override it (an edit form loading a saved DOB, a reset); the guarded
  re-seed `useEffect` stays out of the way while the picker is half-filled,
  because both sides are `''` there. One component, four call sites — donor
  register, donor profile, `ThalassemiaTab`, `DonorBulkUpload`.

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

### WhatsApp template pipeline — current state (Aug 2026)

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

### V2 WhatsApp templates (July 2026 — task 77 — historical)
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

### V2 WhatsApp delivery-status hardening (July 2026 — task 79)
Delivery-status webhook now captures `failure_reason` from Meta's
`errors[]` array and promotes known opt-out codes to `delivery_status='OP'`
so the existing `fn_notif_propagate_opt_out` trigger auto-flips
`donors.whatsapp_opted_in`. Only Meta code `131050` maps to opt-out today;
others (`131047` re-engagement, `131056` rate limit) stay as `FA` until we
have data to widen. Existing HMAC-signature enforcement is unchanged.

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

## Source of truth
The single, complete spec is `docs/Raktify_Master_Prompt.md`. The 8 phases (0 → 8) are independent specs. **Each phase is meant to be executed in a fresh agent session.** Do not skip phases. Do not invent fields, tables, statuses, or workflow steps that are not in the spec — if you find a gap, surface it; do not paper over it.

## Hard rules

1. **Patient-safety rules live in the database.** CHECK constraints, triggers, and RLS — not application code. Application code has bugs; constraints do not. Never move a clinical rule from a trigger into application logic without explicit user approval.
2. **`audit_log` is INSERT-only.** Only the `audit_writer` Postgres role can write to it. No application role gets UPDATE or DELETE on `audit_log` ever. Do not add an "easy" admin override — there is no override.
3. **Donor PII is masked from hospitals.** Mobile numbers are never returned to the hospital role. All donor↔hospital comms are mediated by the platform.
4. **Self-reported blood group is never used in matching.** `donors.blood_group_self_reported` is display-only with an "Unverified" badge. Only `donors.blood_group_verified` (writable solely by `blood_bank` role) is queried during matching.
5. **Migrations are immutable once applied.** The runner refuses to re-apply a migration whose checksum has changed. To alter a previous migration, write a new one.
6. **Clinical reference data (compatibility matrix, TTI deferrals, component shelf life, eligibility) is now MEDICALLY SIGNED OFF (haematologist, 10-Jul-2026 — see `docs/medical-review/`).** The values live in `002b_seed_blood_components.sql`, `002c_seed_compatibility_matrix.sql`, and `services/donors/eligibility.js`, promoted on the running DB by migration 297. The rule still stands for any FUTURE change: never seed or alter a clinical value from anywhere except the medical advisor's signed document, and record the change in the Q&A doc.

## Repository structure

```
backend/src/
  config/          env, logger, db pool
  routes/          Express routers (one file per resource)
  middleware/      auth, RLS-session, error handler
  services/        domain services + provider abstractions
    encryption/    local (AES-256-GCM; Azure Key Vault crypto provider future work) — swap via ENCRYPTION_PROVIDER
    notifications/ console | msg91 | whatsapp_cloud (Meta Graph API — live primary) — swap via NOTIFICATIONS_PROVIDER
    storage/       local (Azure Blob provider future work) — swap via STORAGE_PROVIDER
    whatsapp/      bot conversation state machine + parsers
  utils/           pure helpers

database/
  migrations/      NNN_name.sql, sequential, immutable, with --ROLLBACK comment block
  seeds/           Reference data (immutable; locked via REVOKE after seeding)
  triggers/        One trigger function per file
  rls/             One file per role-table policy bundle

scripts/           Migration runner, LGD importer, RLS test harness
```

## Provider abstractions

External services that aren't yet provisioned are stubbed with **local providers** that satisfy the same contract:

| Service | Local provider | Live / planned provider | Activates when |
|---------|----------------|---------------|----------------|
| Encryption | AES-256-GCM with env keys (kept in Azure Key Vault, injected as App Service settings) | An Azure Key Vault crypto provider that wraps the key material — future work | `ENCRYPTION_PROVIDER=local` today (only option); a future `azure-kv` value will swap |
| File storage | Local disk under `LOCAL_STORAGE_DIR` | Azure Blob Storage provider — future work | `STORAGE_PROVIDER=local` today; a future `azure-blob` value will swap |
| Notifications | JSON files in `LOCAL_OUTBOX_DIR` | **`whatsapp_cloud` = Meta WhatsApp Business Cloud API direct** (live primary) · `msg91` (SMS / voice fallback — stubbed pending DLT) | `NOTIFICATIONS_PROVIDER=whatsapp_cloud` (live) / `msg91` (fallback) |
| Mail | Console / file outbox | Google Workspace API | `MAIL_PROVIDER=workspace` |

The Master Prompt §1.3 originally specified AWS KMS and AWS S3 for the real-provider column; the May 2026 Azure pivot replaces both with Azure-native equivalents listed above. Implementation of the Azure-native crypto + storage providers is still future work — the `local` providers continue to run on Azure App Service unchanged.

When implementing new features, **always** call the abstraction (`require('../services/encryption')`), never call cloud-provider or notification-vendor SDKs directly from a route handler.

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

## Encryption policy (resolved 2026-05-01)

The spec's `// encrypted` comments on `CHAR` columns are misleading. Decision after design review:

**Hybrid encryption strategy.** Two distinct mechanisms apply to two distinct column-shape categories:

| Column shape | Examples | Mechanism |
|--------------|----------|-----------|
| Fixed-width identifiers (`CHAR(N)`) | `donors.mobile`, `donors.abha_id`, `donors.aadhaar_last4`, all `*_contact_mobile`, `*.guardian_mobile` | Storage-level: **Azure Database for PostgreSQL Flexible Server** encrypts the disk at rest (service-managed key; customer-managed via Azure Key Vault optional). Access enforced by RLS + column-level GRANTs. **Plaintext in the column.** (Spec originally said AWS RDS + KMS — superseded by the May 2026 Azure pivot.) |
| Free-text PII (`TEXT`) | `full_name`, `address_line`, `deferral_reason`, `recall_reason`, `donor_screening.*_method`, `donor_screening.notes`, `lookback_registry.hospital_response`, `outcome_notes`, `notification_log.template_variables` (where appropriate), all encrypted-method columns | Column-level: AES-256-GCM via `backend/src/services/encryption`. Ciphertext format `v1:<provider>:<keyKind>:<base64url>`. |

**Why CHAR columns can't be column-encrypted:**
- Lookup by mobile (OTP login, duplicate detection) needs equality match. AES-GCM uses random IVs → same plaintext yields different ciphertexts → no equality match.
- Length: ciphertext is much wider than the original 13/17 chars; widening to `TEXT` would cascade through the entire schema.

**Why two encryption keys (per spec §1.3, adapted for Azure):**
- `LOCAL_ENCRYPTION_KEY_HEX` (key kind `main`): encrypts general PII text fields (name, address, etc.)
- `LOCAL_SCREENING_ENCRYPTION_KEY_HEX` (key kind `screening`): encrypts TTI screening data only — every method/notes column on `donor_screening` and any field on `screening_audit_log` whose name implies sensitive content.
- Both key materials live in **Azure Key Vault** in prod and are injected as App Service settings (the spec's original AWS-KMS naming `KMS_MAIN_KEY_ARN` / `KMS_SCREENING_KEY_ARN` is superseded by the May 2026 Azure pivot; an Azure Key Vault crypto provider that wraps these keys with a KV-hosted KEK is future work).
- A compromised app server with main-key access cannot read screening data without separately compromising the screening key. The screening API endpoint is the only path that uses the screening provider; everything else must use main.

**What the API code must do:**
- Mobile / ABHA / aadhaar_last4 columns: store plaintext, lookups work.
- TEXT PII columns: pass through `encryption.encrypt(value, { keyKind: 'main' | 'screening' })` before INSERT/UPDATE; pass through `decrypt()` before returning to the client.
- Never log a plaintext or ciphertext PII value. The pino redact list in `backend/src/config/logger.js` already covers known-sensitive paths; extend it when adding fields.

**Hospital-facing API rule (spec §1.2):**
Hospital role NEVER sees donor mobile in API responses, even though it's plaintext in the DB. Mask in the API layer: `+91XXXXX1234` (last 4 only).



## Migration discipline

- One concept per migration. Do not bundle.
- Every migration ends with a commented-out `-- ROLLBACK` block describing how to revert.
- Tables created in earlier migrations may be referenced as foreign keys; the order in `database/migrations/` is the source of truth.
- After seeding immutable reference data (blood groups, components, compatibility matrix), the seed file ends with `REVOKE INSERT, UPDATE, DELETE … FROM app_user`.
- Triggers are defined in `database/triggers/<name>.sql` and `\i`-included from the migration that owns the table.

## Sensitive data handling

- Real secrets only ever live in `.env` (gitignored). Never in code, never in commits, never in logs (logger has redaction rules; extend them when you add new fields).
- Mobile numbers, full names, addresses, ABHA IDs, IP addresses, and TTI results are encrypted at rest. The encryption module returns ciphertext strings prefixed `v1:<provider>:<keyKind>:<payload>`.
- TTI / screening data uses the **separate** `screening` key kind, backed by a different encryption key in production (held in Azure Key Vault as `LOCAL_SCREENING_ENCRYPTION_KEY_HEX`).

## What "done" means for a phase

Each phase has explicit acceptance criteria in the Master Prompt. A phase is complete when:
- Every acceptance criterion ticks
- All migrations apply cleanly to a fresh Postgres 16 instance (dev: Neon; prod: `raktify-db` Flexible Server)
- Lint + format checks pass
- The relevant integration test or smoke test (per phase) passes
- The phase's RLS policies have been exercised by `scripts/test_rls.sql`
