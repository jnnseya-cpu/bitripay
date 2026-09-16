import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
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
  const status = useAsync(
    () => api.get<{ total: number; translated: number; missing: number; fallback: string | null; engineReady: boolean; model: string }>(`/api/admin/translations/${lang}/status`),
    [lang, current.data],
  );
  const [translating, setTranslating] = useState(false);
  const runEngine = async () => {
    setTranslating(true);
    try {
      const r = await api.post<{ stored: number; rejected: string[]; missing: number }>(`/api/admin/translations/${lang}/translate`, {});
      toast(`${r.stored} phrase(s) translated${r.rejected.length ? `, ${r.rejected.length} refused (placeholders)` : ''}; ${r.missing} still missing`, 'success');
      current.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setTranslating(false);
    }
  };
  useEffect(() => {
    if (current.data) setOverrides(JSON.stringify(current.data.overrides, null, 2));
  }, [current.data]);
  const saveLang = async () => {
    await api.put(`/api/admin/languages/${edit.code}`, { name: edit.name, nativeName: edit.nativeName, rtl: !!edit.rtl, enabled: !!edit.enabled });
    toast(tr('Language saved'), 'success');
    setEdit(null);
    list.reload();
    refresh();
  };
  const saveOverrides = async () => {
    try {
      const parsed = JSON.parse(overrides);
      await api.put(`/api/admin/translations/${lang}`, { overrides: parsed });
      toast(tr('Translations saved'), 'success');
    } catch (err) {
      toast('Invalid JSON: ' + (err as Error).message, 'error');
    }
  };
  return (
    <div>
      <PageHeader
        title={tr('Language management')}
        subtitle={tr('Enable languages and override any UI string. Apps ship with built-in dictionaries (en, fr, es, pt, ar, sw, hi, bn) and merge your overrides on top.')}
        actions={<Button onClick={() => setEdit({ code: '', name: '', nativeName: '', rtl: false, enabled: true })}>{tr('+ Add language')}</Button>}
      />
      <div className="grid cols-2">
        <div className="card">
          <Table
            head={[tr('Code'), tr('Name'), tr('Native'), 'RTL', tr('Enabled'), '']}
            rows={(list.data?.items ?? []).map((l) => [
              <b className="mono">{l.code}</b>,
              l.name,
              l.nativeName,
              l.rtl ? 'yes' : '',
              <Switch
                on={l.enabled}
                onChange={(v) =>
                  api.put(`/api/admin/languages/${l.code}`, { ...l, enabled: v }).then(() => {
                    list.reload();
                    refresh();
                  })
                }
              />,
              <div className="row">
                <Button size="sm" variant="secondary" onClick={() => setEdit({ ...l })}>
                  {tr('Edit')}
                </Button>
                {l.code !== 'en' && (
                  <ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/languages/${l.code}`).then(list.reload)}>
                    {tr('Delete')}
                  </ConfirmButton>
                )}
              </div>,
            ])}
          />
        </div>
        <div className="card">
          <h4>{tr('Translation overrides')}</h4>
          <Field label={tr('Language')}>
            <Select value={lang} onChange={(e) => setLang(e.target.value)}>
              {(list.data?.items ?? []).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          {status.data && (
            <div className="card soft compact mb">
              <div className="row between wrap">
                <div>
                  <b>
                    {status.data.translated} / {status.data.total}
                  </b>{' '}
                  phrases of the app translated
                  {status.data.missing > 0 && (
                    <span className="muted">
                      {' '}
                      · {status.data.missing} shown in {status.data.fallback ? `${status.data.fallback.toUpperCase()} (fallback)` : tr('English')}
                    </span>
                  )}
                </div>
                {lang !== 'en' && status.data.missing > 0 && (
                  <Button
                    size="sm"
                    onClick={runEngine}
                    loading={translating}
                    disabled={!status.data.engineReady}
                    title={status.data.engineReady ? `Model ${status.data.model}` : tr('Configure the content agent key under Blog & SEO first')}
                  >
                    {tr('Translate missing phrases')}
                  </Button>
                )}
              </div>
              <p className="tiny muted" style={{ margin: '6px 0 0' }}>
                {tr('The engine translates only what is missing, keeps placeholders and product names, and stores the result below as overrides you can correct by hand. French ships hand-written.')}
              </p>
            </div>
          )}
          <Alert kind="info">
            {tr('JSON map of key → text, e.g.')} <code>{'{"nav.send": "Transfer funds", "landing.hero": "Pay with a scan"}'}</code>. Keys match the app dictionaries (nav.*, common.*, auth.*, dash.*,
            send.*, receive.*, scan.*, addMoney.*, withdraw.*, settings.*, landing.*) or the English phrase itself for sentences of the app (e.g. <code>{'{"Add money": "Ajouter des fonds"}'}</code>).
          </Alert>
          <Textarea value={overrides} onChange={(e) => setOverrides(e.target.value)} style={{ minHeight: 260, fontFamily: 'monospace' }} />
          <div className="mt">
            <Button onClick={saveOverrides}>{tr('Save overrides')}</Button>
          </div>
        </div>
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={tr('Language')}>
        {edit && (
          <>
            <Field label={tr('Code (ISO 639-1)')}>
              <Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} disabled={!!list.data?.items.find((l) => l.code === edit.code)} />
            </Field>
            <Field label={tr('Name (English)')}>
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label={tr('Native name')}>
              <Input value={edit.nativeName} onChange={(e) => setEdit({ ...edit, nativeName: e.target.value })} />
            </Field>
            <Switch on={!!edit.rtl} onChange={(v) => setEdit({ ...edit, rtl: v })} label={tr('Right-to-left')} />
            <div className="mt-sm">
              <Switch on={!!edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label={tr('Enabled')} />
            </div>
            <div className="mt">
              <Button onClick={saveLang} disabled={!edit.code || !edit.name}>
                {tr('Save')}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
