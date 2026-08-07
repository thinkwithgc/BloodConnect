import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

// Vendor integrations admin (part of PR (c) of the vendor push webhook plan).
// Companion to the code at backend/src/routes/admin.js and the public docs
// at /developers. Reads open to ngo_admin + super_admin; writes gated to
// super_admin server-side.

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

// Compact copy-to-clipboard that fits inside a table cell.
function Copy({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard rejection — the value is visible for manual copy */
        }
      }}
    >
      {done ? '✓' : label}
    </button>
  );
}

// Reveal-secret modal. Shown ONCE after issuing a new partner_key — the
// plaintext HMAC secret is not recoverable after this dialog closes.
function IssuedKeyDialog({ issued, vendor, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-16 w-full max-w-2xl space-y-4 rounded-xl bg-white p-6 shadow-lift">
        <h3 className="text-lg font-semibold text-slate-900">
          Partner key issued
          {issued.is_sandbox ? (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
              SANDBOX
            </span>
          ) : (
            <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
              PROD
            </span>
          )}
        </h3>
        <p className="text-sm text-slate-700">
          Send this to <strong>{vendor?.name}</strong> for the{' '}
          <strong>{issued.institution?.display_name}</strong> installation. This is the{' '}
          <strong>only time</strong> the HMAC secret is displayed — save it now.
        </p>

        <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-900">
              Partner key
            </div>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 font-mono text-sm"
                readOnly
                value={issued.partner_key}
                onFocus={(e) => e.target.select()}
              />
              <Copy value={issued.partner_key} />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-900">
              HMAC secret
            </div>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 font-mono text-sm"
                readOnly
                value={issued.hmac_secret}
                onFocus={(e) => e.target.select()}
              />
              <Copy value={issued.hmac_secret} />
            </div>
          </div>
        </div>

        <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-700">
          <div className="mb-1 font-semibold text-slate-900">Ready-to-send email body:</div>
          <textarea
            className="w-full rounded border border-slate-200 bg-white p-2 font-mono text-xs"
            rows={8}
            readOnly
            value={
              `Hi,\n\n` +
              `Your Raktify integration credentials for ${issued.institution?.display_name} (${issued.institution?.shortname}):\n\n` +
              `Partner key : ${issued.partner_key}\n` +
              `HMAC secret : ${issued.hmac_secret}\n\n` +
              `Docs: https://raktify.choudhari.ngo/developers\n` +
              `Markdown for AI assistants: https://raktify.choudhari.ngo/developers.md\n` +
              `Postman collection: https://raktify.choudhari.ngo/api/vendor-webhook-v1.postman_collection.json\n\n` +
              (issued.is_sandbox
                ? `NOTE: this is a SANDBOX key. Donors created via this key are auto-deleted after 24 hours. No real WhatsApp is sent to them — the response body contains a consent_url you can use to walk through the accept flow.\n\n`
                : ``) +
              `Reply to this email for integration questions.\n`
            }
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            className="rk-button-primary"
            onClick={onClose}
          >
            I've saved it — close
          </button>
        </div>
      </div>
    </div>
  );
}

function IssueKeyForm({ vendor, onIssued, onCancel }) {
  const qc = useQueryClient();
  const [shortname, setShortname] = useState('');
  const [isSandbox, setIsSandbox] = useState(false);
  const [notes, setNotes] = useState('');

  const m = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/admin/vendor-partners/${vendor.id}/keys`, {
        institution_shortname: shortname.trim(),
        is_sandbox: isSandbox,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (issued) => {
      qc.invalidateQueries({ queryKey: ['admin', 'vendors'] });
      qc.invalidateQueries({ queryKey: ['admin', 'vendor-detail', vendor.id] });
      onIssued(issued);
    },
  });

  return (
    <form
      className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <label className="block">
        <span className="rk-label">Institution shortname</span>
        <input
          className="rk-input font-mono"
          value={shortname}
          onChange={(e) => setShortname(e.target.value.toLowerCase())}
          placeholder="e.g. pdmc-amt-bb"
          required
        />
        <span className="mt-1 block text-xs text-slate-500">
          The exact <code>institutions.shortname</code>. For a paired HO+BB, use the BB
          shortname (usually <code>&lt;parent&gt;-bb</code>). Must be an active (AC) institution
          unless issuing a sandbox key.
        </span>
      </label>

      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isSandbox}
          onChange={(e) => setIsSandbox(e.target.checked)}
        />
        <span>Issue as sandbox key</span>
        <span className="text-xs text-slate-500">
          — donors auto-purged in 24h, no real WhatsApp fires, response echoes consent_url
        </span>
      </label>

      <label className="block">
        <span className="rk-label">Notes (optional)</span>
        <input
          className="rk-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Initial integration key for Strides at PDMMC"
        />
      </label>

      {m.error ? (
        <p className="text-xs text-rk-700">
          {m.error?.response?.data?.error || 'issue_failed'}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" className="rk-button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="rk-button-primary" disabled={m.isPending}>
          {m.isPending ? '…' : 'Issue key'}
        </button>
      </div>
    </form>
  );
}

function VendorDetail({ vendorId }) {
  const qc = useQueryClient();
  const [showIssue, setShowIssue] = useState(false);
  const [issued, setIssued] = useState(null);

  const q = useQuery({
    queryKey: ['admin', 'vendor-detail', vendorId],
    queryFn: () => apiRequest('GET', `/admin/vendor-partners/${vendorId}`),
    staleTime: 30_000,
  });

  const revoke = useMutation({
    mutationFn: ({ key, reason }) =>
      apiRequest('POST', `/admin/partner-keys/${key}/revoke`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'vendor-detail', vendorId] });
      qc.invalidateQueries({ queryKey: ['admin', 'vendors'] });
    },
  });

  if (q.isLoading) return <div className="p-3 text-sm text-slate-500">Loading…</div>;
  if (q.error) return <div className="p-3 text-sm text-rk-700">Load failed.</div>;

  const { vendor, keys } = q.data;

  return (
    <div className="border-t border-slate-100 bg-slate-50 p-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Keys for {vendor.name}</div>
          <div className="text-xs text-slate-500">
            {vendor.contact_email || 'no contact email'} · created {fmtDate(vendor.created_at)}
          </div>
        </div>
        <button
          type="button"
          className="rk-button-primary text-xs"
          onClick={() => setShowIssue((v) => !v)}
        >
          {showIssue ? 'Cancel' : '+ Issue key'}
        </button>
      </div>

      {showIssue ? (
        <IssueKeyForm
          vendor={vendor}
          onIssued={(r) => {
            setShowIssue(false);
            setIssued(r);
          }}
          onCancel={() => setShowIssue(false)}
        />
      ) : null}

      <div className="mt-3 overflow-x-auto rounded-md bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Partner key</th>
              <th className="px-3 py-2 text-left">Institution</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Issued</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {keys.map((k) => {
              const active = k.is_active;
              return (
                <tr key={k.partner_key}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{k.partner_key}</span>
                      <Copy value={k.partner_key} label="Copy" />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {k.institution_display_name ? (
                      <>
                        <div className="text-slate-900">{k.institution_display_name}</div>
                        <div className="font-mono text-[10px] text-slate-400">
                          @{k.institution_shortname}
                        </div>
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {k.is_sandbox ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-800">
                        SANDBOX
                      </span>
                    ) : (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-800">
                        PROD
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {active ? (
                      <span className="text-slate-800">Active</span>
                    ) : (
                      <span className="text-slate-500">
                        Revoked {k.revoked_at ? fmtDate(k.revoked_at) : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{fmtDate(k.created_at)}</td>
                  <td className="px-3 py-2 text-right">
                    {active ? (
                      <button
                        type="button"
                        className="text-xs text-rk-700 hover:underline"
                        onClick={() => {
                          const reason = window.prompt(
                            'Reason for revoking this key? (optional, saved to audit)',
                          );
                          if (reason !== null) {
                            revoke.mutate({ key: k.partner_key, reason });
                          }
                        }}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {keys.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                  No keys issued yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {issued ? (
        <IssuedKeyDialog issued={issued} vendor={vendor} onClose={() => setIssued(null)} />
      ) : null}
    </div>
  );
}

function NewVendorForm({ onCreated, onCancel }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  const m = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/admin/vendor-partners`, {
        name: name.trim(),
        contact_email: email.trim() || undefined,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin', 'vendors'] });
      onCreated(r.vendor);
    },
  });

  return (
    <form
      className="rk-card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <h3 className="text-sm font-semibold text-slate-900">New vendor</h3>
      <label className="block">
        <span className="rk-label">Company name</span>
        <input
          className="rk-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Strides Software"
          required
        />
      </label>
      <label className="block">
        <span className="rk-label">Contact email</span>
        <input
          type="email"
          className="rk-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="integrations@example.com"
        />
      </label>
      <label className="block">
        <span className="rk-label">Notes</span>
        <input
          className="rk-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Vendor for PDMMC blood bank"
        />
      </label>
      {m.error ? (
        <p className="text-xs text-rk-700">
          {m.error?.response?.data?.error === 'vendor_name_taken'
            ? 'A vendor with that name already exists.'
            : m.error?.response?.data?.error || 'create_failed'}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="rk-button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="rk-button-primary" disabled={m.isPending || !name.trim()}>
          {m.isPending ? '…' : 'Create'}
        </button>
      </div>
    </form>
  );
}

export function VendorIntegrationsTab() {
  const [expanded, setExpanded] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const listQ = useQuery({
    queryKey: ['admin', 'vendors'],
    queryFn: () => apiRequest('GET', `/admin/vendor-partners`),
    staleTime: 30_000,
  });

  const vendors = listQ.data?.vendors || [];

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-slate-600">
          Manage vendor push webhook credentials. Reads: ngo_admin. Writes (issue / revoke keys):
          super_admin only. Public integration docs at{' '}
          <a href="/developers" className="text-rk-700 hover:underline">
            /developers
          </a>
          .
        </p>
        <button
          type="button"
          className="rk-button-primary text-sm"
          onClick={() => setShowNew((v) => !v)}
        >
          {showNew ? 'Cancel' : '+ New vendor'}
        </button>
      </div>

      {showNew ? (
        <NewVendorForm
          onCreated={(v) => {
            setShowNew(false);
            setExpanded(v.id);
          }}
          onCancel={() => setShowNew(false)}
        />
      ) : null}

      <div className="rk-card overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Vendor</th>
              <th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-center">Active keys</th>
              <th className="px-3 py-2 text-center">Sandbox</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vendors.map((v) => {
              const isOpen = expanded === v.id;
              return (
                <>
                  <tr key={v.id} className={isOpen ? 'bg-slate-50' : ''}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{v.name}</div>
                      <div className="font-mono text-[10px] text-slate-400">{v.id}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{v.contact_email || '—'}</td>
                    <td className="px-3 py-2 text-center">{v.active_keys ?? 0}</td>
                    <td className="px-3 py-2 text-center">{v.sandbox_keys ?? 0}</td>
                    <td className="px-3 py-2 text-slate-700">{fmtDate(v.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="text-xs text-rk-700 hover:underline"
                        onClick={() => setExpanded(isOpen ? null : v.id)}
                      >
                        {isOpen ? 'Collapse' : 'Manage keys'}
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <VendorDetail vendorId={v.id} />
                      </td>
                    </tr>
                  ) : null}
                </>
              );
            })}
            {vendors.length === 0 && !listQ.isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                  No vendors yet. Click <b>+ New vendor</b> to add one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
