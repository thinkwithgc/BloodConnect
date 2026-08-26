/**
 * Donations + TTI screening (Phase 4).
 *
 *   POST /donations                          blood_bank role; records a verified donation.
 *                                            DB triggers automatically create a blood_inventory bag in QA.
 *   GET  /donations/:id                      blood_bank (own) or admin
 *   POST /donations/:id/screening            blood_bank; first author enters TTI panel
 *   POST /donations/:id/screening/verify     blood_bank; second author verifies (4-eyes)
 *
 * The screening recompute trigger flips overall_clearance:
 *   - all NR + verified  → CL  → blood_inventory bag(s) auto-flip QA → AV
 *   - any RR + verified  → IN  → donor deferred + bags recalled + lookback fires
 *   - pending / RR-unverified → PE
 */
const express = require('express');
const { z } = require('zod');

const { withRlsContext } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { seal } = require('../services/pii');
const { validateDonation } = require('../services/donations/validate');
const { resolveCampForCollection } = require('../services/donations/camp');
const {
  lookupCandidates: lookupAttributionCandidates,
  applyAttribution,
} = require('../services/donations/attribution');

const router = express.Router();

const donationSchema = z.object({
  donor_id: z.string().uuid(),
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  collection_time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .optional(),
  component_id: z.number().int().min(1).max(6),
  volume_ml: z.number().int().min(50).max(500),
  hb_gdl: z.number().min(5).max(25).optional(),
  hb_method: z.enum(['CS', 'HC', 'LB']).optional(),
  pulse_bpm: z.number().int().min(30).max(200).optional(),
  bp_systolic: z.number().int().min(50).max(250).optional(),
  bp_diastolic: z.number().int().min(30).max(150).optional(),
  weight_kg: z.number().min(20).max(200).optional(),
  isbt_barcode: z.string().min(4).max(64),
  notes: z.string().max(2000).optional(),
  // Optional explicit attribution — BB picks from dropdown when multiple
  // donor_alert_choices match this donation. Auto-attribution kicks in when
  // exactly one candidate exists; the field is only needed for tie-breaks.
  attribute_to_choice_id: z.string().uuid().optional(),
  // Camp attribution. Supplying this sets source='CA' and — via migration 314's
  // trigger — marks the donor Attended on that camp's roster. It is the only
  // way a camp ever learns who actually donated, so the BB portal offers it
  // prominently rather than as an afterthought.
  donation_camp_id: z.string().uuid().optional(),
});

// ── POST /donations ──────────────────────────────────────────────────────
router.post('/', verifyJWT, requireRole('blood_bank'), async (req, res) => {
  const parsed = donationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const data = parsed.data;

  try {
    const result = await withRlsContext(
      req,
      async (c) => {
        // Pre-flight donor-side validation (deferral, gap, Hb, blood group)
        const v = await validateDonation(c, {
          donorId: data.donor_id,
          componentId: data.component_id,
          hbGdl: data.hb_gdl,
        });
        if (!v.ok) {
          throw Object.assign(new Error(v.error), { status: 422, code: v.error, detail: v.detail });
        }

        // Camp attribution, checked before the INSERT so a wrong camp id is a
        // clear 409 rather than an attendance row credited to the wrong camp.
        let camp = null;
        if (data.donation_camp_id) {
          const cv = await resolveCampForCollection(c, {
            campId: data.donation_camp_id,
            collectionDate: data.collection_date,
            bloodBankId: req.user.institutionId,
          });
          if (!cv.ok) {
            throw Object.assign(new Error(cv.error), {
              status: 409,
              code: cv.error,
              detail: cv.detail,
            });
          }
          camp = cv.camp;
        }

        const r = await c.query(
          `INSERT INTO donation_history (
              donor_id, blood_bank_id, trust_level, source,
              collection_date, collection_time, component_id, volume_ml,
              hb_gdl, hb_method, pulse_bpm, bp_systolic, bp_diastolic, weight_kg,
              isbt_barcode, recorded_by_user_id, notes, donation_camp_id)
           VALUES ($1, $2, 'V', $16,
                   $3, $4, $5, $6,
                   $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $17)
           RETURNING id, isbt_barcode, collection_date`,
          [
            data.donor_id,
            req.user.institutionId,
            data.collection_date,
            data.collection_time || null,
            data.component_id,
            data.volume_ml,
            data.hb_gdl ?? null,
            data.hb_method ?? null,
            data.pulse_bpm ?? null,
            data.bp_systolic ?? null,
            data.bp_diastolic ?? null,
            data.weight_kg ?? null,
            data.isbt_barcode,
            req.user.userId,
            data.notes ?? null,
            camp ? 'CA' : 'BB',
            camp ? camp.id : null,
          ],
        );

        // The trg_donation_creates_inventory trigger created the bag; surface it.
        const bag = await c.query(
          `SELECT id, status FROM blood_inventory WHERE donation_id = $1 LIMIT 1`,
          [r.rows[0].id],
        );

        // Auto-attribution (V2 spec §5 refinement 2). If this donor has an
        // active donor_alert_choice matching this donation (blood group +
        // component + BB), link them so the request's fulfilment counter
        // increments + donation_type flips to 'DA'. If explicit
        // attribute_to_choice_id supplied by BB (multi-match dropdown), use
        // that; else auto-attribute only when exactly one candidate exists.
        const donor = await c.query(`SELECT id, blood_group_verified FROM donors WHERE id = $1`, [
          data.donor_id,
        ]);
        const donorBg = donor.rows[0]?.blood_group_verified;
        let attribution = null;
        if (donorBg) {
          const candidates = await lookupAttributionCandidates(c, {
            donorId: data.donor_id,
            componentId: data.component_id,
            bloodGroupId: donorBg,
            bloodBankId: req.user.institutionId,
          });
          const chosenId =
            data.attribute_to_choice_id ||
            (candidates.length === 1 ? candidates[0].choice_id : null);
          if (chosenId) {
            attribution = await applyAttribution(c, {
              donationId: r.rows[0].id,
              choiceId: chosenId,
            });
          } else if (candidates.length > 1) {
            attribution = { attributed: false, ambiguous_candidates: candidates };
          }
        }

        return {
          donation_id: r.rows[0].id,
          isbt_barcode: r.rows[0].isbt_barcode,
          inventory_bag: bag.rows[0] || null,
          screening_required: true,
          attribution,
          // Echo the camp so the portal can confirm the roster was credited
          // without a second round-trip.
          camp: camp ? { id: camp.id, name: camp.name, scheduled_date: camp.scheduled_date } : null,
        };
      },
      { change_reason: 'blood-bank donation entry' },
    );

    res.status(201).json(result);
  } catch (err) {
    if (err.status === 422 || err.status === 409) {
      return res.status(err.status).json({ error: err.code, detail: err.detail });
    }
    if (/unique constraint/i.test(err.message) && /isbt_barcode/i.test(err.message)) {
      return res.status(409).json({ error: 'isbt_barcode_already_used' });
    }
    throw err;
  }
});

// ── GET /donations/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT dh.id, dh.donor_id, dh.blood_bank_id, dh.collection_date,
              dh.component_id, bc.code AS component_code,
              dh.volume_ml, dh.hb_gdl, dh.hb_method,
              dh.isbt_barcode, dh.trust_level,
              ds.id AS screening_id, ds.overall_clearance, ds.verification_required,
              ds.entered_by, ds.verified_by, ds.verified_at,
              bi.id AS bag_id, bi.status AS bag_status, bi.expiry_date
         FROM donation_history dh
    LEFT JOIN blood_components bc ON bc.id = dh.component_id
    LEFT JOIN donor_screening ds ON ds.donation_id = dh.id
    LEFT JOIN blood_inventory bi ON bi.donation_id = dh.id
        WHERE dh.id = $1
        LIMIT 1`,
        [req.params.id],
      ),
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  },
);

// ── POST /donations/:id/screening (blood_bank, first author) ─────────────
const screeningSchema = z.object({
  hiv_status: z.enum(['PE', 'NR', 'RR', 'ID']).default('PE'),
  hbsag_status: z.enum(['PE', 'NR', 'RR', 'ID']).default('PE'),
  hcv_status: z.enum(['PE', 'NR', 'RR', 'ID']).default('PE'),
  syphilis_status: z.enum(['PE', 'NR', 'RR', 'ID']).default('PE'),
  malaria_status: z.enum(['PE', 'NR', 'RR', 'ID']).default('PE'),
  nat_status: z.enum(['PE', 'NR', 'RR', 'ID']).optional(),
  nat_target: z.string().optional(),
  hiv_method: z.string().optional(),
  hbsag_method: z.string().optional(),
  hcv_method: z.string().optional(),
  syphilis_method: z.string().optional(),
  malaria_method: z.string().optional(),
  nat_method: z.string().optional(),
  notes: z.string().optional(),
});

router.post('/:id/screening', verifyJWT, requireRole('blood_bank'), async (req, res) => {
  const parsed = screeningSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const s = parsed.data;

  try {
    const result = await withRlsContext(
      req,
      async (c) => {
        const dh = await c.query(
          `SELECT id, donor_id, blood_bank_id FROM donation_history WHERE id = $1`,
          [req.params.id],
        );
        if (dh.rowCount === 0) {
          throw Object.assign(new Error('donation_not_found'), { status: 404 });
        }
        if (dh.rows[0].blood_bank_id !== req.user.institutionId) {
          throw Object.assign(new Error('not_your_donation'), { status: 403 });
        }

        const r = await c.query(
          `INSERT INTO donor_screening (
              donation_id, donor_id, blood_bank_id,
              hiv_status, hbsag_status, hcv_status, syphilis_status, malaria_status,
              nat_status, nat_target,
              hiv_method, hbsag_method, hcv_method, syphilis_method, malaria_method, nat_method,
              entered_by, notes)
           VALUES ($1, $2, $3,
                   $4, $5, $6, $7, $8,
                   $9, $10,
                   $11, $12, $13, $14, $15, $16,
                   $17, $18)
           RETURNING id, overall_clearance, verification_required`,
          [
            dh.rows[0].id,
            dh.rows[0].donor_id,
            dh.rows[0].blood_bank_id,
            s.hiv_status,
            s.hbsag_status,
            s.hcv_status,
            s.syphilis_status,
            s.malaria_status,
            s.nat_status ?? null,
            // TTI free-text is health data — sealed with the SEPARATE
            // screening key so a main-key compromise can't read it. Status
            // codes (hiv_status etc.) stay plaintext: they must remain
            // queryable for matching + lookback + the clearance trigger.
            seal(s.nat_target ?? null, 'screening'),
            seal(s.hiv_method ?? null, 'screening'),
            seal(s.hbsag_method ?? null, 'screening'),
            seal(s.hcv_method ?? null, 'screening'),
            seal(s.syphilis_method ?? null, 'screening'),
            seal(s.malaria_method ?? null, 'screening'),
            seal(s.nat_method ?? null, 'screening'),
            req.user.userId,
            seal(s.notes ?? null, 'screening'),
          ],
        );
        return r.rows[0];
      },
      { change_reason: 'TTI screening entry', access_reason: 'blood-bank lab entry' },
    );
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (/duplicate key/i.test(err.message)) {
      return res.status(409).json({ error: 'screening_already_recorded' });
    }
    throw err;
  }
});

// ── POST /donations/:id/screening/verify (4-eyes second author) ──────────
router.post('/:id/screening/verify', verifyJWT, requireRole('blood_bank'), async (req, res) => {
  try {
    const result = await withRlsContext(
      req,
      async (c) => {
        const scr = await c.query(
          `SELECT ds.id, ds.entered_by, ds.verified_by, ds.verification_required,
                    ds.overall_clearance, ds.donation_id, dh.blood_bank_id
               FROM donor_screening ds
               JOIN donation_history dh ON dh.id = ds.donation_id
              WHERE ds.donation_id = $1`,
          [req.params.id],
        );
        if (scr.rowCount === 0) {
          throw Object.assign(new Error('no_screening_for_donation'), { status: 404 });
        }
        const row = scr.rows[0];
        if (row.blood_bank_id !== req.user.institutionId) {
          throw Object.assign(new Error('not_your_donation'), { status: 403 });
        }
        if (row.verified_by) {
          throw Object.assign(new Error('already_verified'), { status: 409 });
        }
        if (row.entered_by === req.user.userId) {
          throw Object.assign(new Error('four_eyes_violation'), {
            status: 403,
            detail: 'verifier must be a different user from the entry author',
          });
        }

        const r = await c.query(
          `UPDATE donor_screening
                SET verified_by = $1, verified_at = clock_timestamp()
              WHERE id = $2
          RETURNING id, overall_clearance, verified_at`,
          [req.user.userId, row.id],
        );
        return r.rows[0];
      },
      {
        change_reason: 'TTI four-eyes verification',
        access_reason: 'blood-bank supervisor verify',
      },
    );
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, detail: err.detail });
    }
    throw err;
  }
});

module.exports = router;
