import { Navigate, Route, Routes } from 'react-router-dom';
import { useStore } from './lib/store';
import { Layout, Toasts } from './components/Layout';
import { Loading } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Users } from './pages/Users';
import { Transactions } from './pages/Transactions';
import { Approvals, Kyc } from './pages/Approvals';
import { Verification } from './pages/Verification';
import { Controls } from './pages/Controls';
import { Comms } from './pages/Comms';
import { Supervision } from './pages/Supervision';
import { Analytics } from './pages/Analytics';
import { Corridors } from './pages/Corridors';
import { Emoney } from './pages/Emoney';
import { Seo } from './pages/Seo';
import { Agents } from './pages/Agents';
import { Channels } from './pages/Channels';
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
import { MobileMoney } from './pages/MobileMoney';
import { SwitchConsole } from './pages/Switch';
import { Finops } from './pages/Finops';
import { Risk } from './pages/Risk';
import { Intelligence } from './pages/Intelligence';
import { System } from './pages/System';

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
        <Route
          path="/"
          element={
            <P>
              <Dashboard />
            </P>
          }
        />
        <Route
          path="/users"
          element={
            <P>
              <Users />
            </P>
          }
        />
        <Route
          path="/users/:id"
          element={
            <P>
              <Users />
            </P>
          }
        />
        <Route
          path="/transactions"
          element={
            <P>
              <Transactions />
            </P>
          }
        />
        <Route
          path="/approvals"
          element={
            <P>
              <Approvals />
            </P>
          }
        />
        <Route
          path="/verification"
          element={
            <P>
              <Verification />
            </P>
          }
        />
        <Route
          path="/controls"
          element={
            <P>
              <Controls />
            </P>
          }
        />
        <Route
          path="/corridors"
          element={
            <P>
              <Corridors />
            </P>
          }
        />
        <Route
          path="/emoney"
          element={
            <P>
              <Emoney />
            </P>
          }
        />
        <Route
          path="/seo"
          element={
            <P>
              <Seo />
            </P>
          }
        />
        <Route
          path="/agents"
          element={
            <P>
              <Agents />
            </P>
          }
        />
        <Route
          path="/channels"
          element={
            <P>
              <Channels />
            </P>
          }
        />
        <Route
          path="/kyc"
          element={
            <P>
              <Kyc />
            </P>
          }
        />
        <Route
          path="/currencies"
          element={
            <P>
              <Currencies />
            </P>
          }
        />
        <Route
          path="/fees"
          element={
            <P>
              <Fees />
            </P>
          }
        />
        <Route
          path="/gateways"
          element={
            <P>
              <Gateways />
            </P>
          }
        />
        <Route
          path="/mobile-money"
          element={
            <P>
              <MobileMoney />
            </P>
          }
        />
        <Route
          path="/modules"
          element={
            <P>
              <Modules />
            </P>
          }
        />
        <Route
          path="/catalogs"
          element={
            <P>
              <Catalogs />
            </P>
          }
        />
        <Route
          path="/site"
          element={
            <P>
              <Site />
            </P>
          }
        />
        <Route
          path="/pages"
          element={
            <P>
              <Pages />
            </P>
          }
        />
        <Route
          path="/languages"
          element={
            <P>
              <Languages />
            </P>
          }
        />
        <Route
          path="/messaging"
          element={
            <P>
              <Messaging />
            </P>
          }
        />
        <Route
          path="/comms"
          element={
            <P>
              <Comms />
            </P>
          }
        />
        <Route
          path="/supervision"
          element={
            <P>
              <Supervision />
            </P>
          }
        />
        <Route
          path="/analytics"
          element={
            <P>
              <Analytics />
            </P>
          }
        />
        <Route
          path="/support"
          element={
            <P>
              <Support />
            </P>
          }
        />
        <Route
          path="/chat"
          element={
            <P>
              <Chat />
            </P>
          }
        />
        <Route
          path="/inbox"
          element={
            <P>
              <Inbox />
            </P>
          }
        />
        <Route
          path="/p2p"
          element={
            <P>
              <P2P />
            </P>
          }
        />
        <Route
          path="/reports"
          element={
            <P>
              <Reports />
            </P>
          }
        />
        <Route
          path="/audit"
          element={
            <P>
              <Audit />
            </P>
          }
        />
        <Route
          path="/switch"
          element={
            <P>
              <SwitchConsole />
            </P>
          }
        />
        <Route
          path="/finops"
          element={
            <P>
              <Finops />
            </P>
          }
        />
        <Route
          path="/risk"
          element={
            <P>
              <Risk />
            </P>
          }
        />
        <Route
          path="/intelligence"
          element={
            <P>
              <Intelligence />
            </P>
          }
        />
        <Route
          path="/system"
          element={
            <P>
              <System />
            </P>
          }
        />
        <Route
          path="/profile"
          element={
            <P>
              <Profile />
            </P>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
