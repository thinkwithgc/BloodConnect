/**
 * sandbox_donor_purge — daily. Erases donors created via a sandbox
 * partner_key more than 24 hours ago.
 *
 * See migration 308 for the design context: sandbox pushes create donor
 * rows with is_sandbox=TRUE so vendors can test the /webhooks/v1/*
 * integration end-to-end (including our consent flow) without polluting
 * the real donor pool. 24 hours is a deliberately short retention window
 * — long enough for a vendor to walk through push → consent → matching
 * during a debug session, short enough that stale test data doesn't
 * accumulate.
 *
 * Reuses services/donors/erasure.eraseDonor() so the same scrub semantics
 * apply (mobile tombstoned, name/address wiped, platform_user locked).
 * That means a sandbox test using +919876543210 doesn't permanently burn
 * that mobile — the tombstone is a unique 'ERSD…' sequence.
 *
 * Runs at 03:15 IST daily — offset from data_retention_purge (03:30) and
 * consent_pending_purge (03:45) so the three purge jobs don't contend.
 */
const { withRlsContextRaw } = require('../../../middleware/rlsContext');
const { eraseDonor } = require('../../donors/erasure');
const logger = require('../../../config/logger');

const SANDBOX_RETENTION_HOURS = 24;

async function run() {
  const candidates = await withRlsContextRaw(
    { actor_role: 'system', change_reason: 'sandbox_purge_scan' },
    async (c) => {
      const r = await c.query(
        `SELECT id
           FROM donors
          WHERE is_sandbox = TRUE
            AND is_active = TRUE
            AND created_at < NOW() - make_interval(hours => $1)`,
        [SANDBOX_RETENTION_HOURS],
      );
      return r.rows.map((row) => row.id);
    },
  );

  let purged = 0;
  const failures = [];
  for (const donorId of candidates) {
    try {
      const result = await withRlsContextRaw(
        { actor_role: 'system', change_reason: `sandbox_purge_${SANDBOX_RETENTION_HOURS}h` },
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
      { event: 'sandbox_donor_purge_partial', failures },
      'sandbox donor purge had failures',
    );
  }
  return {
    candidates: candidates.length,
    purged,
    retention_hours: SANDBOX_RETENTION_HOURS,
    failure_count: failures.length,
  };
}

module.exports = {
  run,
  name: 'sandbox_donor_purge',
  cron: '15 3 * * *', // 03:15 IST daily (offset from other purge jobs)
  description: 'Erase sandbox-flagged donor rows older than 24 hours',
};
