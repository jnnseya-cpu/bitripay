import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, AmountInput, Avatar, Button, CopyButton, Empty, Field, Input, Modal, PageHeader, PinModal, QrImage, Select, StatusBadge, Tabs, useAsync } from '../components/ui';
import type { PaymentRequest } from '@bitripay/shared';

export function Requests() {
  const t = useT();
  const { money, config, wallets, toast, refreshWallets } = useStore();
  const [tab, setTab] = useState<'incoming' | 'links' | 'requests'>('incoming');
  const [createOpen, setCreateOpen] = useState<null | 'link' | 'request'>(null);
  const [form, setForm] = useState({ amount: '', currency: wallets[0]?.currency || config?.baseCurrency || 'USD', description: '', payer: '', expires: '' });
  const [created, setCreated] = useState<PaymentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payCode, setPayCode] = useState<PaymentRequest | null>(null);
  const [loading, setLoading] = useState(false);

  const incoming = useAsync(() => api.get<{ items: PaymentRequest[] }>('/api/payment-requests?role=payer&status=open'), [tab]);
  const mine = useAsync(() => api.get<{ items: PaymentRequest[] }>(`/api/payment-requests${qs({ role: 'requester', kind: tab === 'links' ? undefined : 'request', pageSize: 50 })}`), [tab]);

  const create = async () => {
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, unknown> = { kind: createOpen, currency: form.currency, description: form.description || null };
      if (form.amount) body.amount = form.amount;
      if (createOpen === 'request') body.payer = form.payer;
      if (form.expires) body.expiresInMinutes = Number(form.expires) * 60;
      const r = await api.post<{ paymentRequest: PaymentRequest }>('/api/payment-requests', body);
      setCreated(r.paymentRequest);
      setCreateOpen(null);
      mine.reload();
      toast(createOpen === 'link' ? 'Payment link created' : 'Money request sent', 'success');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const pay = async (pin: string) => {
    if (!payCode) return;
    setLoading(true);
    try {
      await api.post(`/api/payment-requests/${payCode.code}/pay`, { pin });
      toast('Paid', 'success');
      setPayCode(null);
      incoming.reload();
      refreshWallets();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const decline = async (code: string) => {
    await api.post(`/api/payment-requests/${code}/decline`);
    incoming.reload();
  };
  const cancel = async (code: string) => {
    await api.post(`/api/payment-requests/${code}/cancel`);
    mine.reload();
  };

  const list = tab === 'incoming' ? incoming.data?.items : mine.data?.items;
  const filtered = tab === 'links' ? list?.filter((r) => r.kind !== 'request') : list;

  return (
    <div>
      <PageHeader
        title={t('nav.requests')}
        subtitle="Request money from other users and create shareable payment links"
        actions={
          <>
            <Button variant="secondary" onClick={() => { setForm((f) => ({ ...f, amount: '', description: '', payer: '' })); setCreateOpen('request'); }}>🙋 Request money</Button>
            <Button onClick={() => { setForm((f) => ({ ...f, amount: '', description: '' })); setCreateOpen('link'); }}>🔗 New payment link</Button>
          </>
        }
      />
      <Tabs tabs={[{ id: 'incoming', label: 'Requests to pay' }, { id: 'requests', label: 'My requests' }, { id: 'links', label: 'My payment links' }]} value={tab} onChange={(v) => setTab(v as any)} />
      <div className="card">
        {(!filtered || filtered.length === 0) && <Empty icon="🔗" />}
        <div className="list">
          {filtered?.map((r) => (
            <div key={r.id} className="list-item">
              <Avatar user={tab === 'incoming' ? r.requester : r.payer ?? r.requester} />
              <div className="flex1">
                <div className="main-text">
                  {r.amount != null ? money(r.amount, r.currency) : `Open amount (${r.currency})`} {r.description ? `· ${r.description}` : ''}
                </div>
                <div className="sub-text">
                  {tab === 'incoming' ? `From ${r.requester?.fullName} (@${r.requester?.tag})` : r.payer ? `To ${r.payer.fullName} (@${r.payer.tag})` : r.kind} · {new Date(r.createdAt).toLocaleString()} · <span className="mono">{r.code}</span>
                </div>
              </div>
              <StatusBadge status={r.status} />
              {tab === 'incoming' && r.status === 'open' && (
                <>
                  <Button size="sm" onClick={() => setPayCode(r)}>Pay</Button>
                  <Button size="sm" variant="secondary" onClick={() => decline(r.code)}>Decline</Button>
                </>
              )}
              {tab !== 'incoming' && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setCreated(r)}>View</Button>
                  {r.status === 'open' && <Button size="sm" variant="ghost" onClick={() => cancel(r.code)}>{t('common.cancel')}</Button>}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <Modal open={!!createOpen} onClose={() => setCreateOpen(null)} title={createOpen === 'link' ? 'New payment link' : 'Request money'}>
        {error && <Alert kind="error">{error}</Alert>}
        {createOpen === 'request' && (
          <Field label="From (@tag, email or phone)">
            <Input value={form.payer} onChange={(e) => setForm({ ...form, payer: e.target.value })} autoFocus />
          </Field>
        )}
        <Field label={t('common.amount')} hint={createOpen === 'link' ? 'Leave empty to let the payer choose the amount' : undefined}>
          <AmountInput amount={form.amount} currency={form.currency} onAmount={(a) => setForm({ ...form, amount: a })} onCurrency={(c) => setForm({ ...form, currency: c })} currencies={(config?.currencies ?? []).map((c) => c.code)} />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Invoice #12, dinner, …" />
        </Field>
        <Field label="Expires in (hours, optional)">
          <Select value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })}>
            <option value="">Never</option>
            <option value="1">1 hour</option>
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </Select>
        </Field>
        <Button block loading={loading} onClick={create} disabled={createOpen === 'request' && (!form.amount || !form.payer)}>
          {createOpen === 'link' ? 'Create link' : 'Send request'}
        </Button>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title={created?.kind === 'request' ? 'Money request' : 'Payment link'}>
        {created && (
          <div className="center">
            <QrImage value={created.link!} size={220} />
            <h3 className="mt">{created.amount != null ? money(created.amount, created.currency) : `Any amount (${created.currency})`}</h3>
            <p className="muted small">{created.description}</p>
            <div className="card soft compact small mono" style={{ wordBreak: 'break-all' }}>{created.link}</div>
            <div className="row mt" style={{ justifyContent: 'center' }}>
              <CopyButton text={created.link!} label="Copy link" />
              <Link className="btn secondary sm" to={`/pay/${created.code}`} target="_blank">Open checkout</Link>
              <a className="btn secondary sm" href={`/api/qr/image.svg?data=${encodeURIComponent(created.link!)}`} download>QR SVG</a>
            </div>
            <div className="mt"><StatusBadge status={created.status} /></div>
          </div>
        )}
      </Modal>
      <PinModal open={!!payCode} onClose={() => setPayCode(null)} onSubmit={pay} loading={loading} summary={payCode && <p>Pay {money(payCode.amount ?? 0, payCode.currency)} to {payCode.requester?.fullName}</p>} />
    </div>
  );
}
