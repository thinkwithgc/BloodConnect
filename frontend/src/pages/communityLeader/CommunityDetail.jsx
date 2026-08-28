import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { apiRequest } from '../../lib/api.js';
import { isoOffsetYears, todayISO } from '../../lib/dateBounds.js';

/**
 * Community detail — placeholder shell for Phase 2.
 *
 * What it shows today:
 *   • Community name + region + counts
 *   • Co-leaders list (owner badge, add/remove if you're the owner)
 *
 * Phase 3 will add:
 *   • Donor roster (limited PII)
 *   • Referral link/QR widget
 *   • Camp hosting integration
 *   • Stats over time
 */
export function CommunityDetail() {
  const { id } = useParams();
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ['cl-community', id],
    queryFn: () => apiRequest('GET', `/community-leader/communities/${id}`),
    staleTime: 30_000,
  });

  const removeMod = useMutation({
    mutationFn: (moderatorId) =>
      apiRequest('DELETE', `/community-leader/communities/${id}/co-leaders/${moderatorId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cl-community', id] }),
  });

  if (detailQ.isLoading) {
    return (
      <Shell>
        <p className="text-stone-500">Loading…</p>
      </Shell>
    );
  }
  if (detailQ.error) {
    return (
      <Shell>
        <div className="rk-card text-rk-700">
          {detailQ.error?.response?.data?.error || 'load_failed'}
        </div>
      </Shell>
    );
  }

  const { community, moderators } = detailQ.data;

  return (
    <Shell>
      <Link to="/community-leader" className="text-sm text-rk-700 hover:underline">
        ← Back to dashboard
      </Link>

      <CommunityHeader community={community} />

      <section className="grid grid-cols-3 gap-3">
        <Stat label="Donors" value={community.donor_count} />
        <Stat label="Active donors" value={community.active_donor_count} />
        <Stat label="Donations facilitated" value={community.donations_facilitated} />
      </section>

      <section className="rk-card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            Co-leaders ({moderators.length})
          </h2>
          {community.is_owner ? <AddCoLeaderInline communityId={id} /> : null}
        </div>
        <ul className="mt-3 divide-y divide-slate-100">
          {moderators.map((m) => (
            <li key={m.moderator_row_id} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-stone-900">{m.display_name}</div>
                <div className="text-xs text-stone-500">
                  {m.district_name || '—'} · added{' '}
                  {m.added_at ? new Date(m.added_at).toLocaleDateString() : '—'}
                </div>
              </div>
              {community.is_owner && moderators.length > 1 ? (
                <button
                  type="button"
                  className="text-xs text-rk-700 hover:underline"
                  onClick={() => {
                    if (window.confirm(`Remove ${m.display_name} as co-leader?`)) {
                      removeMod.mutate(m.moderator_row_id);
                    }
                  }}
                  disabled={removeMod.isPending}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {moderators.length === 1 ? (
          <p className="mt-3 text-xs text-amber-700">
            ⚠ Only one co-leader on this community. Add another before that person becomes
            unavailable — every community needs at least one co-leader for the handover path.
          </p>
        ) : null}
      </section>

      <ReferralCard communityId={id} />
      <DonorsCard communityId={id} />
      <CampsCard community={community} />
    </Shell>
  );
}

function ReferralCard({ communityId }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const q = useQuery({
    queryKey: ['cl-referral', communityId],
    queryFn: () => apiRequest('GET', `/community-leader/communities/${communityId}/referral`),
    staleTime: 5 * 60_000,
  });
  if (q.isLoading || !q.data) {
    return (
      <section className="rk-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Referral link
        </h2>
        <p className="mt-2 text-sm text-stone-500">Generating link…</p>
      </section>
    );
  }
  const { url, qr_png_data_url } = q.data;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable in some browsers — fall back silently.
      setCopied(false);
    }
  }
  return (
    <section className="rk-card">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
        Referral link
      </h2>
      <p className="mt-1 text-xs text-stone-500">
        Share this in your WhatsApp group. Anyone who signs up via this link will be
        tagged to your community.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={url}
          readOnly
          className="rk-input flex-1 font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <button type="button" className="rk-button-primary text-sm" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className="text-xs text-rk-700 hover:underline"
          onClick={() => setShowQr((s) => !s)}
        >
          {showQr ? 'Hide QR code' : 'Show QR code'}
        </button>
      </div>
      {showQr && qr_png_data_url ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded border border-slate-200 bg-white p-3">
          <img src={qr_png_data_url} alt="Referral QR" className="h-48 w-48" />
          <a
            href={qr_png_data_url}
            download={`raktify-community-${communityId.slice(0, 8)}-qr.png`}
            className="text-xs text-rk-700 hover:underline"
          >
            Download PNG
          </a>
        </div>
      ) : null}
    </section>
  );
}

function DonorsCard({ communityId }) {
  const q = useQuery({
    queryKey: ['cl-donors', communityId],
    queryFn: () => apiRequest('GET', `/community-leader/communities/${communityId}/donors`),
    staleTime: 30_000,
  });
  const donors = q.data?.donors || [];
  return (
    <section className="rk-card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Donors in this community ({donors.length})
        </h2>
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Name + blood group + last donation date only. Mobile numbers stay in your
        WhatsApp group — you already have them there.
      </p>
      {q.isLoading ? (
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      ) : donors.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">
          No donors yet. Share the referral link above to start recruiting.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left">Donor</th>
                <th className="px-2 py-1.5 text-left">Blood group</th>
                <th className="px-2 py-1.5 text-right">Donations</th>
                <th className="px-2 py-1.5 text-left">Last donation</th>
                <th className="px-2 py-1.5 text-left">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {donors.map((d) => (
                <tr key={d.id}>
                  <td className="px-2 py-1.5 font-medium">{d.display_name}</td>
                  <td className="px-2 py-1.5">
                    {d.blood_group_verified || (
                      <span className="text-slate-400">
                        {d.blood_group_self ? `${d.blood_group_self} (unverified)` : '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">{d.total_donations}</td>
                  <td className="px-2 py-1.5 text-stone-600">
                    {d.last_donation_date
                      ? new Date(d.last_donation_date).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-stone-600">
                    {d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Header card with name + region + description + owner badge + Edit button
// (owner only). The Edit button opens a modal that PATCHes the community.
// Slug is intentionally NOT editable — see comment on the backend route.
function CommunityHeader({ community }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="rk-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-stone-900">{community.name}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {[community.taluka_name, community.district_name, community.state_name]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {community.description ? (
            <p className="mt-2 text-sm text-stone-700">{community.description}</p>
          ) : null}
          <p className="mt-2 text-xs text-stone-500">
            Public URL:{' '}
            <code className="rounded bg-sand px-1.5 py-0.5">/community/{community.slug}</code>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {community.is_owner ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
              You are the owner
            </span>
          ) : (
            <span className="rounded-full bg-sand px-2 py-0.5 text-xs font-medium text-stone-700">
              Co-leader
            </span>
          )}
          {community.is_owner ? (
            <button
              type="button"
              className="rk-button-secondary text-xs"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <EditCommunityModal community={community} onClose={() => setEditing(false)} />
      ) : null}
    </section>
  );
}

function EditCommunityModal({ community, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: community.name,
    description: community.description || '',
    state_id: String(community.state_id || ''),
    district_id: String(community.district_id || ''),
    taluka_id: String(community.taluka_id || ''),
  });
  const [error, setError] = useState(null);
  const [confirmingRename, setConfirmingRename] = useState(false);

  const statesQ = useQuery({
    queryKey: ['geo', 'states'],
    queryFn: () => apiRequest('GET', '/geography/states'),
    staleTime: 24 * 3600_000,
  });
  const districtsQ = useQuery({
    queryKey: ['geo', 'districts', form.state_id],
    queryFn: () => apiRequest('GET', `/geography/districts?state_id=${form.state_id}`),
    enabled: !!form.state_id,
    staleTime: 24 * 3600_000,
  });
  const talukasQ = useQuery({
    queryKey: ['geo', 'talukas', form.district_id],
    queryFn: () => apiRequest('GET', `/geography/talukas?district_id=${form.district_id}`),
    enabled: !!form.district_id,
    staleTime: 24 * 3600_000,
  });

  const save = useMutation({
    mutationFn: () => {
      // Send only changed fields so the audit log captures the actual diff.
      const body = {};
      if (form.name.trim() !== community.name) body.name = form.name.trim();
      if ((form.description || '').trim() !== (community.description || '')) {
        body.description = form.description.trim() || null;
      }
      const newState = Number(form.state_id) || null;
      const newDistrict = Number(form.district_id) || null;
      const newTaluka = form.taluka_id ? Number(form.taluka_id) : null;
      if (newState !== community.state_id) body.state_id = newState;
      if (newDistrict !== community.district_id) body.district_id = newDistrict;
      if (newTaluka !== community.taluka_id) body.taluka_id = newTaluka;
      return apiRequest('PATCH', `/community-leader/communities/${community.id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cl-community', community.id] });
      qc.invalidateQueries({ queryKey: ['community-leader', 'communities'] });
      onClose();
    },
    onError: (err) => setError(err?.response?.data?.error || 'save_failed'),
  });

  function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    // If the name changed, surface the donor-confusion confirmation once.
    const nameChanged = form.name.trim() !== community.name;
    if (nameChanged && !confirmingRename) {
      setConfirmingRename(true);
      return;
    }
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="space-y-3">
          <h3 className="text-lg font-semibold text-stone-900">Edit community</h3>
          <p className="text-xs text-slate-500">
            URL slug (<code>{community.slug}</code>) can&apos;t be changed — printed posters
            + shared WhatsApp links + bookmarked URLs would all break. Everything else is
            editable.
          </p>

          <label className="block">
            <span className="rk-label">Community name</span>
            <input
              type="text"
              className="rk-input w-full"
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setConfirmingRename(false);
              }}
              required
              minLength={2}
              maxLength={120}
            />
          </label>

          <label className="block">
            <span className="rk-label">Description</span>
            <textarea
              className="rk-input w-full"
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={2000}
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="rk-label">State</span>
              <select
                className="rk-input w-full"
                value={form.state_id}
                onChange={(e) =>
                  setForm({ ...form, state_id: e.target.value, district_id: '', taluka_id: '' })
                }
                required
              >
                <option value="">—</option>
                {(statesQ.data?.states || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="rk-label">District</span>
              <select
                className="rk-input w-full"
                value={form.district_id}
                onChange={(e) => setForm({ ...form, district_id: e.target.value, taluka_id: '' })}
                required
                disabled={!form.state_id}
              >
                <option value="">—</option>
                {(districtsQ.data?.districts || []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="rk-label">Taluka</span>
              <select
                className="rk-input w-full"
                value={form.taluka_id}
                onChange={(e) => setForm({ ...form, taluka_id: e.target.value })}
                disabled={!form.district_id}
              >
                <option value="">—</option>
                {(talukasQ.data?.talukas || []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
          </div>

          {confirmingRename ? (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <strong>Renaming this community.</strong> Existing donors signed up under the
              old name <strong>&ldquo;{community.name}&rdquo;</strong>. They won&apos;t be
              notified of the rename. Continue?
            </div>
          ) : null}

          {error ? <p className="text-sm text-rk-700">{error}</p> : null}

          <div className="flex gap-2 pt-2">
            <button type="button" className="rk-button-secondary flex-1" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="rk-button-primary flex-1" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : confirmingRename ? 'Yes, rename + save' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Camps card — lists camps tied to this community (any status) and lets
// the owner host a new one. Co-leaders see the list but no "Host" button.
function CampsCard({ community }) {
  const [hosting, setHosting] = useState(false);
  const campsQ = useQuery({
    queryKey: ['cl-camps', community.id],
    queryFn: () => apiRequest('GET', `/community-leader/communities/${community.id}/camps`),
    staleTime: 30_000,
  });
  const camps = campsQ.data?.camps || [];
  return (
    <section className="rk-card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Camps ({camps.length})
        </h2>
        {community.is_owner ? (
          <button
            type="button"
            className="rk-button-primary text-xs"
            onClick={() => setHosting(true)}
          >
            + Host a camp
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Donation drives tied to this community. New camps start in &ldquo;Pending&rdquo; — an
        NGO coordinator reviews and approves before donors can RSVP.
      </p>
      {campsQ.isLoading ? (
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      ) : camps.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">
          No camps yet. Host your first one to start collecting donations as a community.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left">Camp</th>
                <th className="px-2 py-1.5 text-left">When</th>
                <th className="px-2 py-1.5 text-left">Venue</th>
                <th className="px-2 py-1.5 text-left">Status</th>
                <th className="px-2 py-1.5 text-right">RSVPs</th>
                {/* Derived from the donations the blood bank records against
                    the camp (migrations 313 + 314), not a roster tap - so it is
                    donations, and it now matches every other surface. */}
                <th className="px-2 py-1.5 text-right">Donated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {camps.map((c) => (
                <tr key={c.id}>
                  <td className="px-2 py-1.5 font-medium">{c.name}</td>
                  <td className="px-2 py-1.5 text-stone-600">
                    {new Date(c.scheduled_date).toLocaleDateString()} {c.start_time?.slice(0, 5)}
                  </td>
                  <td className="px-2 py-1.5 text-stone-600">{c.venue}</td>
                  <td className="px-2 py-1.5">
                    <CampStatusBadge status={c.status} />
                  </td>
                  <td className="px-2 py-1.5 text-right">{c.registered_donor_count}</td>
                  <td className="px-2 py-1.5 text-right">{c.attended_donor_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hosting ? (
        <HostCampModal community={community} onClose={() => setHosting(false)} />
      ) : null}
    </section>
  );
}

function CampStatusBadge({ status }) {
  const map = {
    PE: { label: 'Pending', cls: 'bg-amber-100 text-amber-800' },
    PL: { label: 'Planned', cls: 'bg-blue-100 text-blue-800' },
    LV: { label: 'Live', cls: 'bg-emerald-100 text-emerald-800' },
    CO: { label: 'Completed', cls: 'bg-slate-100 text-slate-700' },
    CA: { label: 'Cancelled', cls: 'bg-rk-100 text-rk-800' },
    // Was missing, so a declined camp rendered the raw code 'DC' to the very
    // person who needs to read why it was declined.
    DC: { label: 'Declined', cls: 'bg-rk-100 text-rk-800' },
  };
  const m = map[status] || { label: status, cls: 'bg-slate-100 text-slate-700' };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.label}</span>
  );
}

function HostCampModal({ community, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    venue: '',
    address_line: '',
    pincode: '',
    scheduled_date: '',
    start_time: '09:00',
    end_time: '13:00',
    organiser_name: community.name,
    organiser_contact_name: '',
    organiser_contact_mobile: '+91',
    target_donor_count: '',
    notes: '',
  });
  const [error, setError] = useState(null);

  const submit = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        organiser_type: 'CO',
        organiser_name: form.organiser_name.trim(),
        state_id: community.state_id,
        district_id: community.district_id,
        venue: form.venue.trim(),
        address_line: form.address_line.trim(),
        scheduled_date: form.scheduled_date,
        start_time: form.start_time,
        end_time: form.end_time,
      };
      if (community.taluka_id) body.taluka_id = community.taluka_id;
      if (form.pincode.trim()) body.pincode = form.pincode.trim();
      if (form.organiser_contact_name.trim())
        body.organiser_contact_name = form.organiser_contact_name.trim();
      if (form.organiser_contact_mobile.trim() && form.organiser_contact_mobile !== '+91')
        body.organiser_contact_mobile = form.organiser_contact_mobile.trim();
      if (form.target_donor_count) body.target_donor_count = Number(form.target_donor_count);
      if (form.notes.trim()) body.notes = form.notes.trim();
      return apiRequest(
        'POST',
        `/community-leader/communities/${community.id}/camps`,
        body,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cl-camps', community.id] });
      qc.invalidateQueries({ queryKey: ['cl-community', community.id] });
      onClose();
    },
    onError: (err) => setError(err?.response?.data?.error || 'host_failed'),
  });

  // Default scheduled date to a week from today (typical lead time).
  if (!form.scheduled_date) {
    const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const iso = d.toISOString().slice(0, 10);
    setTimeout(() => setForm((p) => ({ ...p, scheduled_date: iso })), 0);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            submit.mutate();
          }}
          className="space-y-3"
        >
          <h3 className="text-lg font-semibold text-stone-900">Host a camp</h3>
          <p className="text-xs text-slate-500">
            Submission goes to NGO coordinators for review. Once approved, donors can RSVP via
            the public camp page. Community location ({community.district_name},{' '}
            {community.state_name}) is used by default.
          </p>

          <Field label="Camp name" required>
            <input
              type="text"
              className="rk-input w-full"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              minLength={2}
              maxLength={160}
              placeholder="e.g. Marwadi Yuva Manch Annual Drive 2026"
            />
          </Field>

          <Field label="Venue (building / hall name)" required>
            <input
              type="text"
              className="rk-input w-full"
              value={form.venue}
              onChange={(e) => setForm({ ...form, venue: e.target.value })}
              required
              minLength={2}
            />
          </Field>

          <Field label="Address" required>
            <input
              type="text"
              className="rk-input w-full"
              value={form.address_line}
              onChange={(e) => setForm({ ...form, address_line: e.target.value })}
              required
              minLength={5}
              placeholder="Street, locality, landmark"
            />
          </Field>

          <Field label="Pincode (optional)">
            <input
              type="text"
              className="rk-input w-full font-mono"
              value={form.pincode}
              onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              pattern="^[1-9]\d{5}$"
            />
          </Field>

          <div className="grid grid-cols-3 gap-2">
            <Field label="Date" required>
              <input
                type="date"
                className="rk-input w-full"
                value={form.scheduled_date}
                onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })}
                required
                min={todayISO()}
                max={isoOffsetYears(1)}
              />
            </Field>
            <Field label="Start" required>
              <input
                type="time"
                className="rk-input w-full"
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                required
              />
            </Field>
            <Field label="End" required>
              <input
                type="time"
                className="rk-input w-full"
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                required
              />
            </Field>
          </div>

          <Field label="Organiser contact name (optional)">
            <input
              type="text"
              className="rk-input w-full"
              value={form.organiser_contact_name}
              onChange={(e) => setForm({ ...form, organiser_contact_name: e.target.value })}
            />
          </Field>

          <Field label="Organiser contact mobile (optional)">
            <input
              type="tel"
              className="rk-input w-full font-mono"
              value={form.organiser_contact_mobile}
              onChange={(e) => setForm({ ...form, organiser_contact_mobile: e.target.value })}
              pattern="^\+91\d{10}$"
              placeholder="+91XXXXXXXXXX"
            />
          </Field>

          <Field label="Target donor count (optional)">
            <input
              type="number"
              className="rk-input w-full"
              value={form.target_donor_count}
              onChange={(e) => setForm({ ...form, target_donor_count: e.target.value })}
              min={1}
              max={2000}
            />
          </Field>

          <Field label="Notes for reviewer (optional)">
            <textarea
              className="rk-input w-full"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              maxLength={2000}
            />
          </Field>

          {error ? <p className="text-sm text-rk-700">{error}</p> : null}

          <div className="flex gap-2 pt-2">
            <button type="button" className="rk-button-secondary flex-1" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="rk-button-primary flex-1" disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : 'Submit camp'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="rk-label">
        {label}
        {required ? <span className="text-rk-700"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function Shell({ children }) {
  return (
    <div className="flex min-h-full flex-col bg-cream font-sans">
      <Header subtitle="Community" />
      <main className="mx-auto w-full max-w-3xl px-4 py-6 space-y-5">{children}</main>
      <Footer variant="compact" />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rk-card">
      <div className="text-2xl font-semibold text-stone-900">{value ?? 0}</div>
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
    </div>
  );
}

function AddCoLeaderInline({ communityId }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);

  const lookupQ = useQuery({
    queryKey: ['cl-lookup', q],
    queryFn: () => apiRequest('GET', `/community-leader/leaders/lookup?q=${encodeURIComponent(q)}`),
    enabled: open && q.trim().length >= 2,
    staleTime: 10_000,
  });

  const add = useMutation({
    mutationFn: (leaderId) =>
      apiRequest('POST', `/community-leader/communities/${communityId}/co-leaders`, {
        co_leader_id: leaderId,
      }),
    onSuccess: () => {
      setOpen(false);
      setQ('');
      qc.invalidateQueries({ queryKey: ['cl-community', communityId] });
    },
    onError: (err) => setError(err?.response?.data?.error || 'add_failed'),
  });

  if (!open) {
    return (
      <button type="button" className="rk-button-primary text-xs" onClick={() => setOpen(true)}>
        + Add co-leader
      </button>
    );
  }

  return (
    <div className="w-full max-w-sm space-y-1">
      <input
        type="text"
        className="rk-input w-full text-sm"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        placeholder="Type a name or last 4 mobile digits…"
      />
      {q.trim().length >= 2 ? (
        <div className="rounded border border-slate-300 bg-white shadow-sm">
          {lookupQ.isLoading ? (
            <p className="p-2 text-xs text-stone-500">Searching…</p>
          ) : (lookupQ.data?.leaders || []).length === 0 ? (
            <p className="p-2 text-xs text-stone-500">No matches</p>
          ) : (
            <ul className="max-h-40 overflow-auto">
              {lookupQ.data.leaders.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className="block w-full px-2 py-1.5 text-left text-xs hover:bg-slate-50"
                    // onMouseDown + preventDefault — same dropdown-blur fix
                    // as the create-form CoLeaderPicker. Without this the
                    // input's blur fires before the button click on mobile,
                    // and the selection is lost.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add.mutate(l.id);
                    }}
                    disabled={add.isPending}
                  >
                    <span className="font-medium">{l.display_name}</span>
                    {l.district_name ? <span className="text-stone-500"> · {l.district_name}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {error ? <p className="text-xs text-rk-700">{error}</p> : null}
      <button
        type="button"
        className="text-xs text-stone-500 hover:underline"
        onClick={() => {
          setOpen(false);
          setQ('');
          setError(null);
        }}
      >
        Cancel
      </button>
    </div>
  );
}
