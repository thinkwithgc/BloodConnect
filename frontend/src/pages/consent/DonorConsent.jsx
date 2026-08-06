import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { apiRequest } from '../../lib/api.js';

// Consent magic-link landing. Reachable via WhatsApp button URL after a
// blood-bank software vendor pushes the donor's data to Raktify. Public — no
// auth. Backend endpoint is /consent/:token/{info,accept,decline}.

function ErrorCard({ code }) {
  const map = {
    invalid: {
      title: 'This link is not valid',
      body: 'The activation link is incorrect or has expired. If you meant to accept sharing your details with Raktify, please contact the blood bank that registered you.',
    },
    expired: {
      title: 'This link has expired',
      body: 'For your safety, activation links expire after 30 days. Your details will be automatically removed from Raktify if we don\'t hear from you soon.',
    },
    used: {
      title: 'You\'ve already responded',
      body: 'Thanks — your decision has been recorded. You can go to the Raktify home page below.',
    },
    wrong_token_scope: {
      title: 'This link is for a different flow',
      body: 'This link is not a consent link. If you were expecting to set up an account, use the link from your welcome message.',
    },
    donor_not_found: {
      title: 'Your record was not found',
      body: 'We could not find your details. This can happen if you asked us to delete your data earlier. Contact the blood bank if this is a mistake.',
    },
  };
  const m = map[code] || {
    title: 'Something went wrong',
    body: 'Please try again in a moment. If the problem persists, contact contact@choudhari.ngo.',
  };
  return (
    <div className="rk-card space-y-3">
      <h1 className="text-xl font-semibold text-rk-700">{m.title}</h1>
      <p className="text-sm text-slate-700">{m.body}</p>
      <Link to="/" className="rk-button-secondary inline-block">
        Home
      </Link>
    </div>
  );
}

export function DonorConsent() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [decision, setDecision] = useState(null); // 'accepted' | 'declined' | null

  const q = useQuery({
    queryKey: ['consent', 'info', token],
    queryFn: () => apiRequest('GET', `/consent/${token}/info`),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => apiRequest('POST', `/consent/${token}/accept`),
    onSuccess: () => setDecision('accepted'),
  });

  const decline = useMutation({
    mutationFn: () => apiRequest('POST', `/consent/${token}/decline`),
    onSuccess: () => setDecision('declined'),
  });

  // Error state (invalid / expired / used / wrong scope / donor_not_found).
  if (q.error) {
    const code = q.error?.response?.data?.error;
    return (
      <div className="min-h-full">
        <Header subtitle="Consent" />
        <main className="mx-auto max-w-2xl px-4 py-10">
          <ErrorCard code={code} />
        </main>
        <Footer variant="compact" />
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div className="min-h-full">
        <Header subtitle="Consent" />
        <main className="mx-auto max-w-2xl px-4 py-10">
          <div className="rk-card text-center text-slate-500">Loading…</div>
        </main>
        <Footer variant="compact" />
      </div>
    );
  }

  const info = q.data;

  // Post-decision confirmation card.
  if (decision === 'accepted') {
    return (
      <div className="min-h-full">
        <Header subtitle="Consent · Accepted" />
        <main className="mx-auto max-w-2xl space-y-4 px-4 py-10">
          <div className="rk-card space-y-3">
            <h1 className="text-xl font-semibold text-rk-700">Thank you</h1>
            <p className="text-sm text-slate-700">
              Your consent is recorded. Raktify will only contact you for compatible blood
              requests in your district, and never share your details with hospitals directly
              — every request goes through the platform.
            </p>
            <p className="text-sm text-slate-700">
              You can withdraw consent or delete your data at any time from your donor
              dashboard, or by replying STOP to any WhatsApp we send.
            </p>
            <Link to="/login" className="rk-button-primary inline-block">
              Log in to your donor account
            </Link>
          </div>
        </main>
        <Footer variant="compact" />
      </div>
    );
  }

  if (decision === 'declined') {
    return (
      <div className="min-h-full">
        <Header subtitle="Consent · Declined" />
        <main className="mx-auto max-w-2xl space-y-4 px-4 py-10">
          <div className="rk-card space-y-3">
            <h1 className="text-xl font-semibold text-rk-700">Your details have been removed</h1>
            <p className="text-sm text-slate-700">
              Raktify no longer holds your identifying information. The blood bank that
              originally registered you may still have its own records under its own consent
              terms — contact them if you want those removed too.
            </p>
            <Link to="/" className="rk-button-secondary inline-block">
              Home
            </Link>
          </div>
        </main>
        <Footer variant="compact" />
      </div>
    );
  }

  // Main accept/decline screen.
  return (
    <div className="min-h-full">
      <Header subtitle="Consent" />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-10">
        <div className="rk-card space-y-3">
          <h1 className="text-2xl font-semibold text-slate-900">
            Do you want to share your details with Raktify?
          </h1>
          {info.source ? (
            <p className="text-sm text-slate-600">
              <strong>{info.source.display_name}</strong> has shared your donor registration with
              Raktify — a district-wide blood-response platform run by Choudhari Foundation.
              Please confirm you're happy for us to hold and use these details.
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              A blood bank has shared your donor registration with Raktify. Please confirm
              you're happy for us to hold and use these details.
            </p>
          )}

          <section className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              What Raktify has about you
            </h2>
            <dl className="grid grid-cols-3 gap-x-3 gap-y-1">
              <dt className="text-slate-500">Name</dt>
              <dd className="col-span-2 text-slate-900">{info.donor.full_name || '—'}</dd>
              <dt className="text-slate-500">Mobile</dt>
              <dd className="col-span-2 font-mono text-slate-900">
                {info.donor.masked_mobile || '—'}
              </dd>
              <dt className="text-slate-500">Date of birth</dt>
              <dd className="col-span-2 text-slate-900">{info.donor.date_of_birth || '—'}</dd>
              <dt className="text-slate-500">Blood group</dt>
              <dd className="col-span-2 text-slate-900">{info.donor.blood_group || '—'}</dd>
            </dl>
          </section>

          <section className="mt-4 rounded-md border border-slate-200 p-3 text-sm">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              What we'll do
            </h2>
            <ul className="list-inside list-disc space-y-1 text-slate-700">
              <li>
                Contact you on WhatsApp when a patient in your district needs your blood group.
              </li>
              <li>Never share your mobile or address with hospitals — every request is mediated.</li>
              <li>Encrypt your name, address, and identifiers at rest.</li>
              <li>
                Give you a dashboard where you can pause alerts, withdraw consent, or delete
                your data at any time.
              </li>
            </ul>
          </section>

          {accept.error ? (
            <p className="text-xs text-rk-700">
              Accept failed: {accept.error?.response?.data?.error || 'unknown'}
            </p>
          ) : null}
          {decline.error ? (
            <p className="text-xs text-rk-700">
              Decline failed: {decline.error?.response?.data?.error || 'unknown'}
            </p>
          ) : null}

          <div className="mt-6 grid gap-2 sm:grid-cols-3">
            <button
              type="button"
              className="rk-button-primary"
              disabled={accept.isPending || decline.isPending}
              onClick={() => accept.mutate()}
            >
              {accept.isPending ? '…' : 'Accept'}
            </button>
            <button
              type="button"
              className="rk-button-secondary"
              disabled={accept.isPending || decline.isPending}
              onClick={() => navigate('/')}
            >
              I need more time
            </button>
            <button
              type="button"
              className="rounded-md border border-rk-700 px-3 py-2 text-sm font-medium text-rk-700 hover:bg-rk-50 disabled:opacity-60"
              disabled={accept.isPending || decline.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'This will permanently delete your details from Raktify. Continue?',
                  )
                ) {
                  decline.mutate();
                }
              }}
            >
              {decline.isPending ? '…' : 'Decline & delete'}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            "I need more time" leaves your details on hold. We'll automatically delete them
            after 14 days if you don't respond.
          </p>
        </div>
      </main>
      <Footer variant="compact" />
    </div>
  );
}
