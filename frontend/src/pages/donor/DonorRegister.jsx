import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { DateOfBirthInput } from '../../components/DateOfBirthInput.jsx';
import { Header } from '../../components/Header.jsx';
import { LocalityPicker } from '../../components/LocalityPicker.jsx';
import { apiRequest } from '../../lib/api.js';
import { indianMobileSchema } from '../../lib/schemas.js';
import { SELF_BLOOD_GROUPS } from '../../lib/bloodGroups.js';
import { otpErrorText } from '../../lib/otpError.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useT } from '../../i18n/useT.js';
import { LANG_LABELS } from '../../i18n/strings.js';

// 2-step donor registration (simplified 2026-07-03):
//   1 = personal details  → POST /donors/register
//   2 = consent + OTP finalisation
//
// The earlier pre-screening (Step 1 Health) and temporary-deferral (Step 3
// Recent) tabs were dropped because:
//   - The blood bank performs the authoritative TTI + interview at donation
//     time. Self-report has no clinical value we don't already re-collect
//     when the donor sits in the chair.
//   - Fewer questions = higher completion rate = larger donor pool.
//   - The DB-level age gate (18–65 via CHECK on date_of_birth) stays in
//     place regardless.

const personalSchema = z.object({
  mobile: indianMobileSchema,
  full_name: z.string().trim().min(2).max(120),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date'),
  gender: z.enum(['M', 'F', 'O']),
  blood_group_self_reported: z.number().int().min(1).max(8).optional(),
  village_id: z.number().int().positive().optional(),
  max_travel_km: z.number().int().min(1).max(100),
  preferred_contact_channel: z.enum(['WA', 'SM', 'CA']),
  // Asked, not inferred. This used to be sent as whatever the UI language
  // happened to be, and detectInitialLang() falls back to the BROWSER's
  // language — most Indian phones report English, so a Marathi-speaking donor
  // was silently registered as 'en' and got English WhatsApp messages for good.
  preferred_language: z.enum(['mr', 'hi', 'en']),
  whatsapp_opted_in: z.boolean(),
  sms_opted_in: z.boolean(),
});

// Coerce the UI-only `details` state into the shape personalSchema expects,
// then validate. Used by both the Step-1 "Continue" gate and the final submit.
function parseDetails(details) {
  return personalSchema.safeParse({
    ...details,
    blood_group_self_reported:
      details.blood_group_self_reported === ''
        ? undefined
        : Number(details.blood_group_self_reported),
    max_travel_km: Number(details.max_travel_km),
    village_id: details.locality?.id,
    locality: undefined, // UI-only object the schema doesn't know about
  });
}

const initialDetails = {
  mobile: '',
  full_name: '',
  date_of_birth: '',
  gender: 'M',
  blood_group_self_reported: '',
  locality: null, // the full { id, name, name_hi, taluka_name, ... } object from LocalityPicker
  max_travel_km: 10,
  preferred_contact_channel: 'WA',
  whatsapp_opted_in: true,
  sms_opted_in: true,
};

export function DonorRegister() {
  const { t, lang, setLang, supported } = useT();
  const { setSession } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  // The picker the donor is already reading in is the right default; they only
  // touch the field if it is wrong.
  const [details, setDetails] = useState(() => ({
    ...initialDetails,
    preferred_language: lang,
  }));
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  // Post-submit handoff state.
  const [registered, setRegistered] = useState(null); // { donor_id, platform_user_id, ... }
  const [otpStage, setOtpStage] = useState('idle'); // 'idle'|'send_failed'|'sent'|'verified'|'consented'
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState('');

  // As soon as the mobile looks complete, probe whether it already belongs to
  // a donor. If so we steer them to OTP login (where they can also correct
  // their profile) instead of letting them fill the whole form only to hit a
  // duplicate error at submit. Debounced; failures are silent (it's a hint).
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  useEffect(() => {
    const m = (details.mobile || '').trim();
    if (!indianMobileSchema.safeParse(m).success) {
      setAlreadyRegistered(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await apiRequest(
          'GET',
          `/donors/registration-status?mobile=${encodeURIComponent(m)}`,
        );
        if (alive) setAlreadyRegistered(Boolean(r.registered));
      } catch {
        // Non-blocking hint — ignore probe failures.
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [details.mobile]);

  // If the user arrived from a public camp link (/register?camp=<slug>) - the
  // QR poster at the camp desk, or the Register button on /c/<slug> - persist
  // that intent in sessionStorage so it survives a multi-step wizard refresh
  // and is honoured by the redirect-after-completion logic below.
  //
  // Then resolve the slug to the camp id, because the intent is not only a
  // redirect: it is the donor's ATTRIBUTION. The payload below used to send a
  // flat registration_source:'WEB' and drop the camp entirely, so every QR
  // signup at every camp was recorded as an ordinary web registration and no
  // organiser could ever see how many donors their poster actually brought -
  // even though the backend has validated and stored 'QRC' +
  // registration_camp_id since the Phase 3 scaffold (donors.js:152).
  const [campId, setCampId] = useState(null);
  const [campName, setCampName] = useState(null);
  useEffect(() => {
    const slug =
      new URLSearchParams(window.location.search).get('camp') ||
      window.sessionStorage.getItem('rk.pendingCampRsvp');
    if (!slug) return;
    window.sessionStorage.setItem('rk.pendingCampRsvp', slug);
    // Carry the share channel across the wizard too. The roster row - and with
    // it referral_channel - is created back on /c/<slug> after signup, and that
    // hand-back used to drop ?via=, so a donor who scanned the desk QR was
    // filed on the roster as 'direct' and the organiser's channel mix
    // undercounted the poster that actually brought them.
    const via = new URLSearchParams(window.location.search).get('via');
    if (via) window.sessionStorage.setItem('rk.pendingCampVia', via);
    let alive = true;
    (async () => {
      try {
        // This endpoint serves PL/LV camps only, which is the same gate the
        // backend applies to a 'QRC' registration - so a camp it will not
        // resolve is a camp we must not claim attribution for. Leaving campId
        // null falls back to 'WEB' and the signup still goes through: an
        // attribution tag is never worth failing a donor registration over.
        const data = await apiRequest('GET', `/camps/public/${encodeURIComponent(slug)}`);
        if (!alive) return;
        setCampId(data.id);
        setCampName(data.name);
      } catch {
        // Unknown, completed or cancelled camp - register without attribution.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Phase 3: if the user arrived from /community/<slug> (a leader's referral
  // link), resolve the community slug → id and stash it. We send community_id
  // with the register payload so the donor is attributed correctly.
  const [communityId, setCommunityId] = useState(null);
  const [communityName, setCommunityName] = useState(null);
  useEffect(() => {
    const slug =
      new URLSearchParams(window.location.search).get('community') ||
      window.sessionStorage.getItem('rk.pendingCommunitySlug');
    if (!slug) return;
    let alive = true;
    (async () => {
      try {
        const data = await apiRequest('GET', `/community/${encodeURIComponent(slug)}`);
        if (!alive) return;
        setCommunityId(data.community.id);
        setCommunityName(data.community.name);
      } catch {
        // Bad slug — ignore silently; donor can still register without attribution.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function update(k, v) {
    setDetails((prev) => ({ ...prev, [k]: v }));
  }

  function backTo(s) {
    setError('');
    setStep(s);
  }

  // ── Step 2: submit ────────────────────────────────────────────────────
  async function submitRegistration() {
    setError('');
    if (!consent) {
      setError(t('reg_err_consent_required'));
      return;
    }
    const parsed = parseDetails(details);
    if (!parsed.success) {
      setError(t('reg_err_invalid_details'));
      setStep(1);
      return;
    }

    setPending(true);
    try {
      const payload = {
        // preferred_language rides in on parsed.data — it is an answered
        // question now, not the ambient UI language.
        ...parsed.data,
        // 'QRC' + registration_camp_id closes the loop the schema has been
        // waiting on since Phase 3 (CLAUDE.md Phase 3 TODO #2). Only sent when
        // the slug actually resolved to an open camp - the backend rejects
        // 'QRC' without a valid camp id (400 qr_registration_requires_camp_id),
        // so guessing here would block the signup.
        ...(campId
          ? { registration_source: 'QRC', registration_camp_id: campId }
          : { registration_source: 'WEB' }),
        // Phase 3 attribution: if the user came from /community/<slug>,
        // tag the donor to that community. The backend defaults
        // referred_by_community_leader_id to the community's current owner
        // when only community_id is provided.
        ...(communityId ? { community_id: communityId } : {}),
      };
      const r = await apiRequest('POST', '/donors/register', payload);
      // Successful registration. We still need to (a) verify the mobile
      // via OTP and (b) POST consent. Both require a session — kick OTP.
      setRegistered(r);
      // The send gets its OWN catch, because by this line the donor row
      // EXISTS: a WhatsApp send that fails is not a failed registration. In the
      // outer catch it read as one — a bare error on the consent step, with
      // otpStage still 'idle' so the OTP panel never rendered, and re-submitting
      // the form then answered mobile_already_registered. A donor whose record
      // was created perfectly had no way forward.
      try {
        const sent = await apiRequest('POST', '/auth/otp/send', {
          mobile: parsed.data.mobile,
          role_hint: 'donor',
        });
        setOtpStage('sent');
        if (sent.dev_otp) setDevOtp(sent.dev_otp);
      } catch (sendErr) {
        setOtpStage('send_failed');
        setError(otpErrorText(sendErr, t));
      }
    } catch (err) {
      const code = err?.response?.data?.error;
      if (code === 'mobile_already_registered') {
        // Surface the "log in instead" banner rather than a raw error code.
        setAlreadyRegistered(true);
        setError('');
      } else if (code === 'invalid_input' || code === 'invalid_mobile_format') {
        setError(t('reg_err_invalid_details'));
        setStep(1);
      } else if (code === 'rate_limit_donor_register') {
        setError(t('otp_err_rate_limited'));
      } else {
        // Every remaining code — a stale camp QR, a duplicate match, a 500 —
        // is not something the donor can act on differently, so they get one
        // honest sentence and the support line rather than a code.
        setError(t('reg_err_submit_failed'));
      }
    } finally {
      setPending(false);
    }
  }

  // Retry path for otpStage === 'send_failed'. The account already exists, so
  // this is the OTP call ALONE — never a second POST /donors/register, which
  // would now answer mobile_already_registered.
  async function resendOtp() {
    setError('');
    setPending(true);
    try {
      const sent = await apiRequest('POST', '/auth/otp/send', {
        mobile: (details.mobile || '').trim(),
        role_hint: 'donor',
      });
      setOtpStage('sent');
      if (sent.dev_otp) setDevOtp(sent.dev_otp);
    } catch (err) {
      setOtpStage('send_failed');
      setError(otpErrorText(err, t));
    } finally {
      setPending(false);
    }
  }

  async function verifyOtp() {
    setError('');
    if (!/^\d{6}$/.test(otp)) {
      setError(otpErrorText('otp_must_be_6_digits', t));
      return;
    }
    setPending(true);
    try {
      const session = await apiRequest('POST', '/auth/otp/verify', {
        mobile: details.mobile,
        otp,
      });
      setSession(session);
      setOtpStage('verified');

      // Now record consent against the freshly-created donor row.
      try {
        await apiRequest('POST', `/donors/${registered.donor_id}/consent`, {
          consent_data_use: true,
        });
      } catch (consentErr) {
        // Consent failure is non-fatal for the user — surface but still send
        // them to the dashboard where they can retry.
        // eslint-disable-next-line no-console
        console.warn('consent_post_failed', consentErr);
      }
      setOtpStage('consented');
      // If they came from a public camp link, bounce back to /c/<slug> so
      // PublicCampPage can auto-RSVP using the sessionStorage marker.
      const q = new URLSearchParams(window.location.search);
      const campParam = q.get('camp');
      const pendingCamp = campParam || window.sessionStorage.getItem('rk.pendingCampRsvp');
      const pendingVia = q.get('via') || window.sessionStorage.getItem('rk.pendingCampVia');
      navigate(
        pendingCamp
          ? `/c/${encodeURIComponent(pendingCamp)}` +
              (pendingVia ? `?via=${encodeURIComponent(pendingVia)}` : '')
          : '/donor',
        { replace: true },
      );
    } catch (err) {
      setError(otpErrorText(err, t));
    } finally {
      setPending(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-full">
      <Header subtitle={t('app_name')} />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <Stepper
          current={step}
          labels={['Your details', 'Consent']}
          onJump={(s) => (s < step ? backTo(s) : null)}
        />

        {campName ? (
          <div className="mb-3 rounded-md bg-rk-50 p-2 text-sm text-rk-900 ring-1 ring-rk-200">
            You&apos;re registering at <strong>{campName}</strong>. We&apos;ll add you to the
            camp roster as soon as your number is verified.
          </div>
        ) : null}

        {communityName ? (
          <div className="mb-3 rounded-md bg-rk-50 p-2 text-sm text-rk-900 ring-1 ring-rk-200">
            You&apos;re joining <strong>{communityName}</strong>. The community organisers will
            see your name + blood group only — never your mobile.
          </div>
        ) : null}

        {alreadyRegistered && !registered ? (
          <div className="mb-3 flex flex-col gap-2 rounded-md bg-rk-50 p-3 text-sm text-rk-900 ring-1 ring-rk-200 sm:flex-row sm:items-center sm:justify-between">
            <span>
              This number is <strong>already registered</strong>. No need to fill this again — log
              in with a one-time password to see your dashboard and fix any details.
            </span>
            <button
              type="button"
              className="rk-button-primary shrink-0 whitespace-nowrap"
              onClick={() =>
                navigate(`/login?m=${encodeURIComponent((details.mobile || '').trim())}`)
              }
            >
              Log in with OTP →
            </button>
          </div>
        ) : null}

        {registered && otpStage === 'send_failed' ? (
          <div className="rk-card space-y-3">
            <h2 className="text-lg font-semibold text-rk-700">{t('otp_send_failed_title')}</h2>
            {error ? <p className="text-sm text-rk-700">{error}</p> : null}
            {/* Say plainly that the record was saved. Without this the donor
                re-fills the form, gets mobile_already_registered, and reads the
                whole thing as broken. */}
            <p className="text-sm text-slate-600">{t('reg_saved_otp_pending')}</p>
            <button
              type="button"
              onClick={resendOtp}
              disabled={pending}
              className="rk-button-primary w-full"
            >
              {pending ? '…' : t('otp_resend')}
            </button>
          </div>
        ) : registered && otpStage !== 'idle' ? (
          <div className="rk-card space-y-4">
            <h2 className="text-lg font-semibold text-rk-700">Verify mobile</h2>
            <p className="text-sm text-slate-600">
              We sent a 6-digit code to {details.mobile}. Enter it to finish setting up your
              account.
            </p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="rk-input tracking-[0.5em] text-center text-lg"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            />
            {devOtp ? (
              <p className="text-xs text-slate-500">dev_otp echoed by backend: {devOtp}</p>
            ) : null}
            <button
              type="button"
              onClick={verifyOtp}
              disabled={pending}
              className="rk-button-primary w-full"
            >
              {pending ? '…' : t('verify_otp')}
            </button>
            {error ? <p className="text-sm text-rk-700">{error}</p> : null}
          </div>
        ) : (
          <>
            {step === 1 ? (
              <StepDetails
                details={details}
                update={update}
                onContinue={() => {
                  // Validate before allowing forward step.
                  const parsed = parseDetails(details);
                  if (!parsed.success) {
                    setError(t('reg_err_invalid_details'));
                    return;
                  }
                  setError('');
                  setStep(2);
                }}
                error={error}
              />
            ) : null}

            {step === 2 ? (
              <StepConsent
                consent={consent}
                setConsent={setConsent}
                pending={pending}
                onBack={() => backTo(1)}
                onSubmit={submitRegistration}
                error={error}
              />
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

// ─── Step 1: personal details ─────────────────────────────────────────────
function StepDetails({ details, update, onContinue, error }) {
  return (
    <section className="rk-card space-y-4">
      <h2 className="text-lg font-semibold text-rk-700">Step 1 — Your details</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile" htmlFor="r-mobile">
          <input
            id="r-mobile"
            inputMode="tel"
            autoComplete="tel"
            className="rk-input"
            placeholder="+91 9XXXXXXXXX"
            value={details.mobile}
            onChange={(e) => update('mobile', e.target.value)}
            required
          />
        </Field>
        <Field label="Full name" htmlFor="r-name">
          <input
            id="r-name"
            className="rk-input"
            value={details.full_name}
            onChange={(e) => update('full_name', e.target.value)}
            required
            maxLength={120}
          />
        </Field>
        <Field label="Date of birth" htmlFor="r-dob">
          {/* Day / month / year selects, not a native date picker: that opens on
              the current month, so a 45-year-old at a camp desk would page back
              540 months to reach 1981. The 18–65 year range mirrors the
              age_min / age_max CHECKs — it does not replace them. */}
          <DateOfBirthInput
            id="r-dob"
            value={details.date_of_birth}
            onChange={(iso) => update('date_of_birth', iso)}
            required
          />
        </Field>
        <Field label="Gender" htmlFor="r-gender">
          <select
            id="r-gender"
            className="rk-input"
            value={details.gender}
            onChange={(e) => update('gender', e.target.value)}
          >
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="O">Other</option>
          </select>
        </Field>

        <Field label="Blood group (if known)" htmlFor="r-bg" hint="Self-reported only — a blood bank will verify this on your first donation.">
          <select
            id="r-bg"
            className="rk-input"
            value={details.blood_group_self_reported}
            onChange={(e) => update('blood_group_self_reported', e.target.value)}
          >
            <option value="">I don't know</option>
            {SELF_BLOOD_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <LocalityPicker
            id="r-locality"
            label="Your village or area (optional)"
            value={details.locality}
            onChange={(loc) => update('locality', loc)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Type the name of your village, city, or (in Amravati City) your ward.
            We use this only to route alerts — we never ask for your street address.
          </p>
        </div>

        <Field label="Max travel (km)" htmlFor="r-km">
          <input
            id="r-km"
            type="number"
            min={1}
            max={100}
            className="rk-input"
            value={details.max_travel_km}
            onChange={(e) => update('max_travel_km', Number(e.target.value || 0))}
          />
        </Field>
        <Field label="Preferred contact" htmlFor="r-channel">
          <select
            id="r-channel"
            className="rk-input"
            value={details.preferred_contact_channel}
            onChange={(e) => update('preferred_contact_channel', e.target.value)}
          >
            <option value="WA">WhatsApp</option>
            <option value="SM">SMS</option>
            <option value="CA">Call</option>
          </select>
        </Field>
        <Field
          label={t('donor_lang_label')}
          htmlFor="r-lang"
          hint={t('donor_lang_hint')}
        >
          <select
            id="r-lang"
            className="rk-input"
            value={details.preferred_language}
            onChange={(e) => {
              update('preferred_language', e.target.value);
              // Switch the page too. Answering "which language do you want" and
              // then carrying on in a different one reads as the question having
              // been ignored — and it makes the choice verifiable on the spot.
              setLang(e.target.value);
            }}
          >
            {supported.map((l) => (
              <option key={l} value={l}>
                {LANG_LABELS[l] || l}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={details.whatsapp_opted_in}
            onChange={(e) => update('whatsapp_opted_in', e.target.checked)}
          />
          <span className="text-sm text-slate-700">
            I'm OK to receive WhatsApp messages about emergency requests
          </span>
        </label>
        <label className="flex items-center gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={details.sms_opted_in}
            onChange={(e) => update('sms_opted_in', e.target.checked)}
          />
          <span className="text-sm text-slate-700">I'm OK to receive SMS</span>
        </label>
      </div>

      {error ? <p className="text-sm text-rk-700">{error}</p> : null}

      <div className="flex justify-end">
        <button type="button" className="rk-button-primary" onClick={onContinue}>
          Continue
        </button>
      </div>
    </section>
  );
}

// ─── Step 2: consent ──────────────────────────────────────────────────────
function StepConsent({ consent, setConsent, pending, onBack, onSubmit, error }) {
  return (
    <section className="rk-card space-y-4">
      <h2 className="text-lg font-semibold text-rk-700">Step 2 — Consent</h2>
      <div className="space-y-2 text-sm text-slate-700">
        <p>
          Raktify uses your contact details and donation history only to match you with
          patients who need blood. We never share your mobile number with hospitals — every
          donor↔hospital message goes through our coordinators.
        </p>
        <p>
          Your name and address are <strong>encrypted at rest</strong>. You can change your
          availability or withdraw consent at any time from your dashboard, and you can ask us
          to delete your data whenever you like.
        </p>
      </div>
      {/* DPDP Act 2023 §5 notice: point the donor at the full privacy notice
          and their erasure rights BEFORE they consent. */}
      <p className="text-sm text-slate-600">
        Before you agree, please read our{' '}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-rk-700 underline"
        >
          Privacy Policy
        </a>{' '}
        — it explains what we collect, why, and your rights under India&apos;s DPDP Act 2023.
        You can withdraw or{' '}
        <a
          href="/data-deletion"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-rk-700 underline"
        >
          delete your data
        </a>{' '}
        any time.
      </p>
      <label className="flex items-start gap-3 rounded-md bg-rk-50 p-3 ring-1 ring-rk-100">
        <input
          type="checkbox"
          className="mt-1"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span className="text-sm text-rk-900">
          I have read the{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline"
          >
            Privacy Policy
          </a>{' '}
          and consent to my details being used to match me with blood donation requests.
        </span>
      </label>
      {error ? <p className="text-sm text-rk-700">{error}</p> : null}
      <div className="flex justify-between">
        <button type="button" className="rk-button-secondary" onClick={onBack} disabled={pending}>
          Back
        </button>
        <button
          type="button"
          className="rk-button-primary"
          onClick={onSubmit}
          disabled={!consent || pending}
        >
          {pending ? '…' : 'Register'}
        </button>
      </div>
    </section>
  );
}

// ─── Shared bits ───────────────────────────────────────────────────────────
function Field({ label, htmlFor, hint, children }) {
  return (
    <div>
      <label className="rk-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function Stepper({ current, labels, onJump }) {
  return (
    <ol className="mb-4 flex items-center justify-between">
      {labels.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const here = n === current;
        return (
          <li key={label} className="flex flex-1 items-center">
            <button
              type="button"
              onClick={() => onJump?.(n)}
              className={
                'flex items-center gap-2 ' +
                (done ? 'cursor-pointer text-rk-700' : here ? 'text-rk-900' : 'text-slate-400')
              }
            >
              <span
                className={
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ' +
                  (done
                    ? 'bg-rk-700 text-white'
                    : here
                      ? 'bg-rk-50 text-rk-700 ring-2 ring-rk-700'
                      : 'bg-slate-100 text-slate-500')
                }
              >
                {n}
              </span>
              <span className="hidden text-sm font-medium sm:inline">{label}</span>
            </button>
            {i < labels.length - 1 ? (
              <div
                className={'mx-2 h-px flex-1 ' + (done ? 'bg-rk-700' : 'bg-slate-200')}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

