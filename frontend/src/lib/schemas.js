// Shared client-side Zod schemas. Source-of-truth lives in the backend (CLAUDE.md
// hard rule #1) — these mirror those Zod shapes so the UX can fail fast before
// the network round-trip. The backend re-validates on every request.

import { z } from 'zod';

// Indian mobile: optional +91/0 prefix, leading 6-9, 10 digits total.
export const indianMobileSchema = z
  .string()
  .trim()
  .regex(/^(\+?91[-\s]?)?[6-9]\d{9}$/, 'invalid_mobile');

// Mirrors backend `routes/requests.js` baseRequestSchema (Phase 5).
export const requestSchema = z.object({
  patient_initials: z.string().trim().min(1).max(10),
  patient_age: z.number().int().min(0).max(120),
  patient_gender: z.enum(['M', 'F', 'O']),
  patient_blood_group_id: z.number().int().min(1).max(8),
  patient_phenotype_note: z.string().max(500).optional(),
  component_id: z.number().int().min(1).max(6),
  units_required: z.number().int().min(1).max(50),
  urgency_tier: z.enum(['PL', 'UR', 'CR']),
  needed_by: z.string().datetime(),
  clinical_indication: z.string().max(2000).optional(),
  ward_or_bed: z.string().max(100).optional(),
});

// Mirrors backend `routes/donations.js` donationSchema (Phase 4).
export const donationSchema = z.object({
  donor_id: z.string().uuid(),
  // Camp attribution. Optional, but load-bearing when present: migration 314
  // derives camp_registrations.status='AT' from a donation carrying this id, so
  // this is what fills a camp roster without anyone tapping it. z.object strips
  // unknown keys and submit() posts parsed.data - omitting the key here would
  // silently drop the camp on every send.
  donation_camp_id: z.string().uuid().optional(),
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date'),
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
});

// Mirrors backend `routes/inventory.js` openingStockSchema (Phase 4).
export const openingStockSchema = z.object({
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bags: z
    .array(
      z.object({
        blood_group_id: z.number().int().min(1).max(8),
        component_id: z.number().int().min(1).max(6),
        units: z.number().int().min(1).max(100),
        volume_ml_each: z.number().int().min(50).max(500),
      }),
    )
    .min(1)
    .max(50),
});

// Helper: convert a Zod error to a flat { fieldPath: message } map for inline UI.
export function zodFlatten(err) {
  const out = {};
  for (const issue of err.issues || []) {
    const key = issue.path.join('.') || '_';
    out[key] = issue.message;
  }
  return out;
}
