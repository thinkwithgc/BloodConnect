/**
 * eligibility_reminder_job (spec §6) — daily at 8 AM.
 *
 * Find donors whose next_eligible_date is exactly 7 days from today and who
 * are opted into WhatsApp/SMS. Send a friendly reminder via the notification
 * chokepoint. The console provider writes to outbox in dev; MSG91 in prod.
 *
 * The query is bounded — we expect tens to hundreds of reminders per day,
 * not thousands. If volume grows, batch via LIMIT + cursor.
 */
const { withRlsContextRaw } = require('../../../middleware/rlsContext');
const { sendNotification } = require('../../notifications');

async function run() {
  return withRlsContextRaw(
    { actor_role: 'system', change_reason: 'eligibility_reminder_job' },
    async (c) => {
      const r = await c.query(
        `SELECT id, mobile, preferred_language, next_eligible_date,
                whatsapp_opted_in, sms_opted_in, preferred_contact_channel
           FROM donors
          WHERE deferral_status = 'A'
            AND is_active = TRUE
            AND mobile_verified = TRUE
            AND consent_data_use = TRUE
            AND next_eligible_date = CURRENT_DATE + INTERVAL '7 days'
          ORDER BY id`,
      );

      let sent = 0;
      for (const d of r.rows) {
        const channel = d.whatsapp_opted_in ? 'WA' : d.sms_opted_in ? 'SM' : null;
        if (!channel) continue;
        await sendNotification({
          recipientId: d.mobile,
          templateType: 'REM',
          variables: { next_eligible_date: d.next_eligible_date.toISOString().slice(0, 10) },
          channel,
          language: d.preferred_language || 'en',
        });
        sent++;
      }
      return { reminded_count: sent, eligible_donors_today: r.rowCount };
    },
  );
}

module.exports = {
  run,
  name: 'eligibility_reminder',
  cron: '0 8 * * *',
  description: 'Remind donors becoming eligible in 7 days',
};
