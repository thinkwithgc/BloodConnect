import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { CollectionBankLine } from '../../components/CollectionBankLine.jsx';
import { apiRequest } from '../../lib/api.js';
import { campStatus, campStatusLabel } from '../../lib/campStatus.js';
import { isoOffsetYears, todayISO } from '../../lib/dateBounds.js';
import { useT } from '../../i18n/useT.js';

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
// Month names come from the string pack, not toLocaleDateString('mr-IN') -
// Intl's Marathi data is not reliably present and its short forms are
// unpredictable. Digits stay Latin in every language.
function fmtDate(v, t) {
  if (!v) return '—';
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return v;
  const months = t('camp_months_short');
  return `${d} ${Array.isArray(months) ? months[m - 1] : m} ${y}`;
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
  { k: 'name', key: 'camp_ed_name', wide: false },
  { k: 'venue', key: 'camp_ed_venue', wide: false },
  { k: 'address_line', key: 'camp_ed_address', wide: true },
  { k: 'organiser_name', key: 'camp_ed_org', wide: false },
  { k: 'organiser_contact_name', key: 'camp_ed_contact_person', wide: false },
];

// The API WhatsApps everyone already registered when one of these moves, so the
// host is warned before they save rather than told afterwards.
const NOTIFY_FIELDS = ['scheduled_date', 'start_time', 'end_time', 'venue', 'address_line'];

const NUMBER_FIELDS = ['target_donor_count', 'expected_volunteer_count'];

// API error code -> string-pack key. The code itself is never shown.
const EDIT_ERROR_KEYS = {
  scheduled_date_in_past: 'camp_ed_e_past',
  camp_update_rejected: 'camp_ed_e_reject',
  camp_not_editable: 'camp_ed_e_not_editable',
  not_camp_owner: 'camp_ed_e_not_owner',
  invalid_mobile_format: 'camp_ed_e_mobile',
  invalid_input: 'camp_ed_e_invalid',
  not_found: 'camp_ed_e_not_found',
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
  const { t } = useT();
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
            <span className="rk-label">{t(f.key)}</span>
            <input className="rk-input" value={form[f.k]} onChange={set(f.k)} />
          </label>
        ))}
        <label className="block">
          <span className="rk-label">{t('camp_ed_date')}</span>
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
          <span className="rk-label">{t('camp_ed_pin')}</span>
          <input
            className="rk-input"
            inputMode="numeric"
            maxLength={6}
            value={form.pincode}
            onChange={set('pincode')}
          />
        </label>
        <label className="block">
          <span className="rk-label">{t('camp_ed_starts')}</span>
          <input
            type="time"
            className="rk-input"
            value={form.start_time}
            onChange={set('start_time')}
          />
        </label>
        <label className="block">
          <span className="rk-label">{t('camp_ed_ends')}</span>
          <input type="time" className="rk-input" value={form.end_time} onChange={set('end_time')} />
        </label>
        <label className="block sm:col-span-2">
          <span className="rk-label">{t('camp_ed_mobile')}</span>
          <input
            className="rk-input"
            inputMode="tel"
            placeholder={t('camp_ed_mobile_ph')}
            value={form.organiser_contact_mobile}
            onChange={set('organiser_contact_mobile')}
          />
        </label>
        <label className="block">
          <span className="rk-label">{t('camp_ed_donors')}</span>
          <input
            type="number"
            min="1"
            className="rk-input"
            value={form.target_donor_count}
            onChange={set('target_donor_count')}
          />
        </label>
        <label className="block">
          <span className="rk-label">{t('camp_ed_volunteers')}</span>
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
          {t('camp_ed_training')}
        </label>
      </div>

      {/* Nobody should learn that a hundred people were messaged by reading the
          result. Say it while the change can still be reconsidered. */}
      {willNotify ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <strong>{t('camp_ed_notify_strong', { n: audience })}</strong>
          {t('camp_ed_notify_rest')}
        </p>
      ) : null}

      {err ? (
        <p className="text-xs text-rk-700">
          {EDIT_ERROR_KEYS[err] ? t(EDIT_ERROR_KEYS[err]) : t('camp_ed_err_generic', { err })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="rk-button-primary" disabled={save.isPending}>
          {save.isPending ? t('camp_ed_saving') : t('camp_ed_save')}
        </button>
        <button
          type="button"
          className="rk-button-secondary"
          onClick={() => onDone(null)}
          disabled={save.isPending}
        >
          {t('camp_ed_cancel')}
        </button>
        <span className="text-[11px] text-slate-500">{t('camp_ed_blank_note')}</span>
      </div>
    </form>
  );
}

// `heading` / `emptyHint` stay overridable so a portal can name the section in
// its own words; unset, they come from the string pack in the reader's language.
export function MyCampsSection({ heading, showWhenEmpty = false, emptyHint }) {
  const { t } = useT();
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
        {heading || t('camp_mine_heading')}
        {camps.length ? <span className="ml-1 text-slate-400">({camps.length})</span> : null}
      </h2>

      <div className="space-y-2">
        {q.isLoading ? (
          <div className="rk-card text-center text-slate-500">…</div>
        ) : q.isError ? (
          <div className="rk-card text-sm text-rk-700">{t('camp_mine_load_err')}</div>
        ) : camps.length === 0 ? (
          <div className="rk-card text-sm text-slate-500">
            {emptyHint || t('camp_mine_empty')}
          </div>
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
                      {fmtDate(c.scheduled_date, t)}
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
                    {campStatusLabel(c.status, t)}
                  </span>
                </div>

                {/* A declined camp is what a host most needs to read, so it is
                    not buried behind a link. */}
                {c.status === 'DC' && c.declined_reason ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    <strong>{t('camp_mine_declined_why')}</strong> {c.declined_reason}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 pt-2">
                  <Count label={t('camp_mine_c_registered')} value={c.registered} />
                  <Count
                    label={t('camp_mine_c_donated')}
                    value={c.donated}
                    tone="text-emerald-700"
                  />
                  {c.deferred ? (
                    <Count
                      label={t('camp_mine_c_deferred')}
                      value={c.deferred}
                      tone="text-amber-700"
                    />
                  ) : null}
                  {/* Absent is only meaningful once the roster has closed - the
                      camp-close-roster job waits 48h for the blood bank's batch
                      entry, so before then a blank is honest and a zero is not. */}
                  {held && c.no_show ? (
                    <Count
                      label={t('camp_mine_c_noshow')}
                      value={c.no_show}
                      tone="text-slate-500"
                    />
                  ) : null}
                </div>

                {/* Attendance is derived from the donations the blood bank
                    records against this camp - nobody ticks a roster. Say so
                    once, where an organiser would otherwise go looking for the
                    button. */}
                {held && c.donated === 0 && (c.status === 'PL' || c.status === 'LV') ? (
                  <p className="text-[11px] text-slate-500">{t('camp_mine_derived')}</p>
                ) : null}

                <div className="flex flex-wrap gap-3 text-xs">
                  {c.manage_url ? (
                    <a
                      href={c.manage_url}
                      className="font-medium text-rk-700 hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('camp_mine_manage')}
                    </a>
                  ) : null}
                  {c.slug && (c.status === 'PL' || c.status === 'LV') ? (
                    <Link
                      to={`/c/${encodeURIComponent(c.slug)}`}
                      className="text-slate-500 hover:text-rk-700 hover:underline"
                    >
                      {t('camp_mine_public')}
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
                      {t('camp_mine_edit')}
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
                          ? t('camp_mine_saved_notified', { n: result.notified })
                          : result.unchanged
                            ? t('camp_mine_unchanged')
                            : t('camp_mine_saved'),
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
