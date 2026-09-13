import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Field, Input, PageHeader, Select, Switch, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

export function Messaging() {
  const { toast } = useStore();
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const outbox = useAsync(() => api.get<{ items: any[] }>('/api/admin/outbox'), []);
  const [tab, setTab] = useState<'smtp' | 'sms' | 'push' | 'newsletter' | 'outbox'>('smtp');
  const [smtp, setSmtp] = useState<any>(null);
  const [sms, setSms] = useState<any>(null);
  const [test, setTest] = useState('');
  const [push, setPush] = useState({ title: '', body: '', role: '' });
  const [news, setNews] = useState({ subject: '', body: '', includeUsers: true });
  useEffect(() => { if (settings.data) { setSmtp(settings.data.smtp); setSms({ provider: 'console', twilioSid: '', twilioToken: '', twilioFrom: '', ...settings.data.sms }); } }, [settings.data]);
  const save = (key: string, value: unknown) => api.put(`/api/admin/settings/${key}`, { value }).then(() => toast('Saved', 'success')).catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader title="Email, SMS, push & newsletter" subtitle="SMTP for verification and notifications, SMS provider for phone OTP, push broadcasts and newsletters" />
      <Tabs tabs={[{ id: 'smtp', label: 'SMTP email' }, { id: 'sms', label: 'SMS / phone auth' }, { id: 'push', label: 'Push notifications' }, { id: 'newsletter', label: 'Newsletter' }, { id: 'outbox', label: 'Message log' }]} value={tab} onChange={(v) => setTab(v as any)} />
      <div className="card">
        {tab === 'smtp' && smtp && (
          <>
            <Alert kind="info">Without SMTP, verification codes are printed to the API console (and returned as <code>devCode</code> outside production).</Alert>
            <div className="grid cols-2">
              <Field label="Host"><Input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.sendgrid.net" /></Field>
              <Field label="Port"><Input type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} /></Field>
              <Field label="Username"><Input value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} /></Field>
              <Field label="Password"><Input type="password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} /></Field>
              <Field label="From"><Input value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} /></Field>
              <div><Switch on={!!smtp.secure} onChange={(v) => setSmtp({ ...smtp, secure: v })} label="Use TLS (port 465)" /></div>
            </div>
            <div className="row wrap"><Button onClick={() => save('smtp', smtp)}>Save SMTP</Button><Input value={test} onChange={(e) => setTest(e.target.value)} placeholder="test@example.com" style={{ maxWidth: 240 }} /><Button variant="secondary" onClick={() => api.post<any>('/api/admin/settings/smtp/test', { to: test }).then((r) => toast(r.delivered ? 'Test email sent' : `Not delivered (${r.via})`, r.delivered ? 'success' : 'error')).catch((e) => toast(e.message, 'error'))}>Send test</Button></div>
          </>
        )}
        {tab === 'sms' && sms && (
          <>
            <Field label="Provider"><Select value={sms.provider} onChange={(e) => setSms({ ...sms, provider: e.target.value })}><option value="console">Console (development)</option><option value="twilio">Twilio</option></Select></Field>
            {sms.provider === 'twilio' && <div className="grid cols-3"><Field label="Account SID"><Input value={sms.twilioSid} onChange={(e) => setSms({ ...sms, twilioSid: e.target.value })} /></Field><Field label="Auth token"><Input type="password" value={sms.twilioToken} onChange={(e) => setSms({ ...sms, twilioToken: e.target.value })} /></Field><Field label="From number"><Input value={sms.twilioFrom} onChange={(e) => setSms({ ...sms, twilioFrom: e.target.value })} /></Field></div>}
            <Button onClick={() => save('sms', sms)}>Save SMS settings</Button>
          </>
        )}
        {tab === 'push' && (
          <>
            <Alert kind="info">Push notifications are delivered through the Expo push service to the mobile apps, and stored as in-app notifications for everyone.</Alert>
            <Field label="Title"><Input value={push.title} onChange={(e) => setPush({ ...push, title: e.target.value })} /></Field>
            <Field label="Message"><Textarea value={push.body} onChange={(e) => setPush({ ...push, body: e.target.value })} /></Field>
            <Field label="Audience"><Select value={push.role} onChange={(e) => setPush({ ...push, role: e.target.value })}><option value="">Everyone</option><option value="user">Users</option><option value="merchant">Merchants</option><option value="agent">Agents</option></Select></Field>
            <Button onClick={() => api.post<any>('/api/admin/notifications/broadcast', { ...push, role: push.role || undefined }).then((r) => toast(`Sent to ${r.sent} accounts`, 'success')).catch((e) => toast(e.message, 'error'))} disabled={!push.title || !push.body}>Send broadcast</Button>
          </>
        )}
        {tab === 'newsletter' && (
          <>
            <Field label="Subject"><Input value={news.subject} onChange={(e) => setNews({ ...news, subject: e.target.value })} /></Field>
            <Field label="Body (plain text)"><Textarea value={news.body} onChange={(e) => setNews({ ...news, body: e.target.value })} style={{ minHeight: 200 }} /></Field>
            <Switch on={news.includeUsers} onChange={(v) => setNews({ ...news, includeUsers: v })} label="Include all registered users (in addition to newsletter subscribers)" />
            <div className="mt"><Button onClick={() => api.post<any>('/api/admin/newsletter/send', news).then((r) => toast(`Newsletter sent to ${r.sent} recipients`, 'success')).catch((e) => toast(e.message, 'error'))} disabled={!news.subject || !news.body}>Send newsletter</Button></div>
          </>
        )}
        {tab === 'outbox' && (
          <>
            <div className="row mb"><Button size="sm" variant="secondary" onClick={outbox.reload}>Refresh</Button><span className="small muted">Last 200 emails/SMS the API tried to send (useful without SMTP configured).</span></div>
            <Table head={['When', 'Channel', 'To', 'Subject / body']} rows={(outbox.data?.items ?? []).map((m) => [fmtDate(m.at), m.channel, m.to, <span className="small">{m.subject ? <b>{m.subject}<br /></b> : null}{m.body}</span>])} empty="Nothing sent yet" />
          </>
        )}
      </div>
    </div>
  );
}
