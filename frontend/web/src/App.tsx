import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useStore } from './lib/store';
import { Layout, Toasts } from './components/Layout';
import { Loading } from './components/ui';
import { Landing } from './pages/Landing';
import { Login, Register, Forgot } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { Send } from './pages/Send';
import { Scan, QrLanding } from './pages/Scan';
import { Receive } from './pages/Receive';
import { Requests } from './pages/Requests';
import { AddMoney } from './pages/AddMoney';
import { Withdraw } from './pages/Withdraw';
import { Agents } from './pages/Agents';
import { Remittance } from './pages/Remittance';
import { Exchange } from './pages/Exchange';
import { VirtualCards } from './pages/VirtualCards';
import { Bills, Topup, GiftCards } from './pages/Services';
import { P2P } from './pages/P2P';
import { Transactions, TransactionDetail } from './pages/Transactions';
import { Statements } from './pages/Statements';
import { Assist } from './pages/Assist';
import { ConfirmCurrency } from './pages/ConfirmCurrency';
import { Referrals } from './pages/Referrals';
import { Support } from './pages/Support';
import { Settings } from './pages/Settings';
import { MerchantDashboard, MerchantPos, MerchantGateway } from './pages/Merchant';
import { AgentDashboard } from './pages/Agent';
import { Checkout } from './pages/Checkout';
import { StaticPage, Contact } from './pages/Static';
import { MoveMoney } from './pages/MoveMoney';
import { MerchantCentre } from './pages/MerchantCentre';
import { QrCentre } from './pages/QrCentre';
import { Developer } from './pages/Developer';
import { Savings } from './pages/Savings';
import { FxTools } from './pages/FxTools';
import { Credit } from './pages/Credit';
import { Subscriptions } from './pages/Subscriptions';
import { Banks } from './pages/Banks';

function Protected({ children }: { children: React.ReactElement }) {
  const { user, loading } = useStore();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Layout>{children}</Layout>;
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/pay/:code" element={<Checkout />} />
        <Route path="/checkout/:code" element={<Checkout />} />
        <Route path="/q" element={<QrLanding />} />
        <Route path="/q/:code" element={<QrLanding />} />
        <Route path="/u/:tag" element={<QrLanding />} />
        <Route path="/pages/:slug" element={<StaticPage />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/confirm-currency/:token" element={<ConfirmCurrency />} />
        <Route
          path="/app"
          element={
            <Protected>
              <Dashboard />
            </Protected>
          }
        />
        <Route
          path="/app/assist"
          element={
            <Protected>
              <Assist />
            </Protected>
          }
        />
        <Route
          path="/app/send"
          element={
            <Protected>
              <Send />
            </Protected>
          }
        />
        <Route
          path="/app/move"
          element={
            <Protected>
              <MoveMoney />
            </Protected>
          }
        />
        <Route
          path="/app/scan"
          element={
            <Protected>
              <Scan />
            </Protected>
          }
        />
        <Route
          path="/app/receive"
          element={
            <Protected>
              <Receive />
            </Protected>
          }
        />
        <Route
          path="/app/requests"
          element={
            <Protected>
              <Requests />
            </Protected>
          }
        />
        <Route
          path="/app/add-money"
          element={
            <Protected>
              <AddMoney />
            </Protected>
          }
        />
        <Route
          path="/app/withdraw"
          element={
            <Protected>
              <Withdraw />
            </Protected>
          }
        />
        <Route
          path="/app/agents"
          element={
            <Protected>
              <Agents />
            </Protected>
          }
        />
        <Route
          path="/app/remittance"
          element={
            <Protected>
              <Remittance />
            </Protected>
          }
        />
        <Route
          path="/app/exchange"
          element={
            <Protected>
              <Exchange />
            </Protected>
          }
        />
        <Route
          path="/app/savings"
          element={
            <Protected>
              <Savings />
            </Protected>
          }
        />
        <Route
          path="/app/fx"
          element={
            <Protected>
              <FxTools />
            </Protected>
          }
        />
        <Route
          path="/app/credit"
          element={
            <Protected>
              <Credit />
            </Protected>
          }
        />
        <Route
          path="/app/subscriptions"
          element={
            <Protected>
              <Subscriptions />
            </Protected>
          }
        />
        <Route
          path="/app/banks"
          element={
            <Protected>
              <Banks />
            </Protected>
          }
        />
        <Route
          path="/app/cards"
          element={
            <Protected>
              <VirtualCards />
            </Protected>
          }
        />
        <Route
          path="/app/bills"
          element={
            <Protected>
              <Bills />
            </Protected>
          }
        />
        <Route
          path="/app/topup"
          element={
            <Protected>
              <Topup />
            </Protected>
          }
        />
        <Route
          path="/app/gift-cards"
          element={
            <Protected>
              <GiftCards />
            </Protected>
          }
        />
        <Route
          path="/app/p2p/*"
          element={
            <Protected>
              <P2P />
            </Protected>
          }
        />
        <Route
          path="/app/transactions"
          element={
            <Protected>
              <Transactions />
            </Protected>
          }
        />
        <Route
          path="/app/transactions/:id"
          element={
            <Protected>
              <TransactionDetail />
            </Protected>
          }
        />
        <Route
          path="/app/statements"
          element={
            <Protected>
              <Statements />
            </Protected>
          }
        />
        <Route
          path="/app/referrals"
          element={
            <Protected>
              <Referrals />
            </Protected>
          }
        />
        <Route
          path="/app/support"
          element={
            <Protected>
              <Support />
            </Protected>
          }
        />
        <Route
          path="/app/settings"
          element={
            <Protected>
              <Settings />
            </Protected>
          }
        />
        <Route
          path="/app/merchant"
          element={
            <Protected>
              <MerchantDashboard />
            </Protected>
          }
        />
        <Route
          path="/app/merchant/pos"
          element={
            <Protected>
              <MerchantPos />
            </Protected>
          }
        />
        <Route
          path="/app/merchant/gateway"
          element={
            <Protected>
              <MerchantGateway />
            </Protected>
          }
        />
        <Route
          path="/app/merchant/centre"
          element={
            <Protected>
              <MerchantCentre />
            </Protected>
          }
        />
        <Route
          path="/app/merchant/qr"
          element={
            <Protected>
              <QrCentre />
            </Protected>
          }
        />
        <Route
          path="/app/merchant/developer"
          element={
            <Protected>
              <Developer />
            </Protected>
          }
        />
        <Route
          path="/app/agent"
          element={
            <Protected>
              <AgentDashboard />
            </Protected>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
