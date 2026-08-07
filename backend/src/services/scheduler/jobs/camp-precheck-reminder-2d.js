/**
 * camp_precheck_reminder_2d — daily. Nudges donors who RSVP'd to a camp
 * that's 2 days out with the 48-hour prep list (avoid alcohol, sleep well,
 * hydrate). Fires the CAMP_PRECHECK_2D approved Meta template.
 *
 * Runs at 10:00 IST so donors see it during working hours. Only touches
 * camps in status PL or LV (not CO/CA/DC/PE). Only sends to donors with
 * whatsapp_opted_in=TRUE. Dedup keyed on notification_log:
 * (template_type=CAMP_PRECHECK_2D, recipient_donor_id, template_variables
 * ->>'camp_id') so a job restart or overlap doesn't double-send.
 *
 * If the WHATSAPP_TEMPLATE_CAMP_PRECHECK_2D env var isn't set (Meta not
 * approved yet), the chokepoint returns a clean {success:false, FA}
 * without throwing — job still runs, just no messages go out. The
 * notification_log row still lands with delivery_status='FA' so the
 * dedup logic later works if the template gets set + we re-run.
 */
const { pool } = require('../../../config/db');
const { withRlsContextRaw } = require('../../../middleware/rlsContext');
const { sendNotification } = require('../..//notifications');
const { open } = require('../../pii');
const logger = require('../../../config/logger');

const TEMPLATE_TYPE = 'CAMP_PRECHECK_2D';
// Camps whose scheduled_date is exactly 2 days from today. Using date math
// on scheduled_date (a DATE column, not TZ-sensitive) — IST-safe.
const DAY_OFFSET = 2;

function firstName(fullName) {
  if (!fullName) return 'friend';
  return String(fullName).trim().split(/\s+/)[0] || 'friend';
}

function fmtDateTime(dateStr, startTime) {
  // e.g. "15 Aug, 09:00"
  try {
    const d = new Date(dateStr);
    const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const t = String(startTime || '').slice(0, 5);
    return `${day}${t ? ', ' + t : ''}`;
  } catch {
    return String(dateStr);
  }
}

async function run() {
  const camps = await pool.query(
    `SELECT c.id, c.name, c.slug, c.scheduled_date, c.start_time, c.venue
       FROM donation_camps c
      WHERE c.scheduled_date = CURRENT_DATE + $1
        AND c.status IN ('PL', 'LV')`,
    [DAY_OFFSET],
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
    // RSVP'd donors who opted in to WhatsApp. Not-yet-cancelled RSVPs only.
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

      // Dedup — skip if we've already sent this template to this donor for
      // this camp in the last day (belt-and-braces; the scheduler only
      // fires once per day, but a manual /admin/jobs/run trigger could
      // cause a double-fire).
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
          {
            actor_role: 'system',
            change_reason: `camp precheck 2d reminder — camp ${camp.slug}`,
          },
          async () =>
            sendNotification({
              recipientId: dr.donor_id,
              recipientMobile: dr.mobile,
              templateType: TEMPLATE_TYPE,
              variables: {
                camp_id: camp.id, // for dedup + audit trail
                donor_first_name: firstName(open(dr.full_name)),
                camp_name: camp.name,
                camp_date_time: fmtDateTime(camp.scheduled_date, camp.start_time),
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
            event: 'camp_precheck_2d_send_error',
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
  name: 'camp_precheck_reminder_2d',
  cron: '0 10 * * *', // 10:00 IST daily
  description: "Send 48-hour pre-check reminder to donors RSVP'd for camps 2 days out",
};
