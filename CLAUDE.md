# Claude / coding-agent instructions

This is a **life-critical** healthcare system. Read this whole file before touching code.

> **Product name:** the platform is **Raktify**. The Postgres GUC namespace is
> `raktify.*` (e.g. `raktify.actor_role`); the Tailwind/CSS design-system prefix
> is `rk-*` / `.rk-*`. Use these consistently — no other brand prefix exists.

## Where things stand (updated 2026-09-08) — READ THIS FIRST

This section is the resume point: branch state, schema head, the gates, what is
live, and what is genuinely blocked. Trust it over any older section it
contradicts. Post-mortem *reasoning* is deliberately not here — the **Lessons
index** below carries one invariant per lesson and points at the full write-up.

**Branch / deploy.** Working branch `feat/paper-mou-onboarding`; deploy is
`git -c credential.helper='!gh auth git-credential' push origin feat/paper-mou-onboarding:main`
(fast-forward → fans out to CI + `raktify-api` + `raktify-web` **and
auto-applies migrations to prod**). **`git log origin/main..HEAD` is the truth
about what is unshipped** — when it is empty, every commit is in prod, whatever
any paragraph in this file says. `git log --oneline -30` for the history; the ten
most recent, and what each one bought:

| Commit | What |
|---|---|
| `0efa2f1` | The **host institution's own name on the printed QR sheets** — a hospital lending a corridor wall should read as the owner of the sheet. Blank field prints the old sheet exactly; a long name shrinks itself, never the 130mm code |
| `a11192b` | **Staff pick their OWN username at setup** — activation and invitation are one seam. A failed rename must not burn the token, which holds only because those routes run with no open transaction |
| `2a969a4` | The **downloaded poster carries a QR** — an image has no hyperlink, so a forwarded card had no path to RSVP. `?poster=1` is one boolean on the same renderer, composite cache key |
| `7d1def8` | `/c/*` joins the service-worker **navigation-fallback denylist** — a returning handset was running an older build's shell and never reached the function |
| `c2362a4` | A shared camp URL **previews as the camp card**: per-route CORP override, 3-channel PNG, no blank band. None of the three defects was the renderer |
| `61f1d37` | The organiser can **download the share poster**, and it **is** the OG card — a download affordance over bytes the API already renders, not a second renderer |
| `8fb380e` | **Per-camp WhatsApp link previews** (SWA managed function + server-rendered PNG), the **logo resize moves to the server**, and the one-line `api_location` fix no gate here can catch |
| `a710cab` | An uploaded organiser logo came out **black** — three passes before it held; the cause was **Firefox blocking canvas readback**, not the encoder |
| `420a84d` | An NGO admin can **hard-delete** an untouched camp, recoverable only because `fn_audit_row` files the whole row as JSON into the INSERT-only ledger |
| `e42b32b` | **English is the default WhatsApp language** (migration **320**); Marathi is a choice, and existing rows are deliberately not backfilled |

**Schema head.** **99 migration files, latest `320_default_language_english`;
the next new migration is `321`.** Everything `≤320` is immutable (hard rule 5).
319 and 320 are both applied in prod and `/health` answers 200 `db: ok`.
**`npm run migrate:status` is the source of truth — the numbered table in
`docs/Raktify_Phase_History.md` is incomplete.**

**Gates, with their real assertion counts** (the phase table in
**`docs/Raktify_Phase_History.md`** understates two of them):

| Command | Count | Notes |
|---|---|---|
| `npm run smoke:camps` | **156** | The camp gate. Attendance derivation + capacity + `bb_response` + the PII scoping + the branding approval gate + the hard-delete guards + the per-camp OG card. **TWO assertions are dev-state-dependent — see below** |
| `node scripts/smoke_test_phase4.js` | 17 | **Required regression** for anything touching `donation_history` / `donor_screening` |
| `node scripts/smoke_test_phase2.js` | **186** | Institution onboarding / paper MoU / staff-login editing / the two-404 split / the portal's own-name banner |
| `node scripts/check_whatsapp_templates.js` | 0 fail, 1 warn | Every `templateType` in `backend/src` must have a handler **and** an env key |
| `npm run lint && npm run format:check` | — | `format:check` is a hard CI gate in all three workflows, **backend only** |
| `npm run smoke:frontend` | — | Vite build. Frontend has no ESLint config, so this is its only gate. **Run from the repo root** |
| `node scripts/smoke_test_phase3/5/6.js` | — | **Do not run.** Pre-268 staff-auth drift; they fail for unrelated reasons |

**`smoke:camps` reports 154/2 on a well-used Neon dev DB, and NEITHER failure is a
regression.** Both are the same shape — a freshly-seeded row sorts off the end of a
`LIMIT`ed list because the dev district is full of previous smoke runs — and both are
**also real product drift**: the truncation is silent, with no search and no total in
either payload. Measured on Neon dev 2026-09-03:

| Failing assertion | The LIMIT | Dev state |
|---|---|---|
| *"the public picker needs NO token and lists active onboarded BBs"* | `GET /camps/blood-bank-options`, `ORDER BY i.display_name LIMIT 25` | district 501 holds **72** active onboarded BBs, so the 2 just-seeded ones sort off the page |
| *"the partnered blood bank sees the camp in its collectable list"* | `GET /camps/collectable`, `ABS(scheduled_date - $1) <= 2`, `ORDER BY ABS(diff) ASC, scheduled_date DESC LIMIT 20` | **46** camps in the ±2-day window, **38 of them on offset 1** — the exact day the fixture uses |

**The collectable one is INTERMITTENT, and the tie is why.** Those 38 offset-1 camps
tie on **both** ORDER BY keys, so Postgres returns them in arbitrary order and whether
the fixture lands in the first 20 is a coin flip — identical code passes some runs and
fails others. Do not read a flip as a regression, and **do not chase it by re-running
until it passes**: count first. Both counts only grow with each smoke run, so both lines
drift **toward** failing, never away. `smoke:camps` is **not in CI**, so this misleads a
developer at the terminal but can never flake a deploy. Both LIMITs are logged,
deliberately not fixed.

```sql
-- collectable competitors (LIMIT 20)
SELECT ABS(scheduled_date - CURRENT_DATE) AS off, COUNT(*) FROM donation_camps
 WHERE status IN ('PL','LV','CO') AND ABS(scheduled_date - CURRENT_DATE) <= 2
   AND district_id = 501 GROUP BY 1 ORDER BY 1;
-- picker competitors (LIMIT 25)
SELECT COUNT(*) FROM institutions
 WHERE kind='BB' AND is_active=TRUE AND onboarding_status='AC' AND district_id=501;
```

### Deploy skew: the SPA goes live ~1 minute before the API

One push, three workflows, and they do **not** land together — `raktify-web`
finishes in roughly 2m30s, `raktify-api` in roughly 3m30s. **Every release
therefore has a ~60–90 second window in which the new SPA is live against the old
API**, so a button shipped in that release calls a route prod does not have yet
and the user gets a 404 from the Express catch-all. That is exactly how the
staff-contact editor was reported broken on 2026-08-28: the record was fine, the
route was 65 seconds from existing, and it cost hours because the catch-all
answered the same bare `not_found` a dozen handlers use for a missing row.

**When a 404 is reported right after a deploy, suspect skew before reading any
handler.** `gh run list --branch main --limit 3` for the timings, then probe prod:

| Probe result | Means |
|---|---|
| `{"error":"missing_token"}` | The route **exists** (`verifyJWT` is per-route). Not skew |
| `{"error":"route_not_found"}` | The route is **not deployed yet**. Skew — tell the user to hard-reload |
| `{"error":"not_found"}` | A handler ran and could not find the **row** |
| `route_not_found` that answers `200` minutes later with **no redeploy** | The **App Service was restarting**. Re-probe once before concluding anything about stale code |

**Never give "endpoint missing" and "row missing" the same code again** —
`app.js`'s catch-all answers `route_not_found`, `institutionErrorText`
(`frontend/src/components/institution/ReasonDialog.jsx`) gives the three cases
three distinct sentences, and `smoke_test_phase2.js` section 22 asserts they
differ.

**Live in prod, code-complete, nothing outstanding:** everything in the phase
table in **`docs/Raktify_Phase_History.md`**, plus per-day BB camp capacity
publishing, per-camp `bb_response` accept/decline, the BB **Camps** tab (calendar
/ requests / brief), the post-camp results worklist, the
`GET /camps/:id/registrations` institution-scoping fix, `<DateOfBirthInput>` and
bounded native date inputs, the server-side logo resize, and per-camp OG. The
camp share path **has been exercised end-to-end in prod** (2026-09-03, camp
`annual-camp-v4x5u`, `status=PL`, `branding_status=AP`): `/c/<slug>` returns the
per-camp metas, the SWA function is provably in the path, and the card renders
with the organiser's own logo.

**Shipped in this push: self-chosen staff usernames.** The person **claiming** an
account picks their own username *and* password at the magic-link setup screen,
whether the row came from institution activation or from a team invitation. No
migration. It also closes a live role-guard defect on `POST /auth/setup/:token`.
**Not yet exercised by a real person** — the founder is re-issuing magic links to
existing users to walk it. See **Staff pick their OWN username at setup**.

**Blocked on other people, not on code:**
1. **MR / HI review for the four new camp templates** — the only Meta-side wait
   left on camps, and **it blocks nothing today**. All **24**
   `WHATSAPP_TEMPLATE_*` appsettings are populated on `raktify-api`, the four
   previously-absent camp templates are **APPROVED in `en`**, and every camp send
   site passes `language: 'en'` **explicitly** (`camps.js:1353`, `:2261`, `:2284`,
   `:2454`) — so the `en` approval *is* the whole requirement. The `mr` and `hi`
   records are submitted and PENDING purely as pre-positioning for whenever those
   call sites localise. See **WhatsApp template pipeline**.
2. **Legal review of the MoU template** — the last sign-off before onboarding
   institutions at scale. Medical sign-off is done (10-Jul-2026).
3. **Manual prod walk-through of the BB-capacity half of the camp lifecycle**,
   which has still never been exercised in prod: host against a full day (blocked,
   alternatives) and against an open day → accept in the BB tab and confirm the
   organiser's mobile appears only then → record two donations and enter TTI from
   the worklist without seeing a UUID → decline after NGO verify and confirm the
   admin sees the reason and the organiser sees the neutral line.

**Deferred by decision (not blocked):** institution-users Stage 2 (staff
capabilities) — starts at migration **321**; `BOT_REPLY` free-form
session-message path (6 sites in `services/whatsapp/bot.js`) — needs a
non-template send, not a template; plus the standing list in
**Post-Phase-8 deferred items** in `docs/Raktify_Phase_History.md`.

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

## Lessons index — one invariant each, full reasoning ON DEMAND

The post-mortems these lines compress live in
**`docs/Raktify_Engineering_Lessons.md`**; phase status and the migration-numbering
table live in **`docs/Raktify_Phase_History.md`**. Both were moved out of this file on
2026-09-08, because this file is loaded into *every* agent session and they are read
perhaps once each. **Anywhere in this file a `See **X**` pointer names one of the titles
below, it means that doc — not a section further down.** Read the invariant here first;
open the doc when you are about to touch the thing it guards.

- **[Marathi i18n — Host a camp + the BB portal](docs/Raktify_Engineering_Lessons.md#marathi-i18n--host-a-camp--the-bb-portal-shipped-2026-08-30-d657d8a)** — `useT()` reads a context (`i18n/LangProvider.jsx`), never per-call-site state; the packs `i18n/camps.js` / `i18n/bloodbank.js` spread into `strings.js` **first** so an existing literal wins a collision. **No Hindi keys, and English clinical terms, are DECISIONS — do not "complete" either.** Month names are pack arrays, never `Intl`.
- **[A blank page is a render throw, and nothing gates it](docs/Raktify_Engineering_Lessons.md#a-blank-page-is-a-render-throw-and-nothing-gates-it-fixed-2026-08-30-b422787)** — a blank SPA page is a **throw**, never a missing i18n key (`tFor` falls back silently and cannot crash). Every component calls `useT()` itself; `t` is never inherited from a sibling's scope. The frontend has **no ESLint config**, so verify with the throwaway `no-undef` pass, not the Vite build.
- **[OTP delivery failures are reported, not swallowed](docs/Raktify_Engineering_Lessons.md#otp-delivery-failures-are-reported-now-not-swallowed-shipped-2026-08-30-d5f518b)** — Meta has **no pre-check** for "is this number on WhatsApp", so a rejected send is the only signal: only recipient-side codes (`131026`, legacy `1013`) may mean `no_whatsapp`, `131050` means `opted_out`. **Never widen that set** to a transport or template code. Donor-facing OTP copy goes through `lib/otpError.js`, never the English-only `lib/errorMessage.js`.
- **[A staff portal never knows its own institution](docs/Raktify_Engineering_Lessons.md#a-staff-portal-never-knows-its-own-institution-shipped-2026-08-30-156eee0)** — self-identity is the session-addressed `GET /institutions/me`, declared **before `GET /:id`** or Express binds `id='me'` and Postgres throws `22P02`. It returns **identity only**, because it fires on every portal load. `institutions.kind` is `CHAR(2)` — `'HO'` / `'BB'`, never the long names.
- **[Camp branding — the organiser's own logo + tagline](docs/Raktify_Engineering_Lessons.md#camp-branding--the-organisers-own-logo--tagline-shipped-2026-09-01-19e3ee3)** — the logo is a `data:` URI, not a storage key (four reasons, all still true). `camp_branding_logo` is deliberately **unaudited** and deliberately has **no `id` column** — that absence is a tripwire, do not "fix" it. The public gate is expressed **in SQL** (`CASE WHEN branding_status = 'AP'`), and any organiser edit resets `branding_status` to `'PE'` in the same UPDATE.
- **[An uploaded camp logo came out BLACK](docs/Raktify_Engineering_Lessons.md#an-uploaded-camp-logo-came-out-black---and-the-fix-was-to-stop-using-the-canvas-2026-09-02)** (three passes) — the cause was **Firefox blocking canvas readback**, so an **optional client-side conversion must never be able to fail an upload**: the resize lives on the server (`services/images/logo.js`) and the client canvas is best-effort inside a bare `try/catch`. **TWO ceilings, never collapse them** — `LOGO_MAX_BYTES` is what is *stored*, `LOGO_UPLOAD_MAX_BYTES` is what is *accepted*.
- **[A camp link previewed the GENERIC card, and the share URL cannot move](docs/Raktify_Engineering_Lessons.md#a-camp-link-shared-on-whatsapp-previewed-the-generic-card-and-the-share-url-cannot-move)** — `https://raktify.choudhari.ngo/c/{{1}}` is baked into **nine APPROVED Meta template buttons**, so moving the share origin costs nine templates × three languages and orphans the printed QR posters. Per-camp OG must therefore be served **at the existing SWA origin**.
- **[Per-camp OG is a SWA managed function + a server-rendered PNG](docs/Raktify_Engineering_Lessons.md#per-camp-og-is-a-swa-managed-function--a-server-rendered-png-built-2026-09-03)** — `api_location` is **repository-root-relative** (`frontend/api`, never `"api"`, never `""`); a wrong value packages no function and **nothing fails anywhere**. `og.png` **never fails to return an image** — a crawler handed a 500 caches the absence for days. Font reachability is read from `GET /camps/public/og/selftest` on the **deployed** API; a local run on this Windows box proves nothing either way.
- **[The poster export IS the OG card](docs/Raktify_Engineering_Lessons.md#the-poster-export-is-the-og-card-so-there-is-no-second-renderer-2026-09-03)** (incl. the `?poster=1` variant) — the organiser's download and the crawler's preview are the **same bytes from the same route**, so they can never drift, and there is **no canvas anywhere near it**. `<a download>` is ignored for a cross-origin href (fetch → blob, revoke on a **timer**). `POSTER_STATUSES` must mirror the route's own visibility filter, and the poster flag needs a **composite** cache key or one variant is served to both audiences.
- **[A link-preview image is a CROSS-SITE subresource, and the card must be OPAQUE](docs/Raktify_Engineering_Lessons.md#a-link-preview-image-is-a-cross-site-subresource-and-the-card-must-be-opaque-2026-09-03-c2362a4)** — helmet's `Cross-Origin-Resource-Policy: same-site` is overridden **per-route only**, inside `og.png`'s own `serve()` helper; `grep` must keep finding `crossOriginResourcePolicy` at `app.js:69` and nowhere else. An OG PNG must be **3-channel**, and the flatten needs an explicit **raw intermediate** when there is a composite. `app-icon.png` / `social-avatar.png` keep alpha on purpose.
- **[A precached SPA shell is a shell from a DIFFERENT BUILD](docs/Raktify_Engineering_Lessons.md#a-precached-spa-shell-is-a-shell-from-a-different-build-2026-09-04)** — any path a **managed function rewrites** must be on Workbox's `navigateFallbackDenylist`, or a returning handset runs an older build's shell *and* never reaches the function. When a shipped element is missing on real devices and present in a private window, suspect the **service worker** before the CSS.
- **[Staff pick their OWN username at setup](docs/Raktify_Engineering_Lessons.md#staff-pick-their-own-username-at-setup-shipped-2026-09-08-a11192b)** — **shipped `a11192b`, no migration.** A failed rename must **not** burn the token — true only because the three public setup routes run on a bare pooled client with **no open transaction**; wrapping them in one silently breaks it. `RESERVED_NAMES` is **exact-match only** or every existing `*_admin` breaks. Refusals are **409 / 409 / 400, never 404 / 410**.
- **[A camp application told NOBODY it needed reviewing](docs/Raktify_Engineering_Lessons.md#a-camp-application-told-nobody-it-needed-reviewing-fixed-2026-09-01)** — `notifyCampReviewPending()` is **fire-and-forget, never awaited** (the organiser's 201 must not wait on Meta), and zero recipients logs `logger.warn` loudly. `on_duty` is deliberately not required; `ngo_admin`s are always included. `platform_users` has **no `is_active` column** — it uses `deactivated_at`. The blood bank's silence at apply is **correct**, not a second bug.
- **[A camp can be hard-deleted, and the audit ledger is what makes that safe](docs/Raktify_Engineering_Lessons.md#a-camp-can-be-hard-deleted-and-the-audit-ledger-is-what-makes-that-safe-shipped-2026-09-02)** — a hard `DELETE` is only ever acceptable on a table `099_attach_audit_triggers.sql` actually audits, because `fn_audit_row()` files **the whole row as JSON** plus the actor and the reason into the INSERT-only ledger. **Check that before allowing one anywhere else.** The `change_reason` is mandatory, and the **four guards must never be widened**.
- **[English is the default language, Marathi is a CHOICE](docs/Raktify_Engineering_Lessons.md#english-is-the-default-language-marathi-is-a-choice-shipped-2026-09-01-migration-320)** — `preferred_language` is the **WhatsApp** language, not the UI language, and a guessed `'mr'` becomes indistinguishable from a chosen one. Existing rows are deliberately **NOT backfilled**. The Marathi **UI** default and `DonorRegister`'s visible page-language pre-fill are separate decisions, left alone. Grep gate: `preferred_language || 'mr'` and `.default('mr')` must both return nothing in `backend/src`.
- **[WhatsApp template pipeline — current state](docs/Raktify_Engineering_Lessons.md#whatsapp-template-pipeline--current-state-aug-2026)** — three layers fail differently: Meta approval (per **name × language**), the template **name** (a plain App Service **appsetting**), and the Meta credentials (Key Vault, **shared by every template**). An unset `WHATSAPP_TEMPLATE_*` key therefore sends **nothing, silently**, while the `FA` row still persists and the job looks healthy. `node scripts/check_whatsapp_templates.js` is the gate, and it **cannot see prod**. A body may not **begin or end with a variable**; every URL button needs a **per-recipient** variable or Meta re-classifies it MARKETING. Chase state through the **Graph API**, never `submit_whatsapp_templates_v2.js`.
- **[V2 WhatsApp templates (July 2026)](docs/Raktify_Engineering_Lessons.md#v2-whatsapp-templates-july-2026--task-77--historical)** — historical record of the donor-alert-gate template set: which are wired to fire today, which have provider handlers still waiting on a caller.
- **[V2 WhatsApp delivery-status hardening](docs/Raktify_Engineering_Lessons.md#v2-whatsapp-delivery-status-hardening-july-2026--task-79)** — the delivery webhook captures `failure_reason` from Meta's `errors[]` and promotes only code `131050` to `'OP'`; the rest stay `FA` until there is data to widen.

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

## Phase history and migration numbering — MOVED

Phases 0–8 are all code-complete and live on Azure; so is everything in the
post-Phase-8 batch. The per-phase acceptance detail, the per-phase deferrable
lists, the Post-Phase-8 breakdown and the migration-numbering table now live in
**`docs/Raktify_Phase_History.md`** — relocated 2026-09-08 for the same reason as
the lessons above. Three things about it that matter more than the detail itself:

- **`npm run migrate:status` is the source of truth for migrations**, not that
  doc's table and not this file. The table is missing rows 267–309 entirely; it is
  kept for the trap notes it records, never as an inventory. Schema head is
  **320**; the next new migration is **321**.
- **Do not run `node scripts/smoke_test_phase3/5/6.js`** — pre-268 staff-auth
  drift, they fail for unrelated reasons. The gates that must pass are the ones in
  the table near the top of this file.
- The **Post-Phase-8 deferred items** list is in that doc. It is the standing
  backlog, and it is where a "why is this not built yet" question is answered.

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
