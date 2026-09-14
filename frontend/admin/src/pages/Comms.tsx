import { useState } from 'react';
import { api } from '../lib/api';
import { Alert, Button, Chip, Field, Input, PageHeader, Select, Table, fmtDate, useAsync } from '../components/ui';

type Channel = 'email' | 'inapp' | 'sms' | 'push' | 'whatsapp';
interface CommsEvent {
  id: string;
  category: string;
  label: string;
  subject: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  channels: Channel[];
  mandatory: boolean;
  sample: Record<string, string>;
}
interface Delivery {
  id: string;
  eventId: string;
  channel: Channel;
  status: string;
  via: string | null;
  recipient: string | null;
  subject: string | null;
  error: string | null;
  test: boolean;
  createdAt: string;
}
interface Overview {
  events: number;
  categories: number;
  mandatory: number;
  delivered: number;
  attempted: number;
  channelsWired: number;
  coverage: { channel: Channel; events: number; sent: number; attempted: number; wired: boolean; detail: string }[];
}
interface Payload {
  categories: { id: string; label: string; description: string }[];
  channels: Channel[];
  events: CommsEvent[];
  overview: Overview;
  deliveries: Delivery[];
}

const SEVERITY: Record<CommsEvent['severity'], 'primary' | 'success' | 'warning' | 'danger'> = { info: 'primary', success: 'success', warning: 'warning', critical: 'danger' };
const STATUS: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = {
  sent: 'success',
  logged: 'primary',
  failed: 'danger',
  skipped_opted_out: 'warning',
  skipped_no_contact: 'warning',
  skipped_no_device: undefined,
};

/** Communication event architecture: one engine, every event across email, in-app, SMS, push and WhatsApp. */
export function Comms() {
  const data = useAsync(() => api.get<Payload>('/api/admin/comms'), []);
  const [eventId, setEventId] = useState('welcome');
  const [preview, setPreview] = useState<{ html: string; channels: Record<Channel, { subject: string; body: string }>; vars: Record<string, string> } | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filterCategory, setFilterCategory] = useState('');
  const [query, setQuery] = useState('');

  if (!data.data) return <PageHeader title="Communication events" subtitle="Loading the catalogue…" />;
  const { categories, channels, events, overview, deliveries } = data.data;
  const doPreview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setPreview(await api.post<any>('/api/admin/comms/preview', { eventId }));
    } catch (e: any) {
      setMessage({ kind: 'error', text: e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.post<{ deliveries: Delivery[] }>('/api/admin/comms/test', { eventId });
      setMessage({ kind: 'success', text: `Fired ${eventId} to you: ${r.deliveries.map((d) => `${d.channel} ${d.status}`).join(' · ')}` });
      data.reload();
    } catch (e: any) {
      setMessage({ kind: 'error', text: e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };
  const visible = events.filter((e) => (!filterCategory || e.category === filterCategory) && (!query || `${e.id} ${e.label} ${e.subject}`.toLowerCase().includes(query.toLowerCase())));
  const selected = events.find((e) => e.id === eventId);

  return (
    <div>
      <PageHeader title="Communication events" subtitle={`One event engine: ${overview.events} events fan out across email, in-app, SMS, push and WhatsApp. Mandatory notices bypass opt-outs.`} />

      <div className="grid cols-4">
        <div className="card">
          <div className="tiny muted">Catalogue events</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{overview.events}</div>
          <div className="tiny">{overview.categories} categories</div>
        </div>
        <div className="card">
          <div className="tiny muted">Mandatory notices</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{overview.mandatory}</div>
          <div className="tiny">bypass user opt-outs</div>
        </div>
        <div className="card">
          <div className="tiny muted">Messages delivered</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{overview.delivered}</div>
          <div className="tiny">of {overview.attempted} attempted (90-day log)</div>
        </div>
        <div className="card">
          <div className="tiny muted">Channels wired</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{overview.channelsWired}</div>
          <div className="tiny">{channels.join(' · ')}</div>
        </div>
      </div>

      <div className="card mt">
        <h4>Channel coverage</h4>
        <p className="tiny muted">How many catalogue events fire on each channel by default, what was sent, and whether the channel is connected.</p>
        <Table
          head={['Channel', 'Events', 'Sent', 'Attempted', 'Connection']}
          rows={overview.coverage.map((c) => [
            <b>{c.channel}</b>,
            c.events,
            c.sent,
            c.attempted,
            <span className="tiny">
              <Chip kind={c.wired ? 'success' : 'warning'}>{c.wired ? 'wired' : 'not connected'}</Chip> {c.detail}
            </span>,
          ])}
        />
      </div>

      <div className="card mt">
        <h4>Template QA</h4>
        <p className="tiny muted">
          Preview the branded email (site logo, colour and contact details on every outbound email) or fire any event to yourself across its channels. Test sends are recorded in the log and marked as
          tests.
        </p>
        <div className="row">
          <Select value={eventId} onChange={(e) => setEventId(e.target.value)} style={{ minWidth: 360 }}>
            {categories.map((c) => (
              <optgroup key={c.id} label={c.label}>
                {events
                  .filter((e) => e.category === c.id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label} — {e.id}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <Button variant="secondary" onClick={doPreview} disabled={busy}>
            Preview email
          </Button>
          <Button onClick={sendTest} disabled={busy}>
            Send test to me
          </Button>
        </div>
        {selected && (
          <div className="tiny muted mt-sm">
            {selected.channels.join(' · ')} · {selected.severity}
            {selected.mandatory ? ' · mandatory' : ''} · placeholders: {Object.keys(selected.sample).join(', ')}
          </div>
        )}
        {message && <Alert kind={message.kind}>{message.text}</Alert>}
        {preview && (
          <div className="grid cols-2 mt">
            <div>
              <h5>Email as received</h5>
              <iframe title="Email preview" srcDoc={preview.html} style={{ width: '100%', height: 520, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
            </div>
            <div>
              <h5>Every channel</h5>
              {channels.map((ch) => (
                <div key={ch} className="mt-sm">
                  <b>{ch}</b>
                  <div className="tiny">
                    {preview.channels[ch].subject && <div style={{ fontWeight: 600 }}>{preview.channels[ch].subject}</div>}
                    <div style={{ whiteSpace: 'pre-wrap' }}>{preview.channels[ch].body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card mt">
        <h4>Recent deliveries</h4>
        <p className="tiny muted">Every event × channel × recipient with its delivery status. Contact details are masked.</p>
        <Table
          head={['Channel', 'Event', 'Status', 'Via', 'Recipient', 'When']}
          rows={deliveries.map((d) => [
            d.channel,
            <span className="mono tiny">{d.eventId}</span>,
            <Chip kind={STATUS[d.status]}>
              {d.status.replace(/_/g, ' ')}
              {d.test ? ' · test' : ''}
            </Chip>,
            <span className="tiny">{d.error ?? d.via ?? ''}</span>,
            <span className="tiny">{d.recipient ?? ''}</span>,
            <span className="tiny">{fmtDate(d.createdAt)}</span>,
          ])}
          empty="No deliveries yet"
        />
      </div>

      <div className="card mt">
        <div className="row between">
          <h4>Catalogue</h4>
          <div className="row">
            <Select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Input placeholder="Search events" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        {categories
          .filter((c) => !filterCategory || c.id === filterCategory)
          .map((c) => {
            const list = visible.filter((e) => e.category === c.id);
            if (!list.length) return null;
            return (
              <div key={c.id} className="mt">
                <h5>
                  {c.label}{' '}
                  <span className="tiny muted">
                    · {list.length} events · {c.description}
                  </span>
                </h5>
                <Table
                  head={['Event', 'Id', 'Subject', 'Severity', 'Channels']}
                  rows={list.map((e) => [
                    <span>
                      <b>{e.label}</b>
                      {e.mandatory && (
                        <>
                          {' '}
                          <Chip kind="warning">mandatory</Chip>
                        </>
                      )}
                    </span>,
                    <span className="mono tiny">{e.id}</span>,
                    <span className="tiny">{e.subject}</span>,
                    <Chip kind={SEVERITY[e.severity]}>{e.severity}</Chip>,
                    <span className="tiny">{e.channels.join(' · ')}</span>,
                  ])}
                />
              </div>
            );
          })}
        <Field hint="Edit the wording of any event per channel and language under Email, SMS & push → Templates; the catalogue text is the shipped default.">
          <span />
        </Field>
      </div>
    </div>
  );
}
