import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { CollectionBankLine } from '../../components/CollectionBankLine.jsx';
import { apiRequest } from '../../lib/api.js';
import { campStatus } from '../../lib/campStatus.js';
import { isoOffsetYears, todayISO } from '../../lib/dateBounds.js';

// Every camp this person hosts, wherever it was created from.
//
// One list, one URL. A principal hosting three camps used to hold three
// magic-link URLs in three WhatsApp messages and no way to see them together;
// a coordinator's camps lived only in a portal that had no camps tab. GET
// /camps/mine keys on the person's MOBILE, not their session, so the same
// component serves the donor profile, the coordinator portal and the
// community-leader page without bridging the two auth clusters.
//
// Deliberately read-only on lifecycle: verify / decline / complete / cancel
// stay in the coordinator and admin portals behind a password + TOTP login.
// What this offers is the organiser link, the public page, the live roster
// counts, and editing the details of a camp not yet held.
function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return v;
  }
}

function Count({ label, value, tone }) {
  return (
    <div className="min-w-[68px]">
      <div className={`text-lg font-semibold leading-tight ${tone || 'text-slate-900'}`}>
        {value ?? 0}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

// ── Editing a camp, from the card the host is already reading ────────────
//
// Details only, never the lifecycle. Verify / decline / complete / cancel stay
// in the coordinator and admin portals behind a password + TOTP login; a 30-day
// OTP session must not reach them. Geography is absent on purpose too - moving
// a camp to another district moves it out of its coordinator's and the DHO's
// scope, which is an admin decision rather than a typo fix.
//
// Only what actually changed is sent. The API treats an omitted field as
// unchanged, which is also why a blank box keeps the current value instead of
// clearing it: nothing here offers "make this empty".
const EDIT_TEXT_FIELDS = [
  { k: 'name', label: 'Camp name', wide: false },
  { k: 'venue', label: 'Venue', wide: false },
  { k: 'address_line', label: 'Address', wide: true },
  { k: 'organiser_name', label: 'Organisation hosting', wide: false },
  { k: 'organiser_contact_name', label: 'Contact person', wide: false },
];

// The API WhatsApps everyone already registered when one of these moves, so the
// host is warned before they save rather than told afterwards.
const NOTIFY_FIELDS = ['scheduled_date', 'start_time', 'end_time', 'venue', 'address_line'];

const NUMBER_FIELDS = ['target_donor_count', 'expected_volunteer_count'];

const EDIT_ERRORS = {
  scheduled_date_in_past: 'Pick a date that has not already passed.',
  camp_update_rejected: 'The end time has to be later than the start time.',
  camp_not_editable: 'This camp can no longer be edited. Refresh to see its current state.',
  not_camp_owner: 'This camp is not yours to edit.',
  invalid_mobile_format: 'Enter a 10-digit Indian mobile number.',
  invalid_input: 'Please check the details above - something is not in the expected format.',
  not_found: 'This camp no longer exists.',
};

function initEditForm(c) {
  return {
    name: c.name || '',
    venue: c.venue || '',
    address_line: c.address_line || '',
    organiser_name: c.organiser_name || '',
    organiser_contact_name: c.organiser_contact_name || '',
    pincode: c.pincode || '',
    scheduled_date: c.scheduled_date || '',
    start_time: String(c.start_time || '').slice(0, 5),
    end_time: String(c.end_time || '').slice(0, 5),
    target_donor_count: c.target_donor_count ?? '',
    expected_volunteer_count: c.expected_volunteer_count ?? '',
    volunteer_training_requested: Boolean(c.volunteer_training_requested),
    // Never pre-filled: see the note on GET /camps/mine.
    organiser_contact_mobile: '',
  };
}

function buildCampPatch(form, base) {
  const out = {};
  for (const k of Object.keys(form)) {
    const v = form[k];
    if (k === 'volunteer_training_requested') {
      if (v !== base[k]) out[k] = v;
    } else if (String(v).trim() === '') {
      // Blank keeps the current value.
      continue;
    } else if (String(v) !== String(base[k])) {
      out[k] = NUMBER_FIELDS.includes(k) ? Number(v) : String(v).trim();
    }
  }
  return out;
}

function CampEditPanel({ camp, onDone }) {
  const qc = useQueryClient();
  // Diff against the camp as it looked when the panel opened, not against a
  // background refetch mid-edit.
  const [base] = useState(() => initEditForm(camp));
  const [form, setForm] = useState(base);
  const [err, setErr] = useState(null);

  const patch = buildCampPatch(form, base);
  const touchedNotify = Object.keys(patch).filter((k) => NOTIFY_FIELDS.includes(k));
  const audience = camp.registered || 0;
  const willNotify = touchedNotify.length > 0 && audience > 0;

  const save = useMutation({
    mutationFn: () => apiRequest('PATCH', `/camps/${camp.id}`, patch),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['camps', 'mine'] });
      onDone(result);
    },
    onError: (e) => setErr(e?.response?.data?.error || 'save_failed'),
  });

  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  return (
    <form
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        if (Object.keys(patch).length === 0) return onDone(null);
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {EDIT_TEXT_FIELDS.map((f) => (
          <label key={f.k} className={f.wide ? 'block sm:col-span-2' : 'block'}>
            <span className="rk-label">{f.label}</span>
            <input className="rk-input" value={form[f.k]} onChange={set(f.k)} />
          </label>
        ))}
        <label className="block">
          <span className="rk-label">Date</span>
          <input
            type="date"
            className="rk-input"
            value={form.scheduled_date}
            onChange={set('scheduled_date')}
            min={todayISO()}
            max={isoOffsetYears(1)}
          />
        </label>
        <label className="block">
          <span className="rk-label">PIN code</span>
          <input
            className="rk-input"
            inputMode="numeric"
            maxLength={6}
            value={form.pincode}
            onChange={set('pincode')}
          />
        </label>
        <label className="block">
          <span className="rk-label">Starts</span>
          <input
            type="time"
            className="rk-input"
            value={form.start_time}
            onChange={set('start_time')}
          />
        </label>
        <label className="block">
          <span className="rk-label">Ends</span>
          <input type="time" className="rk-input" value={form.end_time} onChange={set('end_time')} />
        </label>
        <label className="block sm:col-span-2">
          <span className="rk-label">Contact mobile</span>
          <input
            className="rk-input"
            inputMode="tel"
            placeholder="Leave blank to keep the current number"
            value={form.organiser_contact_mobile}
            onChange={set('organiser_contact_mobile')}
          />
        </label>
        <label className="block">
          <span className="rk-label">Donors expected</span>
          <input
            type="number"
            min="1"
            className="rk-input"
            value={form.target_donor_count}
            onChange={set('target_donor_count')}
          />
        </label>
        <label className="block">
          <span className="rk-label">Volunteers expected</span>
          <input
            type="number"
            min="0"
            className="rk-input"
            value={form.expected_volunteer_count}
            onChange={set('expected_volunteer_count')}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
          <input
            type="checkbox"
            checked={form.volunteer_training_requested}
            onChange={set('volunteer_training_requested')}
          />
          We would like volunteer training before the camp
        </label>
      </div>

      {/* Nobody should learn that a hundred people were messaged by reading the
          result. Say it while the change can still be reconsidered. */}
      {willNotify ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <strong>
            {audience} registered donor{audience === 1 ? '' : 's'} will be told about this change
          </strong>{' '}
          on WhatsApp as soon as you save.
        </p>
      ) : null}

      {err ? (
        <p className="text-xs text-rk-700">{EDIT_ERRORS[err] || `Could not save (${err}).`}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="rk-button-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="rk-button-secondary"
          onClick={() => onDone(null)}
          disabled={save.isPending}
        >
          Cancel
        </button>
        <span className="text-[11px] text-slate-500">
          A box left blank keeps its current value. The camp keeps its status.
        </span>
      </div>
    </form>
  );
}

export function MyCampsSection({
  heading = 'Camps I host',
  showWhenEmpty = false,
  emptyHint = 'Camps you apply to host will appear here so you can track every one of them in one place.',
}) {
  const q = useQuery({
    queryKey: ['camps', 'mine'],
    queryFn: () => apiRequest('GET', '/camps/mine'),
    staleTime: 60_000,
  });

  const [editingId, setEditingId] = useState(null);
  const [saved, setSaved] = useState(null);

  const camps = q.data?.camps || [];

  // A plain donor hosts nothing, and their dashboard should look exactly as it
  // did. Stay invisible while loading too, so the page does not jump.
  if (!showWhenEmpty && (q.isLoading || camps.length === 0)) return null;

  return (
    <section>
      <h2 className="px-1 pb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {heading}
        {camps.length ? <span className="ml-1 text-slate-400">({camps.length})</span> : null}
      </h2>

      <div className="space-y-2">
        {q.isLoading ? (
          <div className="rk-card text-center text-slate-500">…</div>
        ) : q.isError ? (
          <div className="rk-card text-sm text-rk-700">Could not load your camps.</div>
        ) : camps.length === 0 ? (
          <div className="rk-card text-sm text-slate-500">{emptyHint}</div>
        ) : (
          camps.map((c) => {
            const st = campStatus(c.status);
            const held = !c.is_upcoming;
            return (
              <article key={c.id} className="rk-card space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-500">
                      {fmtDate(c.scheduled_date)}
                      {c.start_time ? (
                        <>
                          {' · '}
                          {String(c.start_time).slice(0, 5)}–{String(c.end_time || '').slice(0, 5)}
                        </>
                      ) : null}
                      {c.venue ? ` · ${c.venue}` : ''}
                    </div>
                    <div className="text-xs text-slate-500">{c.district_name}</div>
                    <CollectionBankLine
                      bbResponse={c.bb_response}
                      bloodBankName={c.partnered_blood_bank_name}
                      requestedBloodBankName={c.requested_blood_bank_name}
                    />
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${st.cls}`}
                  >
                    {st.label}
                  </span>
                </div>

                {/* A declined camp is what a host most needs to read, so it is
                    not buried behind a link. */}
                {c.status === 'DC' && c.declined_reason ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    <strong>Why this was declined:</strong> {c.declined_reason}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 pt-2">
                  <Count label="registered" value={c.registered} />
                  <Count label="donated" value={c.donated} tone="text-emerald-700" />
                  {c.deferred ? (
                    <Count label="couldn’t donate" value={c.deferred} tone="text-amber-700" />
                  ) : null}
                  {/* Absent is only meaningful once the roster has closed - the
                      camp-close-roster job waits 48h for the blood bank's batch
                      entry, so before then a blank is honest and a zero is not. */}
                  {held && c.no_show ? (
                    <Count label="did not come" value={c.no_show} tone="text-slate-500" />
                  ) : null}
                </div>

                {/* Attendance is derived from the donations the blood bank
                    records against this camp - nobody ticks a roster. Say so
                    once, where an organiser would otherwise go looking for the
                    button. */}
                {held && c.donated === 0 && (c.status === 'PL' || c.status === 'LV') ? (
                  <p className="text-[11px] text-slate-500">
                    Donations are counted here as soon as the blood bank records them - usually
                    the next working day. Nothing to mark by hand.
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-3 text-xs">
                  {c.manage_url ? (
                    <a
                      href={c.manage_url}
                      className="font-medium text-rk-700 hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open organiser dashboard →
                    </a>
                  ) : null}
                  {c.slug && (c.status === 'PL' || c.status === 'LV') ? (
                    <Link
                      to={`/c/${encodeURIComponent(c.slug)}`}
                      className="text-slate-500 hover:text-rk-700 hover:underline"
                    >
                      Public camp page
                    </Link>
                  ) : null}
                  {c.can_edit && editingId !== c.id ? (
                    <button
                      type="button"
                      className="font-medium text-slate-600 hover:text-rk-700 hover:underline"
                      onClick={() => {
                        setSaved(null);
                        setEditingId(c.id);
                      }}
                    >
                      Edit details
                    </button>
                  ) : null}
                </div>

                {editingId === c.id ? (
                  <CampEditPanel
                    camp={c}
                    onDone={(result) => {
                      setEditingId(null);
                      if (!result) return;
                      setSaved({
                        id: c.id,
                        text: result.notified
                          ? `Saved. ${result.notified} donor${
                              result.notified === 1 ? '' : 's'
                            } told about the change.`
                          : result.unchanged
                            ? 'Nothing had changed.'
                            : 'Saved.',
                      });
                    }}
                  />
                ) : null}

                {saved?.id === c.id ? (
                  <p className="text-xs text-emerald-700">{saved.text}</p>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
