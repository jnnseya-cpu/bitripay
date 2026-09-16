import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, KV, PageHeader, Select, Switch, Table, Tabs, fmtDate, useAsync } from '../components/ui';

/**
 * Feature-phone channels: USSD (menu over any phone), SMS keyword commands and BitriPay Lite (no-JavaScript web).
 * Administrators configure the aggregator formats and ceilings here and drive the real menus in the simulator.
 */
export function Channels() {
  const { toast } = useStore();
  const data = useAsync(() => api.get<any>('/api/admin/channels'), []);
  const [tab, setTab] = useState<'ussd' | 'sms' | 'settings'>('ussd');
  const ok = (m: string) => {
    toast(m, 'success');
    data.reload();
  };
  const err = (e: any) => toast(e.message, 'error');
  const d = data.data;
  if (!d)
    return (
      <div className="loading-page">
        <span className="spinner" />
      </div>
    );
  return (
    <div>
      <PageHeader
        title={tr('USSD, SMS & Lite')}
        subtitle={tr(
          'BitriPay for people without a smartphone or with very little data: a USSD menu on any phone, SMS keyword commands, and a tiny no-JavaScript web. Same wallets, limits and PIN checks as the app.',
        )}
      />
      <div className="grid cols-3 mb">
        <div className="card">
          <KV
            k="USSD"
            v={
              <>
                <Chip kind={d.settings.ussd.enabled ? 'success' : 'danger'}>{d.settings.ussd.enabled ? 'on' : 'off'}</Chip> <span className="mono">{d.settings.ussd.serviceCode}</span>
              </>
            }
          />
          <div className="tiny muted">
            Webhook: <span className="mono">{tr('POST /api/ussd')}</span> · {d.settings.ussd.provider}
          </div>
        </div>
        <div className="card">
          <KV k={tr('SMS commands')} v={<Chip kind={d.settings.sms.enabled ? 'success' : 'danger'}>{d.settings.sms.enabled ? 'on' : 'off'}</Chip>} />
          <div className="tiny muted">
            Webhook: <span className="mono">{tr('POST /api/sms/inbound')}</span> · reply {d.settings.sms.replyFormat}
          </div>
        </div>
        <div className="card">
          <KV k={tr('Lite web')} v={<Chip kind={d.settings.lite.enabled ? 'success' : 'danger'}>{d.settings.lite.enabled ? 'on' : 'off'}</Chip>} />
          <div className="tiny muted">
            <a href={d.liteUrl} target="_blank" rel="noreferrer">
              {d.liteUrl}
            </a>{' '}
            · a few KB per page, works on 2G
          </div>
        </div>
      </div>
      <Tabs
        tabs={[
          { id: 'ussd', label: tr('USSD simulator & sessions') },
          { id: 'sms', label: tr('SMS simulator & log') },
          { id: 'settings', label: tr('Settings') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'ussd' && <Ussd d={d} err={err} />}
      {tab === 'sms' && <Sms d={d} err={err} />}
      {tab === 'settings' && <Settings d={d} ok={ok} err={err} />}
    </div>
  );
}

function Ussd({ d, err }: { d: any; err: (e: any) => void }) {
  const [phone, setPhone] = useState('+243970000001');
  const [session, setSession] = useState<string | null>(null);
  const [screen, setScreen] = useState<string>('Dial ' + d.settings.ussd.serviceCode + ' to start.');
  const [input, setInput] = useState('');
  const [ended, setEnded] = useState(true);
  const step = async (text: string) => {
    try {
      const r = await api.post<any>('/api/admin/channels/ussd/simulate', { sessionId: ended ? undefined : session, phone, input: text });
      setSession(r.sessionId);
      setScreen(r.text);
      setEnded(r.end);
      setInput('');
    } catch (e) {
      err(e);
    }
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>{tr('Phone simulator')}</h4>
        <p className="tiny muted">{tr('Drives the real menu for any number, exactly as an aggregator would. Numbers that are not registered get the registration flow.')}</p>
        <Field label={tr('Phone number')}>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <pre style={{ background: '#0f1318', color: '#dfe4dc', padding: 14, borderRadius: 8, minHeight: 160, whiteSpace: 'pre-wrap', fontSize: 14 }}>{screen}</pre>
        {ended ? (
          <Button onClick={() => step('')}>{tr('📞 Dial {0}', { 0: d.settings.ussd.serviceCode })}</Button>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              step(input);
            }}
          >
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={tr('Reply…')} autoFocus />
            <Button>{tr('Send')}</Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setEnded(true);
                setScreen('Session ended.');
              }}
            >
              {tr('Cancel')}
            </Button>
          </form>
        )}
      </div>
      <div className="card">
        <h4>{tr('Recent sessions')}</h4>
        <Table
          head={[tr('When'), tr('Phone'), tr('Via'), tr('Path'), tr('Last screen'), tr('State')]}
          rows={(d.ussdSessions ?? []).map((s: any) => [
            fmtDate(s.updatedAt),
            <span className="mono tiny">{s.phone}</span>,
            s.provider,
            <span className="mono tiny">{s.inputs.map((x: string) => (/^\d{4,6}$/.test(x) ? '••••' : x)).join('*')}</span>,
            <span className="tiny">{s.lastResponse?.slice(0, 80)}</span>,
            <Chip kind={s.ended ? undefined : 'warning'}>{s.ended ? 'ended' : 'open'}</Chip>,
          ])}
          empty={tr('No USSD traffic yet')}
        />
      </div>
    </div>
  );
}

function Sms({ d, err }: { d: any; err: (e: any) => void }) {
  const [phone, setPhone] = useState('+243970000001');
  const [text, setText] = useState('HELP');
  const [reply, setReply] = useState<string | null>(null);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h4>{tr('SMS simulator')}</h4>
        <p className="tiny muted">{tr('Commands: BAL PIN · SEND amount [CUR] @code PIN · PAY amount @merchant PIN · CASH amount @agent PIN · STMT PIN · CODE · REG name PIN · HELP')}</p>
        <Field label="From">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            api
              .post<any>('/api/admin/channels/sms/simulate', { phone, text })
              .then((r) => setReply(r.reply))
              .catch(err);
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} />
          <Button>{tr('Send')}</Button>
        </form>
        {reply && (
          <div className="card mt" style={{ background: 'var(--bg-soft)' }}>
            <div className="tiny muted">{tr('Reply')}</div>
            {reply}
          </div>
        )}
      </div>
      <div className="card">
        <h4>{tr('Message log')}</h4>
        <Table
          head={[tr('When'), tr('Phone'), '', tr('Message')]}
          rows={(d.sms ?? []).map((m: any) => [
            fmtDate(m.createdAt),
            <span className="mono tiny">{m.phone}</span>,
            m.direction === 'in' ? '📥' : '📤',
            <span className="tiny">{m.body.replace(/\b\d{4,6}\b/g, '••••')}</span>,
          ])}
          empty={tr('No SMS traffic yet')}
        />
      </div>
    </div>
  );
}

function Settings({ d, ok, err }: { d: any; ok: (m: string) => void; err: (e: any) => void }) {
  const [s, setS] = useState<any>(() => JSON.parse(JSON.stringify(d.settings)));
  const u = (k: string, v: unknown) => setS({ ...s, ussd: { ...s.ussd, [k]: v } });
  const m = (k: string, v: unknown) => setS({ ...s, sms: { ...s.sms, [k]: v } });
  return (
    <div className="card">
      <div className="grid cols-2">
        <div>
          <h4>USSD</h4>
          <Switch on={s.ussd.enabled} onChange={(v) => u('enabled', v)} label={tr('USSD enabled')} />
          <Switch on={s.ussd.allowRegistration} onChange={(v) => u('allowRegistration', v)} label={tr('New numbers can register (name + PIN)')} />
          <Field label={tr('Service code (shown in help)')}>
            <Input value={s.ussd.serviceCode} onChange={(e) => u('serviceCode', e.target.value)} />
          </Field>
          <Field
            label={tr('Aggregator format')}
            hint={tr("Africa's Talking sends sessionId/phoneNumber/text and expects CON/END; generic gateways send JSON {sessionId, phone, input} and get JSON back.")}
          >
            <Select value={s.ussd.provider} onChange={(e) => u('provider', e.target.value)}>
              <option value="africastalking">{tr("Africa's Talking (form, CON/END)")}</option>
              <option value="generic">{tr('Generic (JSON)')}</option>
            </Select>
          </Field>
          <div className="grid cols-2">
            <Field label={tr('Max per transaction (minor units)')}>
              <Input type="number" value={s.ussd.maxPerTransaction} onChange={(e) => u('maxPerTransaction', Number(e.target.value))} />
            </Field>
            <Field label="in currency">
              <Input value={s.ussd.maxPerTransactionCurrency} onChange={(e) => u('maxPerTransactionCurrency', e.target.value.toUpperCase())} />
            </Field>
          </div>
          <div className="grid cols-2">
            <Field label={tr('Session timeout (minutes, e.g. 1.5 = 90 s)')}>
              <Input type="number" value={s.ussd.sessionTtlMinutes} onChange={(e) => u('sessionTtlMinutes', Number(e.target.value))} />
            </Field>
            <Field label={tr('Webhook secret (X-Channel-Secret)')}>
              <Input type="password" value={s.ussd.secret} onChange={(e) => u('secret', e.target.value)} />
            </Field>
          </div>
        </div>
        <div>
          <h4>{tr('SMS commands')}</h4>
          <Switch on={s.sms.enabled} onChange={(v) => m('enabled', v)} label={tr('SMS commands enabled')} />
          <Switch on={s.sms.allowRegistration} onChange={(v) => m('allowRegistration', v)} label={tr('REG command can open a wallet')} />
          <Field
            label={tr('Synchronous reply format')}
            hint={tr("Twilio field names always get TwiML; Africa's Talking and generic gateways get this format. Replies are also sent through the SMS provider configured under Email, SMS & push.")}
          >
            <Select value={s.sms.replyFormat} onChange={(e) => m('replyFormat', e.target.value)}>
              <option value="plain">{tr('Plain text')}</option>
              <option value="twiml">{tr('TwiML')}</option>
              <option value="json">JSON</option>
            </Select>
          </Field>
          <div className="grid cols-2">
            <Field label={tr('Max per transaction (minor units)')}>
              <Input type="number" value={s.sms.maxPerTransaction} onChange={(e) => m('maxPerTransaction', Number(e.target.value))} />
            </Field>
            <Field label="in currency">
              <Input value={s.sms.maxPerTransactionCurrency} onChange={(e) => m('maxPerTransactionCurrency', e.target.value.toUpperCase())} />
            </Field>
          </div>
          <Field label={tr('Webhook secret')}>
            <Input type="password" value={s.sms.secret} onChange={(e) => m('secret', e.target.value)} />
          </Field>
          <h4>{tr('Lite web')}</h4>
          <Switch on={s.lite.enabled} onChange={(v) => setS({ ...s, lite: { enabled: v } })} label={tr('BitriPay Lite enabled (/lite)')} />
        </div>
      </div>
      <Alert kind="info">{tr('Keep ceilings modest: these channels have no device binding or biometrics, only the PIN. Larger amounts belong in the app or with an agent.')}</Alert>
      <Button
        onClick={() =>
          api
            .put('/api/admin/channels/settings', s)
            .then(() => ok('Channel settings saved'))
            .catch(err)
        }
      >
        {tr('Save settings')}
      </Button>
    </div>
  );
}
