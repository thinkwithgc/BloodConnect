import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { RoleSwitcher } from '../../components/RoleSwitcher.jsx';
import { apiRequest } from '../../lib/api.js';
import { CommunityLeaderHelpDrawer } from '../help/CommunityLeaderHelpDrawer.jsx';
import { LeaderMobilise } from './LeaderMobilise.jsx';
import { MyCampsSection } from '../camps/MyCampsSection.jsx';

/**
 * Community-leader dashboard (Phase 1 — placeholder).
 *
 * Phase 1 shows just the leader's profile + impact counters (all zero
 * initially). Phase 2 adds the communities list + creation flow. Phase 3
 * adds the donor roster + referral toolkit + camp wiring.
 *
 * Philosophy reminder (per planning conversation):
 *   • Raktify is the OPERATIONS layer, not the COMMUNICATION layer.
 *   • The leader's WhatsApp group stays the leader's WhatsApp group.
 *   • This dashboard surfaces stats + shareable assets — the leader
 *     posts them in their group on their own terms.
 *   • Donor mobiles are NEVER shown here; the leader already has them
 *     via their existing WhatsApp group.
 */
export function CommunityLeaderDashboard() {
  const meQ = useQuery({
    queryKey: ['community-leader', 'me'],
    queryFn: () => apiRequest('GET', '/community-leader/me'),
    staleTime: 60_000,
  });
  const commQ = useQuery({
    queryKey: ['community-leader', 'communities'],
    queryFn: () => apiRequest('GET', '/community-leader/communities'),
    staleTime: 30_000,
    enabled: !!meQ.data?.profile,
  });

  const profile = meQ.data?.profile;
  const communities = commQ.data?.communities || [];
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col bg-cream font-sans">
      <Header subtitle="Community leader" />
      <main className="mx-auto w-full max-w-3xl px-4 py-6 space-y-5">
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-50"
            aria-label="Open help"
          >
            <span aria-hidden="true">?</span>
            <span>Help</span>
          </button>
        </div>
        <CommunityLeaderHelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
        <RoleSwitcher from="community leader" />
        {meQ.isLoading ? (
          <p className="text-slate-500">Loading…</p>
        ) : meQ.error ? (
          <div className="rk-card text-rk-700">
            {meQ.error?.response?.data?.error || 'profile_load_failed'}
          </div>
        ) : profile ? (
          <>
            <section className="rk-card">
              <h1 className="text-xl font-semibold text-stone-900">
                Welcome, {profile.display_name}
              </h1>
              <p className="mt-1 text-sm text-stone-600">
                Open a community below to see your donor roster, grab the referral link + QR,
                and host camps. Impact stats at the top update as donors join and donate.
              </p>
              {profile.suspended_at ? (
                <div className="mt-3 rounded border border-rk-200 bg-rk-50 p-3 text-sm text-rk-900">
                  <strong>Your account is suspended.</strong>{' '}
                  {profile.suspension_reason
                    ? `Reason: ${profile.suspension_reason}.`
                    : null}{' '}
                  Please contact the NGO administrator.
                </div>
              ) : null}
            </section>

            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Communities" value={profile.communities_count} />
              <StatCard label="Donors in network" value={profile.total_donor_count} />
              <StatCard label="Donations facilitated" value={profile.donations_facilitated} />
              <StatCard label="Camps hosted" value={profile.camps_hosted} />
            </section>

            {profile.suspended_at ? null : <LeaderMobilise communities={communities} />}

            <section className="rk-card">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                Your details
              </h2>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <ProfileRow label="Mobile" value={profile.mobile} mono />
                {profile.email ? <ProfileRow label="Email" value={profile.email} /> : null}
                <ProfileRow
                  label="Region"
                  value={
                    [profile.district_name, profile.state_name].filter(Boolean).join(', ') || '—'
                  }
                />
                <ProfileRow
                  label="Preferred language"
                  value={
                    profile.preferred_language === 'mr'
                      ? 'मराठी'
                      : profile.preferred_language === 'hi'
                        ? 'हिंदी'
                        : 'English'
                  }
                />
                <ProfileRow
                  label="Joined"
                  value={profile.joined_at ? new Date(profile.joined_at).toLocaleDateString() : '—'}
                />
                {profile.invitation_notes ? (
                  <ProfileRow label="Notes" value={profile.invitation_notes} colSpan />
                ) : null}
              </dl>
            </section>

            <section className="rk-card">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                  Your communities
                </h2>
                <Link
                  to="/community-leader/communities/new"
                  className="rk-button-primary text-xs"
                >
                  + Create community
                </Link>
              </div>

              {commQ.isLoading ? (
                <p className="mt-3 text-sm text-stone-500">Loading…</p>
              ) : communities.length === 0 ? (
                <p className="mt-3 text-sm text-stone-500">
                  No communities yet. Create one — every community needs a co-leader so the
                  handover path stays open if you ever step away.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {communities.map((co) => (
                    <li key={co.id} className="py-2">
                      <Link
                        to={`/community-leader/communities/${co.id}`}
                        className="flex items-center justify-between gap-3 rounded p-2 hover:bg-slate-50"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-stone-900">
                            {co.name}
                            {co.is_owner ? null : (
                              <span className="ml-2 rounded-full bg-sand px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-600">
                                Co-leader
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-stone-500">
                            {[co.taluka_name, co.district_name, co.state_name]
                              .filter(Boolean)
                              .join(' · ')}{' '}
                            · {co.donor_count} donors
                          </div>
                        </div>
                        <span className="text-xs text-stone-400">›</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Every camp this leader hosts, in one list. Their communities
                each show their own camps above; this is the cross-community
                view, and it also picks up camps they applied for publicly
                before they ever had a leader login. Mounted here rather than
                linked to /donor because a community_leader JWT cannot pass
                that route's guard. */}
            <MyCampsSection />

            <section className="rk-card bg-sand/40">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
                How Raktify works with you
              </h2>
              <p className="mt-2 text-sm text-stone-700">
                Raktify is your <strong>operations layer</strong>. Your WhatsApp group stays your
                communication channel — we don&apos;t message your community members on your behalf,
                and we don&apos;t show you their mobile numbers (you already have them in WhatsApp
                anyway). Open a community to see roster, share the referral link/QR, and host camps.
              </p>
            </section>
          </>
        ) : null}
      </main>
      <Footer variant="compact" />
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rk-card">
      <div className="text-2xl font-semibold text-stone-900">{value ?? 0}</div>
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
    </div>
  );
}

function ProfileRow({ label, value, mono, colSpan }) {
  return (
    <div className={colSpan ? 'sm:col-span-2' : ''}>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className={`text-stone-800 ${mono ? 'font-mono text-sm' : ''}`}>{value || '—'}</dd>
    </div>
  );
}
