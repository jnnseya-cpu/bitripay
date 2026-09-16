import { useState } from 'react';
import { countryFlag } from '@bitripay/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, ConfirmButton, Field, Input, Modal, PageHeader, Select, Switch, Table, Tabs, useAsync } from '../components/ui';

type Kind = 'billers' | 'operators' | 'gift-products';

export function Catalogs() {
  const { toast, config, money } = useStore();
  const [tab, setTab] = useState<Kind>('billers');
  const list = useAsync(() => api.get<{ items: any[] }>(`/api/admin/${tab}`), [tab]);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    try {
      const body = { ...edit };
      if (body.denominations && typeof body.denominations === 'string')
        body.denominations = body.denominations
          .split(',')
          .map((s: string) => Math.round(Number(s.trim()) * 100))
          .filter((n: number) => n > 0);
      if (tab !== 'gift-products') {
        body.minAmount = Math.round(Number(body.minAmount || 0) * 100);
        body.maxAmount = Math.round(Number(body.maxAmount || 0) * 100);
      }
      if (tab === 'billers') body.feeBps = Number(body.feeBps || 0);
      await api.put(`/api/admin/${tab}/${edit.id || 'new'}`, body);
      toast('Saved', 'success');
      setEdit(null);
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const open = (item?: any) => {
    if (item)
      setEdit({
        ...item,
        minAmount: item.minAmount != null ? item.minAmount / 100 : '',
        maxAmount: item.maxAmount != null ? item.maxAmount / 100 : '',
        denominations: (item.denominations ?? []).map((d: number) => d / 100).join(','),
      });
    else
      setEdit(
        tab === 'billers'
          ? { category: 'electricity', name: '', country: 'US', currency: 'USD', minAmount: '', maxAmount: '', feeBps: 0, accountLabel: 'Account number', enabled: true, color: '#0ea5e9' }
          : tab === 'operators'
            ? { name: '', country: 'US', currency: 'USD', minAmount: '', maxAmount: '', denominations: '', enabled: true, color: '#f59e0b' }
            : { brand: '', name: '', description: '', category: 'shopping', currency: 'USD', denominations: '', enabled: true, color: '#8b5cf6' },
      );
  };
  const items = list.data?.items ?? [];
  return (
    <div>
      <PageHeader
        title="Bill pay, mobile top-up & gift card catalogs"
        subtitle="Manage what users can pay for. Connect a fulfilment provider (e.g. Reloadly) in the API to deliver live."
        actions={<Button onClick={() => open()}>+ Add</Button>}
      />
      <Tabs
        tabs={[
          { id: 'billers', label: 'Bill pay methods' },
          { id: 'operators', label: 'Mobile top-up operators' },
          { id: 'gift-products', label: 'Gift card products' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Kind)}
      />
      <div className="card">
        {tab === 'billers' && (
          <Table
            head={['Biller', 'Category', 'Country', 'Currency', 'Min–max', 'Fee bps', 'Enabled', '']}
            rows={items.map((b) => [
              <b>{b.name}</b>,
              b.category,
              b.country,
              b.currency,
              `${money(b.minAmount, b.currency)} – ${money(b.maxAmount, b.currency)}`,
              b.feeBps,
              <Switch on={b.enabled} onChange={(v) => api.put(`/api/admin/billers/${b.id}`, { ...b, enabled: v }).then(list.reload)} />,
              <div className="row">
                <Button size="sm" variant="secondary" onClick={() => open(b)}>
                  Edit
                </Button>
                <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/billers/${b.id}`).then(list.reload)}>
                  Delete
                </ConfirmButton>
              </div>,
            ])}
          />
        )}
        {tab === 'operators' && (
          <Table
            head={['Operator', 'Country', 'Currency', 'Min–max', 'Denominations', 'Enabled', '']}
            rows={items.map((o) => [
              <b>{o.name}</b>,
              o.country,
              o.currency,
              `${money(o.minAmount, o.currency)} – ${money(o.maxAmount, o.currency)}`,
              o.denominations.map((d: number) => money(d, o.currency)).join(', '),
              <Switch on={o.enabled} onChange={(v) => api.put(`/api/admin/operators/${o.id}`, { ...o, enabled: v }).then(list.reload)} />,
              <div className="row">
                <Button size="sm" variant="secondary" onClick={() => open(o)}>
                  Edit
                </Button>
                <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/operators/${o.id}`).then(list.reload)}>
                  Delete
                </ConfirmButton>
              </div>,
            ])}
          />
        )}
        {tab === 'gift-products' && (
          <Table
            head={['Brand', 'Product', 'Category', 'Currency', 'Denominations', 'Enabled', '']}
            rows={items.map((p) => [
              <b style={{ color: p.color }}>{p.brand}</b>,
              p.name,
              p.category,
              p.currency,
              p.denominations.map((d: number) => money(d, p.currency)).join(', '),
              <Switch on={p.enabled} onChange={(v) => api.put(`/api/admin/gift-products/${p.id}`, { ...p, enabled: v }).then(list.reload)} />,
              <div className="row">
                <Button size="sm" variant="secondary" onClick={() => open(p)}>
                  Edit
                </Button>
                <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/gift-products/${p.id}`).then(list.reload)}>
                  Delete
                </ConfirmButton>
              </div>,
            ])}
          />
        )}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit' : 'Add'}>
        {edit && (
          <>
            {tab === 'gift-products' && (
              <Field label="Brand">
                <Input value={edit.brand} onChange={(e) => setEdit({ ...edit, brand: e.target.value })} />
              </Field>
            )}
            <Field label="Name">
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            {tab === 'gift-products' && (
              <Field label="Description">
                <Input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
              </Field>
            )}
            {(tab === 'billers' || tab === 'gift-products') && (
              <Field label="Category">
                <Input
                  value={edit.category}
                  onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                  placeholder={tab === 'billers' ? 'electricity, water, internet, tv…' : 'shopping, entertainment, gaming…'}
                />
              </Field>
            )}
            <div className="grid cols-2">
              {tab !== 'gift-products' && (
                <Field label="Country">
                  <Select value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })}>
                    {(config?.countries ?? []).map((c: any) => (
                      <option key={c.code} value={c.code}>
                        {countryFlag(c.code)} {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Currency">
                <Select value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}>
                  {(config?.currencies ?? []).map((c: any) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {tab !== 'gift-products' && (
              <div className="grid cols-2">
                <Field label="Min amount">
                  <Input value={edit.minAmount} onChange={(e) => setEdit({ ...edit, minAmount: e.target.value })} />
                </Field>
                <Field label="Max amount">
                  <Input value={edit.maxAmount} onChange={(e) => setEdit({ ...edit, maxAmount: e.target.value })} />
                </Field>
              </div>
            )}
            {tab === 'billers' && (
              <div className="grid cols-2">
                <Field label="Extra fee (bps)">
                  <Input type="number" value={edit.feeBps} onChange={(e) => setEdit({ ...edit, feeBps: e.target.value })} />
                </Field>
                <Field label="Account field label">
                  <Input value={edit.accountLabel} onChange={(e) => setEdit({ ...edit, accountLabel: e.target.value })} />
                </Field>
              </div>
            )}
            {tab !== 'billers' && (
              <Field label="Denominations (comma separated, major units)">
                <Input value={edit.denominations} onChange={(e) => setEdit({ ...edit, denominations: e.target.value })} placeholder="10,25,50" />
              </Field>
            )}
            <Field label="Tile color">
              <Input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
            </Field>
            <Switch on={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" />
            <div className="mt">
              <Button onClick={save}>Save</Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
