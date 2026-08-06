/**
 * Donor consent magic-link endpoints — /consent/:token/*
 *
 * A donor who was pushed to Raktify from a blood bank's software (Safetrans,
 * etc.) receives a WhatsApp with a link to https://raktify.choudhari.ngo/consent/<token>.
 * That link surfaces what data Raktify holds and asks the donor to explicitly
 * accept, decline, or wait. This is Raktify's DPDP §7 consent capture — done
 * on Raktify's own screen, not buried in the source BB's paperwork.
 *
 * Endpoints:
 *   GET  /consent/:token/info      — validate token; return decrypted display
 *                                    data for the accept screen.
 *   POST /consent/:token/accept    — flip consent_data_use = TRUE. Runs under
 *                                    actor_role='donor' so the
 *                                    trg_donors_consent_protect trigger
 *                                    (migration 099) accepts the change.
 *   POST /consent/:token/decline   — erase the donor row via eraseDonor()
 *                                    with change_reason='consent_declined'.
 *
 * Token infrastructure REUSED from services/users/setup.js — the same
 * setup_token_hash/expires_at/used_at columns on platform_users hold this
 * consent token. It's a magic-link token; the "setup" name is legacy.
 */
const express = require('express');

const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContextRaw } = require('../middleware/rlsContext');
const { open } = require('../services/pii');
const setupSvc = require('../services/users/setup');
const { eraseDonor } = require('../services/donors/erasure');

const router = express.Router();

function maskMobile(m) {
  if (!m) return null;
  const s = String(m).replace(/\s+/g, '');
  if (s.length < 5) return '••••';
  return `${s.slice(0, -8)}••••${s.slice(-4)}`;
}

// ── GET /consent/:token/info ────────────────────────────────────────────────
router.get('/:token/info', async (req, res) => {
  const v = await setupSvc.validateSetupToken(pool, req.params.token);
  if (!v.ok) {
    return res.status(v.code === 'invalid' ? 404 : 410).json({ error: v.code });
  }
  if (v.user.role !== 'donor') {
    // Consent tokens are only meaningful for donor rows. If someone points a
    // staff-setup token at this endpoint, refuse.
    return res.status(409).json({ error: 'wrong_token_scope' });
  }

  const donorR = await pool.query(
    `SELECT d.id, d.full_name, d.mobile, d.consent_data_use, d.consent_pending_since,
            d.pushed_by_partner_key, d.date_of_birth, d.gender,
            d.blood_group_verified,
            bg.code AS blood_group_code,
            pk.institution_id AS source_institution_id,
            i.display_name AS source_institution_display_name,
            i.shortname AS source_institution_shortname
       FROM donors d
       LEFT JOIN blood_groups bg ON bg.id = d.blood_group_verified
       LEFT JOIN partner_keys pk ON pk.partner_key = d.pushed_by_partner_key
       LEFT JOIN institutions  i ON i.id = pk.institution_id
      WHERE d.platform_user_id = $1`,
    [v.user.id],
  );
  if (donorR.rowCount === 0) return res.status(404).json({ error: 'donor_not_found' });
  const d = donorR.rows[0];

  res.json({
    donor: {
      id: d.id,
      full_name: open(d.full_name),
      masked_mobile: maskMobile(d.mobile),
      date_of_birth: d.date_of_birth,
      gender: d.gender,
      blood_group: d.blood_group_code || null,
      consent_status: d.consent_data_use ? 'active' : 'pending',
      pending_since: d.consent_pending_since,
    },
    source: d.source_institution_display_name
      ? {
          display_name: d.source_institution_display_name,
          shortname: d.source_institution_shortname,
        }
      : null,
    expires_at: v.expires_at,
  });
});

// ── POST /consent/:token/accept ─────────────────────────────────────────────
router.post('/:token/accept', async (req, res) => {
  const v = await setupSvc.validateSetupToken(pool, req.params.token);
  if (!v.ok) {
    return res.status(v.code === 'invalid' ? 404 : 410).json({ error: v.code });
  }
  if (v.user.role !== 'donor') {
    return res.status(409).json({ error: 'wrong_token_scope' });
  }

  // Run under actor_role='donor' + actor_user_id=donor's platform_user_id so
  // trg_donors_consent_protect (migration 099) accepts the consent grant.
  try {
    const result = await withRlsContextRaw(
      {
        actor_role: 'donor',
        actor_user_id: v.user.id,
        change_reason: 'consent accepted via magic-link',
      },
      async (c) => {
        // Flip consent + clear pending marker in one shot. consent_given_at
        // is stamped by fn_donors_touch (migration 008) on the FALSE→TRUE
        // transition when it's still NULL.
        const uR = await c.query(
          `UPDATE donors
              SET consent_data_use = TRUE,
                  consent_pending_since = NULL
            WHERE platform_user_id = $1
              AND consent_data_use = FALSE
          RETURNING id`,
          [v.user.id],
        );
        // Mark the magic-link token as used so a second click doesn't
        // re-fire the flow.
        await c.query(
          `UPDATE platform_users
              SET setup_token_used_at = NOW()
            WHERE id = $1
              AND setup_token_used_at IS NULL`,
          [v.user.id],
        );
        return uR.rowCount === 1 ? { donor_id: uR.rows[0].id, already: false } : { already: true };
      },
    );
    return res.json({ status: 'accepted', ...result });
  } catch (err) {
    logger.error({ err: err.message, platform_user_id: v.user.id }, 'consent accept failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /consent/:token/decline ────────────────────────────────────────────
router.post('/:token/decline', async (req, res) => {
  const v = await setupSvc.validateSetupToken(pool, req.params.token);
  if (!v.ok) {
    return res.status(v.code === 'invalid' ? 404 : 410).json({ error: v.code });
  }
  if (v.user.role !== 'donor') {
    return res.status(409).json({ error: 'wrong_token_scope' });
  }

  // Find the donor row for this platform_user.
  const donorR = await pool.query(`SELECT id FROM donors WHERE platform_user_id = $1`, [v.user.id]);
  if (donorR.rowCount === 0) return res.status(404).json({ error: 'donor_not_found' });
  const donorId = donorR.rows[0].id;

  try {
    const result = await withRlsContextRaw(
      { actor_role: 'donor', actor_user_id: v.user.id, change_reason: 'consent_declined' },
      async (c) => {
        // Consume the token first so a second decline doesn't try to erase
        // an already-erased row.
        await c.query(`UPDATE platform_users SET setup_token_used_at = NOW() WHERE id = $1`, [
          v.user.id,
        ]);
        return await eraseDonor(c, donorId);
      },
    );
    if (!result.ok) {
      return res
        .status(500)
        .json({ error: result.error || 'decline_failed', detail: result.detail });
    }
    return res.json({ status: 'declined', erased_at: result.erased_at });
  } catch (err) {
    logger.error({ err: err.message, donor_id: donorId }, 'consent decline failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
