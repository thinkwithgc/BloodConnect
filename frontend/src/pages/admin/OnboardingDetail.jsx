import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { api, apiRequest } from '../../lib/api.js';
import { SetupLinkCard } from '../../components/institution/SetupLinkCard.jsx';

const STATUS_LABEL = {
  PE: 'Pending license review',
  VE: 'Licence verified · awaiting paper MoU',
  AC: 'Active',
  SU: 'Suspended',
  AR: 'Archived',
};

const KIND_LABEL = { HO: 'Hospital', BB: 'Blood bank' };

const SIGNING_MODE_LABEL = { PA: 'Paper (offline)', ES: 'Aadhaar eSign' };

// Accepted scan formats, mirroring SCAN_TYPES in backend/src/routes/onboarding.js.
const SCAN_ACCEPT = 'application/pdf,image/jpeg,image/png';
const SCAN_MAX_BYTES = 10 * 1024 * 1024;

// India-only platform, so "today" means today in IST — not UTC. Matches
// istToday() in the backend route so the date the picker offers is never
// rejected as being in the future. IST has no DST, so the offset is exact.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function fmt(v) {
  if (v == null || v === '') return '—';
  return String(v);
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', {
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

function fmtBool(v) {
  return v ? 'Yes' : 'No';
}

function InstitutionCard({ inst, kindLabel }) {
  if (!inst) return null;
  return (
    <article className="rk-card space-y-3">
      <header className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{kindLabel}</h2>
          <p className="font-mono text-xs text-slate-500">@{inst.shortname}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          {STATUS_LABEL[inst.onboarding_status] || inst.onboarding_status}
        </span>
      </header>

      <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-500">Legal name</dt>
        <dd className="col-span-2 text-slate-900">{fmt(inst.legal_name)}</dd>

        <dt className="text-slate-500">Display name</dt>
        <dd className="col-span-2 text-slate-900">{fmt(inst.display_name)}</dd>

        <dt className="text-slate-500">Kind</dt>
        <dd className="col-span-2 text-slate-900">
          {KIND_LABEL[inst.kind]}
          {inst.parent_institution_id ? (
            <span className="ml-2 text-xs text-slate-500">(child of hospital)</span>
          ) : null}
        </dd>

        <dt className="col-span-3 mt-2 border-t border-slate-100 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Address
        </dt>
        <dt className="text-slate-500">Line</dt>
        <dd className="col-span-2 text-slate-900">{fmt(inst.address_line)}</dd>
        <dt className="text-slate-500">Geo</dt>
        <dd className="col-span-2 text-slate-900">
          {[inst.village_name, inst.taluka_name, inst.district_name, inst.state_name]
            .filter(Boolean)
            .join(', ') || '—'}
        </dd>
        <dt className="text-slate-500">Pincode</dt>
        <dd className="col-span-2 font-mono text-slate-900">{fmt(inst.pincode)}</dd>
        {inst.latitude || inst.longitude ? (
          <>
            <dt className="text-slate-500">Coordinates</dt>
            <dd className="col-span-2 font-mono text-slate-900">
              {inst.latitude ?? '?'}, {inst.longitude ?? '?'}
            </dd>
          </>
        ) : null}

        <dt className="col-span-3 mt-2 border-t border-slate-100 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Regulatory
        </dt>
        <dt className="text-slate-500">CDSCO licence</dt>
        <dd className="col-span-2 text-slate-900">
          {fmt(inst.cdsco_licence_number)}
          {inst.cdsco_licence_expires ? (
            <span className="ml-2 text-xs text-slate-500">
              (expires {fmtDate(inst.cdsco_licence_expires)})
            </span>
          ) : null}
        </dd>
        <dt className="text-slate-500">Hospital reg. no</dt>
        <dd className="col-span-2 text-slate-900">{fmt(inst.hospital_registration_no)}</dd>
        <dt className="text-slate-500">In-house blood bank</dt>
        <dd className="col-span-2 text-slate-900">{fmtBool(inst.has_inhouse_blood_bank)}</dd>
        <dt className="text-slate-500">Software vendor</dt>
        <dd className="col-span-2 text-slate-900">
          {inst.is_blood_bank_software_user ? fmt(inst.software_vendor) : 'None'}
        </dd>

        <dt className="col-span-3 mt-2 border-t border-slate-100 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Primary contact
        </dt>
        <dt className="text-slate-500">Name</dt>
        <dd className="col-span-2 text-slate-900">
          {fmt(inst.primary_contact_name)}
          {inst.primary_contact_designation ? (
            <span className="ml-2 text-xs text-slate-500">
              ({inst.primary_contact_designation})
            </span>
          ) : null}
        </dd>
        <dt className="text-slate-500">Mobile</dt>
        <dd className="col-span-2 font-mono text-slate-900">
          {fmt(inst.primary_contact_mobile)}
        </dd>
        <dt className="text-slate-500">Email</dt>
        <dd className="col-span-2 text-slate-900">{fmt(inst.primary_contact_email)}</dd>

        <dt className="col-span-3 mt-2 border-t border-slate-100 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Timeline
        </dt>
        <dt className="text-slate-500">Applied</dt>
        <dd className="col-span-2 text-slate-900">{fmtDateTime(inst.onboarding_started_at)}</dd>
        <dt className="text-slate-500">Licence verified</dt>
        <dd className="col-span-2 text-slate-900">{fmtDateTime(inst.license_verified_at)}</dd>
        <dt className="text-slate-500">MoU signed</dt>
        <dd className="col-span-2 text-slate-900">
          {fmtDate(inst.mou_signed_at)}
          {inst.mou_signatory_name ? (
            <span className="ml-2 text-xs text-slate-500">by {inst.mou_signatory_name}</span>
          ) : null}
        </dd>
        <dt className="text-slate-500">MoU signing mode</dt>
        <dd className="col-span-2 text-slate-900">
          {SIGNING_MODE_LABEL[inst.mou_signing_mode] || '—'}
        </dd>
        <dt className="text-slate-500">MoU expires</dt>
        <dd className="col-span-2 text-slate-900">{fmtDate(inst.mou_expires_at)}</dd>
        <dt className="text-slate-500">Activated</dt>
        <dd className="col-span-2 text-slate-900">{fmtDateTime(inst.onboarded_at)}</dd>
      </dl>
    </article>
  );
}

export function OnboardingDetail() {
  const { id } = useParams();
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ['admin', 'onboarding', 'detail', id],
    queryFn: () => apiRequest('GET', `/onboarding/applications/${id}`),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  });

  const parent = detailQ.data?.institution;
  const children = detailQ.data?.children || [];
  const child = children[0] || null;

  // Activate form. Fields start unset and fall back to the applicant's own
  // submission, so the admin only types what differs from what was applied
  // with — the person who signs is usually the primary contact.
  const [form, setForm] = useState({});
  const [scanFile, setScanFile] = useState(null);
  const [scanError, setScanError] = useState(null);

  const maxDate = istToday();
  const signedOn = form.signedOn ?? maxDate;
  const signatoryName = form.signatoryName ?? parent?.primary_contact_name ?? '';
  const signatoryDesignation =
    form.signatoryDesignation ?? parent?.primary_contact_designation ?? '';

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const verify = useMutation({
    mutationFn: () => apiRequest('POST', `/onboarding/verify/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] }),
  });

  // Two requests when a scan is attached: the file goes up as a raw body
  // (JSON/base64 would be truncated by the API's input sanitiser), and the
  // returned key + hash are recorded by the activate call.
  const activate = useMutation({
    mutationFn: async () => {
      let scan = null;
      if (scanFile) {
        const r = await api.request({
          method: 'POST',
          url: `/onboarding/${id}/mou-scan`,
          data: scanFile,
          headers: { 'Content-Type': scanFile.type },
        });
        scan = r.data;
      }
      return apiRequest('POST', `/onboarding/activate/${id}`, {
        mou_signed_on: signedOn,
        signatory_name: signatoryName.trim(),
        ...(signatoryDesignation.trim()
          ? { signatory_designation: signatoryDesignation.trim() }
          : {}),
        ...(scan ? { mou_scan_key: scan.storage_key, mou_scan_sha256: scan.sha256 } : {}),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] }),
  });

  function onPickScan(e) {
    const f = e.target.files?.[0] || null;
    setScanError(null);
    if (!f) {
      setScanFile(null);
      return;
    }
    if (!SCAN_ACCEPT.split(',').includes(f.type)) {
      setScanError('Only PDF, JPEG or PNG files are accepted.');
      setScanFile(null);
      return;
    }
    if (f.size > SCAN_MAX_BYTES) {
      setScanError('File is larger than 10 MB — please compress or rescan it.');
      setScanFile(null);
      return;
    }
    setScanFile(f);
  }

  const canActivate = signatoryName.trim().length >= 2 && signedOn && !activate.isPending;

  return (
    <div className="flex min-h-full flex-col">
      <Header subtitle="Onboarding · Detail" />
      <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
        <div className="flex items-baseline justify-between">
          <Link to="/admin" className="text-sm text-rk-700 hover:underline">
            ← Back to admin
          </Link>
          <span className="font-mono text-xs text-slate-400">{id}</span>
        </div>

        {detailQ.isLoading ? <div className="rk-card">Loading…</div> : null}
        {detailQ.error ? (
          <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
            {detailQ.error?.response?.data?.error || 'load_failed'}
          </div>
        ) : null}

        {parent ? (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <InstitutionCard inst={parent} kindLabel={KIND_LABEL[parent.kind] || 'Institution'} />
              {child ? (
                <InstitutionCard inst={child} kindLabel="Blood bank (in-house)" />
              ) : parent.has_inhouse_blood_bank ? (
                <article className="rk-card border border-amber-300 bg-amber-50 text-sm text-amber-900">
                  <p className="font-semibold">In-house blood bank flagged</p>
                  <p className="mt-1">
                    The applicant ticked <em>has_inhouse_blood_bank</em> but no child row was
                    created. This is a data inconsistency — investigate before proceeding.
                  </p>
                </article>
              ) : null}
            </div>

            {/* Action bar */}
            <section className="rk-card space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Next action
              </h2>

              {parent.onboarding_status === 'PE' ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="flex-1 text-sm text-slate-700">
                    Verify the CDSCO licence
                    {child ? ' (blood bank) and hospital registration' : ''} above matches the
                    applicant's uploaded documents.{' '}
                    <strong>This action activates the licence-verified state for both rows.</strong>
                  </div>
                  <button
                    type="button"
                    className="rk-button-primary"
                    onClick={() => verify.mutate()}
                    disabled={verify.isPending}
                  >
                    {verify.isPending ? '…' : 'Verify licences'}
                  </button>
                </div>
              ) : null}

              {parent.onboarding_status === 'VE' ? (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (canActivate) activate.mutate();
                  }}
                >
                  <div className="rounded-md border border-slate-200 bg-sand/60 p-3 text-sm text-slate-700">
                    <p className="font-semibold text-slate-900">The MoU is signed on paper</p>
                    <p className="mt-1">
                      Record the signed hard copy you are holding, then activate. Activating
                      provisions the hospital admin login and WhatsApps a password-setup link to{' '}
                      <span className="font-mono">{parent.primary_contact_mobile}</span>
                      {child
                        ? '. The blood-bank admin login is created at the same time and surfaces on the hospital dashboard.'
                        : '.'}
                    </p>
                    <p className="mt-1">
                      One MoU covers {child ? 'both the hospital and its blood bank' : 'this institution'}, and
                      is valid for one year from the date signed.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="rk-label" htmlFor="mou-signed-on">
                        Date signed on paper
                      </label>
                      <input
                        id="mou-signed-on"
                        type="date"
                        className="rk-input"
                        value={signedOn}
                        max={maxDate}
                        onChange={setField('signedOn')}
                        required
                      />
                    </div>
                    <div>
                      <label className="rk-label" htmlFor="mou-signatory">
                        Signatory name
                      </label>
                      <input
                        id="mou-signatory"
                        type="text"
                        className="rk-input"
                        value={signatoryName}
                        onChange={setField('signatoryName')}
                        placeholder="Who signed the MoU"
                        required
                        minLength={2}
                      />
                    </div>
                    <div>
                      <label className="rk-label" htmlFor="mou-designation">
                        Signatory designation <span className="text-slate-400">(optional)</span>
                      </label>
                      <input
                        id="mou-designation"
                        type="text"
                        className="rk-input"
                        value={signatoryDesignation}
                        onChange={setField('signatoryDesignation')}
                        placeholder="e.g. Medical Superintendent"
                      />
                    </div>
                    <div>
                      <label className="rk-label" htmlFor="mou-scan">
                        Scan of the signed MoU <span className="text-slate-400">(optional)</span>
                      </label>
                      <input
                        id="mou-scan"
                        type="file"
                        className="rk-input"
                        accept={SCAN_ACCEPT}
                        onChange={onPickScan}
                      />
                      <p className="mt-1 text-xs text-slate-500">
                        PDF, JPEG or PNG · up to 10 MB. Leave empty if only the paper original is
                        filed.
                      </p>
                      {scanError ? <p className="mt-1 text-xs text-rk-700">{scanError}</p> : null}
                      {scanFile ? (
                        <p className="mt-1 text-xs text-slate-600">
                          {scanFile.name} · {(scanFile.size / 1024).toFixed(0)} KB
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                    <button type="submit" className="rk-button-primary" disabled={!canActivate}>
                      {activate.isPending ? 'Activating…' : 'Approve & activate'}
                    </button>
                  </div>
                </form>
              ) : null}

              {parent.onboarding_status === 'AC' ? (
                <div className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex-1 text-sm text-slate-700">
                      Activated {fmtDateTime(parent.onboarded_at)}. Admin logins were provisioned
                      for the hospital
                      {child ? ' and its in-house blood bank' : ''}.
                    </div>
                    <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">
                      Active
                    </span>
                  </div>
                  {/* Activating is not the same as anybody being able to sign in.
                      The setup link is single-use and only its SHA-256 is stored,
                      so if the WhatsApp failed to send, the link is gone and the
                      account sits unusable with nothing on this page to say so.
                      The users tab is where that is visible and fixable. */}
                  <div className="rounded-md border border-slate-200 bg-sand/60 p-3 text-sm text-slate-700">
                    <p>
                      Being active does not mean anyone has signed in yet. If the password-setup
                      WhatsApp did not arrive, re-issue the link from the staff logins tab — the
                      original is single-use and is not recoverable.
                    </p>
                    {/* One link per institution: the roster filters to a
                        single institution_id, and a hospital with an in-house
                        blood bank is two institution rows with two admins. */}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[parent, child].filter(Boolean).map((inst) => (
                        <Link
                          key={inst.id}
                          to={`/admin?tab=institution-users&institution_id=${inst.id}`}
                          className="inline-block rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Staff logins · @{inst.shortname} →
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {verify.error ? (
                <p className="text-xs text-rk-700">
                  Verify failed: {verify.error?.response?.data?.error || 'unknown'}
                </p>
              ) : null}
              {activate.error ? (
                <p className="text-xs text-rk-700">
                  Activation failed: {activate.error?.response?.data?.error || 'unknown'}
                </p>
              ) : null}
              {/* The one and only sighting of these URLs. generateSetupToken
                  stores SHA-256(token) alone, so what is rendered here exists
                  nowhere else — not in the DB, not in a log. Navigating away
                  without sending them means re-issuing from the staff logins
                  tab, which mints a new token and invalidates these. */}
              {activate.data ? (
                <div className="space-y-3 rounded-md border border-slate-200 bg-white p-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Sign-in details — send these now
                    </h3>
                    <p className="mt-1 text-xs text-slate-600">
                      Filed as MoU v{activate.data.version}. Each link lets that person choose their
                      own username and password; nobody, including you, ever sets either for them.
                    </p>
                  </div>

                  <SetupLinkCard
                    label="Hospital admin"
                    username={activate.data.ho_admin_username}
                    url={activate.data.ho_admin_setup_url}
                    expiresAt={activate.data.ho_setup_expires_at}
                    whatsappSent={activate.data.whatsapp_sent}
                    nextStep={activate.data.next_step}
                  />

                  {activate.data.bb_admin_setup_url ? (
                    <SetupLinkCard
                      label="Blood-bank admin (in-house)"
                      username={activate.data.bb_admin_username}
                      url={activate.data.bb_admin_setup_url}
                      expiresAt={activate.data.bb_setup_expires_at}
                      // Deliberately never WhatsApp'd: the BB admin is created
                      // with mobile = NULL because one mobile may hold only one
                      // staff login (idx_platform_users_mobile_staff_cluster),
                      // and the hospital admin already holds that number.
                      deliveryNotAttempted
                    />
                  ) : null}

                  <div className="flex flex-wrap gap-3">
                    {[parent, child].filter(Boolean).map((inst) => (
                      <Link
                        key={inst.id}
                        to={`/admin?tab=institution-users&institution_id=${inst.id}`}
                        className="text-xs text-rk-700 hover:underline"
                      >
                        Manage @{inst.shortname} logins →
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
      <Footer variant="compact" />
    </div>
  );
}
