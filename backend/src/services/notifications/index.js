/**
 * Single chokepoint for ALL outgoing donor/coordinator/hospital comms.
 * Per Section 6.6 of the spec: "Never call MSG91 directly from route handlers."
 *
 * sendNotification({ recipientId, templateType, variables, channel, language, emergencyOverride })
 *   - delegates the wire transmission to the provider (console | msg91)
 *   - persists ONE notification_log row per attempt regardless of provider
 *     success/failure so we have a complete outbound audit
 *   - returns { success, provider, messageId, deliveryStatus, notificationLogId }
 *
 * Resolution: recipientId may be a UUID (donors.id / platform_users.id /
 * institutions.id) OR a +91 mobile string. We try to resolve it to a
 * donor first; if that fails it's stored as recipient_external_mobile.
 *
 * Opt-in / DND enforcement is intentionally a TODO — when MSG91 lands in
 * Phase 6, this chokepoint adds the donors.{whatsapp,sms}_opted_in checks
 * and the DND hours window. The spec calls for fallback chains too
 * (WA -> SM -> CA on Critical) — that machinery lands with MSG91 wiring.
 */
const { pool } = require('../../config/db');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { isValidIndianMobile } = require('../../utils/phone');

let provider;
if (env.providers.notifications === 'msg91') {
  provider = require('./msg91Provider');
} else if (env.providers.notifications === 'whatsapp_cloud') {
  provider = require('./whatsappCloudProvider');
} else {
  provider = require('./consoleProvider');
}

// notification_log.provider is CHAR(2): M9 MSG91, LO local-console,
// WC WhatsApp Cloud (migration 250). Default to LO for the console provider.
const PROVIDER_CODE = { msg91: 'M9', whatsapp_cloud: 'WC' };

async function resolveRecipient(client, recipientId) {
  if (!recipientId) return { recipient_external_mobile: null };
  // UUID? try donors first, then platform_users, then institutions.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(recipientId))) {
    const donor = await client.query(`SELECT id, mobile FROM donors WHERE id = $1 LIMIT 1`, [
      recipientId,
    ]);
    if (donor.rowCount > 0) {
      return {
        recipient_donor_id: donor.rows[0].id,
        recipient_external_mobile: donor.rows[0].mobile,
      };
    }
    const user = await client.query(`SELECT id, mobile FROM platform_users WHERE id = $1 LIMIT 1`, [
      recipientId,
    ]);
    if (user.rowCount > 0) {
      return {
        recipient_user_id: user.rows[0].id,
        recipient_external_mobile: user.rows[0].mobile,
      };
    }
    const inst = await client.query(
      `SELECT id, primary_contact_mobile FROM institutions WHERE id = $1 LIMIT 1`,
      [recipientId],
    );
    if (inst.rowCount > 0) {
      return {
        recipient_institution_id: inst.rows[0].id,
        recipient_external_mobile: inst.rows[0].primary_contact_mobile,
      };
    }
    return {};
  }
  // Mobile string?
  if (isValidIndianMobile(recipientId)) {
    const donor = await client.query(`SELECT id FROM donors WHERE mobile = $1 LIMIT 1`, [
      recipientId,
    ]);
    if (donor.rowCount > 0) {
      return { recipient_donor_id: donor.rows[0].id, recipient_external_mobile: recipientId };
    }
    const user = await client.query(`SELECT id FROM platform_users WHERE mobile = $1 LIMIT 1`, [
      recipientId,
    ]);
    if (user.rowCount > 0) {
      return { recipient_user_id: user.rows[0].id, recipient_external_mobile: recipientId };
    }
    return { recipient_external_mobile: recipientId };
  }
  return { recipient_external_mobile: null };
}

async function sendNotification({
  recipientId,
  templateType,
  variables = {},
  channel = 'WA', // WA | SM | CA | EM
  language = 'mr',
  emergencyOverride = false,
  relatedRequestId = null,
  relatedAlertId = null,
}) {
  // 1. Resolve the recipient up front. Needs actor_role='system' so the
  //    donors/platform_users/institutions RLS SELECT policies permit the read.
  //    The resolved mobile is handed to the provider AND used for the log row.
  let recipient = {};
  {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('raktify.actor_role', 'system', TRUE)`);
      recipient = await resolveRecipient(c, recipientId);
      await c.query('COMMIT');
    } catch (err) {
      try {
        await c.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      logger.error({ err: err.message, templateType }, 'notification recipient resolve failed');
    } finally {
      c.release();
    }
  }

  // 2. Dispatch via the active provider, giving it the resolved phone number.
  const dispatchResult = await provider.send({
    recipientId,
    recipientMobile: recipient.recipient_external_mobile || null,
    templateType,
    variables,
    channel,
    language,
    emergencyOverride,
  });

  // 3. Persist to notification_log regardless of provider outcome.
  //    SET LOCAL actor_role='system' so the notif_system_insert RLS policy
  //    permits the INSERT (sendNotification runs from routes, jobs, the bot).
  let notificationLogId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('raktify.actor_role', 'system', TRUE)`);
    const r = await client.query(
      `INSERT INTO notification_log (
         recipient_donor_id, recipient_user_id, recipient_institution_id,
         recipient_external_mobile,
         channel, template_type, language, msg91_template_id, template_variables,
         related_request_id, related_alert_id,
         provider, provider_message_id,
         delivery_status, was_dnd_overridden, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id`,
      [
        recipient.recipient_donor_id || null,
        recipient.recipient_user_id || null,
        recipient.recipient_institution_id || null,
        recipient.recipient_external_mobile || null,
        channel,
        templateType,
        language,
        env.msg91.templates?.[templateType?.toLowerCase()] || null,
        JSON.stringify(variables),
        relatedRequestId,
        relatedAlertId,
        PROVIDER_CODE[provider.providerName] || 'LO',
        dispatchResult.messageId || null,
        dispatchResult.deliveryStatus || (dispatchResult.success ? 'SE' : 'FA'),
        emergencyOverride,
        // Until now only the delivery webhook ever filled this column, so a
        // send that failed at dispatch left an 'FA' row with no stated cause —
        // which is why three camp reminders could look healthy while sending
        // nothing for a whole release.
        dispatchResult.failureReason || null,
      ],
    );
    notificationLogId = r.rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    // Never break the upstream send if logging fails.
    logger.error({ err: err.message, templateType, channel }, 'notification_log write failed');
  } finally {
    client.release();
  }

  // 4. A confirmed recipient-side rejection is worth REMEMBERING, not just
  //    reporting. Meta gives no way to ask whether a number is on WhatsApp, so
  //    a rejected send is the only evidence that exists — and throwing it away
  //    means asking the same question again on every future send.
  //
  //    Flipping preferred_contact_channel to 'SM' here is what makes the SMS
  //    channel a switch rather than a project: donors.sms_opted_in already
  //    defaults TRUE and the column already CHECKs IN ('WA','SM','CA'), so on
  //    the day DLT registration clears, the list of exactly who needs SMS has
  //    already been gathered passively instead of surveyed.
  //
  //    Deliberately narrow: only the two reasons that are facts about the
  //    RECIPIENT. An unapproved template or a Meta outage must never move a
  //    donor off WhatsApp — see classifyFailure() in whatsappCloudProvider.
  const recipientRejected =
    channel === 'WA' &&
    recipient.recipient_donor_id &&
    (dispatchResult.reason === 'no_whatsapp' || dispatchResult.reason === 'opted_out');

  if (recipientRejected) {
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await c2.query(`SELECT set_config('raktify.actor_role', 'system', TRUE)`);
      await c2.query(`SELECT set_config('raktify.change_reason', $1, TRUE)`, [
        `whatsapp ${dispatchResult.reason} — routing to SMS`,
      ]);
      await c2.query(
        `UPDATE donors
            SET whatsapp_opted_in = FALSE,
                preferred_contact_channel = CASE
                  WHEN preferred_contact_channel = 'WA' THEN 'SM'
                  ELSE preferred_contact_channel
                END,
                updated_at = clock_timestamp()
          WHERE id = $1
            AND (whatsapp_opted_in OR preferred_contact_channel = 'WA')`,
        [recipient.recipient_donor_id],
      );
      await c2.query('COMMIT');
    } catch (err) {
      try {
        await c2.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      // Same rule as the log write: never break the caller over bookkeeping.
      logger.error(
        { err: err.message, templateType, reason: dispatchResult.reason },
        'whatsapp unreachable — donor channel update failed',
      );
    } finally {
      c2.release();
    }
  }

  return { ...dispatchResult, notificationLogId };
}

module.exports = { sendNotification, providerName: provider.providerName };
