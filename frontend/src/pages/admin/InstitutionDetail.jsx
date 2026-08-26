import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { apiRequest } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { LocalityPicker } from '../../components/LocalityPicker.jsx';
import { StaffRosterTable } from '../../components/institution/StaffRoster.jsx';
import { ReasonDialog, institutionErrorText } from '../../components/institution/ReasonDialog.jsx';

/**
 * One institution, after onboarding: its details, who can sign in for it, what
 * has been changed and why, and the lifecycle actions that stop or restart it.
 *
 * Until this page existed an institution was write-once. A renewed CDSCO
 * licence, a moved hospital, a replaced contact person had no route in, and
 * suspend was a one-way door — so the register drifted and the only fix was a
 * hand-written UPDATE against production. Everything here goes through
 * PUT /institutions/:id and the lifecycle endpoints, which means every change
 * lands in audit_log against the operator's username, field by field.
 *
 * The reason box is the point of the page, not decoration. A licence expiry or a
 * district change is answered months later by an inspection reading that one
 * sentence, so the server refuses those edits without it (>= 10 characters) and
 * this form does not offer Save until it is written. The field tiers below are a
 * copy of CRITICAL_FIELDS in backend/src/routes/institutions.js — the server is
 * the gate; this copy exists only so the textarea appears at the moment the
 * operator touches something that needs it, rather than after a rejected save.
 */

// Mirror of CRITICAL_FIELDS (backend/src/routes/institutions.js). Keep in step.
const CRITICAL_FIELDS = new Set([
  'legal_name',
  'cdsco_licence_number',
  'cdsco_licence_expires',
  'hospital_registration_no',
  'state_id',
  'district_id',
  'taluka_id',
  'village_id',
  'has_inhouse_blood_bank',
]);

const GEOGRAPHY_FIELDS = ['state_id', 'district_id', 'taluka_id', 'village_id'];

// Every key the form may send, with how an empty box should be transmitted.
//   'null'  — nullable column; blanking it clears the value
//   'text'  — plain optional string; blanking it stores ''
//   'num'   — numeric column that the schema will not accept as null, so a
//             blanked box is treated as "unchanged" rather than silently
//             dropping a coordinate the API cannot express
const EDITABLE = {
  legal_name: 'text',
  display_name: 'text',
  address_line: 'text',
  pincode: 'text',
  latitude: 'num',
  longitude: 'num',
  cdsco_licence_number: 'null',
  cdsco_licence_expires: 'null',
  hospital_registration_no: 'null',
  primary_contact_name: 'text',
  primary_contact_designation: 'text',
  primary_contact_mobile: 'text',
  primary_contact_email: 'text',
  software_vendor: 'text',
  has_inhouse_blood_bank: 'bool',
  is_blood_bank_software_user: 'bool',
  state_id: 'geo',
  district_id: 'geo',
  taluka_id: 'geo',
  village_id: 'geo',
};

const STATUS_META = {
  PE: { label: 'Pending licence review', cls: 'bg-slate-100 text-slate-700' },
  VE: { label: 'Awaiting paper MoU', cls: 'bg-amber-100 text-amber-900' },
  AC: { label: 'Active', cls: 'bg-green-100 text-green-800' },
  SU: { label: 'Suspended', cls: 'bg-amber-100 text-amber-900' },
  AR: { label: 'Archived', cls: 'bg-rk-50 text-rk-800' },
};

const KIND_LABEL = { HO: 'Hospital', BB: 'Blood bank' };

// Audit field names in operator words. Anything unmapped falls through as the
// column name, which is still readable and still a lead.
const FIELD_LABEL = {
  legal_name: 'Legal name',
  display_name: 'Display name',
  address_line: 'Address',
  pincode: 'PIN code',
  latitude: 'Latitude',
  longitude: 'Longitude',
  cdsco_licence_number: 'CDSCO licence number',
  cdsco_licence_expires: 'CDSCO licence expiry',
  hospital_registration_no: 'Hospital registration no.',
  primary_contact_name: 'Primary contact',
  primary_contact_designation: 'Contact designation',
  primary_contact_mobile: 'Contact mobile',
  primary_contact_email: 'Contact email',
  has_inhouse_blood_bank: 'Has in-house blood bank',
  is_blood_bank_software_user: 'Uses blood-bank software',
  software_vendor: 'Software vendor',
  state_id: 'State',
  district_id: 'District',
  taluka_id: 'Taluka',
  village_id: 'Village / area',
  onboarding_status: 'Status',
  suspension_reason: 'Suspension reason',
  suspended_at: 'Suspended at',
  is_active: 'Active',
  is_institution_admin: 'Institution admin',
  deactivated_at: 'Deactivated at',
  is_locked: 'Locked',
};

function norm(v) {
  if (v == null) return '';
  return String(v);
}

function fmt(v) {
  if (v == null || v === '') return '—';
  return String(v);
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    // Expiry dates arrive as 'YYYY-MM-DD' text so no timezone can shift a legal
    // date; anchoring at UTC midnight keeps that true through the formatter.
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00Z` : v;
    return new Date(iso).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(v);
  }
}

function fmtDateTime(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(v);
  }
}

export function InstitutionDetail() {
  const { id } = useParams();
  const { role, userId } = useAuth();
  const qc = useQueryClient();
  const isSuperAdmin = role === 'super_admin';

  const instQ = useQuery({
    queryKey: ['admin', 'institution', id],
    queryFn: () => apiRequest('GET', `/institutions/${id}`),
  });

  const rosterQ = useQuery({
    queryKey: ['admin', 'institution', id, 'users'],
    queryFn: () => apiRequest('GET', `/institutions/${id}/users`),
    staleTime: 10_000,
  });

  const auditQ = useQuery({
    queryKey: ['admin', 'institution', id, 'audit'],
    queryFn: () => apiRequest('GET', `/institutions/${id}/audit?limit=200`),
    staleTime: 10_000,
  });

  const inst = instQ.data || null;

  // ── Lifecycle ───────────────────────────────────────────────────────
  // Held rather than fired: every one of these needs a written justification,
  // and archive additionally needs the shortname typed out.
  const [pendingAction, setPendingAction] = useState(null);
  const [lifecycleError, setLifecycleError] = useState(null);
  const [note, setNote] = useState(null);

  const lifecycle = useMutation({
    mutationFn: ({ kind, reason }) =>
      apiRequest('POST', `/institutions/${id}/${kind}`, { reason }),
    onSuccess: (data, vars) => {
      setLifecycleError(null);
      setPendingAction(null);
      setNote(lifecycleNote(vars.kind, data));
      qc.invalidateQueries({ queryKey: ['admin', 'institution', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'institutions'] });
    },
    onError: (err) => setLifecycleError(err?.response?.data?.error || 'action_failed'),
  });

  const blockers = lifecycle.error?.response?.data || null;

  return (
    <div className="min-h-screen bg-cream">
      <Header subtitle="NGO admin" />
      <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6">
        <Link to="/admin?tab=institutions" className="text-sm text-slate-500 hover:underline">
          ← Institutions
        </Link>

        {instQ.isLoading ? <div className="rk-card">Loading…</div> : null}
        {instQ.error ? (
          <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
            {institutionErrorText(instQ.error?.response?.data?.error || 'load_failed')}
          </div>
        ) : null}

        {inst ? (
          <>
            <section className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold text-stone-900">
                    {inst.display_name || inst.legal_name}
                  </h1>
                  <p className="font-mono text-xs text-slate-500">
                    @{inst.shortname} · {KIND_LABEL[inst.kind] || inst.kind} ·{' '}
                    {inst.district_name || 'district unknown'}
                  </p>
                  {inst.parent ? (
                    <p className="mt-1 text-xs text-slate-600">
                      In-house blood bank of{' '}
                      <Link
                        to={`/admin/institutions/${inst.parent.id}`}
                        className="text-rk-700 hover:underline"
                      >
                        {inst.parent.display_name || `@${inst.parent.shortname}`}
                      </Link>
                      . Its hospital's admin governs both.
                    </p>
                  ) : null}
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    (STATUS_META[inst.onboarding_status] || {}).cls || 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {(STATUS_META[inst.onboarding_status] || {}).label || inst.onboarding_status}
                </span>
              </div>

              {inst.onboarding_status === 'SU' || inst.onboarding_status === 'AR' ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-semibold">
                    {inst.onboarding_status === 'AR' ? 'Archived' : 'Suspended'}
                    {inst.suspended_at ? ` on ${fmtDateTime(inst.suspended_at)}` : ''}
                  </p>
                  <p className="mt-1 text-xs">
                    Nobody at this institution can sign in. Reason on record:{' '}
                    {fmt(inst.suspension_reason)}
                  </p>
                </div>
              ) : null}

              <LifecycleBar
                inst={inst}
                isSuperAdmin={isSuperAdmin}
                busy={lifecycle.isPending}
                onPick={(kind) => {
                  setLifecycleError(null);
                  setNote(null);
                  setPendingAction(kind);
                }}
              />

              {note ? <p className="text-sm text-green-700">✓ {note}</p> : null}
              {lifecycleError && !pendingAction ? (
                <div className="rounded-md border border-rk-700/30 bg-rk-700/5 p-3 text-sm text-rk-700">
                  <p>✗ {institutionErrorText(lifecycleError)}</p>
                  {blockers?.open_requests || blockers?.committed_bags ? (
                    <p className="mt-1 text-xs">
                      {blockers.open_requests || 0} open request
                      {blockers.open_requests === 1 ? '' : 's'} ·{' '}
                      {blockers.committed_bags || 0} reserved or issued bag
                      {blockers.committed_bags === 1 ? '' : 's'}.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>

            <DetailsForm inst={inst} onSaved={(msg) => setNote(msg)} />

            <StaffSection inst={inst} rosterQ={rosterQ} selfUserId={userId} />

            <HistorySection auditQ={auditQ} />
          </>
        ) : null}
      </main>
      <Footer variant="compact" />

      {pendingAction && inst ? (
        <ReasonDialog
          {...lifecycleCopy(pendingAction, inst)}
          busy={lifecycle.isPending}
          error={lifecycleError}
          onCancel={() => {
            setPendingAction(null);
            setLifecycleError(null);
          }}
          onSubmit={(reason) => lifecycle.mutate({ kind: pendingAction, reason })}
        />
      ) : null}
    </div>
  );
}

/**
 * Copy for each lifecycle action. Suspend and archive differ in more than
 * severity: suspend deliberately does NOT touch an in-house blood bank (a
 * hospital can be stood down while its blood bank keeps serving the district),
 * archive moves the whole family. Saying so here is the only place an operator
 * would learn it.
 */
function lifecycleCopy(kind, inst) {
  const hasChild = (inst.children || []).length > 0;
  switch (kind) {
    case 'suspend':
      return {
        title: `Suspend ${inst.display_name || inst.shortname}`,
        description:
          'Everyone here is refused sign-in until it is lifted. Existing requests and reserved bags are untouched — this stops people, not work in progress.',
        consequence: hasChild
          ? 'Its in-house blood bank is NOT suspended by this and keeps operating. Suspend that separately if it must also stop.'
          : null,
        actionLabel: 'Suspend institution',
        tone: 'danger',
        minLength: 10,
      };
    case 'unsuspend':
      return {
        title: `Lift the suspension on ${inst.display_name || inst.shortname}`,
        description:
          'Sign-in is restored for every account here. Check the CDSCO licence and MoU are still in date before lifting.',
        actionLabel: 'Lift suspension',
        minLength: 10,
      };
    case 'archive':
      return {
        title: `Archive ${inst.display_name || inst.shortname}`,
        description:
          'This is how an institution leaves the platform. Nothing is deleted — every donation, screening and request it recorded stays, which is why this retires the institution rather than removing it. It can be restored by a super-admin.',
        consequence: hasChild
          ? 'Its in-house blood bank is archived with it. Refused while either still has an open request or a reserved/issued bag.'
          : 'Refused while it still has an open request or a reserved/issued bag.',
        actionLabel: 'Archive institution',
        tone: 'danger',
        minLength: 20,
        confirmPhrase: inst.shortname,
      };
    case 'unarchive':
      return {
        title: `Restore ${inst.display_name || inst.shortname}`,
        description:
          'Comes back suspended, not active — re-check the licence and MoU, then lift the suspension deliberately.',
        actionLabel: 'Restore institution',
        minLength: 10,
      };
    default:
      return { title: kind, actionLabel: 'Confirm' };
  }
}

/**
 * What to tell the operator afterwards. The endpoints' own `note` / `next_step`
 * strings are written for an API caller ("POST /institutions/:id/unsuspend"), so
 * they are not repeated back to somebody who just clicked a button.
 */
function lifecycleNote(kind, data) {
  const kids = (data.cascaded_to_children || []).join(', ');
  switch (kind) {
    case 'suspend':
      return 'Suspended. Nobody here can sign in until the suspension is lifted.';
    case 'unsuspend':
      return 'Suspension lifted — this institution is active again.';
    case 'archive':
      return kids
        ? `Archived, along with its in-house blood bank (${kids}). Nothing was deleted.`
        : 'Archived. Nothing was deleted — every record it entered stays.';
    case 'unarchive':
      return 'Restored, and deliberately left suspended. Re-check the licence and MoU, then lift the suspension.';
    default:
      return `Institution is now ${data.status}.`;
  }
}

function LifecycleBar({ inst, isSuperAdmin, busy, onPick }) {
  const status = inst.onboarding_status;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== 'SU' && status !== 'AR' ? (
        <button
          type="button"
          className="rk-button-secondary border-rk-700 text-rk-800 hover:bg-rk-50"
          disabled={busy}
          onClick={() => onPick('suspend')}
        >
          Suspend
        </button>
      ) : null}
      {status === 'SU' ? (
        <button
          type="button"
          className="rk-button-primary"
          disabled={busy}
          onClick={() => onPick('unsuspend')}
        >
          Lift suspension
        </button>
      ) : null}
      {status !== 'AR' ? (
        <button
          type="button"
          className="rk-button-secondary border-rk-700 text-rk-800 hover:bg-rk-50 disabled:opacity-50"
          disabled={busy || !isSuperAdmin}
          title={isSuperAdmin ? undefined : 'Archiving is restricted to a super-admin.'}
          onClick={() => onPick('archive')}
        >
          Archive
        </button>
      ) : (
        <button
          type="button"
          className="rk-button-secondary disabled:opacity-50"
          disabled={busy || !isSuperAdmin}
          title={isSuperAdmin ? undefined : 'Restoring is restricted to a super-admin.'}
          onClick={() => onPick('unarchive')}
        >
          Restore from archive
        </button>
      )}
      {!isSuperAdmin ? (
        <span className="text-xs text-slate-500">
          Archive and restore are super-admin only.
        </span>
      ) : null}
    </div>
  );
}

// ── Details ───────────────────────────────────────────────────────────

function DetailsForm({ inst, onSaved }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);
  const [reason, setReason] = useState('');
  const [editLocation, setEditLocation] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [extra, setExtra] = useState(null);

  // Re-seed whenever the record reloads, so a save (or someone else's change)
  // leaves the boxes showing what is actually stored rather than what was typed.
  useEffect(() => {
    const next = {};
    for (const key of Object.keys(EDITABLE)) next[key] = inst[key];
    setForm(next);
    setReason('');
    setEditLocation(false);
    setSaveError(null);
  }, [inst]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const patch = useMemo(() => {
    if (!form) return {};
    const out = {};
    for (const [key, kind] of Object.entries(EDITABLE)) {
      const cur = form[key];
      if (kind === 'bool') {
        if (Boolean(cur) !== Boolean(inst[key])) out[key] = Boolean(cur);
        continue;
      }
      if (norm(cur) === norm(inst[key])) continue;
      if (kind === 'geo') {
        // Set as a group by the picker below; ids are already numbers or null.
        out[key] = cur == null || cur === '' ? null : Number(cur);
        continue;
      }
      if (kind === 'num') {
        // The API cannot express "clear this coordinate", so a blanked box is
        // left alone rather than pretending it was saved.
        if (norm(cur) === '') continue;
        const n = Number(cur);
        if (Number.isFinite(n)) out[key] = n;
        continue;
      }
      if (kind === 'null') {
        out[key] = norm(cur).trim() === '' ? null : String(cur).trim();
        continue;
      }
      out[key] = String(cur ?? '').trim();
    }
    // state_id and district_id are NOT NULL columns; the picker always sets both,
    // so a null here would only ever come from a half-filled selection.
    if ('state_id' in out && out.state_id == null) delete out.state_id;
    if ('district_id' in out && out.district_id == null) delete out.district_id;
    return out;
  }, [form, inst]);

  const changed = Object.keys(patch);
  // The server is the authority on which fields are critical; CRITICAL_FIELDS
  // above is a mirror kept only so the reason box appears without a round trip.
  // When a `reason_required` rejection names fields the mirror has drifted out
  // of, adopt the server's list — otherwise the operator is left holding a
  // refusal with no box to type the reason into.
  const serverCritical = Array.isArray(extra?.critical_fields) ? extra.critical_fields : [];
  const critical = changed.filter((k) => CRITICAL_FIELDS.has(k) || serverCritical.includes(k));
  const reasonOk = reason.trim().length >= 10;
  const needsReason = critical.length > 0;

  const save = useMutation({
    mutationFn: () =>
      apiRequest('PUT', `/institutions/${inst.id}`, {
        ...patch,
        ...(needsReason ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (data) => {
      setSaveError(null);
      setExtra(null);
      onSaved(
        `Saved ${data.fields_updated.length} field${data.fields_updated.length === 1 ? '' : 's'}${
          data.reason_recorded ? ' with your reason on the record' : ''
        }.`,
      );
      qc.invalidateQueries({ queryKey: ['admin', 'institution', inst.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'institutions'] });
    },
    onError: (err) => {
      setSaveError(err?.response?.data?.error || 'action_failed');
      setExtra(err?.response?.data || null);
    },
  });

  if (!form) return null;

  const canSave = changed.length > 0 && (!needsReason || reasonOk) && !save.isPending;
  const locality = form.village_id
    ? { id: form.village_id, name: inst.village_name }
    : null;

  return (
    <section className="rk-card space-y-4">
      <div>
        <h2 className="text-base font-semibold text-stone-900">Details</h2>
        <p className="text-sm text-slate-600">
          Corrections save straight away. The licence, the legal identity and the location need a
          written reason first — those are the fields an inspection asks about.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" id="f-display">
          <input
            id="f-display"
            className="rk-input"
            value={norm(form.display_name)}
            onChange={(e) => set('display_name', e.target.value)}
          />
        </Field>
        <Field label="Legal name" id="f-legal" critical>
          <input
            id="f-legal"
            className="rk-input"
            value={norm(form.legal_name)}
            onChange={(e) => set('legal_name', e.target.value)}
          />
        </Field>

        <Field
          label="CDSCO licence number"
          id="f-lic"
          critical
          hint={inst.kind === 'BB' ? 'A blood bank must keep both this and its expiry.' : null}
        >
          <input
            id="f-lic"
            className="rk-input"
            value={norm(form.cdsco_licence_number)}
            onChange={(e) => set('cdsco_licence_number', e.target.value)}
          />
        </Field>
        <Field
          label="CDSCO licence expiry"
          id="f-lic-exp"
          critical
          hint="The date on the current certificate. Cannot be back-dated to before this institution was onboarded."
        >
          <input
            id="f-lic-exp"
            type="date"
            className="rk-input"
            value={norm(form.cdsco_licence_expires)}
            onChange={(e) => set('cdsco_licence_expires', e.target.value)}
          />
        </Field>

        <Field label="Hospital registration no." id="f-reg" critical>
          <input
            id="f-reg"
            className="rk-input"
            value={norm(form.hospital_registration_no)}
            onChange={(e) => set('hospital_registration_no', e.target.value)}
          />
        </Field>
        <Field label="PIN code" id="f-pin">
          <input
            id="f-pin"
            className="rk-input"
            inputMode="numeric"
            value={norm(form.pincode)}
            onChange={(e) => set('pincode', e.target.value)}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label="Address" id="f-addr">
            <textarea
              id="f-addr"
              className="rk-input"
              rows={2}
              value={norm(form.address_line)}
              onChange={(e) => set('address_line', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Primary contact" id="f-pcn">
          <input
            id="f-pcn"
            className="rk-input"
            value={norm(form.primary_contact_name)}
            onChange={(e) => set('primary_contact_name', e.target.value)}
          />
        </Field>
        <Field label="Designation" id="f-pcd">
          <input
            id="f-pcd"
            className="rk-input"
            value={norm(form.primary_contact_designation)}
            onChange={(e) => set('primary_contact_designation', e.target.value)}
          />
        </Field>
        <Field label="Contact mobile" id="f-pcm">
          <input
            id="f-pcm"
            className="rk-input"
            inputMode="tel"
            value={norm(form.primary_contact_mobile)}
            onChange={(e) => set('primary_contact_mobile', e.target.value)}
          />
        </Field>
        <Field label="Contact email" id="f-pce">
          <input
            id="f-pce"
            className="rk-input"
            type="email"
            value={norm(form.primary_contact_email)}
            onChange={(e) => set('primary_contact_email', e.target.value)}
          />
        </Field>

        <Field label="Latitude" id="f-lat" hint="Blank keeps the stored value.">
          <input
            id="f-lat"
            className="rk-input"
            inputMode="decimal"
            value={norm(form.latitude)}
            onChange={(e) => set('latitude', e.target.value)}
          />
        </Field>
        <Field label="Longitude" id="f-lng" hint="Blank keeps the stored value.">
          <input
            id="f-lng"
            className="rk-input"
            inputMode="decimal"
            value={norm(form.longitude)}
            onChange={(e) => set('longitude', e.target.value)}
          />
        </Field>

        <Field label="Blood-bank software vendor" id="f-vendor">
          <input
            id="f-vendor"
            className="rk-input"
            value={norm(form.software_vendor)}
            onChange={(e) => set('software_vendor', e.target.value)}
          />
        </Field>
        <div className="space-y-2 pt-1">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={Boolean(form.is_blood_bank_software_user)}
              onChange={(e) => set('is_blood_bank_software_user', e.target.checked)}
            />
            <span>Uses blood-bank software</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={Boolean(form.has_inhouse_blood_bank)}
              onChange={(e) => set('has_inhouse_blood_bank', e.target.checked)}
            />
            <span>
              Has an in-house blood bank
              <span className="block text-xs text-slate-500">
                Decides whether this hospital's admin also governs a second institution's logins —
                so it needs a reason.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* Location. One picker sets state, district, taluka and village together:
          the four are a nesting chain the server re-validates, and four
          independent selects can be combined into something it will reject. */}
      <div className="border-t border-stone-200 pt-4">
        <p className="rk-label">Location</p>
        <p className="text-sm text-slate-900">
          {[inst.village_name, inst.taluka_name, inst.district_name, inst.state_name]
            .filter(Boolean)
            .join(', ') || '—'}
        </p>
        {!editLocation ? (
          <button
            type="button"
            className="mt-2 text-sm text-rk-700 hover:underline"
            onClick={() => setEditLocation(true)}
          >
            Change location
          </button>
        ) : (
          <div className="mt-3 space-y-2">
            <LocalityPicker
              id="f-locality"
              label="Village, ward or urban area"
              placeholder="Type the village, city or Municipal Corp ward…"
              value={locality}
              onChange={(loc) => {
                if (!loc) {
                  setForm((f) => ({
                    ...f,
                    state_id: inst.state_id,
                    district_id: inst.district_id,
                    taluka_id: inst.taluka_id,
                    village_id: inst.village_id,
                  }));
                  return;
                }
                setForm((f) => ({
                  ...f,
                  state_id: loc.state_id,
                  district_id: loc.district_id,
                  taluka_id: loc.taluka_id,
                  village_id: loc.id,
                }));
              }}
            />
            <p className="text-xs text-slate-500">
              Only localities inside an activated district can be searched, so an institution
              outside one cannot be re-located here yet. Moving a district re-routes this
              institution's live requests to a different coordinator and DHO — hence the reason.
            </p>
            <button
              type="button"
              className="text-xs text-slate-500 hover:underline"
              onClick={() => {
                setEditLocation(false);
                setForm((f) => ({
                  ...f,
                  state_id: inst.state_id,
                  district_id: inst.district_id,
                  taluka_id: inst.taluka_id,
                  village_id: inst.village_id,
                }));
              }}
            >
              Keep the current location
            </button>
          </div>
        )}
      </div>

      {/* The reason box appears only once something needs it, and names what. */}
      {needsReason ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <label className="rk-label" htmlFor="f-reason">
            Reason for this change
          </label>
          <textarea
            id="f-reason"
            className="rk-input"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Licence renewed — new CDSCO certificate dated 12 Aug 2026 received by email from the hospital administrator."
          />
          <p className="mt-1 text-xs text-amber-900">
            Needed because you changed{' '}
            {critical.map((k) => FIELD_LABEL[k] || k).join(', ')}. Recorded permanently against
            your username on each field you changed, and cannot be edited afterwards. Minimum 10
            characters.
          </p>
          {reason.trim().length > 0 && !reasonOk ? (
            <p className="mt-1 text-xs text-amber-800">
              {10 - reason.trim().length} more character
              {10 - reason.trim().length === 1 ? '' : 's'} needed.
            </p>
          ) : null}
        </div>
      ) : null}

      {saveError ? (
        <div className="rounded-md border border-rk-700/30 bg-rk-700/5 p-3 text-sm text-rk-700">
          <p>✗ {institutionErrorText(saveError)}</p>
          {extra?.institution_created_at ? (
            <p className="mt-1 text-xs">
              This institution was created on {fmtDateTime(extra.institution_created_at)}.
            </p>
          ) : null}
          {extra?.constraint ? (
            <p className="mt-1 font-mono text-xs">constraint: {extra.constraint}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-3">
        <p className="text-xs text-slate-500">
          {changed.length === 0
            ? 'No changes yet.'
            : `${changed.length} field${changed.length === 1 ? '' : 's'} changed: ${changed
                .map((k) => FIELD_LABEL[k] || k)
                .join(', ')}.`}
        </p>
        <button
          type="button"
          className="rk-button-primary"
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </section>
  );
}

function Field({ label, id, hint, critical = false, children }) {
  return (
    <div>
      <label className="rk-label" htmlFor={id}>
        {label}
        {critical ? (
          <span className="ml-1 font-normal text-amber-700" title="Changing this needs a reason">
            · needs a reason
          </span>
        ) : null}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

// ── Staff ─────────────────────────────────────────────────────────────

/**
 * Read-only here on purpose. Every action on a staff login — invite, unlock,
 * re-issue, deactivate, admin flag — already lives on the Institution staff
 * logins tab, which is deep-linkable by institution. A second copy of that
 * mutation surface would be two places to keep the reason gate correct.
 */
function StaffSection({ inst, rosterQ, selfUserId }) {
  const users = rosterQ.data?.users || [];
  const children = rosterQ.data?.children || [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Staff logins</h2>
          <p className="text-sm text-slate-600">
            Who can sign in for this institution, and whether they actually can.
          </p>
        </div>
        <Link
          to={`/admin?tab=institution-users&institution_id=${inst.id}`}
          className="rk-button-secondary"
        >
          Manage these logins →
        </Link>
      </div>

      {rosterQ.isLoading ? <div className="rk-card">Loading team…</div> : null}
      {rosterQ.error ? (
        <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
          {institutionErrorText(rosterQ.error?.response?.data?.error || 'load_failed')}
        </div>
      ) : null}
      {rosterQ.data ? (
        <StaffRosterTable users={users} canManage={false} selfUserId={selfUserId} />
      ) : null}

      {children.map((child) => (
        <div key={child.institution_id} className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2 border-t border-stone-200 pt-3">
            <h3 className="text-sm font-semibold text-stone-900">
              {child.display_name || child.shortname}
            </h3>
            <span className="rounded-full border border-stone-300 px-2 py-0.5 text-[11px] text-slate-600">
              {child.kind === 'BB' ? 'in-house blood bank' : child.kind}
            </span>
            <Link
              to={`/admin/institutions/${child.institution_id}`}
              className="text-xs text-rk-700 hover:underline"
            >
              open its record →
            </Link>
          </div>
          <p className="text-xs text-slate-500">
            Separate logins, because a blood bank's screening and inventory records are its own.
            This hospital's admin manages both sets.
          </p>
          <StaffRosterTable
            users={child.users || []}
            canManage={false}
            selfUserId={selfUserId}
          />
        </div>
      ))}
    </section>
  );
}

// ── History ───────────────────────────────────────────────────────────

/**
 * What changed, who changed it, and why — for this institution, its staff logins
 * and its MoU versions, newest first.
 *
 * A row with no reason renders "—" rather than being dropped: a change nobody
 * justified is exactly the thing worth being able to see. Credential fields come
 * back with their values withheld by the server (utils/auditRedaction.js) while
 * keeping the field name, so "the password was changed, by this actor, at this
 * time" still reads.
 */
function HistorySection({ auditQ }) {
  const events = auditQ.data?.events || [];

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-stone-900">History</h2>
        <p className="text-sm text-slate-600">
          Append-only. Nothing here can be edited or removed, including by a super-admin.
        </p>
      </div>

      {auditQ.isLoading ? <div className="rk-card">Loading history…</div> : null}
      {auditQ.error ? (
        <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
          {institutionErrorText(auditQ.error?.response?.data?.error || 'load_failed')}
        </div>
      ) : null}

      {auditQ.data ? (
        events.length === 0 ? (
          <div className="rk-card text-sm text-slate-600">
            Nothing recorded against this institution yet.
          </div>
        ) : (
          <>
            {auditQ.data.truncated ? (
              <p className="text-xs text-slate-500">
                Showing the most recent {auditQ.data.limit} entries.
              </p>
            ) : null}
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">Who</th>
                    <th className="px-3 py-2">What</th>
                    <th className="px-3 py-2">Change</th>
                    <th className="px-3 py-2">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-700">
                        {fmtDateTime(e.event_time)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs text-slate-800">
                          {e.actor_username || (e.actor_role ? `(${e.actor_role})` : 'unknown')}
                        </div>
                        {e.actor_username && e.actor_role ? (
                          <div className="text-[11px] text-slate-500">{e.actor_role}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-slate-900">
                          {FIELD_LABEL[e.field_name] || e.field_name || e.event_type}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {subjectLabel(e)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {e.value_withheld ? (
                          <span className="text-xs italic text-slate-500">
                            withheld (credential)
                          </span>
                        ) : e.event_type === 'INSERT' ? (
                          <span className="text-xs text-slate-500">created</span>
                        ) : (
                          <span className="break-words">
                            <span className="text-slate-500">{fmt(e.old_value)}</span>
                            {' → '}
                            <span className="font-medium">{fmt(e.new_value)}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{fmt(e.change_reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : null}
    </section>
  );
}

function subjectLabel(e) {
  switch (e.table_name) {
    case 'institutions':
      return `institution @${e.subject_label || '?'}`;
    case 'platform_users':
      return `login ${e.subject_label || '?'}`;
    case 'mou_versions':
      return 'MoU';
    default:
      return e.table_name;
  }
}
