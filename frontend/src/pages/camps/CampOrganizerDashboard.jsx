import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';

import { CollectionBankLine } from '../../components/CollectionBankLine.jsx';
import { Wordmark } from '../../components/Wordmark.jsx';
import { apiRequest } from '../../lib/api.js';
import { CAMP_STATUS } from '../../lib/campStatus.js';

// Roster status. AT and NS are DERIVED, never tapped: AT comes from the blood
// bank recording a donation against this camp (migration 314) and NS from the
// camp-close-roster job 48h after the camp date. DF and CN are the only two the
// desk sets, plus RG to undo them.
//
// DF is an ATTENDANCE fact - "came, could not donate". It says nothing clinical
// about the donor and never touches their deferral fields; the reason lives in
// the blood bank's screening record, not here (migration 312).
const STATUS = {
  RG: { label: 'Registered', cls: 'bg-sky-100 text-sky-800' },
  AT: { label: 'Donated', cls: 'bg-green-100 text-green-800' },
  DF: { label: "Came, couldn't donate", cls: 'bg-amber-100 text-amber-800' },
  NS: { label: 'No-show', cls: 'bg-slate-200 text-slate-700' },
  CN: { label: 'Cancelled', cls: 'bg-rk-700/80 text-white' },
};

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

function fmtTime(v) {
  if (!v) return '';
  return String(v).slice(0, 5);
}

function KpiCard({ label, value, sub }) {
  return (
    <div className="rk-card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-bold text-slate-900">{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

// Stand-alone token-based call (the global axios client adds the JWT
// interceptor; here we don't want that because the token IS the credential.
// Use plain fetch.)
// Match the same env var the global axios client uses (see lib/api.js).
// Dev: empty → Vite dev server proxies /camps to localhost:3000.
// Prod: VITE_API_URL points at the Azure backend.
const apiBase = import.meta.env.VITE_API_URL || '';

async function tokenFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${apiBase}${path}`;
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || r.statusText);
    err.response = { data: body, status: r.status };
    throw err;
  }
  return body;
}

export function CampOrganizerDashboard() {
  const { token } = useParams();
  const qc = useQueryClient();
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastResult, setBroadcastResult] = useState(null);

  const dashQ = useQuery({
    queryKey: ['camp-organizer', token],
    queryFn: () => tokenFetch(`/camps/access/${token}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const markStatus = useMutation({
    mutationFn: ({ regId, status }) =>
      tokenFetch(`/camps/access/${token}/registrations/${regId}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['camp-organizer', token] }),
  });

  const broadcast = useMutation({
    mutationFn: (message) =>
      tokenFetch(`/camps/access/${token}/broadcast`, {
        method: 'POST',
        body: { message },
      }),
    onSuccess: (r) => {
      setBroadcastResult(r);
      setBroadcastText('');
    },
  });

  const regs = dashQ.data?.registrations || [];

  const counts = useMemo(() => {
    const c = { RG: 0, AT: 0, NS: 0, CN: 0, DF: 0 };
    for (const r of regs) c[r.status] = (c[r.status] || 0) + 1;
    // Same definition as migration 313's fn_camp_recount, so this card can
    // never disagree with donation_camps.registered_donor_count: everything
    // that is not a cancellation was a registration.
    c.registered = c.RG + c.AT + c.NS + c.DF;
    // Turnout is who actually showed up - donated or turned away at screening.
    // Keeping DF out of it would make a well-attended camp look half-empty,
    // which is exactly why the two are recorded separately.
    c.turnout = c.AT + c.DF;
    return c;
  }, [regs]);

  if (dashQ.isLoading) {
    return (
      <PageShell>
        <div className="rk-card text-center text-slate-500">Loading your dashboard…</div>
      </PageShell>
    );
  }

  if (dashQ.error) {
    const code = dashQ.error?.response?.data?.error;
    const message =
      code === 'token_expired'
        ? 'This link has expired. Please ask the Raktify NGO admin for a fresh link.'
        : code === 'token_revoked'
          ? 'This link has been revoked. Please contact the Raktify NGO admin.'
          : code === 'invalid_token'
            ? 'This link is not recognised. Double-check the URL.'
            : code || 'load_failed';
    return (
      <PageShell>
        <div className="rk-card text-center">
          <h1 className="text-lg font-semibold text-rk-700">Access not available</h1>
          <p className="mt-2 text-sm text-slate-600">{message}</p>
          <Link to="/" className="rk-button-secondary mt-4 inline-block">
            Go to Raktify home
          </Link>
        </div>
      </PageShell>
    );
  }

  const camp = dashQ.data?.camp || {};
  const cs = CAMP_STATUS[camp.status] || CAMP_STATUS.PL;

  return (
    <PageShell>
      <header className="rk-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Camp organizer dashboard
            </div>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">{camp.name}</h1>
            <p className="text-sm text-slate-600">
              {fmtDate(camp.scheduled_date)} · {fmtTime(camp.start_time)}–{fmtTime(camp.end_time)} · {camp.venue}
            </p>
            <p className="text-xs text-slate-500">{camp.district_name}</p>
            <CollectionBankLine
              bbResponse={camp.bb_response}
              bloodBankName={camp.partnered_blood_bank_name}
            />
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cs.cls}`}>
            {cs.label}
          </span>
        </div>
        {dashQ.data?.granted_to_name ? (
          <p className="mt-2 text-xs text-slate-400">
            Access granted to {dashQ.data.granted_to_name}. Link expires{' '}
            {fmtDate(dashQ.data.expires_at)}. Don&apos;t share this link publicly.
          </p>
        ) : null}
      </header>

      {/* KPI cards */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Registered"
          value={counts.registered}
          sub={camp.target_donor_count ? `Target ${camp.target_donor_count}` : ''}
        />
        <KpiCard
          label="Donated"
          value={counts.AT}
          sub="from blood bank records"
        />
        <KpiCard label="Couldn't donate" value={counts.DF} sub="turned away at screening" />
        <KpiCard
          label="Turnout"
          value={counts.turnout}
          sub={counts.NS > 0 ? `${counts.NS} did not come` : 'donated + turned away'}
        />
        <KpiCard label="Units collected" value={camp.units_collected ?? 0} sub="from blood bank" />
      </section>

      {/* Share toolkit */}
      <ShareToolkit camp={camp} />

      {/* Where RSVPs came from */}
      <ChannelMix mix={dashQ.data?.channel_mix || []} total={regs.length} />

      {/* Broadcast */}
      <article className="rk-card space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Send an update to registered donors
        </h2>
        <p className="text-xs text-slate-500">
          The message goes via WhatsApp (or SMS as fallback) to everyone who&apos;s RSVP&apos;d for this
          camp. Use it for venue changes, ID reminders, or thank-yous after the camp.
        </p>
        <textarea
          className="rk-input min-h-[80px]"
          maxLength={500}
          placeholder="e.g. Venue updated to Hall 2 of Sant Gadge Baba University. Please carry a govt ID. Light breakfast will be served from 8am."
          value={broadcastText}
          onChange={(e) => setBroadcastText(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">{broadcastText.length}/500</span>
          <button
            type="button"
            className="rk-button-primary text-sm"
            onClick={() => broadcast.mutate(broadcastText)}
            disabled={broadcast.isPending || broadcastText.trim().length < 5}
          >
            {broadcast.isPending ? '…' : `Send to ${counts.RG + counts.AT} donors`}
          </button>
        </div>
        {broadcastResult ? (
          <p className="text-sm text-green-700">
            Queued {broadcastResult.queued} message{broadcastResult.queued === 1 ? '' : 's'}.
          </p>
        ) : null}
        {broadcast.error ? (
          <p className="text-sm text-rk-700">
            {broadcast.error?.response?.data?.error || 'broadcast_failed'}
          </p>
        ) : null}
      </article>

      {/* Roster */}
      <article className="rk-card overflow-x-auto p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Roster ({regs.length})
          </h2>
          <span className="text-xs text-slate-500">
            Attendance fills itself as the blood bank records donations.
          </span>
        </div>
        {/* Said once, plainly, because the desk used to tick attendance here and
            will look for the buttons. Nobody marks Donated or No-show now. */}
        <p className="border-y border-slate-100 bg-slate-50/70 px-4 py-2 text-xs text-slate-600">
          <strong>Donated</strong> appears on its own when the blood bank records that
          donation - usually during the camp, sometimes the next morning. Anyone still{' '}
          <strong>Registered</strong> two days after the camp becomes a{' '}
          <strong>No-show</strong> automatically. The one thing to record here is a donor who
          came and was <strong>turned away at screening</strong> - and only that they were,
          never why.
        </p>
        {markStatus.error ? (
          <p className="border-b border-rk-100 bg-rk-50 px-4 py-2 text-xs text-rk-700">
            {markStatus.error?.response?.data?.error === 'attendance_is_derived'
              ? 'Attendance is not set by hand - it comes from the donation the blood bank records against this camp.'
              : markStatus.error?.response?.data?.error || 'could_not_update'}
          </p>
        ) : null}
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Donor</th>
              <th className="px-3 py-2 text-left">Blood group</th>
              <th className="px-3 py-2 text-left">RSVP&apos;d</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Record</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {regs.map((r) => {
              const s = STATUS[r.status] || STATUS.RG;
              const deferred = r.deferral_status && r.deferral_status !== 'OK';
              return (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{r.full_name}</div>
                    {deferred ? (
                      <div className="text-xs text-amber-700">
                        ⚠ currently deferred — may not donate today
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-rk-700">
                      {r.blood_group_code || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{fmtDate(r.registered_at)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                      {s.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/* Nothing to press on a donor who has donated - that row
                        came from the blood bank's own record and the desk
                        cannot improve on it. RG and NS keep the one thing the
                        desk knows better than anyone: whether the person was
                        standing in front of them and got turned away. */}
                    <div className="flex justify-end gap-1">
                      {r.status === 'RG' || r.status === 'NS' ? (
                        <button
                          type="button"
                          className="rounded-md border border-amber-300 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
                          onClick={() => markStatus.mutate({ regId: r.id, status: 'DF' })}
                          disabled={markStatus.isPending}
                        >
                          Couldn&apos;t donate
                        </button>
                      ) : null}
                      {r.status === 'RG' ? (
                        <button
                          type="button"
                          className="rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          onClick={() => markStatus.mutate({ regId: r.id, status: 'CN' })}
                          disabled={markStatus.isPending}
                        >
                          Cancel
                        </button>
                      ) : null}
                      {r.status === 'DF' || r.status === 'CN' ? (
                        <button
                          type="button"
                          className="rounded-md border border-sky-300 px-2 py-0.5 text-xs font-medium text-sky-800 hover:bg-sky-50"
                          onClick={() => markStatus.mutate({ regId: r.id, status: 'RG' })}
                          disabled={markStatus.isPending}
                        >
                          Undo
                        </button>
                      ) : null}
                      {r.status === 'AT' ? (
                        <span className="text-xs text-slate-400">recorded by blood bank</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {regs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">
                  No RSVPs yet — registrations will appear here as donors sign up.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </article>

      <footer className="text-center text-xs text-slate-400">
        Powered by{' '}
        <Link to="/" className="font-semibold text-rk-700 hover:underline">
          Raktify
        </Link>
        {' · '}
        Need help? WhatsApp the NGO coordinator on the number they shared with you.
      </footer>
    </PageShell>
  );
}

// ─── Share toolkit ──────────────────────────────────────────────────────────
// Generates the public /c/<slug> URL plus a QR code and per-channel share
// buttons. Each button appends ?via=<channel> so RSVPs can be attributed.
function ShareToolkit({ camp }) {
  const slug = camp?.slug;
  const [copyState, setCopyState] = useState('');

  // Always use the live origin so QR posters work regardless of dev/staging.
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://raktify.choudhari.ngo';
  const baseUrl = slug ? `${origin}/c/${slug}` : null;

  const shareText = useMemo(() => {
    if (!camp) return '';
    const dateStr = (() => {
      try {
        return new Date(camp.scheduled_date).toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric',
        });
      } catch {
        return camp.scheduled_date || '';
      }
    })();
    return (
      `🩸 Blood donation camp: ${camp.name}\n` +
      `📅 ${dateStr} · ${(camp.start_time || '').slice(0, 5)}–${(camp.end_time || '').slice(0, 5)}\n` +
      `📍 ${camp.venue}\n\n` +
      `If you can donate, please register here:`
    );
  }, [camp]);

  if (!baseUrl) return null;

  function urlWith(channel) {
    return `${baseUrl}?via=${channel}`;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('Copied!');
      setTimeout(() => setCopyState(''), 1800);
    } catch {
      setCopyState('Copy failed — long-press the link.');
    }
  }

  const channels = [
    {
      key: 'whatsapp',
      label: 'WhatsApp',
      href: `https://wa.me/?text=${encodeURIComponent(`${shareText}\n${urlWith('whatsapp')}`)}`,
      cls: 'border-green-500 text-green-700 hover:bg-green-50',
    },
    {
      key: 'facebook',
      label: 'Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(urlWith('facebook'))}`,
      cls: 'border-sky-600 text-sky-700 hover:bg-sky-50',
    },
    {
      key: 'twitter',
      label: 'X / Twitter',
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(urlWith('twitter'))}`,
      cls: 'border-slate-700 text-slate-800 hover:bg-slate-50',
    },
    {
      key: 'email',
      label: 'Email',
      href: `mailto:?subject=${encodeURIComponent(`Blood donation camp: ${camp.name}`)}&body=${encodeURIComponent(`${shareText}\n${urlWith('email')}`)}`,
      cls: 'border-slate-300 text-slate-700 hover:bg-slate-50',
    },
  ];

  return (
    <article className="rk-card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Invite donors
        </h2>
        <span className="text-xs text-slate-500">
          Every share carries a different ?via= so you can see which channels work.
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          {/* Copy-able URL */}
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
            <input
              readOnly
              value={baseUrl}
              className="flex-1 truncate bg-transparent font-mono text-slate-700 outline-none"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="rounded-md bg-rk-700 px-2 py-1 text-xs font-semibold text-white hover:bg-rk-800"
              onClick={() => copy(baseUrl)}
            >
              {copyState || 'Copy'}
            </button>
          </div>

          {/* Channel buttons */}
          <div className="flex flex-wrap gap-2">
            {channels.map((ch) => (
              <a
                key={ch.key}
                href={ch.href}
                target="_blank"
                rel="noreferrer"
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${ch.cls}`}
              >
                {ch.label}
              </a>
            ))}
            <button
              type="button"
              onClick={() => copy(`${shareText}\n${urlWith('instagram')}`)}
              className="rounded-md border border-pink-500 px-3 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-50"
              title="Instagram doesn't accept direct share links — copy this text then paste into your Story or bio"
            >
              Instagram (copy text)
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Instagram doesn&apos;t support direct share URLs. Tap the button above to copy a
            ready-to-paste message; add it to your Story link sticker or bio.
          </p>
        </div>

        {/* QR code for printable posters */}
        <div className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 bg-white p-3">
          <QRCodeSVG
            value={urlWith('qr')}
            size={144}
            level="M"
            includeMargin={false}
            bgColor="#ffffff"
            fgColor="#7c1d1b"
          />
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Scan to register</p>
          <button
            type="button"
            className="mt-1 text-xs font-medium text-rk-700 hover:underline"
            onClick={() => window.print()}
          >
            Print this page
          </button>
        </div>
      </div>
    </article>
  );
}

// ─── Channel mix ───────────────────────────────────────────────────────────
const CHANNEL_LABEL = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  twitter: 'X / Twitter',
  email: 'Email',
  qr: 'QR poster',
  direct: 'Direct link',
  web: 'Web',
};

function ChannelMix({ mix, total }) {
  if (!mix || mix.length === 0 || total === 0) return null;
  const max = Math.max(...mix.map((m) => m.count));
  return (
    <article className="rk-card space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Where RSVPs came from
      </h2>
      <ul className="space-y-1.5">
        {mix.map((m) => (
          <li key={m.channel} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-3 text-sm">
            <span className="text-slate-700">{CHANNEL_LABEL[m.channel] || m.channel}</span>
            <span className="h-2 rounded-full bg-slate-100">
              <span
                className="block h-full rounded-full bg-rk-700/80"
                style={{ width: `${Math.round((m.count / max) * 100)}%` }}
              />
            </span>
            <span className="text-right font-semibold text-slate-900">{m.count}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-400">
        Tracked from the ?via= parameter on your share links.
      </p>
    </article>
  );
}

function PageShell({ children }) {
  return (
    <div className="min-h-full bg-cream">
      <header className="border-b border-sand bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" aria-label="Raktify home" className="flex items-center">
            <Wordmark className="text-xl" />
          </Link>
          <span className="text-xs text-slate-500">Camp organizer</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">{children}</main>
    </div>
  );
}
