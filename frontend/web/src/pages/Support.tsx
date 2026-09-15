import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Button, Empty, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';

export function Support() {
  const t = useT();
  const { config } = useStore();
  const [tab, setTab] = useState<'chat' | 'tickets'>(config?.modules.liveChat !== false ? 'chat' : 'tickets');
  return (
    <div>
      <PageHeader title={t('nav.support')} subtitle={tr("We're here to help – chat with us live or open a ticket")} />
      <Tabs
        tabs={[...(config?.modules.liveChat !== false ? [{ id: 'chat', label: tr('Live chat') }] : []), { id: 'tickets', label: tr('Support tickets') }]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'chat' ? <LiveChat /> : <Tickets />}
    </div>
  );
}

function LiveChat() {
  const { user } = useStore();
  const [msgs, setMsgs] = useState<any[]>([]);
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const load = async (since?: string) => {
    const r = await api.get<{ items: any[] }>(`/api/support/chat${since ? `?since=${encodeURIComponent(since)}` : ''}`);
    if (r.items.length) setMsgs((m) => (since ? [...m, ...r.items.filter((x) => !m.some((y) => y.id === x.id))] : r.items));
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => load(msgs[msgs.length - 1]?.createdAt), 4000);
    return () => clearInterval(timer);
  }, [msgs]);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [msgs]);
  const send = async () => {
    if (!text.trim()) return;
    const r = await api.post<{ message: any }>('/api/support/chat', { body: text });
    setMsgs((m) => [...m, r.message]);
    setText('');
  };
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 520 }}>
      <div style={{ flex: 1, overflowY: 'auto' }} className="col">
        {msgs.length === 0 && <Empty icon="💬" text={tr('Start a conversation with our support team')} />}
        {msgs.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.isAdmin ? 'flex-start' : 'flex-end',
              background: m.isAdmin ? 'var(--bg-soft)' : 'var(--primary)',
              color: m.isAdmin ? 'inherit' : '#fff',
              padding: '8px 12px',
              borderRadius: 12,
              maxWidth: '75%',
            }}
          >
            <div className="tiny bold" style={{ opacity: 0.8 }}>
              {m.isAdmin ? tr('Support') : user?.fullName}
            </div>
            <div className="small">{m.body}</div>
            <div className="tiny" style={{ opacity: 0.7 }}>
              {new Date(m.createdAt).toLocaleTimeString()}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="row mt"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('Type a message…')} />
        <Button>{tr('Send')}</Button>
      </form>
    </div>
  );
}

function Tickets() {
  const tickets = useAsync(() => api.get<{ items: any[] }>('/api/support/tickets'), []);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const [form, setForm] = useState({ subject: '', category: 'general', priority: 'normal', body: '' });
  const [reply, setReply] = useState('');
  const create = async () => {
    const r = await api.post<{ ticket: any }>('/api/support/tickets', form);
    setOpen(false);
    setForm({ subject: '', category: 'general', priority: 'normal', body: '' });
    tickets.reload();
    setSel(r.ticket);
  };
  const view = async (id: string) => {
    const r = await api.get<{ ticket: any }>(`/api/support/tickets/${id}`);
    setSel(r.ticket);
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="card-title">
          <h3>{tr('My tickets')}</h3>
          <Button size="sm" onClick={() => setOpen(true)}>
            {tr('+ New ticket')}
          </Button>
        </div>
        {tickets.data?.items.length === 0 && <Empty icon="🎫" />}
        <div className="list">
          {tickets.data?.items.map((tk) => (
            <div key={tk.id} className="list-item clickable" onClick={() => view(tk.id)}>
              <div className="flex1">
                <div className="main-text">{tk.subject}</div>
                <div className="sub-text">
                  {tk.category} · {new Date(tk.updatedAt).toLocaleString()}
                </div>
              </div>
              <StatusBadge status={tk.status} />
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        {sel ? (
          <>
            <div className="card-title">
              <h3>{sel.subject}</h3>
              <StatusBadge status={sel.status} />
            </div>
            <div className="col" style={{ maxHeight: 360, overflowY: 'auto' }}>
              {sel.messages?.map((m: any) => (
                <div key={m.id} className="card soft compact">
                  <div className="tiny bold">
                    {m.isAdmin ? tr('Support') : tr('You')} · {new Date(m.createdAt).toLocaleString()}
                  </div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                    {m.body}
                  </div>
                </div>
              ))}
            </div>
            {sel.status !== 'closed' && (
              <form
                className="mt"
                onSubmit={(e) => {
                  e.preventDefault();
                  api.post(`/api/support/tickets/${sel.id}/reply`, { body: reply }).then((r: any) => {
                    setSel(r.ticket);
                    setReply('');
                    tickets.reload();
                  });
                }}
              >
                <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={tr('Write a reply…')} />
                <div className="row mt-sm">
                  <Button disabled={!reply.trim()}>{tr('Reply')}</Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      api.post(`/api/support/tickets/${sel.id}/close`).then((r: any) => {
                        setSel(r.ticket);
                        tickets.reload();
                      })
                    }
                  >
                    {tr('Close ticket')}
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : (
          <Empty icon="🎫" text={tr('Select a ticket to view the conversation')} />
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={tr('New support ticket')}>
        <Field label={tr('Subject')}>
          <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label={tr('Category')}>
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {['general', 'payments', 'kyc', 'withdrawals', 'merchant', 'agent', 'security', 'other'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Priority')}>
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              <option value="low">{tr('Low')}</option>
              <option value="normal">{tr('Normal')}</option>
              <option value="high">{tr('High')}</option>
            </Select>
          </Field>
        </div>
        <Field label={tr('Describe the issue')}>
          <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </Field>
        <Button block onClick={create} disabled={form.subject.length < 3 || form.body.length < 3}>
          {tr('Submit')}
        </Button>
      </Modal>
    </div>
  );
}
