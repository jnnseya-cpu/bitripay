import { useEffect, useState } from 'react';
import { countryLabel } from '@bitripay/shared';
import { tr } from '../lib/i18n';
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
  savings: 'Goal savings',
  creditScore: 'Credit-readiness score (informational)',
  openBanking: 'Open banking: linked accounts, pay by bank, mandates',
  restrictedWallets: 'Restricted-purpose wallets',
};
/** Off in the aggregator perimeter of Instructions n°42 and n°58 (issuer and acquirer functions); the API refuses them with module_disabled. */
const OUT_OF_PERIMETER = [
  'transfers',
  'addMoney',
  'withdrawals',
  'agents',
  'remittance',
  'exchange',
  'virtualCards',
  'giftCards',
  'billPay',
  'mobileTopup',
  'referrals',
  'p2p',
  'savings',
  'creditScore',
  'openBanking',
  'restrictedWallets',
];

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
  const applyPerimeter = async () => {
    const r = await api.post<{ modules: Record<string, boolean> }>('/api/admin/settings/modules/aggregator-perimeter', {});
    setModules(r.modules);
    toast(tr('Aggregator perimeter applied: issuer and acquirer functions are switched off'), 'success');
    refresh();
  };
  const perimeterApplied = OUT_OF_PERIMETER.every((k) => modules[k] === false);
  const save = async () => {
    await api.put('/api/admin/settings/modules', { value: modules });
    await api.put('/api/admin/settings/countries', { value: countries });
    toast(tr('Saved'), 'success');
    refresh();
  };
  return (
    <div>
      <PageHeader
        title={tr('Modules, methods & country restrictions')}
        subtitle={tr('Enable or disable platform features and restrict access by country')}
        actions={
          <>
            <Button variant="secondary" onClick={applyPerimeter}>
              {tr('Apply the aggregator perimeter (Instructions n°42 and n°58)')}
            </Button>
            <Button onClick={save}>{tr('Save')}</Button>
          </>
        }
      />
      <Alert kind={perimeterApplied ? 'success' : 'warning'}>
        {perimeterApplied
          ? tr(
              'Aggregator perimeter in force: acceptance (QR, links, requests, merchant gateway and API), identity checks and support are on; every issuer or acquirer function is switched off and refused by the API until the authorisation of the Banque Centrale du Congo.',
            )
          : tr(
              'Issuer or acquirer functions are switched on. Before an authorisation of the Banque Centrale du Congo exists, apply the aggregator perimeter: wallet funding, transfers, withdrawals, agents, remittances, exchange, cards, vouchers, bills and airtime paid from a wallet, savings, restricted wallets, open banking, credit score, P2P and referral rewards are then switched off.',
            )}
      </Alert>
      <div className="grid cols-2">
        <div className="card">
          <h4>{tr('Modules setup')}</h4>
          <div className="col">
            {Object.keys(LABELS).map((k) => (
              <Switch
                key={k}
                on={modules[k] !== false}
                onChange={(v) => setModules({ ...modules, [k]: v })}
                label={OUT_OF_PERIMETER.includes(k) ? `${LABELS[k]} · ${tr('after authorisation')}` : LABELS[k]}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="card mb">
            <h4>{tr('Country restriction setup')}</h4>
            <Field label={tr('Mode')}>
              <Select value={countries.mode} onChange={(e) => setCountries({ ...countries, mode: e.target.value })}>
                <option value="none">{tr('No restriction')}</option>
                <option value="allow">{tr('Only allow listed countries')}</option>
                <option value="block">{tr('Block listed countries')}</option>
              </Select>
            </Field>
            <Field label={tr('Countries (ISO codes, comma separated)')}>
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
                placeholder={tr('US,GB,NG')}
              />
            </Field>
            {(countries.countries ?? []).length > 0 && (
              <div className="small" style={{ marginBottom: 6 }}>
                {(countries.countries as string[]).map((c) => (
                  <span key={c} className="chip" style={{ marginRight: 4 }}>
                    {countryLabel(c, config?.countries?.find((x: { code: string; name: string }) => x.code === c)?.name)}
                  </span>
                ))}
              </div>
            )}
            <div className="small muted">{(config?.countries ?? []).length} countries available. Restriction applies at registration based on the selected country.</div>
          </div>
          <Alert kind="info">
            Deposit methods (card, mobile money, bank) are configured under <b>{tr('Deposit / payment gateways')}</b>. Withdraw methods: bank (approval queue) and agent cash-out. Remittance methods:
            wallet, bank transfer and cash pickup are toggled together here.
          </Alert>
        </div>
      </div>
    </div>
  );
}
