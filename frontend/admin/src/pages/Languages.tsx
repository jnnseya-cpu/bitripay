import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, ConfirmButton, Field, Input, Modal, PageHeader, Select, Switch, Table, Textarea, useAsync } from '../components/ui';

export function Languages() {
  const { toast, refresh } = useStore();
  const list = useAsync(() => api.get<{ items: any[] }>('/api/admin/languages'), []);
  const [edit, setEdit] = useState<any>(null);
  const [lang, setLang] = useState('en');
  const [overrides, setOverrides] = useState('');
  const current = useAsync(() => api.get<{ overrides: Record<string, string> }>(`/api/admin/translations/${lang}`), [lang]);
  useEffect(() => { if (current.data) setOverrides(JSON.stringify(current.data.overrides, null, 2)); }, [current.data]);
  const saveLang = async () => {
    await api.put(`/api/admin/languages/${edit.code}`, { name: edit.name, nativeName: edit.nativeName, rtl: !!edit.rtl, enabled: !!edit.enabled });
    toast('Language saved', 'success');
    setEdit(null);
    list.reload();
    refresh();
  };
  const saveOverrides = async () => {
    try {
      const parsed = JSON.parse(overrides);
      await api.put(`/api/admin/translations/${lang}`, { overrides: parsed });
      toast('Translations saved', 'success');
    } catch (err) {
      toast('Invalid JSON: ' + (err as Error).message, 'error');
    }
  };
  return (
    <div>
      <PageHeader title="Language management" subtitle="Enable languages and override any UI string. Apps ship with built-in dictionaries (en, fr, es, pt, ar, sw, hi, bn) and merge your overrides on top." actions={<Button onClick={() => setEdit({ code: '', name: '', nativeName: '', rtl: false, enabled: true })}>+ Add language</Button>} />
      <div className="grid cols-2">
        <div className="card">
          <Table head={['Code', 'Name', 'Native', 'RTL', 'Enabled', '']} rows={(list.data?.items ?? []).map((l) => [<b className="mono">{l.code}</b>, l.name, l.nativeName, l.rtl ? 'yes' : '', <Switch on={l.enabled} onChange={(v) => api.put(`/api/admin/languages/${l.code}`, { ...l, enabled: v }).then(() => { list.reload(); refresh(); })} />, <div className="row"><Button size="sm" variant="secondary" onClick={() => setEdit({ ...l })}>Edit</Button>{l.code !== 'en' && <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/languages/${l.code}`).then(list.reload)}>Delete</ConfirmButton>}</div>])} />
        </div>
        <div className="card">
          <h4>Translation overrides</h4>
          <Field label="Language"><Select value={lang} onChange={(e) => setLang(e.target.value)}>{(list.data?.items ?? []).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</Select></Field>
          <Alert kind="info">JSON map of key → text, e.g. <code>{'{"nav.send": "Transfer funds", "landing.hero": "Pay with a scan"}'}</code>. Keys match the app dictionaries (nav.*, common.*, auth.*, dash.*, send.*, receive.*, scan.*, addMoney.*, withdraw.*, settings.*, landing.*).</Alert>
          <Textarea value={overrides} onChange={(e) => setOverrides(e.target.value)} style={{ minHeight: 260, fontFamily: 'monospace' }} />
          <div className="mt"><Button onClick={saveOverrides}>Save overrides</Button></div>
        </div>
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Language">
        {edit && (
          <>
            <Field label="Code (ISO 639-1)"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} disabled={!!list.data?.items.find((l) => l.code === edit.code)} /></Field>
            <Field label="Name (English)"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Native name"><Input value={edit.nativeName} onChange={(e) => setEdit({ ...edit, nativeName: e.target.value })} /></Field>
            <Switch on={!!edit.rtl} onChange={(v) => setEdit({ ...edit, rtl: v })} label="Right-to-left" />
            <div className="mt-sm"><Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Enabled" /></div>
            <div className="mt"><Button onClick={saveLang} disabled={!edit.code || !edit.name}>Save</Button></div>
          </>
        )}
      </Modal>
    </div>
  );
}
