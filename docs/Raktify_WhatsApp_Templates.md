# Raktify — WhatsApp Message Templates

> Original 7 templates (§1–7 below) are already submitted to Meta. §8–14 are
> the **V2 batch** — 7 new templates for the donor-alert-gate architecture
> (BB routing, replacement obligation, community-first alerts, BB incoming
> panel, coord prefire warning + critical-new pings, community leader
> mobilise). All wired into the notification chokepoint at
> `backend/src/services/notifications/`. Approval is independent per template
> + per language; typical review time is 1–3 business days. **Submit each
> language variant separately** — they review in parallel.

---

## How to submit each template

1. Go to **WhatsApp Manager** → https://business.facebook.com/wa
2. Left sidebar → **Account tools** → **Message templates**
3. Click **`Create template`** (top-right).
4. **Category:** pick from the table below for each template.
5. **Language:** pick one. To submit the same template in multiple languages, repeat the create-template flow per language; they all share the same template *name*, just with different language tags.
6. **Header:** None (unless specified).
7. **Body:** paste exactly as shown. Use `{{1}}`, `{{2}}` etc. for variables — Meta will ask for sample values during submission.
8. **Footer:** paste exactly as shown (or "None" if blank).
9. **Buttons:** configure as shown.
10. Click **`Submit`**. Meta reviews and emails you the result.

**Naming convention:** Snake-case, descriptive. The backend
`sendNotification()` function references templates by exactly this name string,
so don't rename without updating `backend/src/services/notifications/`.

---

## Template 1 · `donor_otp`

| Field | Value |
|---|---|
| **Name** | `donor_otp` |
| **Category** | **Authentication** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | None *(footers not allowed on Authentication templates)* |

### Body (English)

```
*{{1}}* is your Raktify verification code. For your security, do not share this code with anyone.
```

### Body (Marathi)

```
*{{1}}* हा तुमचा Raktify पडताळणी कोड आहे. सुरक्षेसाठी हा कोड कोणाशीही शेअर करू नका.
```

### Body (Hindi)

```
*{{1}}* आपका Raktify सत्यापन कोड है। सुरक्षा के लिए, यह कोड किसी के साथ साझा न करें।
```

### Variables

- `{{1}}` — 6-digit OTP. Sample: `483921`

### Buttons

- **One button: Copy code**
  - Type: `Copy code`
  - Copy code text variable: `{{1}}` (same as body variable)
  - This auto-fills the OTP into the user's clipboard on tap.

### Fires when

- Donor login (`POST /auth/otp/send` with `role_hint=donor`)
- Donor registration step 4 (consent + OTP)
- Coordinator login

---

## Template 2 · `donor_alert_critical`

| Field | Value |
|---|---|
| **Name** | `donor_alert_critical` |
| **Category** | **Utility** |
| **Languages** | English, Marathi |
| **Header** | None |
| **Footer** | `An initiative of Choudhari Foundation · choudhari.ngo` |

### Body (English)

```
🩸 *Critical blood need*

Patient needs *{{1}}* ({{2}})
*{{3}} units* needed by *{{4}}*
District: *{{5}}*

Tap below to view and respond. Your donation could save a life.
```

### Body (Marathi)

```
🩸 *अत्यावश्यक रक्त गरज*

रुग्णाला *{{1}}* ({{2}}) रक्त हवे
*{{3}} युनिट* — *{{4}}* पर्यंत
जिल्हा: *{{5}}*

प्रतिसाद देण्यासाठी खाली टॅप करा. तुमचे दान एखाद्याचा जीव वाचवू शकते.
```

### Variables

- `{{1}}` — Blood group (e.g. `B-`)
- `{{2}}` — Component (e.g. `PRBC`)
- `{{3}}` — Units required (e.g. `2`)
- `{{4}}` — Needed-by datetime (e.g. `14:00 today`)
- `{{5}}` — District name (e.g. `Amravati`)

### Buttons

- **One button: Open Raktify**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/donor?alert={{1}}` *(Meta calls the dynamic part Variable 1 on the URL)*
  - Sample value for review: `https://raktify.choudhari.ngo/donor?alert=abc123`

### Fires when

- Matching engine activates donors for a critical-tier request when bank inventory is insufficient.

---

## Template 3 · `camp_reminder`

| Field | Value |
|---|---|
| **Name** | `camp_reminder` |
| **Category** | **Utility** *(opted-in roster, not marketing)* |
| **Languages** | English, Marathi |
| **Header** | None |
| **Footer** | `An initiative of Choudhari Foundation · choudhari.ngo` |

### Body (English)

```
Hi *{{1}}*,

Reminder: *{{2}}* on *{{3}}* at *{{4}}*.

{{5}}

See you there! 🩸
```

### Body (Marathi)

```
नमस्कार *{{1}}*,

स्मरण: *{{2}}* — *{{3}}* रोजी, *{{4}}* ठिकाणी.

{{5}}

तिथे भेटू! 🩸
```

### Variables

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Camp name (e.g. `Republic Day Donation Drive 2026`)
- `{{3}}` — Date (e.g. `26 January 2026, 09:00–16:00`)
- `{{4}}` — Venue (e.g. `Main Auditorium, SGBAU campus`)
- `{{5}}` — Custom message from organiser (e.g. `Bring govt ID. Light breakfast from 8am.`)

### Buttons

- **One button: Open camp page**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/c/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/c/republic-day-camp-amravati`

### Fires when

- Camp organiser broadcasts a message to the roster (`POST /camps/access/:token/broadcast`)
- Day-before automated reminder (post-launch automation)

---

## Template 4 · `camp_organizer_link`

| Field | Value |
|---|---|
| **Name** | `camp_organizer_link` |
| **Category** | **Utility** |
| **Languages** | English |
| **Header** | None |
| **Footer** | `An initiative of Choudhari Foundation · choudhari.ngo` |

### Body

```
Hi *{{1}}*,

Your camp *{{2}}* on *{{3}}* has been approved on Raktify. 🩸

Track RSVPs, broadcast updates, and mark attendance from your organiser dashboard. The link below is private — please don't share publicly.
```

### Variables

- `{{1}}` — Organiser name (e.g. `Dr. Rajesh Kulkarni`)
- `{{2}}` — Camp name (e.g. `Republic Day Donation Drive 2026`)
- `{{3}}` — Scheduled date (e.g. `26 January 2026`)

### Buttons

- **One button: Open organiser dashboard**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/camp/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/camp/LD5mQTKwK0KYdGnZguLcCgXHl6CYIjMh`

### Fires when

- NGO admin approves a public camp application (`POST /camps/:id/verify`). The magic-link token is delivered to the organiser's submitted mobile.

---

## Template 5 · `mou_esign_link`

| Field | Value |
|---|---|
| **Name** | `mou_esign_link` |
| **Category** | **Utility** |
| **Languages** | English |
| **Header** | None |
| **Footer** | `Choudhari EduHealth India Foundation · NGO-DARPAN MH/2025/0643345` |

### Body

```
Hi *{{1}}*,

Please review and sign the Raktify Memorandum of Understanding for *{{2}}*.

The eSign link below is valid until *{{3}}*. After signing, your institutional admin credentials will be sent to this number.
```

### Variables

- `{{1}}` — Signatory name (e.g. `Dr. S. Deshmukh`)
- `{{2}}` — Institution legal name (e.g. `Irwin Hospital Amravati`)
- `{{3}}` — Sign-link expiry (e.g. `28 May 2026, 17:00`)

### Buttons

- **One button: Sign MoU**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/onboarding/esign/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/onboarding/esign/abc123`

### Fires when

- NGO admin clicks "Send MoU for eSign" on a verified institution (`POST /onboarding/generate-mou/:id`).

---

## Template 6 · `institutional_credentials` — **DEPRECATED**

> **Status:** Rejected by Meta as Utility (temp passwords resemble OTP
> codes); rejected on principle too — sending plaintext passwords over a
> messaging channel is poor practice. Superseded by **Template 7
> `institutional_setup_link`** below, which sends a single-use
> password-setup URL instead. The legacy template definition is preserved
> here only for change-history reference; do NOT resubmit. The code path
> in `/onboarding/mou-signed` no longer references it.

Legacy body (for reference):
```
Welcome to Raktify, *{{1}}*! 🩸  Your admin login is ready.  *Email:* {{2}}  *Temporary password:* {{3}}  You'll be asked to change your password on first login.
```

---

## Template 7 · `institution_activation_link` *(replaces Template 6)*

> **Naming + framing notes:** the first iteration of this template was
> submitted as `institutional_setup_link` with a body that said "set your
> password". Meta's automated classifier flagged it as Authentication-flavoured
> ("password", "set" trigger the auth NLP) and rejected it. Authentication
> templates must deliver a numeric code, not a link — so resubmitting under
> that category doesn't fit either. The resolution is to **reframe as a
> standard account-activation Utility template** (drops the trigger words,
> matches a well-established Utility pattern across SaaS / e-commerce).
> Backend code keeps `templateType: 'SETUP_LINK'` (internal name) and the
> URL route keeps `/setup/:token` (with `/activate/:token` as a sibling
> route that renders the same component, so the Meta button URL can stay
> on `/activate/` without breaking older in-flight tokens).

| Field | Value |
|---|---|
| **Name** | `institution_activation_link` |
| **Category** | **Utility** |
| **Languages** | English (add MR/HI later if needed; institutional signatories tend to be English-comfortable) |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari EduHealth India Foundation` |

### Body

```
Hi *{{1}}*,

Welcome aboard! Your *{{2}}* account on Raktify is ready to activate. Tap below to complete account setup — takes about 30 seconds. 🩸

The activation link is private and expires in *{{3}}*. Please don't share or forward.
```

### Variables

- `{{1}}` — Signatory name (e.g. `Dr. S. Deshmukh`)
- `{{2}}` — Institution display name (e.g. `Irwin Hospital Amravati`)
- `{{3}}` — Expiry duration (e.g. `7 days`)

### Buttons

- **One button: Activate account**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/activate/{{1}}`
  - Sample value for review: `https://raktify.choudhari.ngo/activate/abc123XYZ-0_0-_0_0`

### Fires when

- eSign webhook fires (`POST /onboarding/mou-signed`) and provisions the
  institutional admin platform_user row. The handler generates a single-use,
  7-day-TTL setup token (see `services/users/setup.js`) and embeds it as the
  URL button variable. Recipient taps the link → lands on `/setup/<token>` →
  sets their own password → token is consumed → can log in normally.

### Security properties

- Token is 32-byte URL-safe random (~256 bits entropy)
- Only the SHA-256 hash is stored in `platform_users.setup_token_hash`
- TTL: 7 days from generation (NGO admin can re-issue if expired)
- Single-use: the second click after a successful setup shows
  "link already used, please log in instead"
- Until consumed, the `platform_users.password_hash` is an unguessable
  random placeholder — the institution literally cannot log in by any other
  path until they use the setup link.

### After approval

Backend env var to set (paste the **Meta-approved template name**, not the internal alias):

```
WHATSAPP_TEMPLATE_SETUP_LINK=institution_activation_link
```

The `setup_link` key inside `env.whatsapp.templates` resolves the template
name at send time. Handler in
`backend/src/services/notifications/whatsappCloudProvider.js` lives in the
`TEMPLATE_HANDLERS.SETUP_LINK` entry — 3 body vars (signatory_name,
institution_name, expires_in) + 1 URL button var (setup_token).

---

## Submission order

If you want to be strategic about review times:

1. **`donor_otp`** (en, mr, hi) — **submit first**, gates donor login on every demo.
2. **`institutional_credentials`** — gates institution onboarding (May 27 demo step).
3. **`mou_esign_link`** — gates institution onboarding step 2.
4. **`camp_organizer_link`** — gates camp approval flow.
5. **`donor_alert_critical`** (en, mr) — gates emergency response demo.
6. **`camp_reminder`** (en, mr) — gates camp organiser broadcast.

In practice all six get reviewed in parallel, so submit in one sitting.

---

## After approval

When Meta emails you approval, the template appears in **Message templates** with status **Approved**.

Your backend then calls `sendNotification({ templateType: 'donor_otp', variables: { '1': '483921' }, channel: 'WA', language: 'mr' })` and Meta routes the right language to the donor's preferred locale.

The chokepoint already exists — see
`backend/src/services/notifications/whatsappCloudProvider.js`.
We just need to flip `NOTIFICATIONS_PROVIDER=whatsapp_cloud` in the Azure App
Service env once the templates are approved + display name is live.

---

## If Meta rejects a template

Common reasons:
- **Footer too promotional** — keep it factual ("An initiative of …"), not promotional ("Donate now!").
- **Body too generic** — Authentication templates must include the word "code" or "verification".
- **Variable misuse** — `{{1}}` in the body must have a sample value during submission.
- **Buttons that look like phishing** — URLs must match a domain owned by the verified business.

If rejected, Meta gives a one-line reason. Tweak and resubmit; the second
review is usually same-day.

---

# V2 batch — donor-alert-gate architecture

> Templates §8–§14 support the V2 donor-alert-gate flow (see CLAUDE.md
> Post-Phase-8). Backend code is already wired to send these — you just need
> Meta approval + the corresponding `WHATSAPP_TEMPLATE_*` env var set.
>
> **Category note:** all V2 templates are **Utility**. Meta rejects
> Marketing-flavoured urgency language; the bodies below have been tuned to
> read transactional (specific request identifiers, concrete next action, no
> "help us!" appeals). If Meta reclassifies to Marketing, the fix is almost
> always to drop emojis in the header line + tighten the CTA to something
> like "Tap to view request".

---

## Template 8 · `donor_alert_bb_routed`

> V2 replacement for `donor_alert_critical` when the matcher has a specific
> blood bank to route the donor to (distance included). Falls back to
> `donor_alert_critical` when no BB routing is available.

| Field | Value |
|---|---|
| **Name** | `donor_alert_bb_routed` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |

### Body (English)

```
A patient needs *{{1}}* blood at *{{2}}* today. That's about *{{3}} km* from you.

Tap below to confirm you can donate. If you can't, please tap 'not this time' so we can find someone else.
```

### Body (Marathi)

```
आज एका रुग्णाला *{{2}}* येथे *{{1}}* रक्ताची गरज आहे. तुमच्यापासून सुमारे *{{3}} किमी*.

रक्तदान करू शकत असल्यास खाली टॅप करा. जमत नसल्यास 'यावेळी नाही' दाबा जेणेकरून आम्ही दुसरा दाता शोधू.
```

### Body (Hindi)

```
आज एक मरीज़ को *{{2}}* पर *{{1}}* रक्त की आवश्यकता है। आपसे लगभग *{{3}} किमी* दूर।

रक्तदान कर सकते हैं तो नीचे टैप करें। नहीं कर सकते तो 'इस बार नहीं' दबाएँ ताकि हम दूसरा दाता ढूँढ सकें।
```

### Variables

- `{{1}}` — Blood group + component (e.g. `B- PRBC`)
- `{{2}}` — Blood bank display name (e.g. `Dr. Panjabrao Deshmukh BB, Amravati`)
- `{{3}}` — Distance from donor's current location (integer km, e.g. `4`)

### Buttons

- **One button: Confirm you can donate**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/alert/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/alert/eyJhbGciOiJIUzI1Ni-sample-jwt`

### Fires when

Scheduler job `donor_alert_gate` fires alerts from `pending_donor_alerts`.
Backend `templateType: 'DONOR_ALERT_BB'`. Provider handler in
`whatsappCloudProvider.js` fills body vars in insertion order: `blood_group`,
`bb_name`, `distance_km` + URL button with the public alert token.

### After approval

```
WHATSAPP_TEMPLATE_DONOR_ALERT_BB=donor_alert_bb_routed
```

---

## Template 9 · `donor_alert_replacement`

> Sent when the requesting BB flags the request as needing a **replacement**
> donor (i.e. BB is giving inventory now, patient's family or friends need to
> return equivalent units within a window). Different framing from a
> life-safety alert — it's an obligation-fulfilment ask, not a rescue.

| Field | Value |
|---|---|
| **Name** | `donor_alert_replacement` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |

### Body (English)

```
Hi *{{1}}*, a patient at *{{2}}* has received *{{3}}* today. The blood bank asks for a replacement donation to keep stock balanced within *{{4}}*.

Tap below to confirm. Your donation replaces the unit and keeps supply stable for the next patient.
```

### Body (Marathi)

```
नमस्कार *{{1}}*, आज *{{2}}* येथील एका रुग्णाला *{{3}}* देण्यात आले आहे. रक्तपेढी *{{4}}* च्या आत बदली रक्तदान मागत आहे.

पुष्टी करण्यासाठी खाली टॅप करा. तुमचे दान त्या युनिटची पूर्तता करते आणि पुरवठा स्थिर ठेवते.
```

### Body (Hindi)

```
नमस्ते *{{1}}*, आज *{{2}}* के एक मरीज़ को *{{3}}* दिया गया है। ब्लड बैंक *{{4}}* के भीतर प्रतिस्थापन दान की ज़रूरत बता रहा है।

पुष्टि करने के लिए नीचे टैप करें। आपका दान उस यूनिट की भरपाई करता है और अगले मरीज़ के लिए आपूर्ति स्थिर रखता है।
```

### Variables

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Blood bank display name (e.g. `Irwin Hospital BB, Amravati`)
- `{{3}}` — Component received (e.g. `1 unit of B- PRBC`)
- `{{4}}` — Timeframe (e.g. `72 hours`)

### Buttons

- **One button: Confirm replacement donation**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/alert/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/alert/repl-abc123`

### Fires when

BB coordinator marks a request `replacement_required=TRUE` via the
coordinator panel. Backend `templateType: 'DONOR_ALERT_REPLACE'`. The alert
token is the same public-JWT scheme as `donor_alert_bb_routed`.

### After approval

```
WHATSAPP_TEMPLATE_DONOR_ALERT_REPLACE=donor_alert_replacement
```

---

## Template 10 · `donor_alert_community_first`

> First-look alert sent only to donors attributed to a specific community
> leader, before the wider donor pool is engaged. Community-scoped alerts
> give the leader's roster a 15–30 min exclusive window to respond.

| Field | Value |
|---|---|
| **Name** | `donor_alert_community_first` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Community leader alert · choudhari.ngo` |

### Body (English)

```
Hi *{{1}}*, your community leader *{{2}}* is looking for *{{3}}* donors for a patient in *{{4}}* today.

Tap below to confirm you can donate. This alert is going to your community first — before Raktify widens the search.
```

### Body (Marathi)

```
नमस्कार *{{1}}*, आज *{{4}}* मधील एका रुग्णासाठी तुमचे कम्युनिटी लीडर *{{2}}* *{{3}}* दात्यांचा शोध घेत आहेत.

रक्तदान करू शकत असल्यास खाली टॅप करा. हा अलर्ट प्रथम तुमच्या कम्युनिटीला जात आहे — त्यानंतर Raktify शोध विस्तृत करेल.
```

### Body (Hindi)

```
नमस्ते *{{1}}*, आज *{{4}}* के एक मरीज़ के लिए आपके कम्युनिटी लीडर *{{2}}* *{{3}}* दाताओं की तलाश में हैं।

रक्तदान कर सकते हैं तो नीचे टैप करें। यह अलर्ट पहले आपकी कम्युनिटी को जा रहा है — उसके बाद Raktify खोज बढ़ाएगा।
```

### Variables

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Community leader display name (e.g. `Anita Kale`)
- `{{3}}` — Blood group + component (e.g. `O+ PRBC`)
- `{{4}}` — District / taluka name (e.g. `Amravati Rural`)

### Buttons

- **One button: Confirm you can donate**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/alert/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/alert/comm-xyz789`

### Fires when

`donor-alert-gate` scheduler fires and the request has
`attributed_community_id != NULL`. Backend `templateType:
'DONOR_ALERT_COMMUNITY'`. Community-first pool is selected in
`selectDonorPool()` via `attributedCommunityId` — same token scheme as
`donor_alert_bb_routed`.

### After approval

```
WHATSAPP_TEMPLATE_DONOR_ALERT_COMMUNITY=donor_alert_community_first
```

---

## Template 11 · `bb_donor_incoming`

> Notifies the receiving blood bank when a donor has accepted an alert and
> is coming to donate. Populates the "Incoming donors" tab in the BB
> dashboard. Marathi and Hindi added Aug 2026: a BB tech in Amravati reads
> Marathi, and the on-screen tab label stays English inside all three bodies
> because that is the label they are looking at.

| Field | Value |
|---|---|
| **Name** | `bb_donor_incoming` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Blood bank alert · choudhari.ngo` |

### Body (English)

```
A donor has accepted an alert and is coming to your bank.

Donor: *{{1}}* ({{2}})
For: *{{3}}*
Expected arrival: *{{4}}*

Open the Incoming Donors tab to review, mark arrived, or defer.
```

### Body (Marathi)

```
एका दात्याने अलर्ट स्वीकारला आहे आणि तो तुमच्या रक्तपेढीत येत आहे.

दाता: *{{1}}* ({{2}})
कारण: *{{3}}*
अपेक्षित आगमन: *{{4}}*

तपासणी, आगमन नोंद किंवा स्थगिती यासाठी Incoming Donors टॅब उघडा.
```

### Body (Hindi)

```
एक दाता ने अलर्ट स्वीकार किया है और वह आपके ब्लड बैंक आ रहा है.

दाता: *{{1}}* ({{2}})
के लिए: *{{3}}*
अपेक्षित आगमन: *{{4}}*

समीक्षा, आगमन दर्ज करने या स्थगित करने के लिए Incoming Donors टैब खोलें.
```

### Variables

- `{{1}}` — Donor display name (BB is authorised to see donor identity)
- `{{2}}` — Verified blood group (e.g. `B-`)
- `{{3}}` — Request short code (e.g. `REQ-A7X9`)
- `{{4}}` — Expected arrival window (e.g. `within 2 hours` / `Tuesday morning`)

### Buttons

- **One button: Open Incoming Donors**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/bb?tab=incoming&donor={{1}}`
  - Sample: `https://raktify.choudhari.ngo/bb?tab=incoming&donor=abc123`

### Fires when

Donor taps 'Accept' on the public `/alert/:token` page and selects this BB.
`routes/donorAlerts.js` writes the `donor_alert_choice` row, then dispatches
this template. Backend `templateType: 'BB_DONOR_INCOMING'`. Recipient is the
BB's `blood_bank.contact_mobile` (or a per-institution notify list if we
add one later).

### Privacy note

Donor identity is shared here because BBs are the point where donation
records are created (they legitimately need to see + verify the donor). This
does NOT violate the hospital-mask rule — hospitals never receive this
template; only BBs do.

### After approval

```
WHATSAPP_TEMPLATE_BB_DONOR_INCOMING=bb_donor_incoming
```

---

## Template 12 · `coord_prefire_warning`

> Fires 15 min before a scheduled donor-alert burst so the coordinator can
> hold, cancel, or let it proceed. EN/MR/HI.

| Field | Value |
|---|---|
| **Name** | `coord_prefire_warning` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Coordinator alert · choudhari.ngo` |

### Body (English)

```
Alerts for request *{{1}}* ({{2}}) will fire to donors in *{{3}}*.

If a BB has quietly committed inventory, hold the alert. Otherwise let it fire.

Tap below to review or hold.
```

### Body (Marathi)

```
विनंती *{{1}}* ({{2}}) साठी दात्यांना अलर्ट *{{3}}* मध्ये जाणार आहेत.

एखाद्या रक्तपेढीने न सांगता साठा राखून ठेवला असेल तर अलर्ट थांबवा. अन्यथा जाऊ द्या.

तपासण्यासाठी किंवा थांबवण्यासाठी खाली टॅप करा.
```

### Body (Hindi)

```
अनुरोध *{{1}}* ({{2}}) के लिए दाताओं को अलर्ट *{{3}}* में भेजे जाएंगे.

यदि किसी ब्लड बैंक ने बिना बताए स्टॉक आरक्षित कर लिया है तो अलर्ट रोकें. अन्यथा जाने दें.

समीक्षा करने या रोकने के लिए नीचे टैप करें.
```

### Variables

- `{{1}}` — Request short code (e.g. `REQ-A7X9`)
- `{{2}}` — Blood group + component + units (e.g. `2 units O- PRBC`)
- `{{3}}` — Time until fire (e.g. `15 minutes`)

### Buttons

- **One button: Review request**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/coordinator/requests/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/coordinator/requests/abc-123`

### Fires when

Scheduler job (planned) — 15 min before `pending_donor_alerts.scheduled_fire_at`.
Backend `templateType: 'COORD_PREFIRE_WARN'`. Recipient is the assigned
district coordinator's mobile.

### After approval

```
WHATSAPP_TEMPLATE_COORD_PREFIRE_WARN=coord_prefire_warning
```

---

## Template 13 · `coord_critical_new`

> Wakes a district coordinator when a new critical request lands in their
> district — before the matcher has completed. Time-sensitive because the
> coordinator can hand-place the request against inventory they know exists
> that Raktify doesn't. EN/MR/HI.

| Field | Value |
|---|---|
| **Name** | `coord_critical_new` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Coordinator alert · choudhari.ngo` |

### Body (English)

```
New critical request in *{{1}}*.

Needs: *{{2}}* by *{{3}}*
From: *{{4}}*

Tap to review. Matching engine is running — you can override, cancel, or hand-place inventory now.
```

### Body (Marathi)

```
*{{1}}* मध्ये नवीन क्रिटिकल विनंती.

गरज: *{{2}}* — *{{3}}* पर्यंत
कडून: *{{4}}*

तपासण्यासाठी टॅप करा. मॅचिंग सुरू आहे — तुम्ही ओव्हरराइड करू शकता, रद्द करू शकता किंवा साठा स्वतः नेमू शकता.
```

### Body (Hindi)

```
*{{1}}* में नया क्रिटिकल अनुरोध.

आवश्यकता: *{{2}}* — *{{3}}* तक
से: *{{4}}*

समीक्षा के लिए टैप करें. मैचिंग इंजन चल रहा है — आप ओवरराइड कर सकते हैं, रद्द कर सकते हैं या स्टॉक स्वयं निर्धारित कर सकते हैं.
```

### Variables

- `{{1}}` — District / taluka (e.g. `Amravati`)
- `{{2}}` — Blood group + component + units (e.g. `3 units B- PRBC`)
- `{{3}}` — Needed-by datetime (e.g. `18:00 today`)
- `{{4}}` — Requesting facility name (e.g. `Government General Hospital, Amravati`)

### Buttons

- **One button: Review request**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/coordinator/requests/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/coordinator/requests/xyz-789`

### Fires when

Coordinator router (`routes/coordinator.js`) auto-assigns a coordinator to a
new CRITICAL request. Backend `templateType: 'COORD_CRITICAL_NEW'`. Recipient
is the assigned coordinator's mobile.

### After approval

```
WHATSAPP_TEMPLATE_COORD_CRITICAL_NEW=coord_critical_new
```

---

## Template 14 · `community_leader_mobilise`

> Nudges a community leader to broadcast the request to their WhatsApp
> group (Raktify never messages community members directly — the leader
> chooses whom to forward to).

| Field | Value |
|---|---|
| **Name** | `community_leader_mobilise` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Community leader alert · choudhari.ngo` |

### Body (English)

```
Hi *{{1}}*, a patient in *{{2}}* urgently needs *{{3}}*.

Tap below to see the shareable poster + WhatsApp text — takes one tap to forward to your community group. Raktify won't message your community members directly.
```

### Body (Marathi)

```
नमस्कार *{{1}}*, *{{2}}* मधील एका रुग्णाला *{{3}}* ची तातडीने गरज आहे.

पोस्टर आणि व्हॉट्सअॅप मजकूर पाहण्यासाठी खाली टॅप करा — तुमच्या कम्युनिटी ग्रुपला एका टॅपमध्ये फॉरवर्ड करा. Raktify तुमच्या कम्युनिटी सदस्यांना थेट संदेश पाठवणार नाही.
```

### Body (Hindi)

```
नमस्ते *{{1}}*, *{{2}}* के एक मरीज़ को *{{3}}* की तत्काल आवश्यकता है।

पोस्टर और व्हाट्सएप टेक्स्ट देखने के लिए नीचे टैप करें — एक टैप से अपने कम्युनिटी ग्रुप में फॉरवर्ड करें। Raktify आपके कम्युनिटी सदस्यों को सीधे संदेश नहीं भेजेगा।
```

### Variables

- `{{1}}` — Community leader name (e.g. `Anita`)
- `{{2}}` — District / taluka (e.g. `Achalpur`)
- `{{3}}` — Blood group + component (e.g. `O+ PRBC, 2 units`)

### Buttons

- **One button: See share toolkit**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/community-leader/mobilise/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/community-leader/mobilise/mob-abc123`

### Fires when

Coordinator marks a request `mobilise_community_leaders=TRUE` (V2 override
button in the coord panel). Backend `templateType:
'COMMUNITY_LEADER_MOBILISE'`. Recipient is the leader whose community's
donor pool overlaps the compatible group set + district.

### After approval

```
WHATSAPP_TEMPLATE_COMMUNITY_LEADER_MOBILISE=community_leader_mobilise
```

---

## V2 batch — submission order (recommended)

Submit **English versions first for all 7** — that's the shared baseline
tests exercise. Add MR + HI for the 4 donor-facing / community-leader-facing
templates in a second batch once the EN ones are approved.

1. `donor_alert_bb_routed` (EN, MR, HI) — highest-impact; blocks V2 alert flow
2. `bb_donor_incoming` (EN) — completes the accept→BB loop
3. `donor_alert_community_first` (EN, MR, HI) — community routing
4. `community_leader_mobilise` (EN, MR, HI) — community amplification
5. `coord_critical_new` (EN) — coord awareness
6. `coord_prefire_warning` (EN) — coord kill-switch
7. `donor_alert_replacement` (EN, MR, HI) — replacement flow (deferred wiring)

**Total submissions:** 4 templates × 3 languages + 3 templates × 1 language = **15 template records**.

## V2 batch — wiring status (as of code merge)

- **Wired now:** `donor_alert_bb_routed` (fired from `donor-alert-gate` when
  a routed alert token exists), `bb_donor_incoming` (fired from
  `routes/donorAlerts.js` on donor accept).
- **Provider handlers exist for all 7** — env keys are read, templates render.
  The remaining 5 templates (`donor_alert_replacement`,
  `donor_alert_community_first`, `coord_prefire_warning`,
  `coord_critical_new`, `community_leader_mobilise`) need small orchestration
  wire-ups (scheduler ticks or override buttons on the coord panel) that
  are follow-up tasks — the notification chokepoint + provider are ready
  the moment those wire-ups land.

---

# V3 batch — camp lifecycle, blood-bank partnering, vendor consent

> **Why this batch exists, bluntly:** six of these eight templates back code
> that is **already deployed and firing**. The three camp reminder jobs from
> commit `5d5d5aa` (`camp_precheck_2d`, `camp_day_of`, `camp_donor_thankyou`),
> the two organiser broadcast call sites (`camp_announcement`) and the vendor
> webhook's consent invite (`donor_consent_invite`) all run on schedule, all
> log a `notification_log` row, and all **send nothing** — the chokepoint
> cannot find a template name, returns `success:false` cleanly, and files the
> row as `FA`. Nothing crashes, which is exactly why it went unnoticed. The
> remaining two (`camp_bb_request`, `camp_bb_accepted`/`camp_bb_changed`) back
> the blood-bank capacity + accept/decline feature (migrations 316–318).
>
> Same discipline as V2: **every template here is Utility.** Bodies are
> anchored to a specific transaction the recipient took part in, name concrete
> data, and end in one concrete action. Every URL button carries a
> **per-recipient** variable — a token or a camp slug, never a constant path.
> `camp_donor_thankyou` is deliberately **body-only** for that reason: its only
> plausible CTA was the constant `/donor` dashboard, which is precisely the
> shape that got `community_leader_welcome` re-classified MARKETING.
>
> **The public camp URL is `/c/<slug>`, not `/camp/<token>`.** `/camp/:token`
> is the organiser's magic-link dashboard. A donor-facing button pointed there
> is an approved, undetectable dead link.

## Template 15 · `camp_precheck_2d`

> Fires two days out, when a donor can still act on it. Pre-donation
> preparation is the single largest cause of on-the-day deferral: a donor who
> skipped breakfast or drank the night before is turned away at the chair,
> which wastes their trip and the blood bank's slot.

| Field | Value |
|---|---|
| **Name** | `camp_precheck_2d` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |

### Body (English)

```
Hi *{{1}}*, your blood donation slot at *{{2}}* is on *{{3}}*.

Two things before you come: eat a proper meal and drink extra water, and avoid alcohol for 24 hours. Carry a photo ID.

If you cannot make it, tap below to update your registration.
```

### Body (Marathi)

```
नमस्कार *{{1}}*, *{{2}}* येथे तुमची रक्तदानाची वेळ *{{3}}* अशी आहे.

येण्यापूर्वी दोन गोष्टी: व्यवस्थित जेवण करा आणि जास्त पाणी प्या, आणि २४ तास मद्यपान टाळा. ओळखपत्र सोबत आणा.

तुम्हाला येणे शक्य नसेल, तर नोंदणी बदलण्यासाठी खाली टॅप करा.
```

### Body (Hindi)

```
नमस्ते *{{1}}*, *{{2}}* में आपके रक्तदान का समय *{{3}}* है।

आने से पहले दो बातें: भरपेट भोजन करें और अधिक पानी पिएँ, और 24 घंटे शराब से बचें। पहचान पत्र साथ लाएँ।

यदि आप नहीं आ सकते, तो अपना पंजीकरण बदलने के लिए नीचे टैप करें।
```

### Variables

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)
- `{{3}}` — Camp date + start time, one line (e.g. `Sat 12 Sep, 9:00 AM`)

### Buttons

- **One button: View camp details**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/c/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/c/shivaji-college-camp-k2x9f`

### Fires when

Scheduler job `camp_precheck_reminder_2d`
(`services/scheduler/jobs/camp-precheck-reminder-2d.js`) at 09:10 IST, for
every `RG` roster row on a camp two days out. Backend
`templateType: 'CAMP_PRECHECK_2D'`; handler variable order is
`donor_first_name, camp_name, camp_date_time`, then `camp_slug` in the button.
Language follows `donors.preferred_language`, defaulting to `mr`.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_PRECHECK_2D=camp_precheck_2d
```

---

## Template 16 · `camp_day_of_v2`  *(supersedes `camp_day_of`)*

> The morning-of message. It carries the two facts a donor actually needs on
> the day — when to report and where the hall is — framed as a reminder about
> a registration they already made, not as an invitation to come.

**`camp_day_of` (v1) is APPROVED in all three languages but Meta filed it as
MARKETING, not Utility.** That is not cosmetic: a MARKETING template is subject
to per-user marketing frequency caps, so a donor who has hit their cap silently
gets **no** reminder on the morning they were expected at the camp. It is the
only MARKETING template in the WABA.

The v1 records also each **open with `*{{1}}*`**, which Meta now rejects
outright (`error_subcode: 2388299`, *"Variables can't be at the start or end of
the template"*), so they cannot be resubmitted as-is even just to correct the
category. Hence a new name rather than an edit — and a `_v2` name rather than
delete-and-recreate, because Meta locks a deleted template's name for weeks.
**v1 is deliberately left in place and keeps delivering (capped) until v2 is
approved and the appsetting is flipped.**

What changed, and why:

| v1 (MARKETING) | v2 (aiming Utility) | Why |
|---|---|---|
| opens `*{{1}}*, today is your donation day` | opens `Hi *{{1}}*, the blood donation camp you registered for on Raktify` | literal opening fixes 2388299; anchoring on the donor's own registration is the strongest Utility signal |
| `Doors open:` | `Reporting time:` | appointment language, not event language |
| `Eat before you come` | `Please have a meal before reporting` | same instruction, no invitation to attend |
| `Tap below for directions and your registration` | `Tap below to view your registration` | record lookup, not an attendance nudge |
| button `Get directions` | button `View your registration` | same |

The meal / photo-ID / 45-minute preparation line is kept, near-verbatim from
**Template 15 `camp_precheck_2d`**, which Meta approved as **Utility** with the
same content — so the instructions were never the problem, the framing was.

| Field | Value |
|---|---|
| **Name** | `camp_day_of_v2` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |

### Body (English)

```
Hi *{{1}}*, the blood donation camp you registered for on Raktify is scheduled for today.

Camp: *{{2}}*
Reporting time: *{{3}}*
Venue: *{{4}}*

Please have a meal before reporting, carry a photo ID, and allow about 45 minutes. Tap below to view your registration.
```

### Body (Marathi)

```
नमस्कार *{{1}}*, तुम्ही Raktify वर नोंदणी केलेले रक्तदान शिबिर आज नियोजित आहे.

शिबिर: *{{2}}*
हजर राहण्याची वेळ: *{{3}}*
ठिकाण: *{{4}}*

येण्यापूर्वी जेवण करा, ओळखपत्र सोबत आणा आणि सुमारे ४५ मिनिटे वेळ ठेवा. तुमची नोंदणी पाहण्यासाठी खाली टॅप करा.
```

### Body (Hindi)

```
नमस्ते *{{1}}*, आपने Raktify पर जिस रक्तदान शिविर के लिए पंजीकरण किया था वह आज निर्धारित है।

शिविर: *{{2}}*
उपस्थिति का समय: *{{3}}*
स्थान: *{{4}}*

आने से पहले भोजन करें, पहचान पत्र साथ लाएँ और लगभग 45 मिनट का समय रखें। अपना पंजीकरण देखने के लिए नीचे टैप करें।
```

### Variables

**Unchanged from v1 — same four, same order.** `buildComponents()` fills them
positionally from the caller's insertion order, so the `CAMP_DAY_OF` handler and
the scheduler job need no change at all. Reword freely; **never renumber.**

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)
- `{{3}}` — Start time, `HH:MM` (e.g. `09:00`)
- `{{4}}` — Venue, one line (e.g. `Shivaji College Main Hall, Amravati`)

### Buttons

- **One button: View your registration** (22 chars — Meta's ceiling is 25)
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/c/{{1}}` — `{{1}}` is `camp_slug`
  - Sample: `https://raktify.choudhari.ngo/c/shivaji-college-camp-k2x9f`
  - Marathi `माझी नोंदणी पहा` · Hindi `मेरा पंजीकरण देखें`
  - The per-recipient slug is load-bearing: a **constant** URL is what got
    `community_leader_welcome` re-classified MARKETING.

### Fires when

Scheduler job `camp_day_of_reminder`
(`services/scheduler/jobs/camp-day-of-reminder.js`, cron `0 7 * * *` = **07:00
IST**) on the camp date. Backend `templateType: 'CAMP_DAY_OF'`; handler variable
order is `donor_first_name, camp_name, start_time, venue`, then `camp_slug` in
the button.

**All three languages are load-bearing here**, unlike the `routes/camps.js` send
sites: this job sends in `donors.preferred_language`, defaulting to `'mr'`. So
EN approval alone is *not* sufficient — submit EN first, then MR + HI from the
approved copy.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_DAY_OF=camp_day_of_v2
```

The env **key** name does not change — only its value. Same pattern as
`WHATSAPP_TEMPLATE_CAMP_LINK` → `camp_organizer_link_v2`.

---

## Template 17 · `camp_donor_thankyou`

> A donation receipt, not a thank-you card. It tells the donor three
> transactional facts: the donation is on their passport, results follow after
> screening, and when they are eligible again.
>
> **Deliberately body-only — no button.** The handler's original button
> parameter was the constant `donor` dashboard path, i.e. a static URL in a
> dynamic slot. `env.js:98-107` records how that ends: Meta re-classified
> `community_leader_welcome` as MARKETING for exactly this pattern, and a
> thank-you body with a generic app CTA is the most promotional-looking
> combination available. The `CAMP_DONOR_THANKYOU` handler was corrected to
> match — a handler that sends a component the approved template lacks is
> rejected as a silent `FA` row, which reads as a delivery failure rather than
> a bug.

| Field | Value |
|---|---|
| **Name** | `camp_donor_thankyou` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |
| **Buttons** | **None** — see rationale above |

### Body (English)

```
Thank you, *{{1}}*. Your donation at *{{2}}* has been recorded on your donor passport.

Your test results will be added once the blood bank completes screening. You can donate again after 90 days — we will remind you.

Rest today, drink extra fluids, and avoid heavy lifting for a few hours.
```

### Body (Marathi)

```
धन्यवाद *{{1}}*. *{{2}}* येथे केलेले तुमचे रक्तदान तुमच्या डोनर पासपोर्टमध्ये नोंदवले आहे.

रक्तपेढीची तपासणी पूर्ण झाल्यावर तुमचे अहवाल त्यात जोडले जातील. पुढील रक्तदान ९० दिवसांनंतर करता येईल — आम्ही आठवण करून देऊ.

आज विश्रांती घ्या, जास्त पाणी प्या आणि काही तास जड वजन उचलणे टाळा.
```

### Body (Hindi)

```
धन्यवाद *{{1}}*। *{{2}}* में किया गया आपका रक्तदान आपके डोनर पासपोर्ट में दर्ज कर लिया गया है।

ब्लड बैंक की जाँच पूरी होने पर आपकी रिपोर्ट उसमें जोड़ दी जाएगी। अगला रक्तदान 90 दिनों के बाद कर सकेंगे — हम याद दिला देंगे।

आज आराम करें, अधिक पानी पिएँ और कुछ घंटे भारी वजन उठाने से बचें।
```

### Variables

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)

### Fires when

Scheduler job `camp_donor_thankyou`
(`services/scheduler/jobs/camp-donor-thankyou.js`) the day after the camp, for
every roster row the attendance trigger (migration 314) marked `'AT'`. Backend
`templateType: 'CAMP_DONOR_THANKYOU'`; handler variable order is
`donor_first_name, camp_name`.

Note the 90-day figure is donor-facing copy, not a clinical gate. The binding
interval stays in `donors.next_eligible_date` and the donation-gap trigger.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_DONOR_THANKYOU=camp_donor_thankyou
```

---

## Template 18 · `camp_announcement`

> The organiser's own broadcast to their registered donors — a venue change, a
> revised start time, a parking note — and the reschedule notice
> `PATCH /camps/:id` sends when a date moves. The organiser's text goes in
> `{{3}}` verbatim.
>
> `oneLine()` in the provider collapses newlines, tabs and runs of spaces
> before the value is sent: Meta rejects any parameter containing a newline, a
> tab, or more than four consecutive spaces, and an organiser typing into a
> textarea will produce all three. The value is also truncated at 900
> characters.

| Field | Value |
|---|---|
| **Name** | `camp_announcement` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |
| **Buttons** | **None** — the announcement is the payload |

### Body (English)

```
Update about *{{1}}*, scheduled on *{{2}}*:

{{3}}

You are receiving this because you registered for this camp.
```

### Body (Marathi)

```
शिबिराबाबत सूचना — *{{1}}*, दिनांक *{{2}}*:

{{3}}

तुम्ही या शिबिरासाठी नोंदणी केली असल्याने हा संदेश मिळाला आहे.
```

### Body (Hindi)

```
शिविर से जुड़ी सूचना — *{{1}}*, दिनांक *{{2}}*:

{{3}}

आपने इस शिविर के लिए पंजीकरण किया है, इसलिए यह संदेश भेजा गया है।
```

### Variables

- `{{1}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)
- `{{2}}` — Camp date (e.g. `Sat 12 Sep`)
- `{{3}}` — The organiser's message, collapsed to one line, max 900 chars

### Fires when

Two live call sites in `routes/camps.js`: the organiser's broadcast action on
the magic-link dashboard, and the reschedule notice when `PATCH /camps/:id`
moves `scheduled_date`. Backend `templateType: 'CAMP_ANNC'`; handler variable
order is `camp_name, camp_date, message`. Recipients are the camp's `RG`
roster rows.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_ANNC=camp_announcement
```

---

## Template 19 · `donor_consent_invite`

> A blood bank running its own vendor software posts a donation to Raktify
> through the partner webhook. That creates a donor row the person has never
> consented to — so the very next thing that happens is this message, which is
> the consent ask. Until they tap it the row is inert: it is never matched, never
> alerted, never counted in a donor pool.
>
> The button carries the single-use `consent_token`, so the URL is
> per-recipient by construction.

| Field | Value |
|---|---|
| **Name** | `donor_consent_invite` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · An initiative of Choudhari Foundation` |

### Body (English)

```
Hi *{{1}}*, *{{2}}* has recorded your blood donation on Raktify.

To see your donor passport, your test results and your next eligible date, confirm your consent using the link below. It takes under a minute and the link is only for you.

If you did not donate at *{{2}}*, ignore this message.
```

### Body (Marathi)

```
नमस्कार *{{1}}*, *{{2}}* यांनी तुमचे रक्तदान Raktify वर नोंदवले आहे.

तुमचा डोनर पासपोर्ट, तपासणी अहवाल आणि पुढील रक्तदानाची तारीख पाहण्यासाठी खालील लिंकवरून संमती द्या. एक मिनिटही लागणार नाही आणि ही लिंक फक्त तुमच्यासाठी आहे.

तुम्ही *{{2}}* येथे रक्तदान केले नसेल, तर हा संदेश दुर्लक्षित करा.
```

### Body (Hindi)

```
नमस्ते *{{1}}*, *{{2}}* ने आपका रक्तदान Raktify पर दर्ज किया है।

अपना डोनर पासपोर्ट, जाँच रिपोर्ट और अगली रक्तदान तिथि देखने के लिए नीचे दी गई लिंक से सहमति दें। इसमें एक मिनट से कम लगेगा और यह लिंक केवल आपके लिए है।

यदि आपने *{{2}}* में रक्तदान नहीं किया है, तो इस संदेश को नज़रअंदाज़ करें।
```

### Variables

- `{{1}}` — Donor first name (e.g. `Ramesh`)
- `{{2}}` — Source blood bank display name (e.g. `Dr. PDMMC Blood Centre`)

### Buttons

- **One button: Confirm consent**
  - Type: `URL` (dynamic)
  - URL: `https://raktify.choudhari.ngo/consent/{{1}}`
  - Sample: `https://raktify.choudhari.ngo/consent/cst-7f3a91b2c4`

### Fires when

`POST /webhooks/vendor/donations` (`routes/vendor-webhooks.js`) immediately
after creating the donor row. Backend `templateType: 'DONOR_CONSENT_INVITE'`;
handler variable order is
`donor_first_name, source_institution_display_name`, then `consent_token` in
the button. The send is wrapped in its own `try/catch` — a failed invite must
not roll back the donation the blood bank just filed.

### After approval

```
WHATSAPP_TEMPLATE_DONOR_CONSENT_INVITE=donor_consent_invite
```

---

## Template 20 · `camp_bb_request`

> The blood bank is told, once, in writing, that a camp has been assigned to it
> for collection — with the three facts it needs to answer: date, venue, and
> how many donors the organiser expects. Today that conversation is a phone
> call the platform never sees, which is the whole reason migrations 316–318
> exist.
>
> **No button, deliberately.** The answer is two clicks in the portal's Camps
> tab (Accept / Decline with a reason), and the tab also carries the live
> registration count, the day's occupancy and the derived kit maths. A URL
> button pointed at a login-gated staff portal adds a step rather than removing
> one.

| Field | Value |
|---|---|
| **Name** | `camp_bb_request` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Blood bank alert · choudhari.ngo` |
| **Buttons** | **None** — see rationale above |

### Body (English)

```
*{{1}}*, a blood donation camp has been assigned to your blood bank for collection.

Date: *{{2}}*
Venue: *{{3}}*
Expected donors: *{{4}}*

Open the Camps tab in your Raktify portal to accept or decline, and to see the live registration count before the day.
```

### Body (Marathi)

```
*{{1}}*, रक्तसंकलनासाठी तुमच्या रक्तपेढीला एक रक्तदान शिबिर देण्यात आले आहे.

दिनांक: *{{2}}*
ठिकाण: *{{3}}*
अपेक्षित रक्तदाते: *{{4}}*

स्वीकारण्यासाठी किंवा नाकारण्यासाठी, आणि दिवसापूर्वी नोंदणीची संख्या पाहण्यासाठी Raktify पोर्टलमधील Camps टॅब उघडा.
```

### Body (Hindi)

```
*{{1}}*, रक्त संग्रह के लिए आपके ब्लड बैंक को एक रक्तदान शिविर सौंपा गया है।

दिनांक: *{{2}}*
स्थान: *{{3}}*
अपेक्षित रक्तदाता: *{{4}}*

स्वीकार या अस्वीकार करने और शिविर से पहले पंजीकरण की संख्या देखने के लिए Raktify पोर्टल में Camps टैब खोलें।
```

### Variables

- `{{1}}` — Blood bank name (e.g. `Dr. PDMMC Blood Centre`)
- `{{2}}` — Camp date (e.g. `Sat 12 Sep`)
- `{{3}}` — Venue, one line (e.g. `Shivaji College Main Hall, Amravati`)
- `{{4}}` — Organiser's expected donor count (e.g. `50`)

### Fires when

`POST /camps/:id/verify` and `POST /camps/:id/repartner`
(`routes/camps.js`) at the moment a partner is written and `bb_response` is set
to `'PE'`. Backend `templateType: 'CAMP_BB_REQUEST'`; handler variable order is
`bb_name, camp_date, venue, expected_donors`. Recipient is the **institution
UUID** — `resolveRecipient()` looks up `institutions.primary_contact_mobile`
itself and stamps `recipient_institution_id` on the log row.

Not sent when the BB has `auto_accept_within_capacity=TRUE` and the day is
inside published capacity: that path stamps `'AC'` at apply time, so there is
nothing to answer.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_BB_REQUEST=camp_bb_request
```

---

## Template 21 · `camp_bb_accepted`

> The organiser hears the good news, and — more usefully — hears exactly what
> they no longer have to arrange. A first-time host does not know whether they
> are expected to supply beds, tables or staff; being told plainly is what stops
> the next three phone calls.

| Field | Value |
|---|---|
| **Name** | `camp_bb_accepted` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Camp organizer alert · choudhari.ngo` |
| **Buttons** | **None** — the organiser already holds their magic-link dashboard from `camp_organizer_link_v2` |

### Body (English)

```
*{{1}}*, the blood bank for *{{2}}* on *{{3}}* is confirmed.

Their team will bring the staff, beds and all collection supplies. Nothing further is needed from you on this — keep sharing your registration link so they can plan supplies from the numbers.
```

### Body (Marathi)

```
*{{1}}*, *{{2}}* (दिनांक *{{3}}*) साठी रक्तपेढी निश्चित झाली आहे.

त्यांची टीम कर्मचारी, बेड आणि संकलनाचे सर्व साहित्य घेऊन येईल. यासाठी तुम्हाला आणखी काही करायचे नाही — नोंदणीची लिंक शेअर करत राहा, म्हणजे संख्येनुसार ते साहित्याची तयारी करू शकतील.
```

### Body (Hindi)

```
*{{1}}*, *{{2}}* (दिनांक *{{3}}*) के लिए ब्लड बैंक तय हो गया है।

उनकी टीम स्टाफ, बेड और संग्रह की सभी सामग्री साथ लाएगी। इसके लिए आपको और कुछ नहीं करना है — पंजीकरण लिंक साझा करते रहें, जिससे वे संख्या के अनुसार सामग्री की तैयारी कर सकें।
```

### Variables

- `{{1}}` — Organiser name (e.g. `Ashish Tayde`)
- `{{2}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)
- `{{3}}` — Camp date (e.g. `Sat 12 Sep`)

### Fires when

`POST /camps/:id/bb-response` with `response: 'AC'`. Backend
`templateType: 'CAMP_BB_ACCEPTED'`; handler variable order is
`organiser_name, camp_name, scheduled_date`. Recipient is
`submitted_by_mobile`.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_BB_ACCEPTED=camp_bb_accepted
```

---

## Template 22 · `camp_bb_changed`

> A blood bank has declined, and the founder's decision was to **tell the
> organiser immediately** rather than let the NGO reassign in silence. So this
> message exists to do one job: reassure. The camp is happening, the
> registrations are untouched, and someone else is being arranged.
>
> **⚠ The decline reason is NEVER in this message, and never in any organiser
> surface.** `bb_decline_reason` (`NC` no capacity · `ND` staff not on duty ·
> `DT` date clash · `VE` venue not workable · `OT` other) goes to the NGO admin
> only. An organiser told "no capacity" starts phoning blood banks — which is
> the exact behaviour migrations 316–318 exist to remove. There is deliberately
> no fourth variable in the handler to carry it.

| Field | Value |
|---|---|
| **Name** | `camp_bb_changed` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Camp organizer alert · choudhari.ngo` |
| **Buttons** | **None** |

### Body (English)

```
*{{1}}*, we are arranging a different blood bank to collect at *{{2}}* on *{{3}}*.

Your camp is going ahead as planned and your registrations are unaffected. We will confirm the new blood bank shortly — you do not need to do anything.
```

### Body (Marathi)

```
*{{1}}*, *{{2}}* (दिनांक *{{3}}*) येथे रक्तसंकलनासाठी आम्ही दुसरी रक्तपेढी नियुक्त करत आहोत.

तुमचे शिबिर ठरल्याप्रमाणे होणार आहे आणि नोंदणीवर कोणताही परिणाम होणार नाही. नवीन रक्तपेढी लवकरच कळवू — तुम्हाला काहीही करण्याची गरज नाही.
```

### Body (Hindi)

```
*{{1}}*, *{{2}}* (दिनांक *{{3}}*) में रक्त संग्रह के लिए हम दूसरा ब्लड बैंक तय कर रहे हैं।

आपका शिविर योजना के अनुसार ही होगा और पंजीकरण पर कोई असर नहीं पड़ेगा। नया ब्लड बैंक शीघ्र ही बता देंगे — आपको कुछ करने की आवश्यकता नहीं है।
```

### Variables

- `{{1}}` — Organiser name (e.g. `Ashish Tayde`)
- `{{2}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)
- `{{3}}` — Camp date (e.g. `Sat 12 Sep`)

### Fires when

`POST /camps/:id/bb-response` with `response: 'DC'`. Backend
`templateType: 'CAMP_BB_CHANGED'`; handler variable order is
`organiser_name, camp_name, scheduled_date` — three, never four. Recipient is
`submitted_by_mobile`. `PublicCampPage` is deliberately left alone: 200 RSVP'd
donors do not need to watch the arrangements wobble.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_BB_CHANGED=camp_bb_changed
```

---

## Template 23 · `camp_review_pending`

> The NGO side is **told** a camp is waiting for it. Until this template,
> `POST /camps/apply` notified nobody — while its own 201 answered the organiser
> *"Our NGO coordinator will contact you within 2 working days."* The entire
> review queue depended on a human happening to open the `/admin` Camps tab, and
> a real prod camp sat unreviewed because nobody did.
>
> **No button, deliberately.** An NGO admin signs in with password + TOTP, so a
> button could only ever carry the constant `/admin` link — and a constant URL is
> the exact thing that got `community_leader_welcome` re-classified MARKETING.
> The Camps tab is one tap from the portal home anyway.
>
> **Opens and closes on literal text**, because Meta rejects a body that begins
> or ends with a variable (`error_subcode: 2388299`).

| Field | Value |
|---|---|
| **Name** | `camp_review_pending` |
| **Category** | **Utility** |
| **Languages** | English, Marathi, Hindi |
| **Header** | None |
| **Footer** | `Raktify · Coordinator alert · choudhari.ngo` |
| **Buttons** | **None** — see rationale above |

### Body (English)

```
A new blood donation camp application is waiting for NGO review on Raktify.

Camp: *{{1}}*
Date: *{{2}}*
Venue: *{{3}}*
Organiser: *{{4}}*
District: *{{5}}*

Open the Camps tab in your Raktify portal to verify the details and assign a blood bank.
```

### Body (Marathi)

```
Raktify वर एक नवीन रक्तदान शिबिराचा अर्ज तपासणीसाठी प्रलंबित आहे.

शिबिर: *{{1}}*
दिनांक: *{{2}}*
ठिकाण: *{{3}}*
आयोजक: *{{4}}*
जिल्हा: *{{5}}*

तपशील तपासण्यासाठी आणि रक्तपेढी नेमण्यासाठी Raktify पोर्टलमधील Camps टॅब उघडा.
```

### Body (Hindi)

```
Raktify पर एक नया रक्तदान शिविर आवेदन समीक्षा के लिए लंबित है।

शिविर: *{{1}}*
दिनांक: *{{2}}*
स्थान: *{{3}}*
आयोजक: *{{4}}*
जिला: *{{5}}*

विवरण सत्यापित करने और ब्लड बैंक तय करने के लिए Raktify पोर्टल में Camps टैब खोलें।
```

### Variables

- `{{1}}` — Camp name (e.g. `Shivaji College Blood Donation Camp`)
- `{{2}}` — Camp date, calendar label (e.g. `2026-09-12`)
- `{{3}}` — Venue, one line (e.g. `Shivaji College Main Hall, Amravati`)
- `{{4}}` — **Organiser organisation**, never the person (e.g. `Shivaji College, Amravati`)
- `{{5}}` — District name (e.g. `Amravati`)

`{{4}}` is `organiser_name`, the organisation — **not** `submitted_by_name`. A
person's name is PII that does not need to ride a WhatsApp message for someone
to decide whether a camp is worth reviewing.

Every one of the five comes off a **public form**, so the handler pushes each
through `oneLine()`: Meta rejects a *parameter* (not body text) holding a
newline, a tab, or more than four consecutive spaces.

### Fires when

`POST /camps/apply` (`routes/camps.js`), immediately after the camp is created
at `status='PE'`. Backend `templateType: 'CAMP_REVIEW_PENDING'`; handler
variable order is `camp_name, camp_date, venue, organiser_name, district`.

Recipients are resolved by `notifyCampReviewPending()` as the union of the two
role-sets `POST /camps/:id/verify` already accepts, minus `super_admin`: the
**camp district's** active coordinators with a mobile, then every active
`ngo_admin` with a mobile, de-duplicated by mobile and capped at
`CAMP_REVIEW_NOTIFY_LIMIT = 5`.

Three deliberate choices in that query:

- **`on_duty` is NOT required.** It gates `COORD_CRITICAL_NEW`, where somebody
  has to be at their phone *now*; a camp carries a two-working-day promise, so
  requiring a live shift would silently notify nobody most evenings.
- **`ngo_admin`s are always included**, because a brand-new district has no
  `coordinators` profile row at all — dev holds 27 coordinator `platform_users`
  against **2** `coordinators` rows.
- **Fire-and-forget, never awaited.** The organiser's 201 must not wait on Meta,
  and a WhatsApp outage must never lose a camp application. Zero recipients logs
  `logger.warn` loudly — "nobody to tell" is an operational hole, not a
  non-event.

`notification_log.template_type` is plain `TEXT` with no CHECK, so this needed
**no migration** — schema head stays 319.

### After approval

```
WHATSAPP_TEMPLATE_CAMP_REVIEW_PENDING=camp_review_pending
```

A **plain App Service appsetting on `raktify-api`**, not a Key Vault secret —
template names are not secrets. Only the Meta credentials live in `raktify-kv`,
and they are shared by every template, which is precisely why the eight missing
camp keys stayed invisible for weeks.

---

## V3 batch — submission order (recommended)

**Submit EN first for every template, let it clear, then submit MR + HI from
the approved copy.** Each language is a separate Meta review at 1–3 days, so a
rejection caught on the EN record is caught once instead of three times.
`scripts/submit_whatsapp_templates_v2.js --lang en` does exactly this;
`--only name1,name2` narrows further, and `--dry-run` prints the payloads.

Ordered by what is broken hardest today — the first four back code that is
already deployed and silently sending nothing:

1. `camp_precheck_2d` (EN, MR, HI) — job live since `5d5d5aa`, cannot send
2. `camp_day_of` (EN, MR, HI) — same
3. `camp_donor_thankyou` (EN, MR, HI) — same
4. `camp_announcement` (EN, MR, HI) — two live call sites, cannot send
5. `donor_consent_invite` (EN, MR, HI) — vendor webhook consent ask, cannot send
6. `camp_bb_request` (EN, MR, HI) — blood-bank partnering (316–318)
7. `camp_bb_accepted` (EN, MR, HI) — organiser confirmation
8. `camp_bb_changed` (EN, MR, HI) — organiser reassurance on a decline

**Total new submissions:** 8 templates × 3 languages = **24 template records**.

Riding along in the same script run: **MR + HI for the three V2 staff-facing
templates** submitted EN-only — `bb_donor_incoming`, `coord_prefire_warning`,
`coord_critical_new` — **6 more records**. A blood-bank technician or a
coordinator in Amravati reads Marathi; there was never a reason for these to be
English-only beyond submission speed.

## V3 batch — wiring status

- **Handlers + env keys: all 8 are already in code** and the gate
  `node scripts/check_whatsapp_templates.js` exits 0. Nothing in `backend/`
  needs to change for these to start delivering — setting each
  `WHATSAPP_TEMPLATE_*` as a plain **App Service appsetting** on `raktify-api`
  flips them on. They are **not** Key Vault secrets — only the Meta credentials
  are, and those are shared by every template.
- **`camp_organizer_link_v2` needs no Meta work.** It is already approved in
  EN + MR + HI as UTILITY with **two** body variables (`organiser_name`,
  `camp_name`) and a `/camp/{{1}}` button taking the **raw token**, not an
  assembled URL. The `CAMP_LINK` handler matches it. Because it is already
  approved, it is the **first send to verify on production** — if it delivers,
  the chokepoint, the provider and the WABA are all healthy and every remaining
  failure is a template-approval fact rather than a code fact.
- **Verify each button URL through the Graph API after creation, not the
  Business Manager UI.** A template can be registered carrying both a
  URL-encoded and a literal `{{1}}`, which silently breaks substitution and
  renders correctly in the UI preview.
- **Still not a template, still broken:** `BOT_REPLY` (6 call sites in
  `services/whatsapp/bot.js`) needs a **free-form session-message** path in the
  provider — legal inside Meta's 24-hour customer-service window, since the bot
  only ever replies to an incoming message. Different fix, different risk;
  tracked separately.
