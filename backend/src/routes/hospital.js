/**
 * Hospital-portal endpoints that don't belong under /requests.
 *
 *   GET  /hospital/pending-bb-admin       — surfaces the child BB admin's
 *                                            plaintext setup URL (if the HO
 *                                            was onboarded with in-house BB
 *                                            and the BB admin hasn't
 *                                            consumed the token yet).
 *   POST /hospital/pending-bb-admin/resend — re-fires the WhatsApp send to
 *                                            the HO's primary_contact_mobile
 *                                            with the same setup URL.
 *                                            Rate-limited 1/min per hospital.
 *
 * The plaintext token is deliberately never returned to /admin/onboarding
 * endpoints — only to the hospital that owns the parent institution.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { sendNotification } = require('../services/notifications');

const router = express.Router();

// ── GET /hospital/pending-bb-admin (hospital) ────────────────────────────
router.get('/pending-bb-admin', verifyJWT, requireRole('hospital'), async (req, res) => {
  const hospId = req.user.institutionId;
  if (!hospId) return res.status(403).json({ error: 'hospital_user_missing_institution' });

  const parentR = await pool.query(
    `SELECT id, display_name, shortname, bb_admin_pending_setup_token,
            parent_institution_id
       FROM institutions WHERE id = $1`,
    [hospId],
  );
  if (parentR.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const parent = parentR.rows[0];
  if (parent.parent_institution_id !== null) {
    return res.json({ pending: false });
  }
  if (!parent.bb_admin_pending_setup_token) {
    return res.json({ pending: false });
  }

  // Fetch the linked BB child + its admin user for label + expiry.
  const childR = await pool.query(
    `SELECT i.id, i.shortname, i.display_name,
            pu.username, pu.setup_token_expires_at, pu.setup_token_used_at
       FROM institutions i
       JOIN platform_users pu ON pu.institution_id = i.id AND pu.role = 'blood_bank'
      WHERE i.parent_institution_id = $1 AND i.kind = 'BB'
      ORDER BY i.created_at ASC
      LIMIT 1`,
    [hospId],
  );
  if (childR.rowCount === 0) return res.json({ pending: false });
  const child = childR.rows[0];

  // Belt-and-braces: if the trigger somehow didn't clear the parent's token
  // after the BB admin consumed theirs, report not-pending anyway.
  if (child.setup_token_used_at) {
    return res.json({ pending: false });
  }

  const setupUrl = `${env.frontendUrl}/setup/${parent.bb_admin_pending_setup_token}`;

  res.json({
    pending: true,
    child_institution: {
      id: child.id,
      shortname: child.shortname,
      display_name: child.display_name,
    },
    username: child.username,
    setup_url: setupUrl,
    expires_at: child.setup_token_expires_at,
  });
});

// ── POST /hospital/pending-bb-admin/resend (hospital) ────────────────────
// Rate limit: 1 request per minute per hospital user. WhatsApp send is
// idempotent from the recipient's perspective (same URL), but a runaway
// resend would burn Meta template quota.
const resendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: 'rate_limit_resend' },
});

router.post(
  '/pending-bb-admin/resend',
  verifyJWT,
  requireRole('hospital'),
  resendLimiter,
  async (req, res) => {
    const hospId = req.user.institutionId;
    if (!hospId) return res.status(403).json({ error: 'hospital_user_missing_institution' });

    const parentR = await pool.query(
      `SELECT id, display_name, shortname, primary_contact_mobile,
              primary_contact_name, bb_admin_pending_setup_token
         FROM institutions WHERE id = $1`,
      [hospId],
    );
    if (parentR.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const parent = parentR.rows[0];
    if (!parent.bb_admin_pending_setup_token) {
      return res.status(409).json({ error: 'no_pending_bb_admin' });
    }

    try {
      const r = await sendNotification({
        recipientId: parent.primary_contact_mobile,
        templateType: 'SETUP_LINK',
        variables: {
          signatory_name: parent.primary_contact_name || 'Admin',
          institution_name: `${parent.display_name} Blood Bank`,
          setup_token: parent.bb_admin_pending_setup_token,
        },
        channel: 'WA',
        language: 'en',
      });
      return res.json({
        sent: Boolean(r?.success),
        provider: r?.provider || null,
        message_id: r?.messageId || null,
      });
    } catch (err) {
      logger.error(
        { event: 'bb_admin_resend_failed', hospId, err: err.message },
        'BB admin activation resend failed',
      );
      return res.status(502).json({ error: 'send_failed' });
    }
  },
);

module.exports = router;
