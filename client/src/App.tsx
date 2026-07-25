import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import { PageStub } from './components/ui';
import { permissionForPath } from './navConfig';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import PPPoE from './pages/PPPoE';
import IPoE from './pages/IPoE';
import ClientsMap from './pages/ClientsMap';
import SalesReport from './pages/SalesReport';
import Inventory from './pages/Inventory';
import Hotspot from './pages/Hotspot';
import Logs from './pages/Logs';
import Company from './pages/Company';
import Uptime from './pages/Uptime';
import StatusHub from './pages/StatusHub';
import OutageMonitor from './pages/OutageMonitor';
import Notifications from './pages/Notifications';
import SystemSettings from './pages/SystemSettings';
import CloudflareAccess from './pages/CloudflareAccess';
import Network from './pages/Network';
import ZeroTier from './pages/ZeroTier';
import MikrotikFiles from './pages/MikrotikFiles';
import Updater from './pages/Updater';
import PanelRoles from './pages/PanelRoles';
import License from './pages/License';
import AiScripting from './pages/AiScripting';
import TerminalPage from './pages/Terminal';
import SubscriberPay from './pages/SubscriberPay';
import PayPortal from './pages/PayPortal';
import UsageStats from './pages/UsageStats';
import FairUseAlerts from './pages/FairUseAlerts';
import { Loader2 } from 'lucide-react';
import Logo from './components/Logo';
import { useEffect } from 'react';
import { PRODUCT_TITLE } from './branding';

function DocumentTitle() {
  useEffect(() => {
    document.title = PRODUCT_TITLE;
  }, []);
  return null;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading)
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 bg-mesh-dark gap-6">
        <Logo size="lg" variant="dark" className="animate-pulse-soft" />
        <div className="flex items-center gap-3 text-slate-400">
          <Loader2 className="animate-spin text-brand-400" size={20} />
          <span className="text-sm font-medium">Loading panel…</span>
        </div>
      </div>
    );
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  return <>{children}</>;
}

function RequireAccess({ children }: { children: React.ReactNode }) {
  const { canAccess } = useAuth();
  const loc = useLocation();
  const perm = permissionForPath(loc.pathname);
  if (!canAccess(perm)) {
    if (canAccess('dashboard') && loc.pathname !== '/') return <Navigate to="/" replace />;
    if (canAccess('license') && loc.pathname !== '/license') return <Navigate to="/license" replace />;
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

const stub = (title: string, description: string) => (
  <Layout title={title}>
    <PageStub title={title} description={description} />
  </Layout>
);

export default function App() {
  const { user } = useAuth();
  return (
    <>
      <DocumentTitle />
      <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/pay/:token" element={<SubscriberPay />} />
      <Route
        path="/*"
        element={
          <Protected>
            <RequireAccess>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/pppoe" element={<PPPoE service="pppoe" title="PPPoE Management" />} />
                <Route path="/ipoe" element={<IPoE />} />
                <Route path="/map" element={<ClientsMap />} />
                <Route path="/sales" element={<SalesReport />} />
                <Route path="/pay-portal" element={<PayPortal />} />
                <Route path="/usage" element={<UsageStats />} />
                <Route path="/fair-use" element={<FairUseAlerts />} />
                <Route path="/routers" element={<Navigate to="/network?tab=routers" replace />} />
                <Route path="/inventory" element={<Inventory />} />
                <Route path="/hotspot" element={<Hotspot />} />
                <Route path="/uptime" element={<Uptime />} />
                <Route path="/status-hub" element={<StatusHub />} />
                <Route path="/outage-monitor" element={<OutageMonitor />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/company" element={<Company />} />
                <Route path="/ai-scripting" element={<AiScripting />} />
                <Route path="/terminal" element={<TerminalPage />} />
                <Route path="/network" element={<Network />} />
                <Route path="/files" element={<MikrotikFiles />} />
                <Route path="/zerotier" element={<ZeroTier />} />
                <Route path="/settings" element={<SystemSettings />} />
                <Route path="/cloudflare" element={<CloudflareAccess />} />
                <Route path="/roles" element={<PanelRoles />} />
                <Route path="/updater" element={<Updater />} />
                <Route path="/super-router" element={stub('Super Router', 'Central controller for managing multiple MikroTik routers.')} />
                <Route path="/license" element={<License />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </RequireAccess>
          </Protected>
        }
      />
    </Routes>
    </>
  );
}
