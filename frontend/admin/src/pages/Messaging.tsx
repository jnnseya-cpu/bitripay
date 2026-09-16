import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, Modal, PageHeader, Select, Switch, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

interface NotificationTemplate {
  id: string;
  key: string;
  channel: string;
  lang: string;
  subject: string | null;
  body: string;
  updatedBy: string | null;
  updatedAt: string;
  isDefault: boolean;
}
interface TemplateEvent {
  key: string;
  description: string;
  placeholders: string[];
  sample: Record<string, string>;
}

export function Messaging() {
  const { toast } = useStore();
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const outbox = useAsync(() => api.get<{ items: any[] }>('/api/admin/outbox'), []);
  const [tab, setTab] = useState<'smtp' | 'sms' | 'push' | 'newsletter' | 'templates' | 'outbox'>('smtp');
  const [smtp, setSmtp] = useState<any>(null);
  const [sms, setSms] = useState<any>(null);
  const [test, setTest] = useState('');
  const [push, setPush] = useState({ title: '', body: '', role: '' });
  const [news, setNews] = useState({ subject: '', body: '', includeUsers: true });
  useEffect(() => {
    if (settings.data) {
      setSmtp(settings.data.smtp);
      setSms({ provider: 'console', twilioSid: '', twilioToken: '', twilioFrom: '', africasTalkingUsername: '', africasTalkingApiKey: '', africasTalkingFrom: '', ...settings.data.sms });
    }
  }, [settings.data]);
  const save = (key: string, value: unknown) =>
    api
      .put(`/api/admin/settings/${key}`, { value })
      .then(() => toast(tr('Saved'), 'success'))
      .catch((e) => toast(e.message, 'error'));
  return (
    <div>
      <PageHeader title={tr('Email, SMS, push & newsletter')} subtitle={tr('SMTP for verification and notifications, SMS provider for phone OTP, push broadcasts and newsletters')} />
      <Tabs
        tabs={[
          { id: 'smtp', label: tr('SMTP email') },
          { id: 'sms', label: tr('SMS / phone auth') },
          { id: 'push', label: tr('Push notifications') },
          { id: 'newsletter', label: tr('Newsletter') },
          { id: 'templates', label: tr('Templates') },
          { id: 'outbox', label: tr('Message log') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      <div className="card">
        {tab === 'smtp' && smtp && (
          <>
            <Alert kind="info">
              {tr('Without SMTP, verification codes are printed to the API console (and returned as')} <code>devCode</code> outside production).
            </Alert>
            <div className="grid cols-2">
              <Field label={tr('Host')}>
                <Input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.sendgrid.net" />
              </Field>
              <Field label={tr('Port')}>
                <Input type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} />
              </Field>
              <Field label={tr('Username')}>
                <Input value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
              </Field>
              <Field label={tr('Password')}>
                <Input type="password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} />
              </Field>
              <Field label="From">
                <Input value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
              </Field>
              <div>
                <Switch on={!!smtp.secure} onChange={(v) => setSmtp({ ...smtp, secure: v })} label={tr('Use TLS (port 465)')} />
              </div>
            </div>
            <div className="row wrap">
              <Button onClick={() => save('smtp', smtp)}>{tr('Save SMTP')}</Button>
              <Input value={test} onChange={(e) => setTest(e.target.value)} placeholder="test@example.com" style={{ maxWidth: 240 }} />
              <Button
                variant="secondary"
                onClick={() =>
                  api
                    .post<any>('/api/admin/settings/smtp/test', { to: test })
                    .then((r) => toast(r.delivered ? 'Test email sent' : `Not delivered (${r.via})`, r.delivered ? 'success' : 'error'))
                    .catch((e) => toast(e.message, 'error'))
                }
              >
                {tr('Send test')}
              </Button>
            </div>
          </>
        )}
        {tab === 'sms' && sms && (
          <>
            <Field label={tr('Provider')}>
              <Select value={sms.provider} onChange={(e) => setSms({ ...sms, provider: e.target.value })}>
                <option value="console">{tr('Console (development)')}</option>
                <option value="twilio">{tr('Twilio')}</option>
                <option value="africastalking">{tr("Africa's Talking (Kinshasa and most African routes)")}</option>
              </Select>
            </Field>
            {sms.provider === 'africastalking' && (
              <div className="grid cols-3">
                <Field label={tr('Username')} hint={`"sandbox" targets the Africa's Talking sandbox; your app username targets live routes`}>
                  <Input value={sms.africasTalkingUsername} onChange={(e) => setSms({ ...sms, africasTalkingUsername: e.target.value })} />
                </Field>
                <Field label={tr('API key')}>
                  <Input type="password" value={sms.africasTalkingApiKey} onChange={(e) => setSms({ ...sms, africasTalkingApiKey: e.target.value })} />
                </Field>
                <Field label={tr('Sender ID (optional)')} hint={tr('An approved alphanumeric sender such as BitriPay, or a short code; empty uses the shared sender')}>
                  <Input value={sms.africasTalkingFrom} onChange={(e) => setSms({ ...sms, africasTalkingFrom: e.target.value })} />
                </Field>
              </div>
            )}
            {sms.provider === 'twilio' && (
              <div className="grid cols-3">
                <Field label={tr('Account SID')}>
                  <Input value={sms.twilioSid} onChange={(e) => setSms({ ...sms, twilioSid: e.target.value })} />
                </Field>
                <Field label={tr('Auth token')}>
                  <Input type="password" value={sms.twilioToken} onChange={(e) => setSms({ ...sms, twilioToken: e.target.value })} />
                </Field>
                <Field label={tr('From number')}>
                  <Input value={sms.twilioFrom} onChange={(e) => setSms({ ...sms, twilioFrom: e.target.value })} />
                </Field>
              </div>
            )}
            <Button onClick={() => save('sms', sms)}>{tr('Save SMS settings')}</Button>
          </>
        )}
        {tab === 'push' && (
          <>
            <Alert kind="info">{tr('Push notifications are delivered through the Expo push service to the mobile apps, and stored as in-app notifications for everyone.')}</Alert>
            <Field label={tr('Title')}>
              <Input value={push.title} onChange={(e) => setPush({ ...push, title: e.target.value })} />
            </Field>
            <Field label={tr('Message')}>
              <Textarea value={push.body} onChange={(e) => setPush({ ...push, body: e.target.value })} />
            </Field>
            <Field label={tr('Audience')}>
              <Select value={push.role} onChange={(e) => setPush({ ...push, role: e.target.value })}>
                <option value="">{tr('Everyone')}</option>
                <option value="user">{tr('Users')}</option>
                <option value="merchant">{tr('Merchants')}</option>
                <option value="agent">{tr('Agents')}</option>
              </Select>
            </Field>
            <Button
              onClick={() =>
                api
                  .post<any>('/api/admin/notifications/broadcast', { ...push, role: push.role || undefined })
                  .then((r) => toast(`Sent to ${r.sent} accounts`, 'success'))
                  .catch((e) => toast(e.message, 'error'))
              }
              disabled={!push.title || !push.body}
            >
              {tr('Send broadcast')}
            </Button>
          </>
        )}
        {tab === 'newsletter' && (
          <>
            <Field label={tr('Subject')}>
              <Input value={news.subject} onChange={(e) => setNews({ ...news, subject: e.target.value })} />
            </Field>
            <Field label={tr('Body (plain text)')}>
              <Textarea value={news.body} onChange={(e) => setNews({ ...news, body: e.target.value })} style={{ minHeight: 200 }} />
            </Field>
            <Switch on={news.includeUsers} onChange={(v) => setNews({ ...news, includeUsers: v })} label={tr('Include all registered users (in addition to newsletter subscribers)')} />
            <div className="mt">
              <Button
                onClick={() =>
                  api
                    .post<any>('/api/admin/newsletter/send', news)
                    .then((r) => toast(`Newsletter sent to ${r.sent} recipients`, 'success'))
                    .catch((e) => toast(e.message, 'error'))
                }
                disabled={!news.subject || !news.body}
              >
                {tr('Send newsletter')}
              </Button>
            </div>
          </>
        )}
        {tab === 'templates' && <Templates />}
        {tab === 'outbox' && (
          <>
            <div className="row mb">
              <Button size="sm" variant="secondary" onClick={outbox.reload}>
                {tr('Refresh')}
              </Button>
              <span className="small muted">{tr('Last 200 emails/SMS the API tried to send (useful without SMTP configured).')}</span>
            </div>
            <Table
              head={[tr('When'), tr('Channel'), 'To', tr('Subject / body')]}
              rows={(outbox.data?.items ?? []).map((m) => [
                fmtDate(m.at),
                m.channel,
                m.to,
                <span className="small">
                  {m.subject ? (
                    <b>
                      {m.subject}
                      <br />
                    </b>
                  ) : null}
                  {m.body}
                </span>,
              ])}
              empty={tr('Nothing sent yet')}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Notification templates: the wording of every message the API sends (OTP codes, payments received, payouts paid…)
 * per event, channel and language, with {{placeholders}} filled at send time. English defaults ship with the API;
 * other languages fall back to English until a variant is saved here.
 */
function Templates() {
  const { toast } = useStore();
  const data = useAsync(() => api.get<{ items: NotificationTemplate[]; channels: string[]; events: TemplateEvent[] }>('/api/admin/messaging/templates'), []);
  const [filter, setFilter] = useState({ key: '', channel: '' });
  const [editing, setEditing] = useState<{ key: string; channel: string; lang: string; subject: string; body: string; isNew: boolean } | null>(null);
  const [preview, setPreview] = useState<{ subject: string | null; body: string } | null>(null);
  const [variant, setVariant] = useState({ key: '', channel: 'push', lang: 'fr' });
  const events = data.data?.events ?? [];
  const channels = data.data?.channels ?? [];
  const items = (data.data?.items ?? []).filter((t) => (!filter.key || t.key === filter.key) && (!filter.channel || t.channel === filter.channel));
  const eventFor = (key: string) => events.find((e) => e.key === key);
  const fail = (e: Error) => toast(e.message, 'error');
  const openEditor = (t: NotificationTemplate, isNew = false, lang = t.lang) => {
    setPreview(null);
    setEditing({ key: t.key, channel: t.channel, lang, subject: t.subject ?? '', body: t.body, isNew });
  };
  const save = () => {
    if (!editing) return;
    api
      .put<{ template: NotificationTemplate }>('/api/admin/messaging/templates', {
        key: editing.key,
        channel: editing.channel,
        lang: editing.lang,
        subject: editing.subject || null,
        body: editing.body,
      })
      .then(() => {
        toast(`Template ${editing.key} (${editing.channel}, ${editing.lang}) saved`, 'success');
        setEditing(null);
        data.reload();
      })
      .catch(fail);
  };
  const reset = (t: NotificationTemplate) =>
    api
      .put('/api/admin/messaging/templates', { key: t.key, channel: t.channel, lang: t.lang, reset: true })
      .then(() => {
        toast(tr('Default text restored'), 'success');
        data.reload();
      })
      .catch(fail);
  const renderPreview = (t: { key: string; channel: string; lang: string; subject?: string | null; body?: string | null }) =>
    api
      .post<{ rendered: { subject: string | null; body: string } | null }>('/api/admin/messaging/templates/preview', t)
      .then((r) => setPreview(r.rendered ?? { subject: null, body: '' }))
      .catch(fail);
  const addVariant = () => {
    const base =
      (data.data?.items ?? []).find((t) => t.key === variant.key && t.channel === variant.channel && t.lang === 'en') ??
      (data.data?.items ?? []).find((t) => t.key === variant.key && t.channel === variant.channel);
    const lang = variant.lang.trim().toLowerCase();
    if (!variant.key || lang.length < 2) return toast(tr('Choose an event and a language code'), 'error');
    openEditor(base ?? { id: '', key: variant.key, channel: variant.channel, lang, subject: null, body: '', updatedBy: null, updatedAt: '', isDefault: false }, true, lang);
  };
  return (
    <>
      <Alert kind="info">
        {tr('Every OTP, payment, payout, KYC and security message is rendered from these templates. Use')} <code>{'{{placeholder}}'}</code> for the values listed per event; a language without its own
        text falls back to English.
      </Alert>
      <div className="row wrap mb">
        <Field label={tr('Event')}>
          <Select value={filter.key} onChange={(e) => setFilter({ ...filter, key: e.target.value })}>
            <option value="">{tr('All events')}</option>
            {events.map((e) => (
              <option key={e.key} value={e.key}>
                {e.key}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr('Channel')}>
          <Select value={filter.channel} onChange={(e) => setFilter({ ...filter, channel: e.target.value })}>
            <option value="">{tr('All channels')}</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" variant="secondary" onClick={data.reload}>
          {tr('Refresh')}
        </Button>
      </div>
      <Table
        head={[tr('Event'), tr('Channel'), tr('Lang'), tr('Subject / body'), tr('Updated'), '']}
        rows={items.map((t) => [
          <span>
            <b>{t.key}</b>
            <div className="tiny muted">{eventFor(t.key)?.description}</div>
          </span>,
          t.channel,
          t.lang,
          <span className="small">
            {t.subject ? (
              <b>
                {t.subject}
                <br />
              </b>
            ) : null}
            {t.body}
          </span>,
          <span className="small">
            {t.isDefault ? <Chip>default</Chip> : <Chip kind="primary">edited</Chip>}
            <div className="tiny muted">{t.updatedAt ? fmtDate(t.updatedAt) : ''}</div>
          </span>,
          <div className="row wrap">
            <Button size="sm" variant="secondary" onClick={() => openEditor(t)}>
              {tr('Edit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => renderPreview({ key: t.key, channel: t.channel, lang: t.lang })}>
              {tr('Preview')}
            </Button>
            {!t.isDefault && t.lang === 'en' && (
              <Button size="sm" variant="ghost" onClick={() => reset(t)}>
                {tr('Reset')}
              </Button>
            )}
          </div>,
        ])}
        empty={tr('No templates match')}
      />
      <div className="card mt">
        <h4>{tr('Add a language variant')}</h4>
        <div className="row wrap">
          <Field label={tr('Event')}>
            <Select value={variant.key} onChange={(e) => setVariant({ ...variant, key: e.target.value })}>
              <option value="">{tr('Choose…')}</option>
              {events.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.key}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Channel')}>
            <Select value={variant.channel} onChange={(e) => setVariant({ ...variant, channel: e.target.value })}>
              {channels.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Language code')} hint="fr, sw, ln, ar…">
            <Input value={variant.lang} onChange={(e) => setVariant({ ...variant, lang: e.target.value })} style={{ width: 90 }} maxLength={5} />
          </Field>
          <Button variant="secondary" onClick={addVariant}>
            {tr('Write variant')}
          </Button>
        </div>
      </div>
      {preview && !editing && (
        <div className="card mt">
          <h4>{tr('Preview (sample values)')}</h4>
          {preview.subject ? <b>{preview.subject}</b> : null}
          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>
            {preview.body}
          </p>
          <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
            {tr('Close')}
          </Button>
        </div>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `${editing.isNew ? tr('New') : tr('Edit')} template · ${editing.key} · ${editing.channel} · ${editing.lang}` : ''} wide>
        {editing && (
          <>
            <p className="small muted">
              {eventFor(editing.key)?.description}. Placeholders:{' '}
              {(eventFor(editing.key)?.placeholders ?? []).map((p) => (
                <code key={p} style={{ marginRight: 6 }}>
                  {`{{${p}}}`}
                </code>
              ))}
              <code>{'{{appName}}'}</code>
            </p>
            {editing.channel !== 'sms' && editing.channel !== 'whatsapp' && (
              <Field label={editing.channel === 'email' ? tr('Subject') : tr('Title')}>
                <Input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} maxLength={200} />
              </Field>
            )}
            <Field label={tr('Body')} hint={editing.channel === 'sms' ? tr('Keep SMS under 160 characters where possible') : undefined}>
              <Textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} style={{ minHeight: 120 }} maxLength={4000} />
            </Field>
            {preview && (
              <Alert kind="success">
                {preview.subject ? (
                  <b>
                    {preview.subject}
                    <br />
                  </b>
                ) : null}
                <span style={{ whiteSpace: 'pre-wrap' }}>{preview.body}</span>
              </Alert>
            )}
            <div className="row wrap">
              <Button onClick={save} disabled={!editing.body.trim()}>
                {tr('Save')}
              </Button>
              <Button variant="secondary" onClick={() => renderPreview({ key: editing.key, channel: editing.channel, lang: editing.lang, subject: editing.subject || null, body: editing.body })}>
                {tr('Preview with sample values')}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {tr('Cancel')}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
