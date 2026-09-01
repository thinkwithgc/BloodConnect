/**
 * Donor-alert WhatsApp dispatcher.
 *
 * Called by the donor-alert-gate scheduler after createAlerts() persists new
 * donor_alerts rows. For each alert:
 *   1. Load donor + request context (blood group, component, district,
 *      donor's preferred language, donor's registered lat/lng)
 *   2. Optionally compute the closest compatible BB in the request's
 *      district using Haversine (skipped when donor has no lat/lng)
 *   3. Mint a one-tap public token (services/donor-alert-tokens)
 *   4. Dispatch via the notification chokepoint (services/notifications)
 *
 * Template selection:
 *   - attributedCommunityId != null  → donor_alert_community_first
 *   - otherwise                      → donor_alert_bb_routed
 *
 * The chokepoint is a no-op when the WhatsApp template env vars aren't set
 * (i.e. Meta hasn't approved yet). This lets us wire the fire path from day
 * 1 and flip on delivery by setting env vars, with no code follow-up.
 *
 * Failure posture: an individual dispatch failure is logged but never
 * throws — the alert row is the source of truth, and the donor can also
 * reach the /alert/:token URL via the log-only path if we ever want to
 * surface it in-app.
 */
const logger = require('../../config/logger');
const { mintDonorAlertToken } = require('../donor-alert-tokens');
const { open } = require('../pii');
const { sendNotification } = require('.');

// Haversine — cheap enough to run inline for a pool of 20-50 alerts.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.min(1, Math.sqrt(a))));
}

async function loadDispatchContext(client, requestId) {
  const r = await client.query(
    `SELECT br.id AS request_id, br.urgency_tier,
            br.requesting_hospital_district_id,
            bg.code AS blood_group, bc.code AS component,
            d.name AS district_name,
            cl.display_name AS leader_name
       FROM blood_requests br
       JOIN blood_groups bg ON bg.id = br.patient_blood_group_id
       JOIN blood_components bc ON bc.id = br.component_id
  LEFT JOIN districts d ON d.id = br.requesting_hospital_district_id
  LEFT JOIN communities cm ON cm.id = br.attributed_community_id
  LEFT JOIN community_leaders cl ON cl.id = cm.owner_community_leader_id
      WHERE br.id = $1`,
    [requestId],
  );
  return r.rows[0] || null;
}

async function loadDonor(client, donorId) {
  const r = await client.query(
    `SELECT d.id, d.mobile, d.full_name, d.preferred_language,
            d.latitude, d.longitude
       FROM donors d
      WHERE d.id = $1`,
    [donorId],
  );
  const donor = r.rows[0] || null;
  if (donor) donor.full_name = open(donor.full_name); // decrypt for WA personalisation
  return donor;
}

// Find the closest compatible BB in the request's district. Falls back to
// null when donor has no lat/lng — in that case the template shows a generic
// "a nearby blood bank" placeholder.
async function findClosestBB(client, { districtId, donorLat, donorLng }) {
  if (donorLat == null || donorLng == null) return null;
  const r = await client.query(
    `SELECT i.id, i.display_name AS name, i.latitude, i.longitude
       FROM institutions i
      WHERE i.kind = 'BB'
        AND i.is_active = TRUE
        AND i.district_id = $1
        AND i.latitude IS NOT NULL
        AND i.longitude IS NOT NULL`,
    [districtId],
  );
  if (r.rows.length === 0) return null;
  let best = null;
  let bestKm = Infinity;
  for (const b of r.rows) {
    const km = haversineKm(donorLat, donorLng, Number(b.latitude), Number(b.longitude));
    if (km < bestKm) {
      bestKm = km;
      best = { name: b.name, distanceKm: km };
    }
  }
  return best;
}

async function dispatchOne(client, ctx, alertRow, { attributedCommunityId, mode }) {
  const donor = await loadDonor(client, alertRow.donor_id);
  if (!donor) {
    logger.warn({ alert_id: alertRow.id }, 'dispatchDonorAlerts: donor missing');
    return;
  }

  const firstName =
    String(donor.full_name || '')
      .trim()
      .split(/\s+/)[0] || 'दाता';
  const language = donor.preferred_language || 'en';
  const bloodGroupComponent = `${ctx.blood_group} ${ctx.component}`.trim();

  const bb = await findClosestBB(client, {
    districtId: ctx.requesting_hospital_district_id,
    donorLat: donor.latitude != null ? Number(donor.latitude) : null,
    donorLng: donor.longitude != null ? Number(donor.longitude) : null,
  });

  const token = mintDonorAlertToken({
    alertId: alertRow.id,
    donorId: alertRow.donor_id,
    urgencyTier: ctx.urgency_tier,
  });

  // Horizon-based template (migration 305). RP (replenish) = honest "help us
  // restock" framing — the patient is served from tested stock, the donor can't
  // produce a usable unit in time. FU (fulfil) = come donate for this patient,
  // split community-first vs BB-routed.
  const community = Boolean(attributedCommunityId);
  let templateType;
  let variables;
  if (mode === 'RP') {
    templateType = 'DONOR_ALERT_REPLACE';
    variables = {
      donor_first_name: firstName,
      bb_name: bb?.name || 'a nearby blood bank',
      component_received: bloodGroupComponent,
      timeframe: 'the next few days',
      alert_token: token,
    };
  } else if (community) {
    templateType = 'DONOR_ALERT_COMMUNITY';
    variables = {
      donor_first_name: firstName,
      leader_name: ctx.leader_name || 'your community leader',
      blood_group_component: bloodGroupComponent,
      district: ctx.district_name || '',
      alert_token: token,
    };
  } else {
    templateType = 'DONOR_ALERT_BB';
    variables = {
      blood_group_component: bloodGroupComponent,
      bb_name: bb?.name || 'a nearby blood bank',
      distance_km: bb?.distanceKm != null ? String(bb.distanceKm) : '',
      alert_token: token,
    };
  }

  try {
    await sendNotification({
      recipientId: alertRow.donor_id,
      templateType,
      variables,
      channel: alertRow.channel || 'WA',
      language,
      relatedRequestId: ctx.request_id,
      relatedAlertId: alertRow.id,
    });
  } catch (err) {
    logger.error(
      { err: err.message, alert_id: alertRow.id, template: templateType },
      'dispatchDonorAlerts: send failed',
    );
  }
}

async function dispatchDonorAlertsFromGate(
  client,
  { requestId, alertRows, attributedCommunityId, mode },
) {
  if (!alertRows || alertRows.length === 0) return;
  const ctx = await loadDispatchContext(client, requestId);
  if (!ctx) {
    logger.warn({ request_id: requestId }, 'dispatchDonorAlerts: request context missing');
    return;
  }
  for (const row of alertRows) {
    // Prefer the mode stamped on the alert row; fall back to the batch mode.
    await dispatchOne(client, ctx, row, { attributedCommunityId, mode: row.alert_mode || mode });
  }
}

module.exports = { dispatchDonorAlertsFromGate };
