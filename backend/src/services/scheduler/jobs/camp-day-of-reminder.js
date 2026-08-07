/**
 * camp_day_of_reminder — daily at 07:00 IST. "The camp is starting today,
 * come donate." Fires the CAMP_DAY_OF Meta template to all RG-status
 * donors of camps with scheduled_date = CURRENT_DATE and status IN PL/LV.
 *
 * Same shape as camp-precheck-reminder-2d.js: opt-in gate, notification_log
 * dedup keyed on template_type + donor + camp_id, chokepoint-safe on missing
 * template env var.
 */
const { pool } = require('../../../config/db');
const { withRlsContextRaw } = require('../../../middleware/rlsContext');
const { sendNotification } = require('../../notifications');
const { open } = require('../../pii');
const logger = require('../../../config/logger');

const TEMPLATE_TYPE = 'CAMP_DAY_OF';

function firstName(fullName) {
  if (!fullName) return 'friend';
  return String(fullName).trim().split(/\s+/)[0] || 'friend';
}

async function run() {
  const camps = await pool.query(
    `SELECT c.id, c.name, c.slug, c.scheduled_date, c.start_time, c.venue
       FROM donation_camps c
      WHERE c.scheduled_date = CURRENT_DATE
        AND c.status IN ('PL', 'LV')`,
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
          AND cr.status IN ('RG', 'AT')
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
            AND sent_at > NOW() - INTERVAL '1 day'
          LIMIT 1`,
        [TEMPLATE_TYPE, dr.donor_id, camp.id],
      );
      if (already.rowCount > 0) {
        summary.skipped_dedup += 1;
        continue;
      }

      try {
        const r = await withRlsContextRaw(
          { actor_role: 'system', change_reason: `camp day-of reminder — camp ${camp.slug}` },
          async () =>
            sendNotification({
              recipientId: dr.donor_id,
              recipientMobile: dr.mobile,
              templateType: TEMPLATE_TYPE,
              variables: {
                camp_id: camp.id,
                donor_first_name: firstName(open(dr.full_name)),
                camp_name: camp.name,
                start_time: String(camp.start_time || '').slice(0, 5),
                venue: camp.venue,
                camp_slug: camp.slug,
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
            event: 'camp_day_of_send_error',
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
  name: 'camp_day_of_reminder',
  cron: '0 7 * * *', // 07:00 IST daily — before typical camp start
  description: "Send day-of reminder to donors RSVP'd for camps starting today",
};
