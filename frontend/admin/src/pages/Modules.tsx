import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Field, PageHeader, Select, Switch, useAsync, Input } from '../components/ui';

const LABELS: Record<string, string> = {
  transfers: 'Send money (P2P transfers)',
  qrPayments: 'QR code payments',
  paymentLinks: 'Payment link generation',
  moneyRequests: 'Money requests',
  addMoney: 'Add money (deposit methods)',
  withdrawals: 'Withdraw money (bank)',
  agents: 'Agents: cash-in / cash-out / cash pickup',
  remittance: 'Remittance (wallet, bank transfer, cash pickup)',
  exchange: 'Currency exchange',
  virtualCards: 'Virtual card API',
  giftCards: 'Gift card API',
  billPay: 'Bill pay method',
  mobileTopup: 'Mobile top-up method',
  referrals: 'Referral system',
  p2p: 'P2P trading & chat',
  support: 'Support tickets',
  liveChat: 'Live chat',
  merchantGateway: 'Merchant payment gateway & API',
  kyc: 'KYC verification',
};

export function Modules() {
  const { toast, refresh, config } = useStore();
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const [modules, setModules] = useState<any>(null);
  const [countries, setCountries] = useState<any>(null);
  useEffect(() => {
    if (settings.data) {
      setModules(settings.data.modules);
      setCountries(settings.data.countries);
    }
  }, [settings.data]);
  if (!modules || !countries) return null;
  const save = async () => {
    await api.put('/api/admin/settings/modules', { value: modules });
    await api.put('/api/admin/settings/countries', { value: countries });
    toast('Saved', 'success');
    refresh();
  };
  return (
    <div>
      <PageHeader title="Modules, methods & country restrictions" subtitle="Enable or disable platform features and restrict access by country" actions={<Button onClick={save}>Save</Button>} />
      <div className="grid cols-2">
        <div className="card">
          <h4>Modules setup</h4>
          <div className="col">
            {Object.keys(LABELS).map((k) => (
              <Switch key={k} on={modules[k] !== false} onChange={(v) => setModules({ ...modules, [k]: v })} label={LABELS[k]} />
            ))}
          </div>
        </div>
        <div>
          <div className="card mb">
            <h4>Country restriction setup</h4>
            <Field label="Mode">
              <Select value={countries.mode} onChange={(e) => setCountries({ ...countries, mode: e.target.value })}>
                <option value="none">No restriction</option>
                <option value="allow">Only allow listed countries</option>
                <option value="block">Block listed countries</option>
              </Select>
            </Field>
            <Field label="Countries (ISO codes, comma separated)">
              <Input
                value={(countries.countries ?? []).join(',')}
                onChange={(e) =>
                  setCountries({
                    ...countries,
                    countries: e.target.value
                      .split(',')
                      .map((s) => s.trim().toUpperCase())
                      .filter(Boolean),
                  })
                }
                placeholder="US,GB,NG"
              />
            </Field>
            <div className="small muted">{(config?.countries ?? []).length} countries available. Restriction applies at registration based on the selected country.</div>
          </div>
          <Alert kind="info">
            Deposit methods (card, mobile money, bank) are configured under <b>Deposit / payment gateways</b>. Withdraw methods: bank (approval queue) and agent cash-out. Remittance methods: wallet,
            bank transfer and cash pickup are toggled together here.
          </Alert>
        </div>
      </div>
    </div>
  );
}
