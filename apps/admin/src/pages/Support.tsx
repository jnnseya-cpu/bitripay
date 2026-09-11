import { useEffect, useRef, useState } from 'react';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Empty, Input, Modal, PageHeader, Select, StatusBadge, Table, Textarea, UserCell, fmtDate, useAsync, Tabs, Field, ConfirmButton } from '../components/ui';

export function Support() {
  const { toast } = useStore();
  const [status, setStatus] = useState('open');
  const list = useAsync(() => api.get<any>(`/api/admin/support/tickets${qs({ status, pageSize: 50 })}`), [status]);
  const [sel, setSel] = useState<any>(null);
  const [reply, setReply] = useState('');
  const open = async (id: string) => setSel((await api.get<any>(`/api/admin/support/tickets/${id}`)).ticket);
  return (
    <div>
      <PageHeader title="Support tickets" subtitle="Manage and respond to user, merchant and agent tickets" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}><option value="open">Open</option><option value="answered">Answered</option><option value="closed">Closed</option><option value="">All</option></Select>} />
      <div className="card">
        <Table head={['User', 'Subject', 'Category', 'Priority', 'Updated', 'Status', '']} rows={(list.data?.items ?? []).map((t: any) => [<UserCell user={t.user} />, t.subject, t.category, t.priority, fmtDate(t.updatedAt), <StatusBadge status={t.status} />, <Button size="sm" variant="secondary" onClick={() => open(t.id)}>Open</Button>])} empty="No tickets" />
      </div>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.subject} wide>
        {sel && (
          <>
            <div className="row wrap mb"><UserCell user={sel.user} /><StatusBadge status={sel.status} /><span className="chip">{sel.category}</span><span className="chip">{sel.priority}</span></div>
            <div className="col" style={{ maxHeight: 340, overflowY: 'auto' }}>{sel.messages.map((m: any) => <div key={m.id} className="card soft compact"><div className="tiny bold">{m.isAdmin ? 'Support' : m.sender?.fullName} · {fmtDate(m.createdAt)}</div><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>)}</div>
            <Textarea className="mt" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" />
            <div className="row mt-sm">
              <Button disabled={!reply.trim()} onClick={() => api.post<any>(`/api/admin/support/tickets/${sel.id}/reply`, { body: reply }).then((r) => { setSel(r.ticket); setReply(''); list.reload(); toast('Reply sent', 'success'); })}>Send reply</Button>
              {sel.status !== 'closed' ? <Button variant="ghost" onClick={() => api.post<any>(`/api/admin/support/tickets/${sel.id}/status`, { status: 'closed' }).then((r) => { setSel(r.ticket); list.reload(); })}>Close ticket</Button> : <Button variant="ghost" onClick={() => api.post<any>(`/api/admin/support/tickets/${sel.id}/status`, { status: 'open' }).then((r) => { setSel(r.ticket); list.reload(); })}>Reopen</Button>}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

export function Chat() {
  const convos = useAsync(() => api.get<{ items: any[] }>('/api/admin/support/chats'), []);
  const [userId, setUserId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [who, setWho] = useState<any>(null);
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const load = async (since?: string) => {
    if (!userId) return;
    const r = await api.get<{ items: any[]; user: any }>(`/api/admin/support/chats/${userId}${since ? `?since=${encodeURIComponent(since)}` : ''}`);
    setWho(r.user);
    if (r.items.length) setMsgs((m) => (since ? [...m, ...r.items.filter((x) => !m.some((y) => y.id === x.id))] : r.items));
  };
  useEffect(() => { setMsgs([]); load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(() => { load(msgs[msgs.length - 1]?.createdAt); convos.reload(); }, 4000); return () => clearInterval(t); }, [msgs, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [msgs]);
  const send = async () => {
    if (!text.trim() || !userId) return;
    const r = await api.post<{ message: any }>(`/api/admin/support/chats/${userId}`, { body: text });
    setMsgs((m) => [...m, r.message]);
    setText('');
  };
  return (
    <div>
      <PageHeader title="Live chat" subtitle="Real-time conversations with users, merchants and agents" />
      <div className="grid cols-3" style={{ minHeight: 520 }}>
        <div className="card" style={{ overflowY: 'auto' }}>
          {convos.data?.items.length === 0 && <Empty icon="💬" text="No conversations yet" />}
          {convos.data?.items.map((c) => (
            <div key={c.userId} className={`list-item clickable`} style={{ background: userId === c.userId ? 'var(--bg-soft)' : undefined, borderRadius: 8 }} onClick={() => setUserId(c.userId)}>
              <UserCell user={c.user} />
              <div className="flex1 small muted truncate">{c.lastBody}</div>
              {c.unread > 0 && <span className="chip danger">{c.unread}</span>}
            </div>
          ))}
        </div>
        <div className="card" style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column' }}>
          {!userId ? <Empty icon="👈" text="Select a conversation" /> : (
            <>
              <div className="row mb"><UserCell user={who} /></div>
              <div style={{ flex: 1, overflowY: 'auto' }} className="col">
                {msgs.map((m) => <div key={m.id} style={{ alignSelf: m.isAdmin ? 'flex-end' : 'flex-start', background: m.isAdmin ? 'var(--primary)' : 'var(--bg-soft)', color: m.isAdmin ? '#fff' : 'inherit', padding: '8px 12px', borderRadius: 12, maxWidth: '75%' }}><div className="small">{m.body}</div><div className="tiny" style={{ opacity: 0.7 }}>{fmtDate(m.createdAt)}</div></div>)}
                <div ref={bottom} />
              </div>
              <form className="row mt" onSubmit={(e) => { e.preventDefault(); send(); }}><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" /><Button>Send</Button></form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function Inbox() {
  const { toast } = useStore();
  const [tab, setTab] = useState<'contact' | 'subscribers'>('contact');
  const messages = useAsync(() => api.get<{ items: any[] }>('/api/admin/contact-messages'), [tab]);
  const subs = useAsync(() => api.get<{ items: any[] }>('/api/admin/newsletter/subscribers'), [tab]);
  const [sel, setSel] = useState<any>(null);
  const [reply, setReply] = useState('');
  return (
    <div>
      <PageHeader title="Contact messages & newsletter" subtitle="Website contact form inbox and newsletter subscriber list" />
      <Tabs tabs={[{ id: 'contact', label: 'Contact messages' }, { id: 'subscribers', label: 'Newsletter subscribers' }]} value={tab} onChange={(v) => setTab(v as any)} />
      <div className="card">
        {tab === 'contact' && <Table head={['From', 'Subject', 'Received', 'Status', '']} rows={(messages.data?.items ?? []).map((m) => [<span className="small">{m.name}<br />{m.email}</span>, m.subject, fmtDate(m.createdAt), <StatusBadge status={m.status} />, <Button size="sm" variant="secondary" onClick={() => { setSel(m); setReply(m.reply ?? ''); }}>Open</Button>])} empty="No messages" />}
        {tab === 'subscribers' && <Table head={['Email', 'Subscribed']} rows={(subs.data?.items ?? []).map((s) => [s.email, fmtDate(s.createdAt)])} empty="No subscribers" />}
      </div>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.subject}>
        {sel && (
          <>
            <div className="small muted mb">{sel.name} · {sel.email} · {fmtDate(sel.createdAt)}</div>
            <div className="card soft compact mb" style={{ whiteSpace: 'pre-wrap' }}>{sel.message}</div>
            <Field label="Reply (sent by email)"><Textarea value={reply} onChange={(e) => setReply(e.target.value)} /></Field>
            <ConfirmButton onConfirm={() => api.post(`/api/admin/contact-messages/${sel.id}/reply`, { reply }).then(() => { toast('Reply sent', 'success'); setSel(null); messages.reload(); }).catch((e) => toast(e.message, 'error'))}>Send reply</ConfirmButton>
          </>
        )}
      </Modal>
    </div>
  );
}
