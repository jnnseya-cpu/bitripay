import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { Alert, Button, Field, Input, PageHeader, useAsync } from '../components/ui';

interface Item {
  key: string;
  label: string;
  home: 'gateways' | 'messaging' | 'whatsapp' | 'settings' | 'content-agent' | 'credentials';
  gates: string;
  required: boolean;
  set: boolean;
  source: 'console' | 'environment' | 'unset';
  env: string | null;
}

/** Where each credential is edited. Everything except the last already had a home; this page links to it. */
const WHERE: Record<Item['home'], { label: string; to: string | null }> = {
  gateways: { label: 'Gateways', to: '/gateways' },
  messaging: { label: 'Messaging', to: '/messaging' },
  whatsapp: { label: 'WhatsApp', to: '/whatsapp' },
  settings: { label: 'Settings', to: '/settings' },
  'content-agent': { label: 'Content agent', to: '/seo' },
  credentials: { label: 'Here', to: null },
};

const SOURCE: Record<Item['source'], { text: string; cls: string }> = {
  console: { text: 'Set in the console', cls: 'ok' },
  environment: { text: 'Set in the server environment', cls: 'warn' },
  unset: { text: 'Not set', cls: 'bad' },
};

export function Credentials() {
  const inv = useAsync<{ items: Item[]; summary: { total: number; set: number; missingRequired: string[] } }>(() => api.get('/admin/credentials'), []);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setMsg(null);
    try {
      const res = (await api.put('/admin/credentials', { values: edits, pin: pin || undefined })) as { changed?: string[]; cleared?: string[] };
      setEdits({});
      setPin('');
      setMsg(res.changed?.length || res.cleared?.length ? tr('Saved') : tr('Nothing changed'));
      inv.reload();
    } catch (e: any) {
      setMsg(e?.message ?? tr('Could not save'));
    }
  };

  const items = inv.data?.items ?? [];
  const mine = items.filter((i) => i.home === 'credentials');
  const elsewhere = items.filter((i) => i.home !== 'credentials');
  const missing = inv.data?.summary.missingRequired ?? [];

  return (
    <>
      <PageHeader
        title={tr('API keys & credentials')}
        subtitle={tr('Everything the platform needs connected, where it is set, and what is waiting on it')}
        actions={Object.keys(edits).length ? <Button onClick={save}>{tr('Save')}</Button> : undefined}
      />
      {msg && <Alert kind="info">{msg}</Alert>}
      {inv.data && (
        <Alert kind={missing.length ? 'warning' : 'success'}>
          {missing.length
            ? tr('Required credentials are still missing: ') + missing.join(', ')
            : tr('Every required credential is set. ') + `${inv.data.summary.set}/${inv.data.summary.total} ` + tr('connected in total.')}
        </Alert>
      )}
      <Alert kind="info">
        {tr(
          'Nothing that moves money needs a key here: the digital rail, the ledger and e-money issuance work with no external provider. These keys add card and mobile-money rails, delivery of mail and SMS, and the AI features — which are the only part that cannot work without one.',
        )}
      </Alert>

      <div className="card mb">
        <h4>{tr('Set here')}</h4>
        <p className="muted small">{tr('A stored key is never shown again. Leave a field untouched to keep it, or clear it to remove it.')}</p>
        {mine.map((i) => (
          <Field key={i.key} label={`${i.label}${i.required ? ' *' : ''}`} hint={i.gates}>
            <Input type="password" placeholder={i.set ? '••••••••' : tr('Not set')} value={edits[i.key] ?? ''} onChange={(e) => setEdits({ ...edits, [i.key]: e.target.value })} />
          </Field>
        ))}
        {Object.keys(edits).length > 0 && (
          <Field label={tr('Your PIN')} hint={tr('Saving a credential is a step-up protected action.')}>
            <Input type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Field>
        )}
      </div>

      <div className="card">
        <h4>{tr('Set on their own screen')}</h4>
        <div className="tw">
          <table>
            <tbody>
              <tr>
                <th>{tr('Credential')}</th>
                <th>{tr('State')}</th>
                <th>{tr('Where')}</th>
                <th>{tr('What waits on it')}</th>
              </tr>
              {elsewhere.map((i) => (
                <tr key={i.key}>
                  <td>
                    {i.label}
                    {i.required ? ' *' : ''}
                  </td>
                  <td>
                    <span className={`pill ${SOURCE[i.source].cls}`}>{tr(SOURCE[i.source].text)}</span>
                  </td>
                  <td>{WHERE[i.home].to ? <a href={`#${WHERE[i.home].to}`}>{tr(WHERE[i.home].label)}</a> : tr(WHERE[i.home].label)}</td>
                  <td className="small muted">{i.gates}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
