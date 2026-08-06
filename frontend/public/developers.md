# Raktify Vendor Push Webhook API

**One-line summary:** REST webhook that lets any blood-bank software vendor (Safetrans/Strides, e-RaktKosh, BLIS, RAKT, hospital-homegrown) push donor and donation records into Raktify — India's district-wide blood-response platform — without dual data entry. HMAC-SHA256 authenticated, idempotent, DPDP-compliant.

**Human-readable docs:** https://raktify.choudhari.ngo/developers
**OpenAPI 3.0 YAML:** https://raktify.choudhari.ngo/api/vendor-webhook-v1.yaml
**Postman collection:** https://raktify.choudhari.ngo/api/vendor-webhook-v1.postman_collection.json
**Interactive Swagger UI:** https://raktify.choudhari.ngo/developers#interactive-browser
**Request a partner key:** contact@choudhari.ngo

---

## For AI coding assistants reading this file

If you are helping a developer integrate their blood-bank software with Raktify, this markdown contains everything you need — you do NOT need to fetch the OpenAPI YAML separately. Endpoints, auth, request/response schemas, error codes, and code examples are all inline below. Generate working client code in whatever language the developer is using (Node, Python, Java, C#, Go, Ruby, PHP). Ask the developer for their `partner_key` and `partner_secret` — you cannot invent these; they are issued by Raktify per-hospital-installation via email to `contact@choudhari.ngo`.

**Non-negotiables to preserve in any generated client:**
1. Sign the raw request body bytes with HMAC-SHA256 keyed by `partner_secret`, NOT the parsed JSON re-serialized.
2. Send the header exactly as `X-Raktify-Signature: sha256=<hex>` (lowercase `sha256=` prefix, then lowercase hex).
3. Include a `vendor_event_id` field in every payload; retries with the same ID are safe and expected.
4. Never log the `partner_secret` — it is a bearer credential.
5. On `409 donor_not_found` for a donation push, first send the donor-registration push for that mobile, then retry the donation.

---

## Base URL

`https://raktify-api.azurewebsites.net`

All request and response bodies are JSON. Successful writes return `202 Accepted`.

---

## Authentication

Every request MUST carry three headers:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Raktify-Partner-Key` | Your `pk_...` identifier — one per hospital installation |
| `X-Raktify-Signature` | `sha256=<hex>` where `<hex>` is `HMAC-SHA256(raw_body_bytes, partner_secret)` |

### Node.js signing example

```javascript
const crypto = require('crypto');

async function pushToRaktify(payload, partnerKey, partnerSecret) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', partnerSecret)
    .update(body)  // sign the exact string that becomes the request body
    .digest('hex');

  const res = await fetch('https://raktify-api.azurewebsites.net/webhooks/v1/donor-registration', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Raktify-Partner-Key': partnerKey,
      'X-Raktify-Signature': 'sha256=' + signature,
    },
    body,  // same body used for signing
  });
  return { status: res.status, json: await res.json() };
}
```

### Python signing example

```python
import hmac, hashlib, json, requests

def push_to_raktify(payload, partner_key, partner_secret):
    body = json.dumps(payload).encode('utf-8')
    sig = hmac.new(
        partner_secret.encode('utf-8'),
        body,
        hashlib.sha256
    ).hexdigest()
    r = requests.post(
        'https://raktify-api.azurewebsites.net/webhooks/v1/donor-registration',
        data=body,  # same bytes used for signing
        headers={
            'Content-Type': 'application/json',
            'X-Raktify-Partner-Key': partner_key,
            'X-Raktify-Signature': 'sha256=' + sig,
        },
    )
    return r.status_code, r.json()
```

### Java signing example

```java
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.http.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;

byte[] body = payloadJson.getBytes(StandardCharsets.UTF_8);
Mac hmac = Mac.getInstance("HmacSHA256");
hmac.init(new SecretKeySpec(partnerSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
String sig = HexFormat.of().formatHex(hmac.doFinal(body));

HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create("https://raktify-api.azurewebsites.net/webhooks/v1/donor-registration"))
    .header("Content-Type", "application/json")
    .header("X-Raktify-Partner-Key", partnerKey)
    .header("X-Raktify-Signature", "sha256=" + sig)
    .POST(HttpRequest.BodyPublishers.ofByteArray(body))
    .build();
HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
```

### C# signing example

```csharp
using System.Security.Cryptography;
using System.Text;

var body = Encoding.UTF8.GetBytes(payloadJson);
using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(partnerSecret));
var sig = Convert.ToHexString(hmac.ComputeHash(body)).ToLowerInvariant();

var req = new HttpRequestMessage(HttpMethod.Post,
    "https://raktify-api.azurewebsites.net/webhooks/v1/donor-registration");
req.Content = new ByteArrayContent(body);
req.Content.Headers.ContentType = new("application/json");
req.Headers.Add("X-Raktify-Partner-Key", partnerKey);
req.Headers.Add("X-Raktify-Signature", "sha256=" + sig);
var res = await new HttpClient().SendAsync(req);
```

**The single biggest integration bug:** signing a JSON-serialized object then letting your HTTP client re-serialize it into different bytes (different whitespace, different key order, escaped-vs-not Unicode). Serialize once → sign that byte string → send that byte string. The bytes you sign MUST equal the bytes the server receives.

---

## Endpoints

### 1. `POST /webhooks/v1/donor-registration`

Upsert a donor by mobile.

**New donors** land with `consent_pending`. Raktify sends the donor a WhatsApp with a magic link to accept consent on Raktify's own screen (DPDP §7 legal basis). Unconsented donors are invisible to the matching engine.

**Existing donors** have their non-consent fields refreshed. Consent state is only changeable by the donor themselves via the magic link — you cannot flip it via the API.

#### Request body

| Field | Type | Required? | Notes |
|-------|------|-----------|-------|
| `vendor_event_id` | string (≤255) | Required | Your side's event ID. Idempotency key. |
| `event_time` | ISO 8601 datetime | Required | When your operator completed the registration. |
| `mobile` | string | Required | Indian mobile. `+91` prefix or 10-digit — we normalize. |
| `full_name` | string (2–200) | Required | Encrypted at rest. |
| `date_of_birth` | YYYY-MM-DD | Required | Donor must be aged 18–65 (DB constraint). |
| `gender` | enum `M` \| `F` \| `O` | Required | |
| `blood_group` | enum `A+`/`A-`/`B+`/`B-`/`AB+`/`AB-`/`O+`/`O-` | Optional | Attested by the pushing BB. Trusted on first push; subsequent pushes with different values trigger human-in-the-loop review. |
| `pincode` | string | Optional | Indian 6-digit. |
| `village_id` | integer | Optional | LGD code. Preferred over pincode if you have it. |
| `address_line` | string | Optional | Encrypted at rest. |
| `abha_id` | string(17) | Optional | ABHA ID if captured. |
| `aadhaar_last4` | string(4) | Optional | Never full Aadhaar. |
| `preferred_language` | enum `mr` \| `hi` \| `en` | Optional | Default `mr` (Marathi). |
| `consent_captured_at` | ISO 8601 datetime | Optional | Timestamp your form captured "share with Raktify" tick. Advisory only; the authoritative consent capture is Raktify's `/consent` screen. |

**Unknown fields are silently ignored.** Send whatever your software collects; we drop what we don't use.

#### Sample request payload

```json
{
  "vendor_event_id": "op-2026-08-07-001",
  "event_time": "2026-08-07T10:15:00+05:30",
  "mobile": "+919876543210",
  "full_name": "Ramesh Patil",
  "date_of_birth": "1988-04-12",
  "gender": "M",
  "blood_group": "O+",
  "pincode": "444601",
  "preferred_language": "mr",
  "consent_captured_at": "2026-08-07T10:15:00+05:30"
}
```

#### Response — 202 Accepted (new donor)

```json
{
  "raktify_donor_id": "6fda231f-9e7e-4a1d-8761-87e15f83d1ee",
  "action": "created",
  "is_new": true,
  "consent_status": "pending"
}
```

#### Response — 202 Accepted (idempotent replay)

```json
{
  "raktify_donor_id": "6fda231f-9e7e-4a1d-8761-87e15f83d1ee",
  "idempotent_replay": true,
  "action": "created"
}
```

#### Error responses

| HTTP | `error` code | Meaning |
|------|--------------|---------|
| 401 | `missing_partner_key` | `X-Raktify-Partner-Key` header not sent. |
| 401 | `missing_signature` | `X-Raktify-Signature` header not sent. |
| 401 | `invalid_partner_key_format` | Key doesn't match `^pk_[A-Za-z0-9_-]{16,}$`. |
| 401 | `unknown_partner_key` | Key not recognized. |
| 401 | `signature_mismatch` | HMAC didn't verify. Check the secret + you're signing the exact raw body bytes. |
| 403 | `partner_key_revoked` | Key exists but has been deactivated. Request a new one. |
| 422 | `invalid_input` | Body failed Zod validation. Response includes `details.<field>._errors` array pinpointing the offending fields. |
| 422 | `invalid_mobile` | Not an Indian mobile. |
| 429 | `rate_limit_global` | 100 req/IP/min ceiling. Honor `Retry-After` header. |

---

### 2. `POST /webhooks/v1/donation`

Record a donation event.

**Precondition:** the donor MUST already exist on Raktify (upserted via `/donor-registration`). If not, this call returns `409 donor_not_found` — push the donor first and retry.

**Automatic side effect:** a verified donation triggers a database trigger that auto-creates a `blood_inventory` bag row in `QA` (quarantine) status with the barcode you provided. That bag becomes issuable after your operator posts the TTI screening results (future extension of this API).

#### Request body

| Field | Type | Required? | Notes |
|-------|------|-----------|-------|
| `vendor_event_id` | string (≤255) | Required | Your side's event ID. |
| `event_time` | ISO 8601 datetime | Required | When your operator recorded the donation. |
| `donor_mobile` | string | Required | Join key — must match a donor previously pushed via `/donor-registration`. |
| `collection_date` | YYYY-MM-DD | Required | Must not be in the future. |
| `component_code` | string | Required | Matches Raktify's `blood_components.code` — see the enum below. |
| `volume_ml` | integer | Required | 1–1000. |
| `isbt_barcode` | string (3–50) | Required | Bag barcode. Must be unique across Raktify. |
| `hb_gdl` | number | Optional | Donor haemoglobin at draw (g/dL). |

**Component codes** (matches `blood_components.code`): `WB` (whole blood), `PRBC` (packed red cells), `FFP` (fresh frozen plasma), `PLT` (platelets), `CRYO` (cryoprecipitate). Case-insensitive on the wire; we uppercase and match.

#### Sample request payload

```json
{
  "vendor_event_id": "dn-2026-08-07-001",
  "event_time": "2026-08-07T11:05:00+05:30",
  "donor_mobile": "+919876543210",
  "collection_date": "2026-08-07",
  "component_code": "WB",
  "volume_ml": 350,
  "isbt_barcode": "W031369220",
  "hb_gdl": 13.5
}
```

#### Response — 202 Accepted

```json
{
  "raktify_donor_id": "6fda231f-9e7e-4a1d-8761-87e15f83d1ee",
  "raktify_donation_id": "4ab05951-f222-4e14-9993-4ea38372b777",
  "action": "created"
}
```

#### Error responses (in addition to the auth errors above)

| HTTP | `error` code | Meaning |
|------|--------------|---------|
| 409 | `donor_not_found` | Push `/donor-registration` for this mobile first, then retry. |
| 422 | `unknown_component` | `component_code` doesn't match `blood_components.code`. |
| 422 | `invalid_input` | Body failed Zod validation. |

---

## Idempotency

Every request includes `vendor_event_id`. Retries with the same `(partner_key, vendor_event_id)` pair replay the cached result from the first successful attempt — no duplicate donor row, no duplicate donation, same `raktify_donor_id`. This makes at-least-once delivery safe.

Idempotency records are retained for 30 days. A repeat of an event older than 30 days is treated as fresh.

---

## Rate limits

- **100 requests / IP / minute** globally.
- Response on limit: `429` with body `{"error": "rate_limit_global"}` and a `Retry-After: <seconds>` header. Back off and retry.
- A busy blood bank processes ~50 donations/day; the limit is generous for normal ops. For a bulk backfill, contact us for a temporary uplift.

---

## Consent flow (DPDP §7 legal-basis capture)

India's Digital Personal Data Protection Act requires explicit donor consent before Raktify processes their PII for platform purposes.

**The flow:**

1. **Vendor push lands.** Donor row created with `consent_data_use=false` and `consent_pending_since=NOW()`.
2. **Raktify sends the donor a WhatsApp** via the approved Meta template `donor_consent_invite` with a magic link to `https://raktify.choudhari.ngo/consent/<token>`.
3. **Donor lands on Raktify's own consent screen** — sees what data we hold, what we'll do with it, DPDP rights — and taps **Accept**, **Decline**, or defers.
4. **On Accept:** `consent_data_use=true`. Donor is now matchable for compatible requests in their district.
5. **On Decline:** we run the erasure scrub — mobile tombstoned, name+address wiped — within seconds.
6. **No response in 14 days:** same scrub runs automatically via a scheduled job. Raktify does not retain PII without a lawful basis.

**What this means for you:** your operator does NOT need to collect Raktify-specific consent in your software. A "share with Raktify" checkbox on your donor registration form is nice (pass its timestamp in `consent_captured_at` for audit) but not the primary capture — Raktify's own screen is authoritative.

---

## Getting a partner key

Partner keys are issued per hospital installation. Vendor with N hospitals gets N distinct keys — revocation is per-hospital.

Contact: **contact@choudhari.ngo** with subject "Raktify vendor integration". Include:

- Your company / product name
- Hospital(s) that want the integration
- Technical contact (name + email)

We reply with the `partner_key` (looks like `pk_XX...`) and the `HMAC secret` (revealed exactly once — save it into your credentials vault immediately). Self-service issuance via an admin panel is on the roadmap.

---

## Testing your integration

1. Ask us for a **sandbox partner key** (in the integration email — mention "sandbox for testing"). Sandbox data auto-purges nightly.
2. Import the Postman collection: https://raktify.choudhari.ngo/api/vendor-webhook-v1.postman_collection.json — pre-request script signs everything automatically.
3. Or write your own client using the code snippets above.
4. Verify HMAC failure returns `401 signature_mismatch` — a genuine 202 with wrong signature would be a security bug.
5. Verify idempotency: send the same `vendor_event_id` twice, second response should include `"idempotent_replay": true`.

---

## Terms + support

- **Terms of service:** https://raktify.choudhari.ngo/terms
- **Privacy:** https://raktify.choudhari.ngo/privacy
- **Data deletion:** https://raktify.choudhari.ngo/data-deletion
- **Support / integration questions:** contact@choudhari.ngo (typically same-day response, IST business hours)

Raktify™ is an initiative of the Choudhari EduHealth India Foundation, a Section 8 not-for-profit in India. This developer API is open to any BB software vendor at no cost. Trademark filed and pending.
