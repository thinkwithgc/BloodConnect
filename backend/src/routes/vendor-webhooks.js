/**
 * Vendor push webhook API — /webhooks/v1/*
 *
 * Public REST contract for blood-bank software vendors (Strides/Safetrans first,
 * then e-RaktKosh, BLIS, RAKT, hospital-homegrown). Vendors POST donor + donation
 * events into Raktify so the BB operator doesn't dual-enter data. Full spec + a
 * publishable OpenAPI file arrive in PR (c) of the integration plan; this file
 * is PR (a) — the minimum to get PDMMC/Safetrans transacting.
 *
 * Endpoints:
 *   POST /webhooks/v1/donor-registration   upsert-by-mobile a donor.
 *                                          Consent starts PENDING (donor gets a
 *                                          WhatsApp magic-link to accept on
 *                                          Raktify's own consent screen).
 *   POST /webhooks/v1/donation             insert a donation record for a
 *                                          consented donor.
 *
 * Auth:
 *   Every request MUST carry:
 *     X-Raktify-Partner-Key: pk_...
 *     X-Raktify-Signature:   sha256=<hex>
 *   The signature is HMAC-SHA256 over the RAW request body, keyed by the
 *   partner_key's `hmac_secret` (sealed at rest, opened per request). Verify
 *   uses timingSafeEqual on raw bytes to defeat timing side-channels — copy of
 *   the Meta / X-Hub-Signature-256 pattern already used in routes/webhooks.js.
 *
 * Idempotency:
 *   Every request MUST carry a vendor_event_id in the body. On a repeat
 *   (same partner_key + same vendor_event_id) we DON'T re-execute — we return
 *   a cached { status, action, raktify_donor_id } from vendor_events. This
 *   makes vendor retries + at-least-once delivery safe.
 *
 * PII handling:
 *   - full_name and address_line are sealed with the main encryption key on
 *     write via services/pii/seal() — same pattern as the direct-register path.
 *   - full_name_bidx is computed via services/pii/blindIndex() for downstream
 *     duplicate detection.
 *   - mobile stays plaintext CHAR(13) for equality lookup (per the codebase's
 *     encryption policy — see CLAUDE.md).
 *
 * Consent flow:
 *   - New donor via push: consent_data_use=FALSE, consent_pending_since=NOW(),
 *     registration_source='VPS'. Matching engine already skips these
 *     (consent_data_use=TRUE filter in services/matching/donors.js).
 *   - Fire a DONOR_CONSENT_INVITE WhatsApp with a magic-link. Donor lands on
 *     /consent/:token, accepts → consent_data_use flips to TRUE (under
 *     actor_role='donor'; the trg_donors_consent_protect trigger from
 *     migration 099 enforces "only donor themselves can grant").
 *   - No accept in 14 days → nightly purge job scrubs the row via eraseDonor().
 *
 * Blood-group handling (PR (a) behavior — PR (b) turns this into full HITL):
 *   - First push for a donor with no verified value: write blood_group_verified
 *     from the push. Attributed to the pushing institution.
 *   - Push carries the SAME verified value already on the donor: no-op.
 *   - Push carries a DIFFERENT verified value: don't overwrite. Log an audit
 *     event 'BLOOD_GROUP_DISCREPANCY_DEFERRED'. PR (b) will convert these
 *     rows into full DP-state discrepancies for HITL resolution.
 */
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContextRaw } = require('../middleware/rlsContext');
const { seal, open, blindIndex } = require('../services/pii');
const { normaliseIndianMobile } = require('../utils/phone');
const { sendNotification } = require('../services/notifications');
const setupSvc = require('../services/users/setup');

const router = express.Router();

// ── Partner-key resolution + HMAC verify ────────────────────────────────────
// Reads the two required headers, looks up the partner_key row, opens the
// sealed hmac_secret, and timingSafeEqual against sha256=<hex>. On success
// attaches req.partner = { partner_key, vendor_partner_id, institution_id }.
async function verifyVendorHmacMw(req, res, next) {
  const partnerKey = req.headers['x-raktify-partner-key'];
  const sigHeader = req.headers['x-raktify-signature'];
  if (!partnerKey || typeof partnerKey !== 'string') {
    return res.status(401).json({ error: 'missing_partner_key' });
  }
  if (!sigHeader || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
    return res.status(401).json({ error: 'missing_signature' });
  }
  if (!/^pk_[A-Za-z0-9_-]{16,}$/.test(partnerKey)) {
    return res.status(401).json({ error: 'invalid_partner_key_format' });
  }

  let row;
  try {
    const r = await pool.query(
      `SELECT partner_key, vendor_partner_id, institution_id, hmac_secret,
              is_active, is_sandbox, created_by
         FROM partner_keys WHERE partner_key = $1`,
      [partnerKey],
    );
    if (r.rowCount === 0) {
      logger.warn({ event: 'vendor_webhook_unknown_key', partnerKey }, 'unknown partner_key');
      return res.status(401).json({ error: 'unknown_partner_key' });
    }
    row = r.rows[0];
  } catch (err) {
    logger.error({ err: err.message }, 'partner_key lookup failed');
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!row.is_active) {
    return res.status(403).json({ error: 'partner_key_revoked' });
  }

  // hmac_secret is stored sealed; open() decrypts it. Cache miss cost is one
  // AES-GCM decrypt per request — negligible.
  let secret;
  try {
    secret = open(row.hmac_secret);
  } catch (err) {
    logger.error({ err: err.message, partnerKey }, 'partner_key hmac_secret decrypt failed');
    return res.status(500).json({ error: 'secret_open_failed' });
  }
  if (!secret) return res.status(500).json({ error: 'secret_missing' });

  const provided = sigHeader.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');
  if (provided.length !== expected.length) {
    logger.warn({ event: 'vendor_webhook_hmac_mismatch', partnerKey }, 'HMAC length mismatch');
    return res.status(401).json({ error: 'signature_mismatch' });
  }
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    ok = false;
  }
  if (!ok) {
    logger.warn({ event: 'vendor_webhook_hmac_mismatch', partnerKey }, 'HMAC verification failed');
    return res.status(401).json({ error: 'signature_mismatch' });
  }

  req.partner = {
    partnerKey: row.partner_key,
    vendorPartnerId: row.vendor_partner_id,
    institutionId: row.institution_id,
    createdBy: row.created_by,
    isSandbox: row.is_sandbox === true,
  };
  next();
}

// Resolve a platform_user id to attribute vendor-pushed writes to:
// partner_keys.created_by (the admin who provisioned the key) → any
// super_admin as fallback → null if the DB has no admins at all (should not
// happen in prod). The trigger fn_donation_creates_inventory requires this
// so the auto-created blood_inventory row has a non-null status_changed_by.
async function resolveAttributedUserId(client, createdBy) {
  if (createdBy) return createdBy;
  const r = await client.query(
    `SELECT id FROM platform_users WHERE role IN ('super_admin','ngo_admin') ORDER BY created_at ASC LIMIT 1`,
  );
  return r.rowCount > 0 ? r.rows[0].id : null;
}

// ── Idempotency helper ──────────────────────────────────────────────────────
// Not a middleware because the handler needs to conditionally write the
// outcome row at the end. Two exported halves: check + record.
async function checkIdempotent(client, partnerKey, vendorEventId, endpoint) {
  const r = await client.query(
    `SELECT result_status, result_action, raktify_donor_id, error_code
       FROM vendor_events
      WHERE partner_key = $1 AND vendor_event_id = $2 AND endpoint = $3`,
    [partnerKey, vendorEventId, endpoint],
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}
async function recordIdempotent(
  client,
  partnerKey,
  vendorEventId,
  endpoint,
  { status, action, donorId = null, errorCode = null },
) {
  await client.query(
    `INSERT INTO vendor_events
       (partner_key, vendor_event_id, endpoint, result_status, result_action,
        raktify_donor_id, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (partner_key, vendor_event_id) DO NOTHING`,
    [partnerKey, vendorEventId, endpoint, status, action, donorId, errorCode],
  );
}

// ── Schemas ────────────────────────────────────────────────────────────────
// Vendor payloads are a SUPERSET of what we require — unknown fields are
// silently dropped by Zod's default parse (no `.strict()`). Required fields
// are Raktify's minimum to run.
const donorRegistrationSchema = z.object({
  vendor_event_id: z.string().min(1).max(255),
  event_time: z.string().datetime(),
  mobile: z.string(),
  full_name: z.string().min(2).max(200),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['M', 'F', 'O']),
  blood_group: z.string().optional(), // e.g. 'A+', 'O-' — resolved to blood_groups.id
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .optional(),
  village_id: z.number().int().positive().optional(),
  address_line: z.string().optional(),
  abha_id: z.string().length(17).optional(),
  aadhaar_last4: z.string().length(4).optional(),
  preferred_language: z.enum(['mr', 'hi', 'en']).optional(),
  consent_captured_at: z.string().datetime().optional(), // vendor-side "share with Raktify" tick
});

const donationSchema = z.object({
  vendor_event_id: z.string().min(1).max(255),
  event_time: z.string().datetime(),
  donor_mobile: z.string(),
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Component code as it appears in blood_components.code (WB, PRBC, FFP, PLT,
  // CRYO, ...). We validate against blood_components at runtime rather than a
  // fixed enum here — the reference table is the source of truth and lets us
  // accept new components without a code change here.
  component_code: z.string().min(1).max(8),
  volume_ml: z.number().int().positive().max(1000),
  isbt_barcode: z.string().min(3).max(50), // required for verified donations
  hb_gdl: z.number().optional(),
});

// ── POST /webhooks/v1/donor-registration ────────────────────────────────────
router.post('/donor-registration', verifyVendorHmacMw, async (req, res) => {
  const parsed = donorRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const data = parsed.data;
  const mobile = normaliseIndianMobile(data.mobile);
  if (!mobile) return res.status(422).json({ error: 'invalid_mobile' });

  const endpoint = 'donor-registration';

  // Idempotency check (short-circuit before any state changes).
  const cached = await checkIdempotent(
    pool,
    req.partner.partnerKey,
    data.vendor_event_id,
    endpoint,
  );
  if (cached) {
    return res.status(cached.result_status || 202).json({
      raktify_donor_id: cached.raktify_donor_id,
      idempotent_replay: true,
      action: cached.result_action,
    });
  }

  // Resolve blood_group code (A+, O-, ...) to blood_groups.id.
  let bloodGroupId = null;
  if (data.blood_group) {
    const bg = await pool.query(
      `SELECT id FROM blood_groups WHERE UPPER(TRIM(code)) = UPPER(TRIM($1))`,
      [data.blood_group],
    );
    if (bg.rowCount === 0) {
      // Non-fatal: proceed without a verified group. Record as such.
      logger.warn(
        { blood_group: data.blood_group, partnerKey: req.partner.partnerKey },
        'unknown blood_group value in push — proceeding without verification',
      );
    } else {
      bloodGroupId = bg.rows[0].id;
    }
  }

  try {
    const result = await withRlsContextRaw(
      {
        actor_role: 'registration',
        change_reason: `vendor push [${req.partner.partnerKey}] — donor-registration`,
      },
      async (c) => {
        // 1. Look up existing donor by mobile.
        const existingR = await c.query(
          `SELECT id, platform_user_id, consent_data_use, consent_pending_since,
                  blood_group_verified, blood_group_verification_state,
                  blood_group_discrepancy_new
             FROM donors WHERE mobile = $1`,
          [mobile],
        );

        if (existingR.rowCount > 0) {
          const existing = existingR.rows[0];

          // 1a. Blood-group HITL state machine (see migration 309).
          //
          //   UV + push has value      → UV→VE (trust first attestation)
          //   VE + same value          → no-op
          //   VE + different value     → VE→DP (flag discrepancy for HITL)
          //   DP + same value          → no-op (either matches existing or
          //                              matches discrepancy_new — dedup)
          //   DP + third distinct val  → 409, don't touch state (see plan)
          //   LK                       → ignore blood_group (audit + refresh
          //                              other fields)
          if (bloodGroupId) {
            const state = existing.blood_group_verification_state;
            const currentValue = existing.blood_group_verified;
            const disputed = existing.blood_group_discrepancy_new;

            if (state === 'LK') {
              // Locked. Never write blood_group_verified — even if the push
              // value happens to match, don't touch it. Just audit.
              logger.info(
                {
                  event: 'BLOOD_GROUP_PUSH_IGNORED_LOCKED',
                  donor_id: existing.id,
                  locked_value: currentValue,
                  pushed_value: bloodGroupId,
                  pushed_by_partner_key: req.partner.partnerKey,
                  source_institution_id: req.partner.institutionId,
                },
                'blood-group push ignored — donor state=LK',
              );
            } else if (state === 'UV') {
              // First attestation — UV → VE.
              await c.query(
                `UPDATE donors
                    SET blood_group_verified = $1,
                        blood_group_verified_at = NOW(),
                        blood_group_verified_by = $2,
                        blood_group_verification_state = 'VE'
                  WHERE id = $3`,
                [bloodGroupId, req.partner.institutionId, existing.id],
              );
              logger.info(
                {
                  event: 'BLOOD_GROUP_ATTESTED',
                  donor_id: existing.id,
                  value: bloodGroupId,
                  source_institution_id: req.partner.institutionId,
                },
                'blood-group first-attestation UV→VE',
              );
            } else if (state === 'VE' && currentValue !== bloodGroupId) {
              // Discrepancy — VE → DP.
              await c.query(
                `UPDATE donors
                    SET blood_group_verification_state = 'DP',
                        blood_group_discrepancy_new = $1,
                        blood_group_discrepancy_source_id = $2
                  WHERE id = $3`,
                [bloodGroupId, req.partner.institutionId, existing.id],
              );
              logger.warn(
                {
                  event: 'BLOOD_GROUP_DISCREPANCY_RAISED',
                  donor_id: existing.id,
                  existing_value: currentValue,
                  proposed_value: bloodGroupId,
                  source_institution_id: req.partner.institutionId,
                  pushed_by_partner_key: req.partner.partnerKey,
                },
                'blood-group discrepancy VE→DP — awaiting HITL',
              );
            } else if (state === 'DP') {
              // Already-pending discrepancy. If the incoming value matches
              // either the current or the disputed value, treat as dedup.
              // A THIRD distinct value = reject — force HITL first.
              if (bloodGroupId !== currentValue && bloodGroupId !== disputed) {
                logger.warn(
                  {
                    event: 'BLOOD_GROUP_DISCREPANCY_REJECTED_ADDITIONAL',
                    donor_id: existing.id,
                    existing_value: currentValue,
                    disputed_value: disputed,
                    rejected_value: bloodGroupId,
                    pushed_by_partner_key: req.partner.partnerKey,
                  },
                  'third blood-group value rejected while state=DP',
                );
                const err = new Error('blood_group_discrepancy_pending');
                err.status = 409;
                err.code = 'blood_group_discrepancy_pending';
                throw err;
              }
              // Else — dedup, no-op.
            }
            // else state === 'VE' && currentValue === bloodGroupId → no-op
          }

          // 1b. Refresh the push-provenance columns (don't touch consent
          //     state — the donor's own /consent/accept flow owns that).
          await c.query(
            `UPDATE donors
                SET pushed_by_partner_key = $1,
                    consent_pending_since = CASE
                      WHEN consent_data_use = TRUE THEN NULL
                      WHEN consent_pending_since IS NOT NULL THEN consent_pending_since
                      ELSE NOW()
                    END
              WHERE id = $2`,
            [req.partner.partnerKey, existing.id],
          );

          const action =
            existing.consent_data_use === true ? 'updated_consented' : 'updated_pending';

          await recordIdempotent(c, req.partner.partnerKey, data.vendor_event_id, endpoint, {
            status: 202,
            action,
            donorId: existing.id,
          });
          return { donorId: existing.id, action, isNew: false };
        }

        // 2. New donor — INSERT + platform_users + fire consent-invite WA.
        //    First create the platform_users row so the consent-accept flow
        //    has an actor_user_id to run under (trg_donors_consent_protect
        //    from migration 099 requires this).
        const passwordHash = await setupSvc.unusablePasswordHash();
        const puR = await c.query(
          `INSERT INTO platform_users
             (role, mobile, password_hash, password_set_at, force_password_change)
           VALUES ('donor', $1, $2, NOW(), TRUE)
           ON CONFLICT (mobile) WHERE mobile IS NOT NULL AND role = 'donor'
           DO UPDATE SET mobile = EXCLUDED.mobile
           RETURNING id`,
          [mobile, passwordHash],
        );
        const platformUserId = puR.rows[0].id;

        // 3. Insert donor row. Consent starts PENDING.
        const sealedName = seal(data.full_name);
        const sealedAddr = seal(data.address_line || null);
        const nameBidx = blindIndex(data.full_name);

        const donorR = await c.query(
          `INSERT INTO donors
             (mobile, mobile_verified, full_name, full_name_bidx,
              date_of_birth, gender, abha_id, aadhaar_last4,
              preferred_language, village_id, address_line, pincode,
              blood_group_verified, blood_group_verified_at, blood_group_verified_by,
              blood_group_verification_state,
              consent_data_use, consent_pending_since,
              platform_user_id, registration_source,
              pushed_by_partner_key, is_sandbox)
           VALUES
             ($1, FALSE, $2, $3,
              $4, $5, $6, $7,
              $8, $9, $10, $11,
              $12, CASE WHEN $12::smallint IS NULL THEN NULL ELSE NOW() END, $13,
              CASE WHEN $12::smallint IS NULL THEN 'UV' ELSE 'VE' END,
              FALSE, NOW(),
              $14, 'VPS',
              $15, $16)
           RETURNING id`,
          [
            mobile,
            sealedName,
            nameBidx,
            data.date_of_birth,
            data.gender,
            data.abha_id || null,
            data.aadhaar_last4 || null,
            data.preferred_language || 'mr',
            data.village_id || null,
            sealedAddr,
            data.pincode || null,
            bloodGroupId,
            bloodGroupId ? req.partner.institutionId : null,
            platformUserId,
            req.partner.partnerKey,
            req.partner.isSandbox,
          ],
        );
        const donorId = donorR.rows[0].id;

        // 4. Generate a consent JWT (single-use, 30-day TTL). Stored in the
        //    donor's platform_users setup_token_hash so the consent route can
        //    validate + invalidate uniformly with existing infra.
        const { token: consentToken } = await setupSvc.generateSetupToken(
          c,
          platformUserId,
          30, // 30-day TTL for consent (setup uses 7 days by default; consent gets more slack)
        );

        await recordIdempotent(c, req.partner.partnerKey, data.vendor_event_id, endpoint, {
          status: 202,
          action: 'created',
          donorId,
        });

        return { donorId, action: 'created', isNew: true, consentToken, platformUserId };
      },
    );

    // 5. Fire the consent-invite WhatsApp (best-effort; row is committed).
    //    Skip for sandbox pushes so vendors testing the integration don't
    //    spam real mobile numbers with test data. The donor row still gets
    //    the consentToken via the platform_users setup_token_hash — a
    //    vendor's test loop can still fetch the dev_consent_url from the
    //    response body and complete the accept/decline flow manually.
    if (result.isNew && result.consentToken && !req.partner.isSandbox) {
      // Resolve the source institution's display name for the WA body.
      const instR = await pool.query(
        `SELECT display_name, shortname FROM institutions WHERE id = $1`,
        [req.partner.institutionId],
      );
      const sourceDisplay =
        instR.rows[0]?.display_name || instR.rows[0]?.shortname || 'a blood bank';
      const firstName = (data.full_name || '').split(/\s+/)[0] || 'donor';

      try {
        await sendNotification({
          recipientId: mobile,
          templateType: 'DONOR_CONSENT_INVITE',
          variables: {
            donor_first_name: firstName,
            source_institution_display_name: sourceDisplay,
            consent_token: result.consentToken,
          },
          channel: 'WA',
          language: data.preferred_language || 'mr',
        });
      } catch (err) {
        logger.error(
          {
            event: 'vendor_webhook_consent_invite_send_failed',
            donor_id: result.donorId,
            err: err.message,
          },
          'DONOR_CONSENT_INVITE send failed — donor row still created',
        );
      }
    }

    // Expose the consent URL in the response when either (a) we're in dev,
    // or (b) the caller is a sandbox partner_key. Sandbox callers need the
    // URL to walk through the accept/decline flow themselves during
    // testing (we don't send them a real WhatsApp).
    const echoConsentUrl =
      result.isNew &&
      result.consentToken &&
      (env.nodeEnv === 'development' || req.partner.isSandbox);

    res.status(202).json({
      raktify_donor_id: result.donorId,
      action: result.action,
      is_new: result.isNew,
      consent_status: result.isNew
        ? 'pending'
        : result.action === 'updated_consented'
          ? 'active'
          : 'pending',
      ...(req.partner.isSandbox ? { sandbox: true } : {}),
      ...(echoConsentUrl
        ? { consent_url: `${env.frontendUrl}/consent/${result.consentToken}` }
        : {}),
    });
  } catch (err) {
    // Semantic errors that the client can act on — 409, not 500.
    if (err.code === 'blood_group_discrepancy_pending') {
      try {
        await recordIdempotent(pool, req.partner.partnerKey, data.vendor_event_id, endpoint, {
          status: 409,
          action: 'rejected',
          errorCode: err.code,
        });
      } catch {
        /* ignore */
      }
      return res.status(409).json({
        error: 'blood_group_discrepancy_pending',
        hint: 'Two blood banks have already attested different blood groups for this donor. Wait for an NGO admin to resolve the discrepancy in /admin before pushing again.',
      });
    }

    logger.error(
      {
        err: err.message,
        partnerKey: req.partner.partnerKey,
        vendor_event_id: data.vendor_event_id,
      },
      'vendor donor-registration failed',
    );
    // Best-effort idempotency-record for the failure so retries with the same
    // vendor_event_id don't repeat the same crash.
    try {
      await recordIdempotent(pool, req.partner.partnerKey, data.vendor_event_id, endpoint, {
        status: 500,
        action: 'rejected',
        errorCode: err.code || 'internal_error',
      });
    } catch {
      /* ignore secondary write failure */
    }
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /webhooks/v1/donation ──────────────────────────────────────────────
router.post('/donation', verifyVendorHmacMw, async (req, res) => {
  const parsed = donationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const data = parsed.data;
  const donorMobile = normaliseIndianMobile(data.donor_mobile);
  if (!donorMobile) return res.status(422).json({ error: 'invalid_donor_mobile' });

  const endpoint = 'donation';

  const cached = await checkIdempotent(
    pool,
    req.partner.partnerKey,
    data.vendor_event_id,
    endpoint,
  );
  if (cached) {
    return res.status(cached.result_status || 202).json({
      raktify_donor_id: cached.raktify_donor_id,
      idempotent_replay: true,
      action: cached.result_action,
    });
  }

  try {
    const result = await withRlsContextRaw(
      {
        actor_role: 'registration',
        change_reason: `vendor push [${req.partner.partnerKey}] — donation`,
      },
      async (c) => {
        // Resolve donor by mobile — do NOT auto-create; vendor must push
        // donor-registration first (409 is the signal to re-order).
        const donorR = await c.query(
          `SELECT id, blood_group_verified FROM donors WHERE mobile = $1`,
          [donorMobile],
        );
        if (donorR.rowCount === 0) {
          const err = new Error('donor_not_found');
          err.status = 409;
          err.code = 'donor_not_found';
          throw err;
        }
        const donor = donorR.rows[0];

        // Resolve component_code → blood_components.id.
        const compR = await c.query(
          `SELECT id FROM blood_components WHERE UPPER(code) = UPPER($1)`,
          [data.component_code],
        );
        if (compR.rowCount === 0) {
          const err = new Error('unknown_component');
          err.status = 422;
          err.code = 'unknown_component';
          throw err;
        }
        const componentId = compR.rows[0].id;

        // Resolve who to attribute this write to. Cascades to the
        // auto-created blood_inventory row (trigger fn_donation_creates_inventory
        // takes NEW.recorded_by_user_id → status_changed_by, which is NOT NULL).
        const attributedUserId = await resolveAttributedUserId(c, req.partner.createdBy);
        if (!attributedUserId) {
          const err = new Error('no_admin_to_attribute');
          err.status = 500;
          err.code = 'no_admin_to_attribute';
          throw err;
        }

        // trust_level='V' (partner-attested verified), source='PT' (partner
        // system). Constraints require blood_bank_id + isbt_barcode when
        // trust_level='V' — both provided via req.partner and data.
        const dhR = await c.query(
          `INSERT INTO donation_history
             (donor_id, blood_bank_id, trust_level, source,
              collection_date, component_id, volume_ml,
              isbt_barcode, hb_gdl, recorded_by_user_id)
           VALUES ($1, $2, 'V', 'PT',
              $3, $4, $5,
              $6, $7, $8)
           RETURNING id`,
          [
            donor.id,
            req.partner.institutionId,
            data.collection_date,
            componentId,
            data.volume_ml,
            data.isbt_barcode,
            data.hb_gdl || null,
            attributedUserId,
          ],
        );

        await recordIdempotent(c, req.partner.partnerKey, data.vendor_event_id, endpoint, {
          status: 202,
          action: 'created',
          donorId: donor.id,
        });
        return { donationId: dhR.rows[0].id, donorId: donor.id };
      },
    );

    res.status(202).json({
      raktify_donor_id: result.donorId,
      raktify_donation_id: result.donationId,
      action: 'created',
    });
  } catch (err) {
    if (err.code === 'donor_not_found') {
      // Record failure for idempotency, then reject.
      try {
        await recordIdempotent(pool, req.partner.partnerKey, data.vendor_event_id, endpoint, {
          status: 409,
          action: 'rejected',
          errorCode: 'donor_not_found',
        });
      } catch {
        /* ignore */
      }
      return res.status(409).json({
        error: 'donor_not_found',
        hint: 'Push donor-registration first, then retry this donation event.',
      });
    }
    if (err.code === 'unknown_component') {
      try {
        await recordIdempotent(pool, req.partner.partnerKey, data.vendor_event_id, endpoint, {
          status: 422,
          action: 'rejected',
          errorCode: 'unknown_component',
        });
      } catch {
        /* ignore */
      }
      return res.status(422).json({
        error: 'unknown_component',
        hint: 'component_code must match a value in blood_components.code (WB, PRBC, FFP, PLT, CRYO, …).',
      });
    }
    logger.error(
      {
        err: err.message,
        partnerKey: req.partner.partnerKey,
        vendor_event_id: data.vendor_event_id,
      },
      'vendor donation push failed',
    );
    try {
      await recordIdempotent(pool, req.partner.partnerKey, data.vendor_event_id, endpoint, {
        status: 500,
        action: 'rejected',
        errorCode: err.code || 'internal_error',
      });
    } catch {
      /* ignore */
    }
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
