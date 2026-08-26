import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { CoordinatorDashboard } from './CoordinatorDashboard.jsx';
import { CoordinatorQueue } from './CoordinatorQueue.jsx';
import { CreateCampForm } from '../admin/CampsTab.jsx';
import { MyCampsSection } from '../camps/MyCampsSection.jsx';

export function CoordinatorPortal() {
  const { role } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();
  const TABS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'queue', label: 'Queue' },
    // A coordinator could create camps but had nowhere to see them: the
    // only list was the NGO admin's Camps tab, which a coordinator cannot
    // open. Same component the donor profile uses, keyed on the person.
    { id: 'camps', label: 'Camps' },
  ];

  return (
    <div className="flex min-h-full flex-col">
      <Header subtitle={role === 'coordinator' ? 'Coordinator portal' : role} />
      <main className="mx-auto w-full max-w-5xl px-4 py-6">
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
            </button>
          ))}
        </nav>

        {tab === 'dashboard' ? (
          <CoordinatorDashboard onOpenQueue={() => setTab('queue')} />
        ) : null}
        {tab === 'queue' ? <CoordinatorQueue /> : null}
        {tab === 'camps' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-600">
                Camps you created, plus any you applied to host on this mobile number.
              </p>
              <button
                type="button"
                className="rk-button-secondary text-xs"
                onClick={() => setShowCreate((v) => !v)}
              >
                {showCreate ? 'Close' : '+ Schedule a camp'}
              </button>
            </div>

            {showCreate ? (
              <CreateCampForm
                onCreated={() => {
                  setShowCreate(false);
                  qc.invalidateQueries({ queryKey: ['camps', 'mine'] });
                }}
              />
            ) : null}

            <MyCampsSection
              showWhenEmpty
              heading="My camps"
              emptyHint="No camps yet. Schedule one above, or verify a public application from the NGO admin queue."
            />
          </div>
        ) : null}
      </main>
      <Footer variant="compact" />
    </div>
  );
}
