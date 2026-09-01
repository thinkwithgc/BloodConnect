# Raktify — Production deployment runbook (Azure)

Raktify deploys to **Microsoft Azure**, region **Central India** (Pune — keeps data inside Maharashtra, satisfies data-residency expectations for an Indian health NGO).

> The application code was originally scaffolded against AWS provider names
> (`ENCRYPTION_PROVIDER=kms`, `STORAGE_PROVIDER=s3`). **On Azure those stay on
> the `local` provider** — see §6. The app runs unchanged; Azure-native crypto
> and blob-storage providers are future work, not a launch blocker.

## 0. One-time foundation

| Item | Value |
|---|---|
| Azure subscription | Choudhari EduHealth India Foundation (nonprofit — apply for [Azure for Nonprofits](https://www.microsoft.com/en-us/nonprofits) credits) |
| Resource group | `raktify-prod` |
| Region | `Central India` |
| Naming | `raktify-<resource>-prod` (e.g. `raktify-db-prod`) |

```sh
az group create --name raktify-prod --location centralindia
```

## 1. Database — Azure Database for PostgreSQL Flexible Server

| Setting | Value | Why |
|---|---|---|
| Engine | PostgreSQL 16 | Matches Neon dev — `gen_random_uuid()`, `CITEXT`, JSONB. |
| Tier / size | Burstable **B1ms** (1 vCore, 2 GB) at launch; **B2s** past ~500 donors | Cost-appropriate; scale vertically first. |
| High availability | **Zone-redundant HA enabled** | Life-critical — Azure's equivalent of Multi-AZ. Costs ~2×; no justification to skip. |
| Backups | 7–35 day retention, PITR on; geo-redundant if budget allows | |
| Encryption at rest | On by default (service-managed key); customer-managed key via Key Vault optional | Satisfies the CHAR-column "storage-level encryption" requirement in the encryption policy. |
| Networking | **Private access (VNet integration)** — only the App Service subnet reaches it | No public endpoint. |
| SSL | `require` — append `?sslmode=require` to `DATABASE_URL` | The `pg` pool already enables `rejectUnauthorized` when it sees `sslmode=`. |

```sh
az postgres flexible-server create \
  --resource-group raktify-prod --name raktify-db-prod \
  --location centralindia --tier Burstable --sku-name Standard_B1ms \
  --version 16 --storage-size 32 --high-availability ZoneRedundant \
  --backup-retention 14 --admin-user raktify_admin \
  --admin-password "$(openssl rand -base64 24)"
```

**First-time DB setup** (from a jumpbox in the VNet, or temporarily allow your IP):
1. Create the helper roles the schema expects:
   ```sql
   CREATE USER app_user      LOGIN PASSWORD '<rotated>';
   CREATE USER audit_writer  NOLOGIN;
   CREATE USER audit_reader  NOLOGIN;
   CREATE USER bb_writer     NOLOGIN;
   ```
2. `npm run migrate` against `DATABASE_URL` → verify with `npm run migrate:status` (every migration `applied`).
3. Seed reference data (`database/seeds/`) — the seed step self-revokes write grants on immutable clinical tables.
4. Run `scripts/test_rls.sql` — confirm every role sees only its permitted rows.

**Rollback:** PITR restore to the timestamp before a bad change. Migrations are immutable (CLAUDE.md hard rule §5) — never edit an applied migration; write a new one.

## 2. Backend — Azure App Service (Linux, Node 22)

| Setting | Value |
|---|---|
| Plan | Basic **B1** at launch; **P0v3/P1v3** Premium for autoscale + staging slots later |
| Runtime | Node 22 LTS, Linux |
| Startup command | `node backend/src/server.js` (or `npm --workspace backend start`) |
| Health check path | `/health` — App Service recycles the instance if it fails |
| Always On | Enabled |
| VNet integration | Same VNet as the database |
| Logs | Azure Monitor / Log Analytics workspace |
| Deploy | GitHub Actions via the App Service Deployment Center, or `az webapp deploy` |

```sh
az appservice plan create -g raktify-prod -n raktify-plan --is-linux --sku B1
az webapp create -g raktify-prod -p raktify-plan -n raktify-api-prod \
  --runtime "NODE:22-lts"
az webapp config set -g raktify-prod -n raktify-api-prod \
  --startup-file "node backend/src/server.js"
az webapp config set -g raktify-prod -n raktify-api-prod \
  --generic-configurations '{"healthCheckPath": "/health"}'
```

**App settings** (env vars — set via portal, `az webapp config appsettings set`, or Key Vault references):
```
NODE_ENV=production
PORT=8080                       # App Service Linux expects the app on $PORT
FRONTEND_URL=https://raktify.choudhari.ngo
ALLOWED_ORIGINS=https://raktify.choudhari.ngo
DATABASE_URL=@Microsoft.KeyVault(SecretUri=https://raktify-kv.vault.azure.net/secrets/database-url/)
JWT_SECRET=@Microsoft.KeyVault(SecretUri=.../secrets/jwt-secret/)
JWT_EXPIRES_IN=8h
ENCRYPTION_PROVIDER=local
LOCAL_ENCRYPTION_KEY_HEX=@Microsoft.KeyVault(.../secrets/enc-key/)
LOCAL_SCREENING_ENCRYPTION_KEY_HEX=@Microsoft.KeyVault(.../secrets/screening-key/)
NOTIFICATIONS_PROVIDER=whatsapp_cloud   # primary live channel; 'console' for dev, 'msg91' for the SMS path
STORAGE_PROVIDER=local
MAIL_PROVIDER=console
SCHEDULER_ENABLED=true
OTP_ECHO=false                          # NEVER true in prod — echoes OTP in API response for staging demos

# WhatsApp Business Cloud API (Meta-direct — no BSP, no India DLT).
# Required when NOTIFICATIONS_PROVIDER=whatsapp_cloud.
WHATSAPP_PHONE_NUMBER_ID=@Microsoft.KeyVault(.../secrets/wa-phone-number-id/)
WHATSAPP_ACCESS_TOKEN=@Microsoft.KeyVault(.../secrets/wa-access-token/)
WHATSAPP_WABA_ID=@Microsoft.KeyVault(.../secrets/wa-waba-id/)
WHATSAPP_WEBHOOK_VERIFY_TOKEN=@Microsoft.KeyVault(.../secrets/wa-webhook-verify/)
WHATSAPP_APP_SECRET=@Microsoft.KeyVault(.../secrets/wa-app-secret/)   # verifies X-Hub-Signature-256 on inbound webhooks
WHATSAPP_API_VERSION=v21.0
# Template names, one env var per templateType. The full keyed map lives in
# backend/src/config/env.js (env.whatsapp.templates) and the approved copy in
# docs/Raktify_WhatsApp_Templates.md. An UNSET var is not a crash: the provider
# logs a warning, returns success:false and still files the notification_log row
# as FA -- so a missing key looks exactly like a delivery failure. Set every one
# a deployed code path can reach.
WHATSAPP_TEMPLATE_OTP=donor_otp
WHATSAPP_TEMPLATE_EMERGENCY=donor_alert_critical
WHATSAPP_TEMPLATE_REMINDER=camp_reminder
WHATSAPP_TEMPLATE_SETUP_LINK=institution_activation_link
WHATSAPP_TEMPLATE_COMMUNITY_LEADER_SIGNIN=community_leader_signin
WHATSAPP_TEMPLATE_CAMP_LINK=camp_organizer_link_v2
# V2 donor-alert-gate batch. Submitted; check approval through the Graph API,
# not the Business Manager UI.
WHATSAPP_TEMPLATE_DONOR_ALERT_BB=donor_alert_bb_routed
WHATSAPP_TEMPLATE_DONOR_ALERT_COMMUNITY=donor_alert_community_first
WHATSAPP_TEMPLATE_DONOR_ALERT_REPLACE=donor_alert_replacement
WHATSAPP_TEMPLATE_BB_DONOR_INCOMING=bb_donor_incoming
WHATSAPP_TEMPLATE_COORD_PREFIRE_WARN=coord_prefire_warning
WHATSAPP_TEMPLATE_COORD_CRITICAL_NEW=coord_critical_new
WHATSAPP_TEMPLATE_COMMUNITY_LEADER_MOBILISE=community_leader_mobilise
# V3 batch -- camp lifecycle + blood-bank coordination. The first four back
# scheduler jobs that are ALREADY DEPLOYED and silently sending nothing until
# these are set.
WHATSAPP_TEMPLATE_CAMP_PRECHECK_2D=camp_precheck_2d
# CAMP_DAY_OF: v1 is APPROVED but Meta filed it MARKETING, so it is frequency-
# capped per user and a capped donor silently gets no day-of reminder. Flip this
# to camp_day_of_v2 (same 4 vars, Utility-tuned copy) once Meta approves v2;
# leave it on camp_day_of until then so the capped record keeps delivering.
WHATSAPP_TEMPLATE_CAMP_DAY_OF=camp_day_of
WHATSAPP_TEMPLATE_CAMP_DONOR_THANKYOU=camp_donor_thankyou
WHATSAPP_TEMPLATE_CAMP_ANNC=camp_announcement
WHATSAPP_TEMPLATE_DONOR_CONSENT_INVITE=donor_consent_invite
WHATSAPP_TEMPLATE_CAMP_BB_REQUEST=camp_bb_request
WHATSAPP_TEMPLATE_CAMP_BB_ACCEPTED=camp_bb_accepted
WHATSAPP_TEMPLATE_CAMP_BB_CHANGED=camp_bb_changed
# Legacy / dormant, nothing in the running app reaches these. Leave unset.
#   WHATSAPP_TEMPLATE_THANKYOU            no such approved template; camp thank-you
#                                         is CAMP_DONOR_THANKYOU above
#   WHATSAPP_TEMPLATE_CRED=mou_esign_link eSign removed from onboarding Aug 2026
#   WHATSAPP_TEMPLATE_COMMUNITY_LEADER_WELCOME   re-classified MARKETING by Meta;
#                                         superseded by COMMUNITY_LEADER_SIGNIN
```
> **Note:** `server.js` reads `env.port` from `PORT`. App Service Linux injects
> `PORT` (commonly 8080) — the app already honours it.
>
> **WhatsApp delivery prerequisites (Meta-side, not code):** the WABA needs a
> **payment method on file** before any business-initiated template delivers (the
> Graph API returns `accepted` + a `wamid` but Meta silently drops delivery until
> billing is set), and until the WABA matures, sends only reach **allow-listed
> test recipients** (≤5). Business Verification is done (21 May 2026). Set the
> access token to a **System User long-lived token**, not a temporary one — temp
> tokens expire in 24 h. The webhook callback URL in the Meta App dashboard must
> point at `https://api.raktify.choudhari.ngo/webhooks/whatsapp/incoming` with the
> verify token above.

### 2.1 Staging deployment (current reality — May 2026)

Staging is **already live** and differs from the prod recipe above:

| Concern | Staging today (May 2026) | Prod target (this doc) |
|---|---|---|
| Backend | `raktify-api-staging` App Service B1 (Central India) | `raktify-api-prod` (same SKU is fine through Q3 2026 per load forecast) |
| Frontend | Azure Static Web Apps `raktify.choudhari.ngo` (free tier) | `raktify-web-prod` |
| Database | **Azure Database for PostgreSQL Flexible Server `raktify-db-staging` (Standard_B1ms, 1 vCore, 2 GB, 32 GB storage, Central India)** — currently on the 12-month Azure free-tier benefit (Free up to 750 hr/mo); ~₹1,800/mo after the benefit expires. Neon is reserved for **local-laptop demo environments** (see §2.2). | Same SKU at launch; bump to `B2s` past ~500 active donors. |
| Deploy trigger | **push to `main`** fires both GitHub Actions automatically | same |

- Workflows: `.github/workflows/main_raktify-api-staging.yml` (backend) and
  `.github/workflows/azure-static-web-apps-jolly-bay-08008c700.yml` (frontend).
  Both trigger **only on push to `main`**. `VITE_API_URL` is baked into the Vite
  build at deploy time (set in the SWA workflow env).
- The working pattern in the Claude worktree is `git push origin <local-branch>:main`
  (fast-forward) — one push fans out to both deploys, frontend in ~2 min, backend
  in ~3–5 min.
- **Migrations + seed are NOT in the workflow.** Run them manually against the
  staging `DATABASE_URL`: `npm run migrate` then (optionally) `node scripts/seed_demo.js --reset`.
- **Azure free-trial credit (~₹18,900) expires 17 Jun 2026; the subscription
  auto-deletes 17 Jul 2026** unless upgraded to Pay-As-You-Go. Steady-state
  monthly bill at projected load (4-5 hospitals, 10 blood banks, 2000 donors,
  5-8 camps/quarter): **~₹3,000/mo** (App Service B1 ~₹1,100 + Azure Postgres
  B1ms ~₹1,800 after the 12-month free benefit + WhatsApp Cloud ~₹150 + Static
  Web Apps + Key Vault = ₹0). Set a Cost Management budget alert at ₹100/mo
  pre-cutover, then raise to ~₹3,500/mo once prod is live.

### 2.2 Demo environment (Neon branch + local backend, ₹0/mo)

For all post-cutover prospect demos: **don't deploy a second Azure environment.**
Run the backend locally on the demo laptop against a Neon branch. Cost: zero.

**Existing setup (already done, 2026-05-26):**

- Neon project: **`raktify-demo`** (region: `ap-southeast-1` Singapore — closest
  free region; ~50 ms latency to India is fine for demos)
- Branch: **`production`** (Neon's default branch name; do not confuse with our
  Azure production environment. Rename in the Neon console to `demo` if you
  want avoid the naming collision.)
- Database: `neondb`, role `neondb_owner`
- Schema: all 46 migrations applied, reference data seeded (8 blood groups, 6
  components, 225 compatibility-matrix rows)
- Demo dataset already seeded: 30 donors · 61 donations · 24 requests · 5
  camps · 6 thalassemia patients · 3 rare-blood entries · 2 lookback cases ·
  6 institutions · 38 platform_users
- `.env.demo.example` is committed at the repo root — copy to `.env.demo`
  and fill in the real `DATABASE_URL` from the Neon console
  (Project → Connection details → Copy snippet). **Never commit `.env.demo`** —
  it is gitignored.

**Neon-specific note:** Neon doesn't grant `neondb_owner` superuser, so the
seed's `SET session_replication_role = replica` calls fail with `42501`.
`scripts/seed_demo.js` detects this and falls back to per-table
`ALTER TABLE … DISABLE TRIGGER USER` (owner privilege is sufficient on owned
tables). Same effect, no manual workaround needed.

**One-time setup checklist (if rebuilding from scratch on a new Neon project):**

1. Create a free Neon project at `console.neon.tech`.
2. Apply the schema:
   ```sh
   DATABASE_URL="<neon-url>" npm run migrate
   ```
3. Seed reference data (blood_groups + components + compatibility_matrix):
   ```sh
   DATABASE_URL="<neon-url>" node -e "const fs=require('fs');const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true}});(async()=>{const c=await p.connect();for(const f of ['database/seeds/002a_seed_blood_groups.sql','database/seeds/002b_seed_blood_components_DRAFT_PENDING_REVIEW.sql','database/seeds/002c_seed_compatibility_matrix_DRAFT_PENDING_REVIEW.sql']){await c.query(fs.readFileSync(f,'utf8'));}await c.release();await p.end();})()"
   ```
4. Seed the demo dataset:
   ```sh
   DATABASE_URL="<neon-url>" node scripts/seed_demo.js
   ```
5. Copy `.env.demo.example` → `.env.demo` and fill in the real `DATABASE_URL`.

**Per-demo (5 minutes before the meeting):**

```sh
# Refresh demo data (the seed is idempotent; --reset wipes + re-seeds)
DATABASE_URL="<neon-demo-url>?sslmode=require" node scripts/seed_demo.js --reset

# Start backend + frontend against the demo DB
cp .env.demo .env                # OR `dotenv -e .env.demo …` if you prefer not to swap
npm run dev:backend              # → http://localhost:3000/health
npm run dev:frontend             # → http://localhost:5173
```

**Per-prospect option:** Neon supports free branches. Click **Branches → Create
branch** in the Neon console to clone the demo state into a per-prospect branch
(e.g. `demo-irwin-hospital`) — useful if you want to leave a demo URL with the
prospect for a few days. Delete the branch when done; branches are free.

**Why this works:** hospital and blood-bank demos happen on a laptop in their
office anyway. Running the backend locally against Neon is indistinguishable
from running it against Azure — same code, same DB engine, same UX. The only
visible difference is the URL bar shows `localhost`, which prospects don't see
when you're driving the demo on your screen.

### 2.3 Staging → production cutover runbook

The current `raktify-api-staging` App Service + `raktify-db-staging` Postgres
will become the production environment. The Azure infra stays — only the data
+ env flags + outbound notification behaviour change. Total cutover time:
~30 minutes if all steps run cleanly.

**Pre-cutover (do 24 h before):**

1. **Take a manual point-in-time backup of `raktify-db-staging`** via the
   Azure Portal (Postgres Flexible Server → Backup and restore → Create
   manual backup). Keep it for 7 days. This is the rollback safety net.
2. **Confirm the WhatsApp Cloud payment method is on file** on the WABA
   (Meta Business Suite → WhatsApp Manager → Account tools → Payment
   methods). Without this, OTP / alert templates return `accepted` but Meta
   silently drops delivery. (See §2 env-vars note.)
3. **Confirm Business Verification status = Verified** (it was approved
   21 May 2026 — should still be active).
4. **Add the first onboarding hospital's WhatsApp contact number to the
   WABA allow-list** (WhatsApp Manager → Phone numbers → click the
   registered number → Manage phone number list). Until WABA maturity
   lifts the test-mode cap, only allow-listed numbers will receive messages.

**Cutover (30 min):**

```sh
# 0. Pre-flight: dry-run the wipe to see what will be deleted.
DATABASE_URL="$STAGING_AZURE_PG_URL" node scripts/wipe_demo.js
#   → prints demo-marker row counts + reference-data counts. Sanity-check
#     the numbers match what seed_demo.js created (~30 donors, 4
#     institutions, ~30 requests, 5 camps, etc.). Reference-data counts
#     must look populated (blood_groups: 8, blood_components: ~6, etc.).

# 1. Run the actual wipe. Inside a single transaction; rolls back on error.
DATABASE_URL="$STAGING_AZURE_PG_URL" node scripts/wipe_demo.js --confirm
#   → expected output: all demo counts AFTER = 0; reference-data counts
#     unchanged BEFORE → AFTER; final "✓ Wipe complete." line.

# 2. Flip env on the App Service. From the Azure Portal:
#    App Services → raktify-api-staging → Settings → Configuration
#    Application settings:
#      OTP_ECHO=false                            # was true
#      NOTIFICATIONS_PROVIDER=whatsapp_cloud     # confirm (was already this)
#    Click Save → App Service auto-restarts (~30 s).

# 3. Verify health:
curl https://raktify-api-staging-hsdxfzhrg5a7ekes.centralindia-01.azurewebsites.net/health
#   → {"status":"ok",…}

# 4. Hit the public landing + sign in to /admin as the super_admin. Confirm:
#    • Donors tab: empty
#    • Coordinators tab: empty
#    • Camps tab: empty
#    • Inventory: empty
#    • Requests: empty
#    • Reference data still works (blood-group dropdown shows 8 groups,
#      district picker shows Maharashtra + Amravati, etc.)
```

**Post-cutover (same day):**

5. **Issue the first NGO super_admin** if not already provisioned. Use
   `npm run create:admin` or insert directly:
   ```sql
   INSERT INTO platform_users (role, email, password_hash, password_set_at)
   VALUES ('super_admin', 'admin@choudhari.ngo', crypt('<bootstrap-pwd>', gen_salt('bf', 12)), NOW());
   ```
   First login forces TOTP enrolment.

6. **Onboard the first real hospital/blood bank** via either path:
   - **Admin-driven:** super_admin → `/admin` → Onboarding tab → Add new
     institution → fill Schedule 1 → triggers Leegality Aadhaar eSign request
     to the institution's authorised signatory mobile.
   - **Self-apply:** institution staff → `/onboarding/apply` → submits
     application → super_admin reviews in `/admin` → verifies → MoU
     eSign → credentials auto-provisioned and delivered via WhatsApp Cloud
     template (`mou_esign_link`).

7. **Update the docs** (small follow-up):
   - CLAUDE.md staging-row label → "production"
   - `OTP_ECHO` reference → note staging now defaults `false`
   - Add a "Production live since YYYY-MM-DD" line to README.md

**Rollback (only if something goes badly wrong in the first 24 h):**

The Azure Postgres manual backup from step "Pre-cutover 1" can be restored to
a new server (`raktify-db-staging-rollback`), and the App Service's
`DATABASE_URL` flipped to point at it. Demo data comes back instantly. Do this
ONLY if no real institution has been onboarded yet — once real data exists,
the restore would wipe it.

**What this cutover does NOT change:**

- The App Service URL stays `raktify-api-staging-*.azurewebsites.net` (renaming
  the Azure resource would require touching the GitHub Actions workflow file
  and the SWA's `VITE_API_URL`. Worth doing for cleanliness; not urgent).
- The Postgres server keeps its `raktify-db-staging` name. Same reasoning.
- The frontend domain `raktify.choudhari.ngo` is already production-grade —
  no changes.
- Code is identical — no deploy needed for cutover, just env-var changes
  + a DB wipe.

### 2.4 First-week-of-production guardrails

For the first 7 days after cutover, before donor volume builds:

- **Daily**: check Azure Monitor for unexpected error rates; check the audit
  log integrity (`/admin/audit/integrity`) once you have the `audit_reader`
  grant applied (see deferred items in CLAUDE.md).
- **Per onboarded institution**: keep its primary WhatsApp number on the WABA
  allow-list until the WABA test-mode cap lifts (typically auto-graduates
  ~30 days after Business Verification with consistent sending; expected to
  clear by **late June 2026**).
- **Set the Azure Cost Management budget** to ₹3,500/month with email alert
  at 80% — catches any surprise costs (unintended Postgres scale-up,
  bandwidth spike) before the bill arrives.
- **Snapshot the production DB nightly for the first month** via the Portal
  (Postgres Flexible Server's automatic backups already do PITR up to 7 days;
  this is for extra peace of mind during ramp-up).

## 3. Frontend — Azure Static Web Apps

The Vite build is a static bundle with a precached service worker — Static Web Apps is the ideal host (global CDN, free SSL, SPA routing, custom domains).

```sh
az staticwebapp create -g raktify-prod -n raktify-web-prod \
  --location centralindia --sku Standard
```

- **Build config** (GitHub Actions, auto-generated by Static Web Apps):
  - App location: `frontend`
  - Output location: `dist`
  - Build command: `npm run build`
- **Production env:** set `VITE_API_URL=https://api.raktify.choudhari.ngo` as a build-time variable so the SPA calls the API origin directly (CORS on the backend allows it).
- **SPA fallback + cache headers:** `frontend/staticwebapp.config.json` (committed) routes unknown paths to `index.html` and sets cache headers per asset type.

## 4. Secrets — Azure Key Vault

```sh
az keyvault create -g raktify-prod -n raktify-kv --location centralindia
az keyvault secret set --vault-name raktify-kv --name jwt-secret \
  --value "$(openssl rand -hex 64)"
az keyvault secret set --vault-name raktify-kv --name enc-key \
  --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name raktify-kv --name screening-key \
  --value "$(openssl rand -hex 32)"
# database-url, msg91-auth-key, leegality-auth-token, leegality-private-salt … set the same way
```
Grant the App Service's **system-assigned managed identity** `get` on Key Vault secrets so the `@Microsoft.KeyVault(...)` references resolve. Never commit a real `.env`.

## 5. Custom domains & DNS

On the `choudhari.ngo` DNS zone:

| Host | Type | Target |
|---|---|---|
| `raktify.choudhari.ngo` | CNAME | the Static Web App default hostname |
| `api.raktify.choudhari.ngo` | CNAME | the App Service default hostname |

Add each as a custom domain in the respective Azure resource; Azure issues managed TLS certificates for both. `theme-color` and the PWA manifest already carry the Raktify brand.

## 6. Provider-abstraction reality on Azure

| Concern | Launch state | Future work |
|---|---|---|
| Encryption | `ENCRYPTION_PROVIDER=local` — AES-256-GCM, key material held in Key Vault and injected as an app setting. Data is encrypted; you just don't get cloud-managed key rotation. | An Azure Key Vault crypto provider in `services/encryption`. |
| File storage | `STORAGE_PROVIDER=local` — disk on the App Service. Fine for low document volume at launch; not durable across scale-out. | An Azure Blob Storage provider in `services/storage`. |
| Notifications | **`whatsapp_cloud`** is the primary live channel (Meta-direct Cloud API — no BSP, no DLT). `console` for dev/CI; `msg91` is the stubbed SMS path. | Wire MSG91 SMS as the WA→SM→CA fallback chain once DLT registration lands. |
| DB at-rest encryption | Provided by Azure PostgreSQL Flexible Server automatically. | Customer-managed key via Key Vault (optional). |

## 7. Monitoring & alerting

- **Application Insights** — create a resource, set `APPLICATIONINSIGHTS_CONNECTION_STRING` as an app setting. Wire `applicationinsights` in `server.js` (future small task) or use App Service auto-instrumentation.
- **Azure Monitor alerts:** CPU > 80%, memory > 85%, HTTP 5xx spike, DB connections > 80% of max → action group emailing `ops@choudhari.ngo`.
- **Availability test:** Application Insights URL ping test on `/health` every 5 min from multiple regions.
- **Log retention:** Log Analytics workspace, 90 days.

## 8. Security-hardening verification (already in code — verify in prod)

- [ ] `helmet` headers — `curl -I https://api.raktify.choudhari.ngo/health` shows `Content-Security-Policy: default-src 'none'`.
- [ ] CORS — a non-whitelisted origin is rejected (`origin_not_allowed`).
- [ ] Global rate limit — 101 req/IP/min → `429 rate_limit_global`.
- [ ] OTP / login per-route limits fire.
- [ ] `sanitizeInput` strips control chars + script bookends.
- [ ] `npm run lint` passes — the `no-restricted-syntax` rule blocks template-literal SQL.
- [ ] `app_user` cannot UPDATE/DELETE `audit_log`; `/admin/audit/integrity` returns `ok: true`.
- [ ] No secrets committed — Key Vault holds everything sensitive.

## 9. Go-live checklist (excerpt)

The Master Prompt has the full list. Launch blockers:

1. All migrations apply cleanly to a fresh prod DB; `migrate:status` all `applied`.
2. Reference data seeded; compatibility matrix promoted out of `_DRAFT_PENDING_REVIEW` only after haematologist sign-off.
3. RLS smoke (`scripts/test_rls.sql`) green per role.
4. Audit hash chain verified over a 100-row sample.
5. WhatsApp Cloud API: payment method on the WABA, templates approved (donor_otp +
   donor_alert_critical + camp_reminder + camp_organizer_link + mou_esign_link),
   webhook verified, System-User long-lived token in Key Vault, WhatsApp bot tested
   MR/HI/EN. (MSG91 DLT is only needed for the SMS fallback, not launch.)
6. OTP, TOTP, Leegality eSign tested in staging.
7. Scheduled jobs registered (`SCHEDULER_ENABLED=true`).
8. Lookback protocol tested end-to-end (reactive TTI → deferral → recall → lookback rows).
9. Offline emergency fallback sheet delivered to partner hospitals + blood banks.
