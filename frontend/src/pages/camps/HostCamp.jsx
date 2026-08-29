import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';

import { Header } from '../../components/Header.jsx';
import { apiRequest } from '../../lib/api.js';
import { isoOffsetYears, todayISO } from '../../lib/dateBounds.js';
import { BbAvailabilityCalendar } from '../../components/camps/BbAvailabilityCalendar.jsx';

const ORGANISER_TYPES = [
  { code: 'CC', label: 'Corporate / company' },
  { code: 'EI', label: 'Educational institution / college' },
  { code: 'EO', label: 'NGO or external organisation' },
  { code: 'MC', label: 'Medical college / hospital' },
  { code: 'CO', label: 'Community / neighbourhood group' },
  { code: 'OT', label: 'Other' },
];

// Client-side mirror of backend/src/routes/camps.js applySchema. The
// backend re-validates so this just keeps the UX tight.
const schema = z.object({
  name: z.string().min(2),
  organiser_type: z.enum(['CC', 'CO', 'EI', 'EO', 'MC', 'OT']),
  organiser_name: z.string().min(2),
  state_id: z.number().int().positive(),
  district_id: z.number().int().positive(),
  taluka_id: z.number().int().positive().optional(),
  venue: z.string().min(2),
  address_line: z.string().min(5),
  pincode: z.string().regex(/^[1-9]\d{5}$/).optional(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  target_donor_count: z.number().int().positive().max(2000).optional(),
  // The organiser's preferred blood bank. A request, never an assignment -
  // the NGO admin promotes it at verify. Optional on purpose: the organiser
  // this field exists for is usually the one who has no idea.
  requested_blood_bank_id: z.string().uuid().optional(),
  submitted_by_name: z.string().min(2),
  submitted_by_mobile: z
    .string()
    .regex(/^(\+?91[-\s]?)?[6-9]\d{9}$/, 'invalid_mobile'),
  submitted_by_email: z.string().email().optional().or(z.literal('')),
  submitted_by_role: z.string().optional(),
  volunteer_training_requested: z.boolean().optional(),
  expected_volunteer_count: z.number().int().min(0).max(500).optional(),
  notes: z.string().max(2000).optional(),
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

export function HostCamp() {
  const [form, setForm] = useState({
    name: '',
    organiser_type: 'EO',
    organiser_name: '',
    state_id: 0,
    district_id: 0,
    taluka_id: 0,
    venue: '',
    address_line: '',
    pincode: '',
    requested_blood_bank_id: '',
    scheduled_date: '',
    start_time: '09:00',
    end_time: '15:00',
    target_donor_count: '',
    submitted_by_name: '',
    submitted_by_mobile: '',
    submitted_by_email: '',
    submitted_by_role: '',
    volunteer_training_requested: true,
    expected_volunteer_count: '',
    notes: '',
  });
  const [states, setStates] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [talukas, setTalukas] = useState([]);
  const [bloodBanks, setBloodBanks] = useState([]);
  const [errors, setErrors] = useState({});
  const [topError, setTopError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  // Set only by a 409 blood_bank_day_full. Holds the alternatives the backend
  // offered, so the rejection can suggest a day instead of just refusing one.
  const [dayFull, setDayFull] = useState(null);

  function update(k, v) {
    setForm((p) => ({ ...p, [k]: v }));
    // A 409 refusal is about one date at one blood bank. Change either and the
    // refusal no longer describes anything - and leaving it up would put a red
    // "fully booked on the 14th" line under a calendar on which the organiser
    // has just tapped a green 21st.
    if (k === 'scheduled_date' || k === 'requested_blood_bank_id') setDayFull(null);
  }

  useEffect(() => {
    apiRequest('GET', '/geography/states').then((r) => setStates(r.states || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!form.state_id) {
      setDistricts([]);
      return;
    }
    apiRequest('GET', `/geography/districts?state_id=${form.state_id}`)
      .then((r) => setDistricts(r.districts || []))
      .catch(() => {});
    update('district_id', 0);
    update('taluka_id', 0);
    setTalukas([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.state_id]);
  useEffect(() => {
    if (!form.district_id) {
      setTalukas([]);
      return;
    }
    apiRequest('GET', `/geography/talukas?district_id=${form.district_id}`)
      .then((r) => setTalukas(r.talukas || []))
      .catch(() => {});
    update('taluka_id', 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.district_id]);
  // Blood banks are scoped to the camp's own district - the backend rejects a
  // cross-district request - so the list reloads and the pick clears whenever
  // the district changes. A failed fetch leaves the list empty, which renders
  // the honest "we'll arrange one" panel rather than an error.
  useEffect(() => {
    if (!form.district_id) {
      setBloodBanks([]);
      return;
    }
    apiRequest('GET', `/camps/blood-bank-options?district_id=${form.district_id}`)
      .then((r) => setBloodBanks(r.blood_banks || []))
      .catch(() => setBloodBanks([]));
    update('requested_blood_bank_id', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.district_id]);

  async function submit(e) {
    e.preventDefault();
    setErrors({});
    setTopError('');
    setDayFull(null);

    const payload = {
      ...form,
      state_id: Number(form.state_id),
      district_id: Number(form.district_id),
      taluka_id: form.taluka_id ? Number(form.taluka_id) : undefined,
      target_donor_count: form.target_donor_count ? Number(form.target_donor_count) : undefined,
      expected_volunteer_count: form.expected_volunteer_count
        ? Number(form.expected_volunteer_count)
        : undefined,
      pincode: form.pincode || undefined,
      requested_blood_bank_id: form.requested_blood_bank_id || undefined,
      submitted_by_email: form.submitted_by_email || undefined,
      submitted_by_role: form.submitted_by_role || undefined,
      notes: form.notes || undefined,
    };

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const f = {};
      for (const issue of parsed.error.issues) f[issue.path[0]] = issue.message;
      setErrors(f);
      setTopError('Please review the highlighted fields.');
      return;
    }
    // Date sanity
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(parsed.data.scheduled_date) < today) {
      setErrors({ scheduled_date: 'must be a future date' });
      setTopError('Camp date must be in the future.');
      return;
    }
    if (parsed.data.end_time <= parsed.data.start_time) {
      setErrors({ end_time: 'must be after start time' });
      setTopError('End time must be after start time.');
      return;
    }

    setSubmitting(true);
    try {
      const r = await apiRequest('POST', '/camps/apply', parsed.data);
      setSubmitted(r);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const data = err?.response?.data || {};
      if (data.error === 'blood_bank_day_full') {
        // Not a validation failure - the form is correct, the day is taken. The
        // alternatives ride down to the strip beside the blood bank, which is
        // where the choice actually gets made.
        setDayFull(data);
        setErrors({ scheduled_date: 'that blood bank is full on this day' });
        setTopError(
          'That blood bank cannot take another camp on ' +
            (data.scheduled_date || 'that date') +
            '. Pick one of the open days shown below, or leave the blood bank blank ' +
            'and we will arrange one.',
        );
      } else {
        setTopError(data.error || 'submit_failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-full">
        <Header subtitle="Host a camp" />
        <main className="mx-auto max-w-2xl px-4 py-10">
          <div className="rk-card space-y-3">
            <h1 className="text-xl font-semibold text-rk-700">Application received</h1>
            <p className="text-sm text-slate-700">
              Thank you for offering to host a donation camp. Our NGO coordinator will
              contact you on the mobile number you provided to verify details and arrange
              <strong> volunteer training</strong> on how to use Raktify during the camp.
            </p>
            <dl className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 text-sm">
              <dt className="text-slate-500">Application ID</dt>
              <dd className="font-mono text-xs text-slate-800">{submitted.camp_id}</dd>
              <dt className="text-slate-500">Camp name</dt>
              <dd className="font-medium">{submitted.name}</dd>
              <dt className="text-slate-500">Scheduled</dt>
              <dd>{submitted.scheduled_date}</dd>
              <dt className="text-slate-500">Status</dt>
              <dd>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  Pending review
                </span>
              </dd>
            </dl>
            <p className="text-xs text-slate-500">
              {submitted.next_step}
            </p>

            {/* The organiser's real question is who is coming to collect. Answer
                it here instead of leaving them to wonder - that is the whole
                point of the picker on the form. */}
            {submitted.requested_blood_bank_name ? (
              <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                You asked for <strong>{submitted.requested_blood_bank_name}</strong> to
                collect. We will confirm it with them and tell you - normally within 2-3
                days.
              </p>
            ) : (
              <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <strong>We will arrange a blood bank</strong> and tell you which one is
                coming. You do not have to find one yourself.
              </p>
            )}

            {/* Hosting stays open to anyone - no sign-in wall on this page.
                But a principal hosting three camps should not be holding
                three magic links in three WhatsApp messages, so say where
                the list lives. With a token the camp is already theirs; with
                none, signing in on the same mobile inherits it, because the
                number is stored either way. No link to the public camp page
                here on purpose - it only serves verified camps, and this one
                is still pending review. */}
            {submitted.tracked_in_profile ? (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                <strong>This camp is now in your profile.</strong> Open{' '}
                <strong>My camps</strong> to follow registrations, get the organiser link and
                correct the details while it is still pending.
              </p>
            ) : (
              <p className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
                <strong>Sign in with this mobile number</strong> to track this camp - and any
                other you host - from one place. We will link it to you automatically.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {submitted.tracked_in_profile ? (
                <Link to="/" className="rk-button-primary inline-block">
                  Go to my camps
                </Link>
              ) : (
                <>
                  <Link to="/login" className="rk-button-primary inline-block">
                    Sign in to track it
                  </Link>
                  <Link to="/" className="rk-button-secondary inline-block">
                    Back to home
                  </Link>
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <Header subtitle="Host a camp" />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Host a blood donation camp</h1>
          <p className="mt-1 text-sm text-slate-600">
            Anyone can register a camp — hospitals, blood banks, schools, colleges, corporates,
            housing societies, Rotary / Lions clubs, panchayats, or other NGOs. You do not need
            a Raktify account. Our NGO coordinator will verify your details and{' '}
            <strong>train your volunteers</strong> on how to use Raktify so every donor at the
            camp gets registered and every unit gets traced.
          </p>
        </div>

        {topError ? (
          <div className="rk-card mb-4 border border-rk-700/30 bg-rk-700/5 text-sm text-rk-700">
            {topError}
          </div>
        ) : null}

        <form className="space-y-6" onSubmit={submit}>
          {/* Organiser */}
          <section className="rk-card grid gap-3 sm:grid-cols-2">
            <h2 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
              Who is hosting?
            </h2>
            <Field label="Organisation type">
              <select
                className="rk-input"
                value={form.organiser_type}
                onChange={(e) => update('organiser_type', e.target.value)}
              >
                {ORGANISER_TYPES.map((o) => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Organisation name" error={errors.organiser_name}>
              <input
                className="rk-input"
                value={form.organiser_name}
                onChange={(e) => update('organiser_name', e.target.value)}
                placeholder="e.g. Rotary Club of Amravati"
                required
              />
            </Field>
          </section>

          {/* Date + district + who collects, ONE block, and deliberately the
              second thing on the form.

              The founder's reason for moving it up: "doing this will give
              upfront idea of selection of dates to organizer. then we can
              record the camp details." An organiser who fills in a camp name,
              a target and a date first, and only then learns the blood bank
              cannot serve that date, has to unpick their own form. Asking the
              constrained question first means the date they type is one that
              can actually happen.

              State + district moved up here with it because they have to: the
              blood-bank list is district-scoped (the backend rejects a
              cross-district request), so the district IS part of this
              question, not part of the venue. Taluka, venue, address and
              pincode stay behind in the Location section — they constrain
              nothing.

              Who collects is still a REQUEST, not an assignment: the NGO admin
              promotes it to partnered_blood_bank_id at verify (migration
              315). */}
          <section className="rk-card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              When, and who will collect the blood?
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="State" error={errors.state_id}>
                <select
                  className="rk-input"
                  value={form.state_id}
                  onChange={(e) => update('state_id', Number(e.target.value))}
                  required
                >
                  <option value={0}>— select —</option>
                  {states.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
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
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="text-sm text-slate-600">
              The blood bank sends the team, the beds and the cold-chain boxes. If you
              already work with one, name it here. If you do not know one,{' '}
              <strong>that is perfectly fine</strong> - Raktify will arrange it for you.
            </p>
            {!form.district_id ? (
              <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                Choose the district above first, then pick a blood bank here.
              </p>
            ) : bloodBanks.length === 0 ? (
              <p className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
                No blood bank is on Raktify in this district yet -{' '}
                <strong>we will arrange collection for you.</strong> Nothing to do on this
                question.
              </p>
            ) : (
              <Field
                label="Preferred blood bank"
                hint="Optional. Our NGO team confirms the blood bank when we review your application."
                error={errors.requested_blood_bank_id}
              >
                <select
                  className="rk-input"
                  value={form.requested_blood_bank_id}
                  onChange={(e) => update('requested_blood_bank_id', e.target.value)}
                >
                  <option value="">I do not know - please arrange one for us</option>
                  {bloodBanks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.display_name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {/* The calendar is browsable on its own — it answers "which days
                are free" for someone who has picked no date at all, and it is
                the surface the founder asked for so an organiser "can keep
                watch on the dates" while they are still planning. */}
            {form.requested_blood_bank_id ? (
              <BbAvailabilityCalendar
                bloodBankId={form.requested_blood_bank_id}
                date={form.scheduled_date}
                dayFull={dayFull}
                onPickDate={(d) => update('scheduled_date', d)}
              />
            ) : null}
            <Field
              label="Camp date"
              hint={
                form.requested_blood_bank_id
                  ? 'Tap a day above, or type it here.'
                  : undefined
              }
              error={errors.scheduled_date}
            >
              <input
                type="date"
                className="rk-input max-w-[14rem]"
                value={form.scheduled_date}
                min={todayISO()}
                max={isoOffsetYears(1)}
                onChange={(e) => update('scheduled_date', e.target.value)}
                required
              />
            </Field>
          </section>

          {/* Camp basics */}
          <section className="rk-card grid gap-3 sm:grid-cols-2">
            <h2 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
              Camp details
            </h2>
            <Field label="Camp name" error={errors.name}>
              <input
                className="rk-input"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder="e.g. Republic Day Donation Drive"
                required
              />
            </Field>
            <Field label="Target donors" hint="Optional — roughly how many donors are you expecting?">
              <input
                className="rk-input"
                inputMode="numeric"
                value={form.target_donor_count}
                onChange={(e) =>
                  update('target_donor_count', e.target.value.replace(/\D/g, ''))
                }
                placeholder="e.g. 50"
              />
            </Field>
            <Field label="Start time" error={errors.start_time}>
              <input
                type="time"
                className="rk-input"
                value={form.start_time}
                onChange={(e) => update('start_time', e.target.value)}
                required
              />
            </Field>
            <Field label="End time" error={errors.end_time}>
              <input
                type="time"
                className="rk-input"
                value={form.end_time}
                onChange={(e) => update('end_time', e.target.value)}
                required
              />
            </Field>
          </section>

          {/* Location */}
          <section className="rk-card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Where will it be held?
            </h2>
            <div className="max-w-sm">
              <Field
                label="Taluka"
                hint="Optional — inside the district you chose above"
              >
                <select
                  className="rk-input"
                  value={form.taluka_id}
                  onChange={(e) => update('taluka_id', Number(e.target.value))}
                  disabled={!form.district_id || talukas.length === 0}
                >
                  <option value={0}>— optional —</option>
                  {talukas.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Venue" error={errors.venue}>
              <input
                className="rk-input"
                value={form.venue}
                onChange={(e) => update('venue', e.target.value)}
                placeholder="e.g. Auditorium, Sant Gadge Baba University"
                required
              />
            </Field>
            <Field label="Address" error={errors.address_line}>
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
              />
            </Field>
          </section>

          {/* Volunteer training */}
          <section className="rk-card space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Volunteer training
            </h2>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.volunteer_training_requested}
                onChange={(e) => update('volunteer_training_requested', e.target.checked)}
              />
              <span>
                Yes — please train our volunteers on Raktify so we can register every donor
                and trace every unit during the camp.
              </span>
            </label>
            {form.volunteer_training_requested ? (
              <Field label="How many volunteers will need training?" error={errors.expected_volunteer_count}>
                <input
                  className="rk-input max-w-[10rem]"
                  inputMode="numeric"
                  value={form.expected_volunteer_count}
                  onChange={(e) =>
                    update('expected_volunteer_count', e.target.value.replace(/\D/g, ''))
                  }
                  placeholder="e.g. 6"
                />
              </Field>
            ) : null}
          </section>

          {/* Contact */}
          <section className="rk-card grid gap-3 sm:grid-cols-2">
            <h2 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
              Your contact details
            </h2>
            <Field label="Full name" error={errors.submitted_by_name}>
              <input
                className="rk-input"
                value={form.submitted_by_name}
                onChange={(e) => update('submitted_by_name', e.target.value)}
                required
              />
            </Field>
            <Field label="Your role" hint="e.g. President, Headmistress, HR Manager">
              <input
                className="rk-input"
                value={form.submitted_by_role}
                onChange={(e) => update('submitted_by_role', e.target.value)}
              />
            </Field>
            <Field
              label="Mobile (10-digit)"
              hint="Our coordinator will WhatsApp / call you on this number"
              error={errors.submitted_by_mobile}
            >
              <input
                className="rk-input"
                value={form.submitted_by_mobile}
                onChange={(e) => update('submitted_by_mobile', e.target.value)}
                placeholder="9XXXXXXXXX"
                inputMode="tel"
                required
              />
            </Field>
            <Field label="Email (optional)" error={errors.submitted_by_email}>
              <input
                type="email"
                className="rk-input"
                value={form.submitted_by_email}
                onChange={(e) => update('submitted_by_email', e.target.value)}
              />
            </Field>
            <Field label="Anything else you'd like us to know?" hint="Partnerships, blood-bank tie-ups, accessibility needs, etc.">
              <textarea
                className="rk-input col-span-full min-h-[80px]"
                value={form.notes}
                onChange={(e) => update('notes', e.target.value)}
                rows={3}
              />
            </Field>
          </section>

          <div className="flex items-center justify-between gap-3 pt-2">
            <p className="max-w-md text-xs text-slate-500">
              By submitting you agree that our coordinator may contact you on the number you
              provided. Raktify is free for camp hosts and donors — always.
            </p>
            <button type="submit" className="rk-button-primary" disabled={submitting}>
              {submitting ? '…' : 'Submit application'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
