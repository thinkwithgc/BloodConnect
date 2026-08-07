/**
 * camp_donor_thankyou — daily at 20:00 IST. Post-camp thank-you WhatsApp
 * to donors who actually attended (cr.status='AT'). Fires the
 * CAMP_DONOR_THANKYOU Meta template.
 *
 * Targets camps whose scheduled_date is yesterday. Deliberately does NOT
 * gate on camp status — a camp that was scheduled yesterday but is still
 * PL (organizer hasn't clicked Complete yet) can still have valid AT
 * registrations; we thank those donors regardless. If a camp is CA
 * (cancelled), no rows will have status='AT' so nothing fires — safe.
 *
 * Same opt-in + dedup + chokepoint-safe pattern as the other camp jobs.
 */
const { pool } = require('../../../config/db');
const { withRlsContextRaw } = require('../../../middleware/rlsContext');
const { sendNotification } = require('../../notifications');
const { open } = require('../../pii');
const logger = require('../../../config/logger');

const TEMPLATE_TYPE = 'CAMP_DONOR_THANKYOU';

function firstName(fullName) {
  if (!fullName) return 'friend';
  return String(fullName).trim().split(/\s+/)[0] || 'friend';
}

async function run() {
  const camps = await pool.query(
    `SELECT c.id, c.name, c.slug, c.scheduled_date
       FROM donation_camps c
      WHERE c.scheduled_date = CURRENT_DATE - INTERVAL '1 day'
        AND c.status <> 'CA'`,
  );

  const summary = {
    camps: camps.rowCount,
    candidates: 0,
    sent: 0,
    skipped_dedup: 0,
    skipped_opt_out: 0,
    failed: 0,
  };

  for (const camp of camps.rows) {
    const donors = await pool.query(
      `SELECT d.id AS donor_id, d.full_name, d.mobile, d.preferred_language, d.whatsapp_opted_in
         FROM camp_registrations cr
         JOIN donors d ON d.id = cr.donor_id
        WHERE cr.camp_id = $1
          AND cr.status = 'AT'
          AND d.is_active = TRUE`,
      [camp.id],
    );

    for (const dr of donors.rows) {
      summary.candidates += 1;
      if (!dr.whatsapp_opted_in) {
        summary.skipped_opt_out += 1;
        continue;
      }
      const already = await pool.query(
        `SELECT 1 FROM notification_log
          WHERE template_type = $1
            AND recipient_donor_id = $2
            AND template_variables->>'camp_id' = $3
            AND sent_at > NOW() - INTERVAL '7 days'
          LIMIT 1`,
        [TEMPLATE_TYPE, dr.donor_id, camp.id],
      );
      if (already.rowCount > 0) {
        summary.skipped_dedup += 1;
        continue;
      }

      try {
        const r = await withRlsContextRaw(
          { actor_role: 'system', change_reason: `camp donor thankyou — camp ${camp.slug}` },
          async () =>
            sendNotification({
              recipientId: dr.donor_id,
              recipientMobile: dr.mobile,
              templateType: TEMPLATE_TYPE,
              variables: {
                camp_id: camp.id,
                donor_first_name: firstName(open(dr.full_name)),
                camp_name: camp.name,
                donor_dashboard_path: 'donor',
              },
              channel: 'WA',
              language: dr.preferred_language || 'mr',
            }),
        );
        if (r?.success) summary.sent += 1;
        else summary.failed += 1;
      } catch (err) {
        logger.warn(
          {
            event: 'camp_donor_thankyou_send_error',
            camp_id: camp.id,
            donor_id: dr.donor_id,
            err: err.message,
          },
          'send error',
        );
        summary.failed += 1;
      }
    }
  }
  return summary;
}

module.exports = {
  run,
  name: 'camp_donor_thankyou',
  cron: '0 20 * * *', // 20:00 IST daily — evening after camp
  description: 'Send thank-you WhatsApp to donors who attended a camp yesterday (cr.status=AT)',
};
