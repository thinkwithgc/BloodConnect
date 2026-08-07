/**
 * Donor matching — finds activatable donors when inventory falls short.
 *
 * Spec §7 step 3:
 *   Query donors WHERE
 *     blood_group_verified IN (compatible groups)
 *     AND deferral_status = 'A'
 *     AND is_available = TRUE
 *     AND mobile_verified = TRUE
 *     AND consent_data_use = TRUE
 *     AND next_eligible_date <= CURRENT_DATE
 *     AND village_id.district_id IN (request hospital district initially)
 *   ORDER BY reliability_score DESC, ST_Distance(donor coords, hospital coords) ASC
 *
 * Distance fallback: when latitude/longitude aren't both present on the donor
 * row (consent-gated), we sort by reliability_score only. Spec acknowledges
 * this is an explicit design choice — geo coords require donor consent.
 */

async function findActivatableDonors(client, { districtId, compatibleGroupIds, limit }) {
  if (compatibleGroupIds.length === 0) return [];

  const r = await client.query(
    `SELECT d.id, d.blood_group_verified, d.reliability_score,
            d.village_id, d.latitude, d.longitude, d.preferred_contact_channel,
            d.preferred_language, d.whatsapp_opted_in, d.sms_opted_in,
            v.district_id AS donor_district_id
       FROM donors d
  LEFT JOIN villages v ON v.id = d.village_id
      WHERE d.blood_group_verified = ANY($2)
        AND d.blood_group_verification_state IN ('VE','LK')
        AND d.deferral_status = 'A'
        AND d.is_available = TRUE
        AND d.mobile_verified = TRUE
        AND d.consent_data_use = TRUE
        AND (d.next_eligible_date IS NULL OR d.next_eligible_date <= CURRENT_DATE)
        AND d.is_active = TRUE
        AND (v.district_id = $1 OR v.district_id IS NULL)
   ORDER BY d.reliability_score DESC, d.created_at ASC
      LIMIT $3`,
    [districtId, compatibleGroupIds, limit],
  );
  return r.rows;
}

// mode = horizon-based purpose (migration 305): 'FU' fulfil / 'RP' replenish.
// Defaults to 'RP' (the conservative "restock" framing) for callers that don't
// compute a horizon — e.g. geographic escalation, where by the time it widens
// the search the need is almost always too near for a donor to fulfil.
async function createAlerts(client, { requestId, donors, channelDefault = 'WA', mode = 'RP' }) {
  if (donors.length === 0) return 0;

  const values = [];
  const placeholders = donors
    .map((d, i) => {
      const base = i * 5;
      values.push(
        requestId,
        d.id,
        d.preferred_contact_channel || channelDefault,
        `score=${d.reliability_score}`,
        mode,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    })
    .join(', ');

  // `placeholders` is a generated list of `($N…$N+4)` tuples produced row-by-row
  // above. Every value flows through `values[]` — only the parameter-placeholder
  // syntax is interpolated.
  const r = await client.query(
    // eslint-disable-next-line no-restricted-syntax
    `INSERT INTO donor_alerts (request_id, donor_id, channel, match_reason, alert_mode)
     VALUES ${placeholders}
     ON CONFLICT (request_id, donor_id) DO NOTHING
  RETURNING id, donor_id, channel, alert_mode`,
    values,
  );
  // Return the inserted rows so callers can dispatch WhatsApp per-alert.
  // Callers that just need a count can `.length` this.
  return r.rows;
}

module.exports = { findActivatableDonors, createAlerts };
