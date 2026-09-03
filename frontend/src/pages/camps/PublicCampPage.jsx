import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Wordmark } from '../../components/Wordmark.jsx';
import { apiRequest } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useT } from '../../i18n/useT.js';

// Canonical via channel values (must match the backend Zod enum).
const VALID_CHANNELS = [
  'whatsapp', 'facebook', 'instagram', 'twitter', 'email', 'qr', 'direct', 'web',
];

const PENDING_KEY = 'rk.pendingCampRsvp';

// Month and weekday names come from the string pack, never
// toLocaleDateString('mr-IN'): Intl's Marathi data is not reliably present and
// its forms are unpredictable. Digits stay Latin in every language.
function fmtDate(v, t) {
  if (!v) return '—';
  const ymd = String(v).slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return String(v);
  const months = t('camp_months');
  const mn = Array.isArray(months) ? months[m - 1] : m;
  return `${d} ${mn} ${y}`;
}

function fmtTime(v) {
  return v ? String(v).slice(0, 5) : '';
}

function fmtWeekday(v, t) {
  if (!v) return '';
  const ymd = String(v).slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return '';
  const dows = t('camp_weekdays');
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return Array.isArray(dows) ? dows[dow] : '';
}

export function PublicCampPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAuthenticated, role } = useAuth();
  const { t } = useT();

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
        <div className="rk-card text-center text-slate-500">{t('camp_pub_loading')}</div>
      </Shell>
    );
  }

  if (campQ.error) {
    return (
      <Shell>
        <div className="rk-card text-center">
          <h1 className="text-lg font-semibold text-rk-700">{t('camp_pub_nf_title')}</h1>
          <p className="mt-2 text-sm text-slate-600">{t('camp_pub_nf_body')}</p>
          <Link to="/" className="rk-button-secondary mt-4 inline-block">
            {t('camp_pub_nf_cta')}
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
            {t('camp_pub_eyebrow', { district: camp.district_name })}
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{camp.name}</h1>
        </div>
        <OrganiserBlock camp={camp} />
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Fact
            label={t('camp_pub_f_date')}
            big={fmtDate(camp.scheduled_date, t)}
            sub={fmtWeekday(camp.scheduled_date, t)}
          />
          <Fact
            label={t('camp_pub_f_time')}
            big={`${fmtTime(camp.start_time)}–${fmtTime(camp.end_time)}`}
          />
          <Fact label={t('camp_pub_f_venue')} big={camp.venue} sub={camp.address_line} />
          <Fact
            label={t('camp_pub_f_signed_up')}
            big={`${camp.registered_donor_count ?? 0}${camp.target_donor_count ? ` / ${camp.target_donor_count}` : ''}`}
            sub={slotsLeft != null ? t('camp_pub_slots_left', { n: slotsLeft }) : null}
          />
        </dl>
        {camp.partnered_blood_bank_name ? (
          <p className="text-xs text-slate-500">
            {t('camp_pub_partner_bb')}
            <strong>{camp.partnered_blood_bank_name}</strong>
          </p>
        ) : null}
      </article>

      {/* CTA card */}
      <article className="rk-card space-y-3">
        {ctaState === 'done' || ctaState === 'already-registered' ? (
          <div className="text-center">
            <h2 className="text-lg font-semibold text-green-800">
              {ctaState === 'done' ? t('camp_pub_done_title') : t('camp_pub_already_title')}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {ctaState === 'done'
                ? t('camp_pub_done_body', { venue: camp.venue })
                : t('camp_pub_already_body', { name: camp.name })}
            </p>
            <Link to="/donor" className="rk-button-secondary mt-3 inline-block">
              {t('camp_pub_open_profile')}
            </Link>
          </div>
        ) : ctaState === 'wrong-role' ? (
          <div className="text-center">
            <p className="text-sm text-slate-600">
              {t('camp_pub_wrong_role_pre')}
              <strong>{role}</strong>
              {t('camp_pub_wrong_role_post')}
            </p>
            <Link to="/" className="rk-button-secondary mt-3 inline-block">
              {t('camp_pub_back_home')}
            </Link>
          </div>
        ) : (
          <>
            <h2 className="text-base font-semibold text-slate-900">
              {t('camp_pub_reg_title')}
            </h2>
            <p className="text-sm text-slate-600">
              {ctaState === 'rsvp' ? t('camp_pub_reg_body_rsvp') : t('camp_pub_reg_body_new')}
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
                  ? t('camp_pub_cta_rsvp')
                  : t('camp_pub_cta_signup')}
            </button>
            {ctaState === 'signup-or-login' ? (
              <p className="text-center text-xs text-slate-500">
                {t('camp_pub_already_donor')}
                <button
                  type="button"
                  onClick={onLoginCta}
                  className="font-semibold text-rk-700 hover:underline"
                >
                  {t('camp_pub_login_link')}
                </button>
              </p>
            ) : null}
            {ctaState === 'error' ? (
              <p className="text-center text-xs text-rk-700">
                {t('camp_pub_err', {
                  err: rsvp.error?.response?.data?.error || 'rsvp_failed',
                })}
              </p>
            ) : null}
          </>
        )}
      </article>

      {/* Educational footer */}
      <article className="rk-card space-y-2 text-sm text-slate-600">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {t('camp_pub_expect_title')}
        </h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('camp_pub_expect_1')}</li>
          <li>{t('camp_pub_expect_2')}</li>
          <li>{t('camp_pub_expect_3')}</li>
          <li>{t('camp_pub_expect_4')}</li>
          <li>{t('camp_pub_expect_5')}</li>
        </ul>
      </article>

      <Footer />
    </Shell>
  );
}

// The organiser's own identity, deliberately INSIDE the body and at a smaller
// scale than the camp name, which stays the page's <h1>. Raktify keeps visual
// primacy (founder decision, 30-Aug-2026): this is never a lockup with the
// wordmark, never an equal-scale pairing, and never says "in partnership with"
// - Raktify is the platform, not a co-host.
//
// The logo BOX is 96px (founder, 02-Sep-2026, raised from 56px so a village
// organisation is actually recognisable on a phone). That does not contradict
// the rule above: primacy is carried by the TYPE scale - the camp name is the
// text-2xl <h1>, the organiser name is text-sm body copy - and the image sits
// below the heading, never beside it. Do not read "smaller scale" as a cap on
// the picture and shrink this back.
//
// logo_data_uri and organiser_tagline arrive NULL unless branding_status='AP'
// (the gate lives in SQL, in GET /camps/public/:slug), so both are optional and
// this block must read correctly with neither. On a brand-new camp it is just
// the label and the name, which is what the page said before branding existed.
function OrganiserBlock({ camp }) {
  const { t } = useT();
  const typeKey = camp.organiser_type ? `camp_org_type_${camp.organiser_type}` : null;
  const typeLabel = typeKey ? t(typeKey) : '';
  // tFor falls back to the raw key when a value is missing, and this is a public
  // page - show nothing rather than a snake_case key.
  const showType = typeLabel && typeLabel !== typeKey;

  return (
    <div className="flex items-start gap-4">
      {camp.logo_data_uri ? (
        <img
          src={camp.logo_data_uri}
          // Decorative: the organisation name sits right beside it, so an alt
          // text here would only make a screen reader say the name twice.
          alt=""
          className="h-24 w-24 shrink-0 rounded-lg object-contain ring-1 ring-slate-200"
        />
      ) : null}
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {t('camp_brand_organiser')}
        </div>
        <div className="text-sm font-semibold text-slate-900">{camp.organiser_name}</div>
        {showType ? <div className="text-xs text-slate-500">{typeLabel}</div> : null}
        {camp.organiser_tagline ? (
          <p className="mt-1 text-sm italic text-slate-600">{camp.organiser_tagline}</p>
        ) : null}
      </div>
    </div>
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

// The wordmark sits AFTER the words in English and BEFORE them in Marathi, so
// this is two fragment keys rather than one: mr leaves _pre empty and carries
// ' द्वारे' in _post, en does the reverse.
function Footer() {
  const { t } = useT();
  return (
    <footer className="pt-4 text-center text-xs text-slate-400">
      {t('camp_pub_powered_pre')}
      <Link to="/" className="font-semibold text-rk-700 hover:underline">
        <Wordmark tm className="inline-block align-baseline text-[13px]" />
      </Link>
      {t('camp_pub_powered_post')}
    </footer>
  );
}

export { PENDING_KEY };
