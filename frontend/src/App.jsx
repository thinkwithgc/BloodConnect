import { Routes, Route, Navigate } from 'react-router-dom';

import { Landing } from './pages/Landing.jsx';
import { DonorLogin } from './pages/donor/DonorLogin.jsx';
import { DonorRegister } from './pages/donor/DonorRegister.jsx';
import { DonorDashboard } from './pages/donor/DonorDashboard.jsx';
// PILOT SCOPE (Aug 2026): citizen blood-request raising is switched off for the
// PDMC pilot, which runs the donor + camp modules first. Import and route are
// commented rather than deleted — DonorRaiseRequest.jsx and POST
// /requests/citizen are both intact and tested, so re-enabling is uncommenting
// these two blocks plus the CTA in DonorDashboard.jsx. See CLAUDE.md
// "Pilot scope".
// import { DonorRaiseRequest } from './pages/donor/DonorRaiseRequest.jsx';
import { StaffLogin } from './pages/staff/StaffLogin.jsx';
import { StaffSetup2FA } from './pages/staff/StaffSetup2FA.jsx';
import { CoordinatorPortal } from './pages/coordinator/CoordinatorPortal.jsx';
import { RequestDetail } from './pages/coordinator/RequestDetail.jsx';
import { HospitalPortal } from './pages/hospital/HospitalPortal.jsx';
import { BloodBankPortal } from './pages/bloodbank/BloodBankPortal.jsx';
import { AdminDashboard } from './pages/admin/AdminDashboard.jsx';
import { OnboardingDetail } from './pages/admin/OnboardingDetail.jsx';
import { InstitutionDetail } from './pages/admin/InstitutionDetail.jsx';
import { ReportsViewer } from './pages/admin/ReportsViewer.jsx';
import { InstitutionApply } from './pages/onboarding/InstitutionApply.jsx';
import { SetupPassword } from './pages/onboarding/SetupPassword.jsx';
import { DonorConsent } from './pages/consent/DonorConsent.jsx';
import { HostCamp } from './pages/camps/HostCamp.jsx';
import { CampOrganizerDashboard } from './pages/camps/CampOrganizerDashboard.jsx';
import { PublicCampPage } from './pages/camps/PublicCampPage.jsx';
// /privacy, /terms, /data-deletion are static HTML in frontend/public/ (served
// by staticwebapp.config.json rewrites) — better SEO/crawlability + one source
// of truth. They are intentionally NOT React routes.
import { DhoDashboard } from './pages/dho/DhoDashboard.jsx';
import { CommunityLeaderDashboard } from './pages/communityLeader/CommunityLeaderDashboard.jsx';
import { CommunityCreate } from './pages/communityLeader/CommunityCreate.jsx';
import { CommunityDetail } from './pages/communityLeader/CommunityDetail.jsx';
import { PublicCommunity } from './pages/community/PublicCommunity.jsx';
import { DonorAlertResponse } from './pages/donor/DonorAlertResponse.jsx';
import { CommunityLeaderHelpPage } from './pages/help/CommunityLeaderHelpPage.jsx';
import { CaseDetailPage } from './components/CaseDetailPage.jsx';
import { RequireAuth } from './auth/RequireAuth.jsx';
import { useAuth } from './auth/AuthContext.jsx';

function HomeRedirect() {
  const { isAuthenticated, role } = useAuth();
  if (!isAuthenticated) return <Landing />;
  if (role === 'donor') return <Navigate to="/donor" replace />;
  if (role === 'coordinator') return <Navigate to="/coordinator" replace />;
  if (role === 'hospital') return <Navigate to="/hospital" replace />;
  if (role === 'blood_bank') return <Navigate to="/bb" replace />;
  if (role === 'ngo_admin' || role === 'super_admin') return <Navigate to="/admin" replace />;
  if (role === 'dho') return <Navigate to="/dho" replace />;
  if (role === 'community_leader') return <Navigate to="/community-leader" replace />;
  // ngo_admin / blood_bank / super_admin still need their own dashboards;
  // Phase 7 starter sends them through the staff landing.
  return <Landing />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<DonorLogin />} />
      <Route path="/register" element={<DonorRegister />} />
      <Route path="/staff/login" element={<StaffLogin />} />
      <Route path="/staff/setup-2fa" element={<StaffSetup2FA />} />
      <Route path="/onboarding/apply" element={<InstitutionApply />} />
      <Route path="/setup/:token" element={<SetupPassword />} />
      {/* /activate/:token — Meta-approved WhatsApp button URL points here.
          Renders the same SetupPassword component. /setup/:token kept for
          backwards compatibility with any in-flight tokens issued before
          the URL switch. */}
      <Route path="/activate/:token" element={<SetupPassword />} />
      <Route path="/consent/:token" element={<DonorConsent />} />
      <Route path="/camps/host" element={<HostCamp />} />
      <Route path="/camp/:token" element={<CampOrganizerDashboard />} />
      <Route path="/c/:slug" element={<PublicCampPage />} />
      <Route path="/community/:slug" element={<PublicCommunity />} />
      <Route path="/alert/:token" element={<DonorAlertResponse />} />
      <Route path="/help/community-leader" element={<CommunityLeaderHelpPage />} />

      <Route
        path="/donor"
        element={
          <RequireAuth roles={['donor']}>
            <DonorDashboard />
          </RequireAuth>
        }
      />
      {/* PILOT SCOPE (Aug 2026) — off for the PDMC donor+camp pilot. Restore by
          uncommenting this and the import at the top of this file. A donor who
          deep-links to /donor/raise while this is off falls through to the
          catch-all redirect rather than a blank screen. */}
      {/*
      <Route
        path="/donor/raise"
        element={
          <RequireAuth roles={['donor']}>
            <DonorRaiseRequest />
          </RequireAuth>
        }
      />
      */}
      <Route
        path="/coordinator"
        element={
          <RequireAuth roles={['coordinator', 'ngo_admin', 'super_admin']}>
            <CoordinatorPortal />
          </RequireAuth>
        }
      />
      <Route
        path="/coordinator/requests/:id"
        element={
          <RequireAuth roles={['coordinator', 'ngo_admin', 'super_admin']}>
            <RequestDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/hospital"
        element={
          <RequireAuth roles={['hospital']}>
            <HospitalPortal />
          </RequireAuth>
        }
      />
      <Route
        path="/hospital/requests/:id"
        element={
          <RequireAuth roles={['hospital']}>
            <CaseDetailPage backTo="/hospital" backLabel="Back to my requests" subtitle="Request" />
          </RequireAuth>
        }
      />
      <Route
        path="/bb"
        element={
          <RequireAuth roles={['blood_bank', 'ngo_admin', 'super_admin']}>
            <BloodBankPortal />
          </RequireAuth>
        }
      />
      <Route
        path="/bb/requests/:id"
        element={
          <RequireAuth roles={['blood_bank', 'ngo_admin', 'super_admin']}>
            <CaseDetailPage backTo="/bb" backLabel="Back to blood bank" subtitle="Request" />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth roles={['ngo_admin', 'super_admin']}>
            <AdminDashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/admin/reports"
        element={
          <RequireAuth roles={['ngo_admin', 'super_admin', 'coordinator', 'blood_bank', 'dho']}>
            <ReportsViewer />
          </RequireAuth>
        }
      />
      <Route
        path="/admin/onboarding/:id"
        element={
          <RequireAuth roles={['ngo_admin', 'super_admin']}>
            <OnboardingDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/admin/institutions/:id"
        element={
          <RequireAuth roles={['ngo_admin', 'super_admin']}>
            <InstitutionDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/dho"
        element={
          <RequireAuth roles={['dho', 'ngo_admin', 'super_admin']}>
            <DhoDashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/community-leader"
        element={
          <RequireAuth roles={['community_leader']}>
            <CommunityLeaderDashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/community-leader/requests/:id"
        element={
          <RequireAuth roles={['community_leader']}>
            <CaseDetailPage
              backTo="/community-leader"
              backLabel="Back to my communities"
              subtitle="Request"
            />
          </RequireAuth>
        }
      />
      <Route
        path="/community-leader/communities/new"
        element={
          <RequireAuth roles={['community_leader']}>
            <CommunityCreate />
          </RequireAuth>
        }
      />
      <Route
        path="/community-leader/communities/:id"
        element={
          <RequireAuth roles={['community_leader']}>
            <CommunityDetail />
          </RequireAuth>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
