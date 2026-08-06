import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { Header } from '../../components/Header.jsx';
import { apiRequest } from '../../lib/api.js';

// Client-side mirror of backend/src/routes/onboarding.js applySchema.
// Backend re-validates; this keeps UX snappy. The `.superRefine` block below
// mirrors the backend's conditional required-ness for CDSCO fields — kept in
// sync by hand; if backend refine rules change, mirror them here.
const schema = z
  .object({
    kind: z.enum(['HO', 'BB']),
    shortname: z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/, 'invalid_shortname'),
    legal_name: z.string().min(2),
    display_name: z.string().min(2),
    state_id: z.number().int().positive(),
    district_id: z.number().int().positive(),
    taluka_id: z.number().int().positive().optional(),
    address_line: z.string().min(5),
    pincode: z.string().regex(/^[1-9]\d{5}$/, 'invalid_pincode'),
    cdsco_licence_number: z.string().optional(),
    cdsco_licence_expires: z.string().optional(),
    hospital_registration_no: z.string().optional(),
    primary_contact_name: z.string().min(2),
    primary_contact_designation: z.string().optional(),
    primary_contact_mobile: z
      .string()
      .regex(/^(\+?91[-\s]?)?[6-9]\d{9}$/, 'invalid_mobile'),
    primary_contact_email: z.string().email().optional().or(z.literal('')),
    has_inhouse_blood_bank: z.boolean().optional(),
    is_blood_bank_software_user: z.boolean().optional(),
    software_vendor: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'BB') {
      if (!data.cdsco_licence_number) {
        ctx.addIssue({
          path: ['cdsco_licence_number'],
          code: z.ZodIssueCode.custom,
          message: 'required_for_blood_bank',
        });
      }
      if (!data.cdsco_licence_expires) {
        ctx.addIssue({
          path: ['cdsco_licence_expires'],
          code: z.ZodIssueCode.custom,
          message: 'required_for_blood_bank',
        });
      }
    }
    if (data.kind === 'HO' && data.has_inhouse_blood_bank === true) {
      if (!data.cdsco_licence_number) {
        ctx.addIssue({
          path: ['cdsco_licence_number'],
          code: z.ZodIssueCode.custom,
          message: 'required_for_inhouse_bb',
        });
      }
      if (!data.cdsco_licence_expires) {
        ctx.addIssue({
          path: ['cdsco_licence_expires'],
          code: z.ZodIssueCode.custom,
          message: 'required_for_inhouse_bb',
        });
      }
      if (data.shortname.length > 23) {
        ctx.addIssue({
          path: ['shortname'],
          code: z.ZodIssueCode.custom,
          message: 'shortname_max_23_for_inhouse_bb',
        });
      }
    }
  });

function Field({ label, hint, children, error }) {
  return (
    <label className="block">
      <span className="rk-label">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-rk-700">{error}</span> : null}
    </label>
  );
}

export function InstitutionApply() {
  const [form, setForm] = useState({
    kind: 'HO',
    shortname: '',
    legal_name: '',
    display_name: '',
    state_id: 0,
    district_id: 0,
    taluka_id: 0,
    address_line: '',
    pincode: '',
    cdsco_licence_number: '',
    cdsco_licence_expires: '',
    hospital_registration_no: '',
    primary_contact_name: '',
    primary_contact_designation: '',
    primary_contact_mobile: '',
    primary_contact_email: '',
    has_inhouse_blood_bank: false,
    is_blood_bank_software_user: false,
    software_vendor: '',
  });
  const [states, setStates] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [talukas, setTalukas] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [topError, setTopError] = useState('');
  const [submitted, setSubmitted] = useState(null);

  function update(k, v) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  // Load active states on mount.
  useEffect(() => {
    apiRequest('GET', '/geography/states')
      .then((r) => setStates(r.states || []))
      .catch(() => setStates([]));
  }, []);

  // Cascade: state → districts.
  useEffect(() => {
    if (!form.state_id) {
      setDistricts([]);
      return;
    }
    apiRequest('GET', `/geography/districts?state_id=${form.state_id}`)
      .then((r) => setDistricts(r.districts || []))
      .catch(() => setDistricts([]));
    update('district_id', 0);
    update('taluka_id', 0);
    setTalukas([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.state_id]);

  // Cascade: district → talukas (optional, can be skipped).
  useEffect(() => {
    if (!form.district_id) {
      setTalukas([]);
      return;
    }
    apiRequest('GET', `/geography/talukas?district_id=${form.district_id}`)
      .then((r) => setTalukas(r.talukas || []))
      .catch(() => setTalukas([]));
    update('taluka_id', 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.district_id]);

  async function submit(e) {
    e.preventDefault();
    setErrors({});
    setTopError('');

    // Strip empty optional strings so Zod can validate cleanly.
    const payload = {
      ...form,
      taluka_id: form.taluka_id || undefined,
      cdsco_licence_number: form.cdsco_licence_number || undefined,
      cdsco_licence_expires: form.cdsco_licence_expires || undefined,
      hospital_registration_no: form.hospital_registration_no || undefined,
      primary_contact_designation: form.primary_contact_designation || undefined,
      primary_contact_email: form.primary_contact_email || undefined,
      software_vendor: form.software_vendor || undefined,
    };

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrs = {};
      for (const issue of parsed.error.issues) {
        fieldErrs[issue.path[0]] = issue.message;
      }
      setErrors(fieldErrs);
      setTopError('Please review the highlighted fields.');
      return;
    }

    setSubmitting(true);
    try {
      const r = await apiRequest('POST', '/onboarding/apply', parsed.data);
      setSubmitted(r);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const code = err?.response?.data?.error;
      if (code === 'shortname_taken') {
        setErrors({ shortname: 'shortname_taken' });
        setTopError('That shortname is already taken. Try another.');
      } else {
        setTopError(code || 'submit_failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-full">
        <Header subtitle="Onboarding" />
        <main className="mx-auto max-w-2xl px-4 py-10">
          <div className="rk-card space-y-3">
            <h1 className="text-xl font-semibold text-rk-700">Application received</h1>
            <p className="text-sm text-slate-700">
              Thank you. Your application for{' '}
              <span className="font-semibold">{submitted.shortname}</span> has been logged.
            </p>
            <dl className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 text-sm">
              <dt className="text-slate-500">Application ID</dt>
              <dd className="font-mono text-xs text-slate-800">{submitted.institution_id}</dd>
              {submitted.child_institution_id ? (
                <>
                  <dt className="text-slate-500">Linked blood bank ID</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {submitted.child_institution_id}
                    <span className="ml-2 text-slate-500">
                      @{submitted.child_shortname}
                    </span>
                  </dd>
                </>
              ) : null}
              <dt className="text-slate-500">Status</dt>
              <dd>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  Pending review
                </span>
              </dd>
              <dt className="text-slate-500">Next step</dt>
              <dd className="text-slate-700">{submitted.next_step}</dd>
            </dl>
            <p className="text-xs text-slate-500">
              Our NGO admin team will verify your licence within 2 working days and contact your
              primary contact on the mobile number you provided. Once the MoU is signed via
              Aadhaar eSign, you will receive login credentials by WhatsApp.
              {submitted.child_institution_id
                ? ' The linked blood bank shares this MoU — its admin credentials will be surfaced on your hospital dashboard after activation.'
                : ''}
            </p>
            <Link to="/" className="rk-button-secondary inline-block">
              Back to home
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const isBB = form.kind === 'BB';
  // CDSCO fields render for a standalone BB, OR for an HO that ticks the
  // in-house-BB checkbox — because in that case the paired child BB row
  // needs the licence.
  const showCdsco = isBB || (form.kind === 'HO' && form.has_inhouse_blood_bank === true);
  const showHospReg = form.kind === 'HO';

  return (
    <div className="min-h-full">
      <Header subtitle="Onboarding" />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">
            Join Raktify as a hospital or blood bank
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Self-apply form. We verify every applicant before activation — licence check,
            MoU eSign, and admin credential provisioning. Your data is encrypted at rest.
          </p>
        </div>

        {topError ? (
          <div className="rk-card mb-4 border border-rk-700/30 bg-rk-700/5 text-sm text-rk-700">
            {topError}
          </div>
        ) : null}

        <form className="space-y-6" onSubmit={submit}>
          {/* Kind */}
          <section className="rk-card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Institution type
            </h2>
            <div className="flex flex-wrap gap-2">
              {[
                { v: 'HO', label: 'Hospital' },
                { v: 'BB', label: 'Blood bank' },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => update('kind', opt.v)}
                  className={
                    'rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ' +
                    (form.kind === opt.v
                      ? 'border-rk-700 bg-rk-700 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {isBB ? (
              <p className="text-xs text-slate-500">
                Blood banks must hold a valid CDSCO licence under the Drugs & Cosmetics Act.
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                Hospitals are onboarded as raisers of blood requests. If your hospital also
                runs an in-house blood bank, tick the box below.
              </p>
            )}
          </section>

          {/* Identity */}
          <section className="rk-card grid gap-3 sm:grid-cols-2">
            <Field label="Legal name" error={errors.legal_name}>
              <input
                className="rk-input"
                value={form.legal_name}
                onChange={(e) => update('legal_name', e.target.value)}
                placeholder="e.g. Indira Gandhi Government Medical College"
                required
              />
            </Field>
            <Field label="Public display name" error={errors.display_name}>
              <input
                className="rk-input"
                value={form.display_name}
                onChange={(e) => update('display_name', e.target.value)}
                placeholder="e.g. IGGMC Nagpur"
                required
              />
            </Field>
            <Field
              label="Shortname"
              hint={
                form.kind === 'HO' && form.has_inhouse_blood_bank
                  ? 'Lowercase letters, digits, dash, underscore (3–23 chars for paired hospital + blood bank onboarding).'
                  : 'Lowercase letters, digits, dash, underscore (3–32 chars). Becomes your portal email prefix.'
              }
              error={errors.shortname}
            >
              <input
                className="rk-input font-mono"
                value={form.shortname}
                onChange={(e) =>
                  update('shortname', e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                }
                placeholder="iggmc-nagpur"
                required
              />
            </Field>
            <Field label={isBB ? 'In-house only (you are the bank)' : 'In-house blood bank?'}>
              <label className="mt-1 inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.has_inhouse_blood_bank}
                  onChange={(e) => update('has_inhouse_blood_bank', e.target.checked)}
                />
                Yes
              </label>
              {form.kind === 'HO' && form.has_inhouse_blood_bank ? (
                <p className="mt-2 text-xs text-slate-500">
                  Ticking this creates a linked blood-bank entity that shares this MoU. You will
                  receive activation credentials for both — the hospital admin over WhatsApp, and
                  the blood bank admin surfaced on your hospital dashboard once activated.
                </p>
              ) : null}
            </Field>
          </section>

          {/* Address */}
          <section className="rk-card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Address
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="State" error={errors.state_id}>
                <select
                  className="rk-input"
                  value={form.state_id}
                  onChange={(e) => update('state_id', Number(e.target.value))}
                  required
                >
                  <option value={0}>— select —</option>
                  {states.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="District" error={errors.district_id}>
                <select
                  className="rk-input"
                  value={form.district_id}
                  onChange={(e) => update('district_id', Number(e.target.value))}
                  disabled={!form.state_id}
                  required
                >
                  <option value={0}>— select —</option>
                  {districts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Taluka"
                hint="Optional — leave blank if you operate at district level"
              >
                <select
                  className="rk-input"
                  value={form.taluka_id}
                  onChange={(e) => update('taluka_id', Number(e.target.value))}
                  disabled={!form.district_id || talukas.length === 0}
                >
                  <option value={0}>— optional —</option>
                  {talukas.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Address line" error={errors.address_line}>
              <input
                className="rk-input"
                value={form.address_line}
                onChange={(e) => update('address_line', e.target.value)}
                placeholder="Building / street / locality"
                required
              />
            </Field>
            <Field label="Pincode" error={errors.pincode}>
              <input
                className="rk-input max-w-[10rem] tracking-widest"
                value={form.pincode}
                onChange={(e) =>
                  update('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                inputMode="numeric"
                maxLength={6}
                required
              />
            </Field>
          </section>

          {/* Regulatory */}
          <section className="rk-card grid gap-3 sm:grid-cols-2">
            <h2 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
              Regulatory
            </h2>
            {showHospReg ? (
              <Field
                label="Hospital registration number"
                hint="Clinical Establishments Act number, if any"
              >
                <input
                  className="rk-input"
                  value={form.hospital_registration_no}
                  onChange={(e) => update('hospital_registration_no', e.target.value)}
                />
              </Field>
            ) : null}
            {showCdsco ? (
              <>
                <Field
                  label="CDSCO licence number"
                  hint={
                    form.kind === 'HO'
                      ? 'For your in-house blood bank — under the Drugs & Cosmetics Act.'
                      : undefined
                  }
                  error={errors.cdsco_licence_number}
                >
                  <input
                    className="rk-input"
                    value={form.cdsco_licence_number}
                    onChange={(e) => update('cdsco_licence_number', e.target.value)}
                    placeholder="e.g. MH/BC/12-345/2026"
                    required
                  />
                </Field>
                <Field label="CDSCO licence expiry" error={errors.cdsco_licence_expires}>
                  <input
                    type="date"
                    className="rk-input"
                    value={form.cdsco_licence_expires}
                    onChange={(e) => update('cdsco_licence_expires', e.target.value)}
                    required
                  />
                </Field>
              </>
            ) : null}
            <Field label="Existing blood-bank software?">
              <label className="mt-1 inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.is_blood_bank_software_user}
                  onChange={(e) => update('is_blood_bank_software_user', e.target.checked)}
                />
                Yes
              </label>
            </Field>
            {form.is_blood_bank_software_user ? (
              <Field label="Software vendor">
                <input
                  className="rk-input"
                  value={form.software_vendor}
                  onChange={(e) => update('software_vendor', e.target.value)}
                  placeholder="e.g. e-RaktKosh, BLIS"
                />
              </Field>
            ) : null}
          </section>

          {/* Contact */}
          <section className="rk-card grid gap-3 sm:grid-cols-2">
            <h2 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
              Primary contact
            </h2>
            <Field label="Full name" error={errors.primary_contact_name}>
              <input
                className="rk-input"
                value={form.primary_contact_name}
                onChange={(e) => update('primary_contact_name', e.target.value)}
                required
              />
            </Field>
            <Field label="Designation">
              <input
                className="rk-input"
                value={form.primary_contact_designation}
                onChange={(e) => update('primary_contact_designation', e.target.value)}
                placeholder="e.g. Medical Superintendent"
              />
            </Field>
            <Field
              label="Mobile (10-digit)"
              hint="We will WhatsApp the MoU eSign request to this number"
              error={errors.primary_contact_mobile}
            >
              <input
                className="rk-input"
                value={form.primary_contact_mobile}
                onChange={(e) => update('primary_contact_mobile', e.target.value)}
                placeholder="9XXXXXXXXX"
                inputMode="tel"
                required
              />
            </Field>
            <Field label="Email (optional)" error={errors.primary_contact_email}>
              <input
                type="email"
                className="rk-input"
                value={form.primary_contact_email}
                onChange={(e) => update('primary_contact_email', e.target.value)}
              />
            </Field>
          </section>

          <div className="flex items-center justify-between gap-3 pt-2">
            <p className="max-w-md text-xs text-slate-500">
              By submitting you confirm the information provided is accurate. Misrepresentation
              may result in permanent debarment from the platform.
            </p>
            <button
              type="submit"
              className="rk-button-primary"
              disabled={submitting}
            >
              {submitting ? '…' : 'Submit application'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
