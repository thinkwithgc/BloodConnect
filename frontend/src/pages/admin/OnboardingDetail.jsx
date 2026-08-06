import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { apiRequest } from '../../lib/api.js';

const STATUS_LABEL = {
  PE: 'Pending license review',
  VE: 'License verified · awaiting MoU',
  AC: 'Active',
  SU: 'Suspended',
  AR: 'Archived',
};

const KIND_LABEL = { HO: 'Hospital', BB: 'Blood bank' };

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
          {fmtDateTime(inst.mou_signed_at)}
          {inst.mou_signatory_name ? (
            <span className="ml-2 text-xs text-slate-500">by {inst.mou_signatory_name}</span>
          ) : null}
        </dd>
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
    // Refetch on window focus so a webhook that flips VE → AC while the
    // admin is watching the page reflects without a manual reload.
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  });

  const verify = useMutation({
    mutationFn: () => apiRequest('POST', `/onboarding/verify/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] }),
  });

  const generateMou = useMutation({
    mutationFn: () => apiRequest('POST', `/onboarding/generate-mou/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] }),
  });

  const parent = detailQ.data?.institution;
  const children = detailQ.data?.children || [];
  const child = children[0] || null;

  const persistedSignUrl = parent?.current_esign_url;
  const persistedExpiresAt = parent?.current_esign_expires_at;
  const persistedDocId = parent?.current_esign_doc_id;

  // Human-readable expiry status for the persisted URL.
  const persistedExpiryLabel = useMemo(() => {
    if (!persistedExpiresAt) return null;
    const now = Date.now();
    const t = new Date(persistedExpiresAt).getTime();
    if (t <= now) return 'expired';
    const hours = Math.round((t - now) / 3_600_000);
    if (hours < 48) return `${hours}h left`;
    const days = Math.round(hours / 24);
    return `${days}d left`;
  }, [persistedExpiresAt]);

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
                <div className="space-y-3">
                  {persistedSignUrl && persistedExpiryLabel !== 'expired' ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                      <p className="font-semibold text-amber-900">MoU eSign in flight</p>
                      <p className="mt-1 text-amber-900">
                        Doc ID: <span className="font-mono">{persistedDocId}</span> ·{' '}
                        <span className="font-semibold">{persistedExpiryLabel}</span> to sign
                      </p>
                      <a
                        href={persistedSignUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-amber-800 underline"
                      >
                        Open sign URL →
                      </a>
                      <p className="mt-2 text-xs text-amber-800">
                        The signatory should have received this URL on WhatsApp from Leegality.
                        If they didn't, share this URL out-of-band. Clicking "Re-send MoU" below
                        will return this same URL (no new document created) until it expires.
                      </p>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex-1 text-sm text-slate-700">
                      Sends an Aadhaar eSign request via Leegality to{' '}
                      <span className="font-mono">{parent.primary_contact_mobile}</span>. One MoU
                      covers {child ? 'both the hospital and its blood bank' : 'this institution'}.
                    </div>
                    <button
                      type="button"
                      className="rk-button-primary"
                      onClick={() => generateMou.mutate()}
                      disabled={generateMou.isPending}
                    >
                      {generateMou.isPending
                        ? '…'
                        : persistedSignUrl && persistedExpiryLabel !== 'expired'
                          ? 'Re-send MoU'
                          : 'Send MoU for eSign'}
                    </button>
                  </div>
                </div>
              ) : null}

              {parent.onboarding_status === 'AC' ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="flex-1 text-sm text-slate-700">
                    Activated {fmtDateTime(parent.onboarded_at)}. Admin credentials have been
                    provisioned — hospital admin over WhatsApp
                    {child ? ', blood-bank admin surfaced on the hospital dashboard' : ''}.
                  </div>
                  <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">
                    Active
                  </span>
                </div>
              ) : null}

              {verify.error ? (
                <p className="text-xs text-rk-700">
                  Verify failed: {verify.error?.response?.data?.error || 'unknown'}
                </p>
              ) : null}
              {generateMou.error ? (
                <p className="text-xs text-rk-700">
                  Send-MoU failed: {generateMou.error?.response?.data?.error || 'unknown'}
                </p>
              ) : null}
              {generateMou.data && !generateMou.data.cached ? (
                <p className="text-xs text-slate-500">
                  New eSign document created ({generateMou.data.doc_id}). Reload to see it in the
                  in-flight card above.
                </p>
              ) : null}
              {generateMou.data && generateMou.data.cached ? (
                <p className="text-xs text-slate-500">
                  Returned the existing in-flight eSign document — no new Leegality request made.
                </p>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
      <Footer variant="compact" />
    </div>
  );
}
