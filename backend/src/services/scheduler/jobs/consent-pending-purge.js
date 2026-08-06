/**
 * consent_pending_purge — daily. Erases donors whose consent has been pending
 * beyond the retention window (default 14 days).
 *
 * A donor pushed to Raktify by a BB software vendor starts with
 * consent_data_use=FALSE + consent_pending_since=NOW(). They receive a
 * WhatsApp magic-link to accept or decline on Raktify's own /consent/:token
 * screen. If they never respond within the window, we have no lawful basis
 * (DPDP §7) to hold their data — this job scrubs the row via the same
 * services/donors/erasure.js path used for donor-requested erasures.
 *
 * Reused, not reinvented:
 *   - eraseDonor() from services/donors/erasure.js writes both the donors row
 *     AND the platform_users row in one call; audit trail is written by
 *     existing triggers keyed on raktify.change_reason.
 *   - The nightly slot at 03:45 IST sits after data-retention-purge (03:30)
 *     so the two don't contend for the same rows.
 *
 * Idempotent: only rows still in consent-pending state are candidates.
 */
const { withRlsContextRaw } = require('../../../middleware/rlsContext');
const { eraseDonor } = require('../../donors/erasure');
const logger = require('../../../config/logger');

// Retention window in days. Aligned with the frontend copy on /consent/:token
// ("we'll hold your details for 14 days while you decide"). If we ever raise
// this, update both the copy and any legal documentation.
const CONSENT_PENDING_RETENTION_DAYS = 14;

async function run() {
  const candidates = await withRlsContextRaw(
    { actor_role: 'system', change_reason: 'consent_purge_scan' },
    async (c) => {
      const r = await c.query(
        `SELECT id
           FROM donors
          WHERE consent_pending_since IS NOT NULL
            AND consent_pending_since < NOW() - make_interval(days => $1)
            AND is_active = TRUE
            AND consent_data_use = FALSE`,
        [CONSENT_PENDING_RETENTION_DAYS],
      );
      return r.rows.map((row) => row.id);
    },
  );

  let purged = 0;
  const failures = [];
  for (const donorId of candidates) {
    try {
      // Each erasure runs in its own RLS context + txn — a single donor row
      // failing (e.g. row FK'd from an unexpected place) shouldn't abort the
      // whole batch.
      const result = await withRlsContextRaw(
        {
          actor_role: 'system',
          change_reason: `consent_purge_${CONSENT_PENDING_RETENTION_DAYS}d`,
        },
        (c) => eraseDonor(c, donorId),
      );
      if (result?.ok) {
        purged += 1;
      } else {
        failures.push({ donorId, code: result?.error, detail: result?.detail });
      }
    } catch (err) {
      failures.push({ donorId, error: err.message });
    }
  }

  if (failures.length > 0) {
    logger.warn(
      { event: 'consent_pending_purge_partial', failures },
      'consent-pending purge had failures',
    );
  }
  return {
    candidates: candidates.length,
    purged,
    retention_days: CONSENT_PENDING_RETENTION_DAYS,
    failure_count: failures.length,
  };
}

module.exports = {
  run,
  name: 'consent_pending_purge',
  cron: '45 3 * * *', // daily at 03:45 IST (offset from data_retention_purge at 03:30)
  description:
    'Scrub donor rows whose vendor-push consent has been pending past the retention window',
};
