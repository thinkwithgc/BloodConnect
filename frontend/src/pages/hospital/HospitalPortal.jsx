import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { HospitalActiveRequests } from './HospitalActiveRequests.jsx';
import { HospitalAwaitingConfirmation } from './HospitalAwaitingConfirmation.jsx';
import { HospitalDashboard } from './HospitalDashboard.jsx';
import { HospitalRaiseRequest } from './HospitalRaiseRequest.jsx';
import { apiRequest } from '../../lib/api.js';
import { useT } from '../../i18n/useT.js';
import { TeamPanel } from '../../components/institution/TeamPanel.jsx';
import { InstitutionBanner } from '../../components/institution/InstitutionBanner.jsx';

export function HospitalPortal() {
  const { t } = useT();
  const [tab, setTab] = useState('dashboard');
  // Badge the "Confirm" tab so a hospital notices a citizen-raised request even
  // if they're on another tab (in-app notification, not a WhatsApp nudge).
  const awaitingQ = useQuery({
    queryKey: ['hospital', 'awaiting-confirmation'],
    queryFn: () => apiRequest('GET', '/requests/awaiting-confirmation'),
    refetchInterval: 30_000,
  });
  const awaitingCount = awaitingQ.data?.count || 0;
  const TABS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'mine', label: t('my_requests') },
    { id: 'confirm', label: 'Confirm', badge: awaitingCount },
    { id: 'raise', label: t('raise_new') },
    { id: 'team', label: 'Team' },
  ];

  // Hospital portal uses a slightly wider canvas than the original two-tab
  // layout so the district-availability grid + KPI row breathe on desktop.
  return (
    <div className="flex min-h-full flex-col">
      <Header subtitle="Hospital portal" />
      <main className="mx-auto w-full max-w-5xl px-4 py-6">
        <InstitutionBanner fallback="Hospital portal" />
        <nav className="mb-4 flex gap-2 border-b border-slate-200">
          {TABS.map((tt) => (
            <button
              key={tt.id}
              type="button"
              onClick={() => setTab(tt.id)}
              className={
                'border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
                (tab === tt.id
                  ? 'border-rk-700 text-rk-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800')
              }
            >
              {tt.label}
              {tt.badge ? (
                <span className="ml-1.5 rounded-full bg-rk-700 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {tt.badge}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        {tab === 'dashboard' ? <HospitalDashboard onRaise={() => setTab('raise')} /> : null}
        {tab === 'mine' ? <HospitalActiveRequests /> : null}
        {tab === 'confirm' ? <HospitalAwaitingConfirmation /> : null}
        {tab === 'raise' ? <HospitalRaiseRequest /> : null}
        {tab === 'team' ? <TeamPanel /> : null}
      </main>
      <Footer variant="compact" />
    </div>
  );
}
