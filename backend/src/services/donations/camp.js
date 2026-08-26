/**
 * Camp attribution for a donation.
 *
 * A donation recorded against a camp is what proves a donor attended it —
 * migration 314 turns donation_history.donation_camp_id into
 * camp_registrations.status = 'AT' with no volunteer tapping a roster. That
 * makes this column load-bearing rather than decorative, so the checks live in
 * one place and both donation-insert paths (POST /donations and the partner
 * vendor webhook) call it.
 *
 * What is deliberately NOT enforced here: nothing clinical. Whether this donor
 * may donate at all is validateDonation()'s job and the DB triggers'. This
 * function answers only "is it plausible that this donation happened at this
 * camp", because a wrong camp id silently credits attendance and units to the
 * wrong organiser.
 */

// A camp being collected against must be verified and not terminated. 'PE' is a
// public application nobody has reviewed, so it has no organiser relationship
// and no business receiving units; 'CA'/'DC' never happened.
const COLLECTABLE_STATUSES = ['PL', 'LV', 'CO'];

// Days either side of the camp date that a collection may carry. A camp is one
// row with one date, so an overnight or two-session camp legitimately produces
// donations dated +1, and a clerical day-slip on batch entry the next morning
// is common. Beyond that the id is far more likely to be the wrong camp than a
// late-running one.
const DATE_TOLERANCE_DAYS = 2;

/**
 * @returns {{ok: true, camp: object} | {ok: false, error: string, detail: object}}
 * Callers map ok:false to 409 camp_not_collectable and pass `detail` through —
 * the blood bank needs to see which camp and which dates disagreed, or they
 * cannot tell a typo from a policy refusal.
 */
async function resolveCampForCollection(client, { campId, collectionDate, bloodBankId }) {
  const r = await client.query(
    `SELECT c.id, c.name, c.status, c.district_id,
            to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
            c.partnered_blood_bank_id,
            ABS(c.scheduled_date - $2::date) AS day_gap
       FROM donation_camps c
      WHERE c.id = $1
      LIMIT 1`,
    [campId, collectionDate],
  );
  if (r.rowCount === 0) {
    return { ok: false, error: 'camp_not_collectable', detail: { reason: 'camp_not_found' } };
  }
  const camp = r.rows[0];

  if (!COLLECTABLE_STATUSES.includes(camp.status)) {
    return {
      ok: false,
      error: 'camp_not_collectable',
      detail: { reason: 'camp_status', status: camp.status, camp_name: camp.name },
    };
  }

  if (Number(camp.day_gap) > DATE_TOLERANCE_DAYS) {
    return {
      ok: false,
      error: 'camp_not_collectable',
      detail: {
        reason: 'collection_date_outside_camp_window',
        camp_name: camp.name,
        scheduled_date: camp.scheduled_date,
        collection_date: collectionDate,
        tolerance_days: DATE_TOLERANCE_DAYS,
      },
    };
  }

  // Either this blood bank is the camp's partner, or it operates in the camp's
  // district. District is enough on purpose: partnered_blood_bank_id is often
  // unset on a camp a village hosted and a nearby bank staffed on the day, and
  // refusing those would push the BB to record the donations with no camp at
  // all — losing the attendance derivation entirely, which is worse than a
  // slightly loose attribution inside one district.
  if (bloodBankId) {
    const own = await client.query(
      `SELECT 1
         FROM institutions i
        WHERE i.id = $1
          AND ($1 = $2::uuid OR i.district_id = $3)
        LIMIT 1`,
      [bloodBankId, camp.partnered_blood_bank_id, camp.district_id],
    );
    if (own.rowCount === 0) {
      return {
        ok: false,
        error: 'camp_not_collectable',
        detail: { reason: 'camp_outside_blood_bank_district', camp_name: camp.name },
      };
    }
  }

  return { ok: true, camp };
}

module.exports = { resolveCampForCollection, COLLECTABLE_STATUSES, DATE_TOLERANCE_DAYS };
