import { Navigate, Route, Routes } from 'react-router-dom';
import { useStore } from './lib/store';
import { Layout, Toasts } from './components/Layout';
import { Loading } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Users } from './pages/Users';
import { Transactions } from './pages/Transactions';
import { Approvals, Kyc } from './pages/Approvals';
import { Currencies } from './pages/Currencies';
import { Fees } from './pages/Fees';
import { Gateways } from './pages/Gateways';
import { Modules } from './pages/Modules';
import { Catalogs } from './pages/Catalogs';
import { Site } from './pages/Site';
import { Pages } from './pages/Pages';
import { Languages } from './pages/Languages';
import { Messaging } from './pages/Messaging';
import { Support, Chat, Inbox } from './pages/Support';
import { P2P } from './pages/P2P';
import { Reports } from './pages/Reports';
import { Audit } from './pages/Audit';
import { Profile } from './pages/Profile';

function P({ children }: { children: React.ReactElement }) {
  const { user, loading } = useStore();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<P><Dashboard /></P>} />
        <Route path="/users" element={<P><Users /></P>} />
        <Route path="/users/:id" element={<P><Users /></P>} />
        <Route path="/transactions" element={<P><Transactions /></P>} />
        <Route path="/approvals" element={<P><Approvals /></P>} />
        <Route path="/kyc" element={<P><Kyc /></P>} />
        <Route path="/currencies" element={<P><Currencies /></P>} />
        <Route path="/fees" element={<P><Fees /></P>} />
        <Route path="/gateways" element={<P><Gateways /></P>} />
        <Route path="/modules" element={<P><Modules /></P>} />
        <Route path="/catalogs" element={<P><Catalogs /></P>} />
        <Route path="/site" element={<P><Site /></P>} />
        <Route path="/pages" element={<P><Pages /></P>} />
        <Route path="/languages" element={<P><Languages /></P>} />
        <Route path="/messaging" element={<P><Messaging /></P>} />
        <Route path="/support" element={<P><Support /></P>} />
        <Route path="/chat" element={<P><Chat /></P>} />
        <Route path="/inbox" element={<P><Inbox /></P>} />
        <Route path="/p2p" element={<P><P2P /></P>} />
        <Route path="/reports" element={<P><Reports /></P>} />
        <Route path="/audit" element={<P><Audit /></P>} />
        <Route path="/profile" element={<P><Profile /></P>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
