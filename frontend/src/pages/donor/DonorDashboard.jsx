import { useMemo, useState } from 'react';
// PILOT SCOPE (Aug 2026): the only <Link> on this page was the raise-a-request
// CTA below, commented out with it. Uncomment both together.
// import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DateOfBirthInput } from '../../components/DateOfBirthInput.jsx';
import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { RoleSwitcher } from '../../components/RoleSwitcher.jsx';
import { LocalityPicker } from '../../components/LocalityPicker.jsx';
import { apiRequest } from '../../lib/api.js';
import { SELF_BLOOD_GROUPS } from '../../lib/bloodGroups.js';
import { useT } from '../../i18n/useT.js';
import { LANG_LABELS } from '../../i18n/strings.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { isOfflineError, useOutbox } from '../../lib/useOutbox.js';
import { MyCampsSection } from '../camps/MyCampsSection.jsx';

function formatDate(s, lang) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString(lang || 'en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return s;
  }
}

export function DonorDashboard() {
  const { t, lang } = useT();
  const { logout } = useAuth();
  const qc = useQueryClient();
  const { pending: outboxPending, enqueue: enqueueOutbox, flushNow } = useOutbox({
    invalidateKeys: [['donor', 'me']],
  });

  const passportQuery = useQuery({
    queryKey: ['donor', 'me'],
    queryFn: () => apiRequest('GET', '/donors/me'),
    staleTime: 0, // donor surfaces shouldn't show stale availability
  });

  // Spec §7.6: availability toggle must work offline. Strategy:
  //   1. Optimistic update of the cached passport so the UI flips immediately
  //   2. Try the network call
  //   3. If it fails with a network/5xx, enqueue to the IndexedDB outbox; the
  //      `online` listener in useOutbox replays it on reconnect
  const availability = useMutation({
    mutationFn: async ({ donorId, isAvailable }) => {
      try {
        return await apiRequest('POST', `/donors/${donorId}/availability`, {
          is_available: isAvailable,
        });
      } catch (err) {
        if (isOfflineError(err)) {
          await enqueueOutbox({
            method: 'POST',
            url: `/donors/${donorId}/availability`,
            body: { is_available: isAvailable },
          });
          return { queued: true };
        }
        throw err;
      }
    },
    onMutate: async ({ isAvailable }) => {
      await qc.cancelQueries({ queryKey: ['donor', 'me'] });
      const prev = qc.getQueryData(['donor', 'me']);
      if (prev?.donor?.stats) {
        qc.setQueryData(['donor', 'me'], {
          ...prev,
          donor: {
            ...prev.donor,
            stats: { ...prev.donor.stats, is_available: isAvailable },
          },
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['donor', 'me'], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['donor', 'me'] }),
  });

  const passport = passportQuery.data;
  const donor = passport?.donor;

  return (
    <div className="flex min-h-full flex-col">
      <Header subtitle={donor?.full_name || ''} />
      <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <RoleSwitcher from="donor" />
        {/* PILOT SCOPE (Aug 2026) — the PDMC pilot runs the donor + camp modules
            first and proves them before any blood request is raised on the
            platform, so this CTA is hidden and the /donor/raise route in
            App.jsx is commented out with it. Nothing behind it was removed:
            DonorRaiseRequest.jsx and POST /requests/citizen still exist and are
            still covered by smoke_test_phase5.js. Re-enable = uncomment here
            plus the two blocks in App.jsx. */}
        {/*
        <Link
          to="/donor/raise"
          className="flex items-center justify-between rounded-lg border border-rk-200 bg-rk-50 p-3 text-sm hover:bg-rk-100"
        >
          <span className="font-semibold text-rk-800">
            Need blood for a patient? Raise a request →
          </span>
        </Link>
        */}
        {outboxPending > 0 ? (
          <div className="flex items-center justify-between rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
            <span>
              {outboxPending === 1
                ? t('pending_sync_one')
                : t('pending_sync_many', { n: outboxPending })}{' '}
              {navigator.onLine ? `· ${t('loading')}` : `· ${t('will_sync_when_online')}`}
            </span>
            <button type="button" className="text-xs font-medium underline" onClick={flushNow}>
              {t('retry')}
            </button>
          </div>
        ) : null}
        {passportQuery.isLoading ? (
          <div className="rk-card text-center text-slate-500">…</div>
        ) : passportQuery.error ? (
          <div className="rk-card">
            <p className="text-rk-700">
              {passportQuery.error?.response?.data?.error || 'load_failed'}
            </p>
            <button className="rk-button-secondary mt-3" onClick={logout}>
              {t('logout')}
            </button>
          </div>
        ) : (
          <>
            <AvailabilityCard
              donor={donor}
              t={t}
              busy={availability.isPending}
              onToggle={() =>
                availability.mutate({
                  donorId: donor.id,
                  isAvailable: !donor.stats.is_available,
                })
              }
            />

            <BadgeCard donations={donor.stats.total_donations ?? 0} />

            <section className="grid gap-4 sm:grid-cols-2">
              <StatCard
                label={t('blood_group')}
                value={
                  donor.blood_group.verified?.code ||
                  donor.blood_group.self_reported?.code ||
                  '—'
                }
                badge={
                  donor.blood_group.verified ? null : t('unverified')
                }
              />
              <StatCard
                label={t('total_donations')}
                value={donor.stats.total_donations ?? 0}
              />
              <StatCard
                label={t('next_eligible')}
                value={formatDate(donor.eligibility.next_eligible_date, lang)}
              />
              <StatCard
                label="reliability"
                value={
                  donor.stats.reliability_score == null
                    ? '—'
                    : `${donor.stats.reliability_score}/100`
                }
              />
            </section>

            <EditProfileCard donor={donor} />

            {/* Camps I host outrank camps I might attend, so this sits
                above them - and renders nothing at all for the donor who
                hosts none, which is almost all of them. */}
            <MyCampsSection />

            <UpcomingCampsSection donorDistrictId={donor?.location?.district_id} />

            <section>
              <h2 className="px-1 pb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Donation history
              </h2>
              <div className="space-y-2">
                {(passport.donations || []).slice(0, 5).map((d) => (
                  <article key={d.id} className="rk-card flex items-center justify-between">
                    <div>
                      <div className="font-medium">{d.component?.name || '—'}</div>
                      <div className="text-sm text-slate-500">
                        {formatDate(d.date, lang)} · {d.blood_bank || '—'}
                      </div>
                    </div>
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-xs font-medium ' +
                        (d.trust_level === 'V'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-800')
                      }
                    >
                      {d.trust_level === 'V' ? 'Verified' : 'Pending'}
                    </span>
                  </article>
                ))}
                {(passport.donations || []).length === 0 ? (
                  <div className="rk-card text-sm text-slate-500">
                    No donations yet — your first one will appear here.
                  </div>
                ) : null}
              </div>
            </section>
          </>
        )}
      </main>
      <Footer variant="compact" />
    </div>
  );
}

// Donor self-service profile correction. Collapsed by default; on save it
// posts ONLY the fields the donor actually changed (so untouched values are
// preserved server-side via COALESCE). full_name re-seal + blind-index update
// happen on the backend.
function EditProfileCard({ donor }) {
  const qc = useQueryClient();
  const { t, setLang, supported } = useT();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');

  const initial = useMemo(
    () => ({
      full_name: donor.full_name || '',
      gender: donor.gender || 'M',
      date_of_birth: (donor.date_of_birth || '').slice(0, 10),
      blood_group_self_reported:
        SELF_BLOOD_GROUPS.find((g) => g.code === donor.blood_group?.self_reported?.code)?.id || '',
      preferred_language: donor.preferred_language || 'mr',
    }),
    [donor],
  );
  const [form, setForm] = useState(initial);
  const [locality, setLocality] = useState(null);

  function set(k, v) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }
  function start() {
    setForm(initial);
    setLocality(null);
    setMsg('');
    setOpen(true);
  }

  // Collect only the fields the donor actually changed — untouched fields are
  // left alone server-side via COALESCE.
  function buildPayload() {
    const payload = {};
    const name = form.full_name.trim();
    if (name && name !== initial.full_name) payload.full_name = name;
    for (const k of ['gender', 'date_of_birth', 'preferred_language']) {
      if (form[k] && form[k] !== initial[k]) payload[k] = form[k];
    }
    if (
      form.blood_group_self_reported !== '' &&
      String(form.blood_group_self_reported) !== String(initial.blood_group_self_reported)
    ) {
      payload.blood_group_self_reported = Number(form.blood_group_self_reported);
    }
    if (locality?.id) payload.village_id = locality.id; // only when a new area was picked
    return payload;
  }

  const save = useMutation({
    mutationFn: (payload) => apiRequest('POST', '/donors/me/profile', payload),
    onSuccess: (data, payload) => {
      // The endpoint returns the authoritative fresh passport — seed the cache
      // with it directly; no invalidate (that would refetch what we just got).
      qc.setQueryData(['donor', 'me'], data);
      // Saved a new message language → move the app to it, so the donor can see
      // the choice took rather than having to wait for the next WhatsApp.
      if (payload?.preferred_language) setLang(payload.preferred_language);
      setOpen(false);
      setMsg('');
    },
    onError: (err) => setMsg(err?.response?.data?.error || 'save_failed'),
  });

  function onSave() {
    const payload = buildPayload();
    if (Object.keys(payload).length === 0) {
      setMsg('Nothing to save — no changes.');
      return;
    }
    save.mutate(payload);
  }

  if (!open) {
    return (
      <div className="flex items-center justify-between rounded-md bg-white p-3 text-sm ring-1 ring-slate-200">
        <span className="text-slate-600">
          Something wrong in your details? You can fix your name, area, or blood group.
        </span>
        <button type="button" className="rk-button-secondary shrink-0" onClick={start}>
          Edit my details
        </button>
      </div>
    );
  }

  return (
    <section className="rk-card space-y-4">
      <h2 className="text-lg font-semibold text-rk-700">Edit my details</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="rk-label" htmlFor="ep-name">
            Full name
          </label>
          <input
            id="ep-name"
            className="rk-input"
            maxLength={120}
            value={form.full_name}
            onChange={(e) => set('full_name', e.target.value)}
          />
        </div>
        <div>
          <label className="rk-label" htmlFor="ep-gender">
            Gender
          </label>
          <select
            id="ep-gender"
            className="rk-input"
            value={form.gender}
            onChange={(e) => set('gender', e.target.value)}
          >
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="O">Other</option>
          </select>
        </div>
        <div>
          <label className="rk-label" htmlFor="ep-dob">
            Date of birth
          </label>
          <DateOfBirthInput
            id="ep-dob"
            value={form.date_of_birth}
            onChange={(iso) => set('date_of_birth', iso)}
          />
        </div>
        <div>
          <label className="rk-label" htmlFor="ep-bg">
            Blood group (if known)
          </label>
          <select
            id="ep-bg"
            className="rk-input"
            value={form.blood_group_self_reported}
            onChange={(e) => set('blood_group_self_reported', e.target.value)}
          >
            <option value="">I don&apos;t know</option>
            {SELF_BLOOD_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Self-reported only — a blood bank verifies this at your donation.
          </p>
        </div>
        <div>
          <label className="rk-label" htmlFor="ep-lang">
            {t('donor_lang_label')}
          </label>
          <select
            id="ep-lang"
            className="rk-input"
            value={form.preferred_language}
            onChange={(e) => set('preferred_language', e.target.value)}
          >
            {supported.map((l) => (
              <option key={l} value={l}>
                {LANG_LABELS[l] || l}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">{t('donor_lang_hint')}</p>
        </div>
        <div className="sm:col-span-2">
          <LocalityPicker
            id="ep-locality"
            label="Change your village or area (optional)"
            value={locality}
            onChange={setLocality}
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank to keep your current area. Search to pick a new one.
          </p>
        </div>
      </div>
      {msg ? <p className="text-sm text-rk-700">{msg}</p> : null}
      <div className="flex justify-between">
        <button
          type="button"
          className="rk-button-secondary"
          onClick={() => setOpen(false)}
          disabled={save.isPending}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rk-button-primary"
          onClick={onSave}
          disabled={save.isPending}
        >
          {save.isPending ? '…' : 'Save changes'}
        </button>
      </div>
    </section>
  );
}

// What the server says when an RSVP is refused, in words a donor can act on.
// These codes are not theoretical: since the camp module started gating
// registration, a camp that has been completed, cancelled, declined or simply
// held already refuses new sign-ups, and a donor who has already donated can no
// longer overwrite that record by tapping Register again.
const RSVP_ERRORS = {
  camp_not_open_for_registration: 'This camp is no longer taking registrations.',
  camp_date_passed: 'This camp has already been held.',
  already_recorded: 'Your attendance at this camp is already recorded.',
  cannot_cancel_after_attendance:
    'You have already donated at this camp, so the RSVP cannot be cancelled.',
  camp_not_found: 'This camp no longer exists.',
  donor_profile_not_found: 'We could not find your donor profile. Please sign in again.',
};

function rsvpErrorText(e) {
  const body = e?.response?.data || {};
  // camp_not_open_for_registration carries a detail.reason that distinguishes
  // "already held" from "cancelled" - the more specific one is the useful one.
  const code = RSVP_ERRORS[body.detail?.reason] ? body.detail.reason : body.error;
  return RSVP_ERRORS[code] || 'Could not save your RSVP. Please try again.';
}

function UpcomingCampsSection({ donorDistrictId }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['donor', 'camps', donorDistrictId || 'all'],
    queryFn: () =>
      apiRequest(
        'GET',
        donorDistrictId ? `/camps?district_id=${donorDistrictId}` : '/camps',
      ),
    staleTime: 60_000,
  });

  // `is_current_donor_registered` is populated by the backend on GET /camps
  // for the donor role, so return visits show the correct state. `dirty`
  // holds session-local optimistic overrides (so the click responds
  // immediately without waiting for the invalidateQueries roundtrip).
  const [dirty, setDirty] = useState({});
  // Which camp is mid-flight, and which one failed. Both keyed by camp id: one
  // shared isPending used to grey out the button on EVERY camp in the list while
  // a single request was in the air.
  const [busyId, setBusyId] = useState(null);
  const [errs, setErrs] = useState({});
  const [showAll, setShowAll] = useState(false);

  // An optimistic tick that is never rolled back is worse than no optimism at
  // all: the donor walks away believing they are on a roster they are not on.
  // On failure, put the toggle back and say why.
  function rsvpHandlers(optimistic) {
    return {
      onMutate: (campId) => {
        setBusyId(campId);
        setErrs((e) => ({ ...e, [campId]: undefined }));
        setDirty((r) => ({ ...r, [campId]: optimistic }));
      },
      onSuccess: () => qc.invalidateQueries({ queryKey: ['donor', 'camps'] }),
      onError: (e, campId) => {
        setDirty((r) => ({ ...r, [campId]: !optimistic }));
        setErrs((x) => ({ ...x, [campId]: rsvpErrorText(e) }));
        // A refused RSVP usually means our copy of the camp is stale (completed
        // or cancelled since this page loaded), so refetch as well.
        qc.invalidateQueries({ queryKey: ['donor', 'camps'] });
      },
      onSettled: () => setBusyId(null),
    };
  }

  const rsvp = useMutation({
    mutationFn: (campId) => apiRequest('POST', `/camps/${campId}/register`),
    ...rsvpHandlers(true),
  });
  const cancel = useMutation({
    mutationFn: (campId) => apiRequest('DELETE', `/camps/${campId}/register`),
    ...rsvpHandlers(false),
    // A cancel that could not be honoured comes back 200 with cancelled:false
    // rather than as an error - an 'NS' row, say, which nothing here can undo.
    // Without this the optimistic un-tick would stand and the donor would
    // believe they had cancelled something they had not.
    onSuccess: (r, campId) => {
      if (r && r.cancelled === false && r.reason !== 'not_registered') {
        setDirty((x) => ({ ...x, [campId]: true }));
        setErrs((x) => ({
          ...x,
          [campId]: 'This registration can no longer be cancelled here.',
        }));
      }
      qc.invalidateQueries({ queryKey: ['donor', 'camps'] });
    },
  });

  // Five was an arbitrary cap with no way past it - a donor in a district
  // running eight camps this month could not reach camp six at all.
  const allCamps = q.data?.camps || [];
  const camps = showAll ? allCamps : allCamps.slice(0, 5);

  return (
    <section>
      <h2 className="px-1 pb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Upcoming camps
      </h2>
      <div className="space-y-2">
        {q.isLoading ? (
          <div className="rk-card text-center text-slate-500">…</div>
        ) : camps.length === 0 ? (
          <div className="rk-card text-sm text-slate-500">
            No camps scheduled near you right now. We&apos;ll notify you on WhatsApp when one
            is announced.
          </div>
        ) : (
          camps.map((c) => {
            const isRegistered =
              dirty[c.id] !== undefined ? dirty[c.id] : Boolean(c.is_current_donor_registered);
            return (
              <article key={c.id} className="rk-card space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-500">
                      {new Date(c.scheduled_date).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                      })}
                      {' · '}
                      {(c.start_time || '').slice(0, 5)}–{(c.end_time || '').slice(0, 5)}
                      {' · '}
                      {c.venue}
                    </div>
                    <div className="text-xs text-slate-500">
                      {c.district_name} · {c.organiser_name}
                    </div>
                  </div>
                  {isRegistered ? (
                    <div className="flex flex-col items-end gap-1">
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                        ✓ Registered
                      </span>
                      <button
                        type="button"
                        className="text-[11px] text-slate-500 hover:text-rk-700 hover:underline disabled:opacity-50"
                        onClick={() => cancel.mutate(c.id)}
                        disabled={busyId === c.id}
                      >
                        Cancel RSVP
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="rk-button-primary text-xs"
                      onClick={() => rsvp.mutate(c.id)}
                      disabled={busyId === c.id}
                    >
                      {busyId === c.id ? '…' : 'I’ll be there'}
                    </button>
                  )}
                </div>
                {errs[c.id] ? <p className="text-xs text-rk-700">{errs[c.id]}</p> : null}
              </article>
            );
          })
        )}
      </div>
      {allCamps.length > 5 ? (
        <button
          type="button"
          className="mt-2 px-1 text-xs font-medium text-rk-700 hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show fewer' : `Show all ${allCamps.length} camps near you`}
        </button>
      ) : null}
    </section>
  );
}

function AvailabilityCard({ donor, t, busy, onToggle }) {
  const isOn = Boolean(donor?.stats?.is_available);
  return (
    <section
      className={
        'rounded-2xl p-5 shadow-sm ring-1 transition-colors ' +
        (isOn ? 'bg-rk-700 text-white ring-rk-700' : 'bg-white text-slate-800 ring-slate-200')
      }
    >
      <div className="text-sm uppercase tracking-wide opacity-80">
        {isOn ? t('available_today') : t('not_available_today')}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className={
          'mt-4 inline-flex h-14 w-full items-center justify-center rounded-full px-6 text-lg font-semibold transition-colors ' +
          (isOn
            ? 'bg-white text-rk-700 hover:bg-slate-100'
            : 'bg-rk-700 text-white hover:bg-rk-900')
        }
      >
        {busy ? '…' : isOn ? 'Pause availability' : 'Mark me available'}
      </button>
    </section>
  );
}

// Tiers track lifetime verified donations. Numbers picked to match Indian
// blood-donor recognition norms (10 = "Many-time donor" badge in most state
// blood-bank programmes, 25 = the Maharashtra State "Maha Rakta Doot" cut).
const TIERS = [
  { min: 0,  label: 'New donor',    cls: 'bg-slate-100 text-slate-700 ring-slate-200',
    medal: 'rgb(148 163 184)', next: 1,  hint: 'Donate once to earn your Bronze badge.' },
  { min: 1,  label: 'Bronze donor', cls: 'bg-amber-50 text-amber-900 ring-amber-200',
    medal: '#cd7f32', next: 5,  hint: '4 more donations until Silver.' },
  { min: 5,  label: 'Silver donor', cls: 'bg-slate-100 text-slate-800 ring-slate-300',
    medal: '#c0c0c0', next: 10, hint: '5 more until Gold.' },
  { min: 10, label: 'Gold donor',   cls: 'bg-amber-100 text-amber-900 ring-amber-300',
    medal: '#d4af37', next: 25, hint: 'On track for Champion status.' },
  { min: 25, label: 'Champion',     cls: 'bg-rk-50 text-rk-700 ring-rk-200',
    medal: '#ef4a32', next: null, hint: 'You’ve saved an estimated 75+ lives.' },
];

function tierFor(donations) {
  return [...TIERS].reverse().find((t) => donations >= t.min) || TIERS[0];
}

function BadgeCard({ donations }) {
  const tier = tierFor(donations);
  const tierIndex = TIERS.indexOf(tier);
  const nextTier = TIERS[tierIndex + 1];
  // Progress = how far between this tier's floor and the next tier's floor.
  let progressPct = null;
  if (nextTier) {
    const span = nextTier.min - tier.min;
    progressPct = Math.min(100, Math.round(((donations - tier.min) / span) * 100));
  }
  // Lives-saved heuristic: each verified donation = ~3 lives (RBC + plasma + plt).
  const livesSaved = donations * 3;

  return (
    <section className={`rounded-2xl p-5 ring-1 ${tier.cls}`}>
      <div className="flex items-center gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-2xl font-bold text-white shadow-soft"
          style={{ background: tier.medal }}
          aria-hidden="true"
        >
          ★
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide opacity-70">Donor tier</div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold">{tier.label}</span>
            <span className="text-sm opacity-70">
              · {donations} donation{donations === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-0.5 text-xs opacity-70">{tier.hint}</div>
        </div>
        <div className="hidden text-right text-xs opacity-80 sm:block">
          <div className="font-semibold">~{livesSaved} lives</div>
          <div>impacted</div>
        </div>
      </div>
      {progressPct != null ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/40">
            <div
              className="h-full rounded-full bg-current opacity-70 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wide opacity-70">
            <span>{tier.label}</span>
            <span>
              {nextTier.min - donations} to {nextTier.label}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StatCard({ label, value, badge }) {
  return (
    <div className="rk-card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-2xl font-semibold text-slate-900">{value}</span>
        {badge ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            {badge}
          </span>
        ) : null}
      </div>
    </div>
  );
}
