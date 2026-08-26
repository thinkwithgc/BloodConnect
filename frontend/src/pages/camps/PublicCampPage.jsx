import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Wordmark } from '../../components/Wordmark.jsx';
import { apiRequest } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';

// Canonical via channel values (must match the backend Zod enum).
const VALID_CHANNELS = [
  'whatsapp', 'facebook', 'instagram', 'twitter', 'email', 'qr', 'direct', 'web',
];

const PENDING_KEY = 'rk.pendingCampRsvp';

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return String(v);
  }
}

function fmtTime(v) {
  return v ? String(v).slice(0, 5) : '';
}

function fmtWeekday(v) {
  if (!v) return '';
  try {
    return new Date(v).toLocaleDateString('en-IN', { weekday: 'long' });
  } catch {
    return '';
  }
}

export function PublicCampPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAuthenticated, role } = useAuth();

  // Capture ?via= and stash for later (so a donor signing in / signing up
  // mid-flow keeps the attribution).
  const viaRaw = (params.get('via') || '').toLowerCase();
  const via = VALID_CHANNELS.includes(viaRaw) ? viaRaw : 'direct';

  const campQ = useQuery({
    queryKey: ['public-camp', slug],
    queryFn: () => apiRequest('GET', `/camps/public/${slug}`),
    staleTime: 60_000,
    retry: false,
  });

  const camp = campQ.data;

  const rsvp = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/camps/${camp.id}/register`, {
        referral_channel: via,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['donor', 'me'] });
      window.sessionStorage.removeItem(PENDING_KEY);
      // Set by the signup wizard so the channel survives the detour. Clearing
      // it here stops a stale 'qr' from being attached to an unrelated camp the
      // donor opens later with no ?via= of its own.
      window.sessionStorage.removeItem('rk.pendingCampVia');
    },
  });

  // If a donor lands here logged in but came from an interrupted flow,
  // auto-RSVP. (Triggered after the auto-redirect from /login or /register
  // sets sessionStorage and bounces back to /c/<slug>.)
  useEffect(() => {
    if (!camp) return;
    const pending = window.sessionStorage.getItem(PENDING_KEY);
    if (
      pending &&
      pending === camp.slug &&
      isAuthenticated &&
      role === 'donor' &&
      !rsvp.isSuccess &&
      !rsvp.isPending
    ) {
      rsvp.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camp, isAuthenticated, role]);

  // Tap "Register for this camp" handler.
  function onPrimaryCta() {
    if (!camp) return;
    if (isAuthenticated && role === 'donor') {
      rsvp.mutate();
      return;
    }
    // Stash pending intent so the donor lands back here after login/signup.
    window.sessionStorage.setItem(PENDING_KEY, camp.slug);
    if (isAuthenticated && role !== 'donor') {
      // Logged in as staff — they can't RSVP. Show a hint via mutation error.
      return;
    }
    // Not a donor yet: prefer the registration path so they finish a real
    // donor profile (verified blood group, eligibility, etc.) before RSVPing.
    navigate(`/register?camp=${encodeURIComponent(camp.slug)}&via=${via}`);
  }

  function onLoginCta() {
    if (!camp) return;
    window.sessionStorage.setItem(PENDING_KEY, camp.slug);
    navigate(`/login?return=${encodeURIComponent(`/c/${camp.slug}?via=${via}`)}`);
  }

  if (campQ.isLoading) {
    return (
      <Shell>
        <div className="rk-card text-center text-slate-500">Loading camp…</div>
      </Shell>
    );
  }

  if (campQ.error) {
    return (
      <Shell>
        <div className="rk-card text-center">
          <h1 className="text-lg font-semibold text-rk-700">Camp not found</h1>
          <p className="mt-2 text-sm text-slate-600">
            This camp link isn&apos;t recognised — it may have been cancelled, completed, or
            the URL was mistyped.
          </p>
          <Link to="/" className="rk-button-secondary mt-4 inline-block">
            Go to Raktify home
          </Link>
        </div>
      </Shell>
    );
  }

  // Migration 313 made registered_donor_count derive as
  // COUNT(*) FILTER (WHERE status <> 'CN'), so a donor who cancelled frees their
  // slot again and someone already recorded as having donated still occupies
  // one. NS is in that set too, but this page only ever renders PL/LV camps and
  // camp-close-roster only writes NS to camps more than a day past, so for an
  // upcoming camp the figure is exactly RG + AT + DF.
  const slotsLeft =
    camp?.target_donor_count && camp?.registered_donor_count != null
      ? Math.max(0, camp.target_donor_count - camp.registered_donor_count)
      : null;

  const ctaState = rsvp.isSuccess
    ? 'done'
    : camp?.is_current_donor_registered
      ? 'already-registered'
      : rsvp.error
        ? 'error'
        : isAuthenticated && role === 'donor'
          ? 'rsvp'
          : isAuthenticated
            ? 'wrong-role'
            : 'signup-or-login';

  return (
    <Shell>
      {/* Hero card */}
      <article className="rk-card space-y-3 border-l-4 border-rk-700">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Blood donation camp · {camp.district_name}
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{camp.name}</h1>
          <p className="text-sm text-slate-600">Hosted by {camp.organiser_name}</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Fact label="Date" big={fmtDate(camp.scheduled_date)} sub={fmtWeekday(camp.scheduled_date)} />
          <Fact label="Time" big={`${fmtTime(camp.start_time)}–${fmtTime(camp.end_time)}`} />
          <Fact label="Venue" big={camp.venue} sub={camp.address_line} />
          <Fact
            label="Already signed up"
            big={`${camp.registered_donor_count ?? 0}${camp.target_donor_count ? ` / ${camp.target_donor_count}` : ''}`}
            sub={slotsLeft != null ? `${slotsLeft} slots left` : null}
          />
        </dl>
        {camp.partnered_blood_bank_name ? (
          <p className="text-xs text-slate-500">
            Partner blood bank: <strong>{camp.partnered_blood_bank_name}</strong>
          </p>
        ) : null}
      </article>

      {/* CTA card */}
      <article className="rk-card space-y-3">
        {ctaState === 'done' || ctaState === 'already-registered' ? (
          <div className="text-center">
            <h2 className="text-lg font-semibold text-green-800">
              {ctaState === 'done' ? 'You’re on the list' : 'You’re already registered'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {ctaState === 'done'
                ? `We’ll send you a reminder a day before the camp. See you at ${camp.venue}.`
                : `Thanks — your RSVP for ${camp.name} is confirmed. We’ll message you a day before with the venue details.`}
            </p>
            <Link to="/donor" className="rk-button-secondary mt-3 inline-block">
              Open my donor profile
            </Link>
          </div>
        ) : ctaState === 'wrong-role' ? (
          <div className="text-center">
            <p className="text-sm text-slate-600">
              You&apos;re signed in as <strong>{role}</strong>, not a donor. Donors can RSVP from
              their own login.
            </p>
            <Link to="/" className="rk-button-secondary mt-3 inline-block">
              Back to home
            </Link>
          </div>
        ) : (
          <>
            <h2 className="text-base font-semibold text-slate-900">Register for this camp</h2>
            <p className="text-sm text-slate-600">
              {ctaState === 'rsvp'
                ? 'One tap and you’re on the roster — we won’t share your phone with the organiser.'
                : 'New to Raktify? Quick mobile-OTP signup, then you’ll be added to the camp.'}
            </p>
            <button
              type="button"
              className="rk-button-primary w-full"
              onClick={onPrimaryCta}
              disabled={rsvp.isPending}
            >
              {rsvp.isPending
                ? '…'
                : ctaState === 'rsvp'
                  ? 'I will be there'
                  : 'Sign up & register'}
            </button>
            {ctaState === 'signup-or-login' ? (
              <p className="text-center text-xs text-slate-500">
                Already a Raktify donor?{' '}
                <button
                  type="button"
                  onClick={onLoginCta}
                  className="font-semibold text-rk-700 hover:underline"
                >
                  Log in to RSVP
                </button>
              </p>
            ) : null}
            {ctaState === 'error' ? (
              <p className="text-center text-xs text-rk-700">
                {rsvp.error?.response?.data?.error || 'rsvp_failed'} — please try again.
              </p>
            ) : null}
          </>
        )}
      </article>

      {/* Educational footer */}
      <article className="rk-card space-y-2 text-sm text-slate-600">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          What to expect
        </h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>Bring a government photo ID (Aadhaar, voter ID, driving licence).</li>
          <li>Eat a normal meal 2–3 hours before. Stay hydrated.</li>
          <li>
            Donation takes ~10 minutes once you&apos;re on the couch. The full visit
            (screening + post-donation rest) is about 30–45 minutes.
          </li>
          <li>
            Your donation will be tested for HIV, Hepatitis B, Hepatitis C, syphilis and
            malaria before being released — your results stay confidential.
          </li>
          <li>
            Raktify never shares your phone number with the organiser. All
            organiser-to-donor communication goes through the platform.
          </li>
        </ul>
      </article>

      <Footer />
    </Shell>
  );
}

function Fact({ label, big, sub }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 font-semibold text-slate-900">{big || '—'}</div>
      {sub ? <div className="text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-full bg-cream">
      <Header />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">{children}</main>
    </div>
  );
}

function Footer() {
  return (
    <footer className="pt-4 text-center text-xs text-slate-400">
      Powered by{' '}
      <Link to="/" className="font-semibold text-rk-700 hover:underline">
        <Wordmark className="inline-block align-baseline text-[13px]" />
      </Link>
    </footer>
  );
}

export { PENDING_KEY };
