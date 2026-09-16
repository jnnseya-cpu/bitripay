import { useState, type ChangeEvent } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { countryLabel } from '@bitripay/shared';
import { Alert, Button, Chip, Field, Input, KV, Select, StatusBadge, Textarea, useAsync } from './ui';

/** Dossier documents an acceptor files with its business verification (KYB). */
const DOCUMENT_KINDS: [string, string][] = [
  ['rccm', 'RCCM extract (trade register)'],
  ['national_id_number', 'National identification number (Id. Nat.)'],
  ['tax_number', 'Tax number (NIF)'],
  ['statutes', 'Statutes / articles of association'],
  ['director_id', 'Identity document of a director'],
  ['proof_of_address', 'Proof of business address'],
  ['licence', 'Sector licence or authorisation'],
  ['other', 'Other'],
];

/**
 * Business verification (KYB): legal name, trade-register number, activity, address, expected volume, directors and
 * beneficial owners, dossier documents (uploaded files are sealed at rest). Reviewed by an administrator under PIN
 * step-up in the console; a verified business moves to Tier 4.
 */
export function KybDossier() {
  const { user, toast, config } = useStore();
  const kyb = useAsync(() => api.get<{ submission: any; status: string }>('/api/risk/kyb'), []);
  const [form, setForm] = useState({
    legalName: user?.businessName ?? '',
    registrationNumber: '',
    country: user?.country ?? 'CD',
    address: '',
    mcc: '',
    expectedMonthlyVolume: '',
    licenceRef: '',
  });
  const [directors, setDirectors] = useState<{ name: string; role: string }[]>([{ name: user?.fullName ?? '', role: tr('Manager') }]);
  const [documents, setDocuments] = useState<{ kind: string; ref: string; data: string; fileName: string }[]>([{ kind: 'rccm', ref: '', data: '', fileName: '' }]);
  const [busy, setBusy] = useState(false);
  const status = kyb.data?.status ?? 'none';
  const latest = kyb.data?.submission;
  const file = (i: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2_500_000) return toast(tr('File must be under 2.5 MB'), 'error');
    const reader = new FileReader();
    reader.onload = () => setDocuments((d) => d.map((x, j) => (j === i ? { ...x, data: String(reader.result), fileName: f.name } : x)));
    reader.readAsDataURL(f);
  };
  const submit = () => {
    setBusy(true);
    api
      .post('/api/risk/kyb', {
        legalName: form.legalName.trim(),
        registrationNumber: form.registrationNumber.trim(),
        country: form.country,
        address: form.address.trim(),
        mcc: form.mcc.trim() || null,
        expectedMonthlyVolume: Math.round(Number(form.expectedMonthlyVolume || 0)),
        licenceRef: form.licenceRef.trim() || null,
        directors: directors.filter((d) => d.name.trim().length >= 2).map((d) => ({ name: d.name.trim(), role: d.role.trim() || null })),
        documents: documents.filter((d) => d.ref.trim() || d.data).map((d) => ({ kind: d.kind, ref: d.ref.trim() || d.fileName || null, data: d.data || null })),
      })
      .then(() => {
        toast(tr('Dossier submitted. You will be notified when it is reviewed.'), 'success');
        kyb.reload();
      })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setBusy(false));
  };
  const canSubmit = form.legalName.trim().length >= 2 && form.registrationNumber.trim().length >= 2 && form.address.trim().length >= 5 && directors.some((d) => d.name.trim().length >= 2);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Business verification (KYB)')}</h3>
        <p className="small muted">
          {tr(
            'The dossier of your business: trade register, activity, directors and beneficial owners, supporting documents. It is reviewed by a BitriPay administrator; a verified business is Tier 4.',
          )}
        </p>
        <KV k={tr('Status')} v={<StatusBadge status={status} />} />
        {latest && (
          <div className="card soft compact small">
            <KV k={tr('Last dossier')} v={`${latest.legalName} · ${latest.registrationNumber} · ${new Date(latest.createdAt).toLocaleDateString()}`} />
            <KV k={tr('Directors')} v={(latest.directors ?? []).map((d: any) => d.name).join(', ')} />
            <KV k={tr('Documents')} v={(latest.documents ?? []).map((d: any) => `${d.kind}${d.hasFile ? ' 📎' : ''}`).join(', ') || '—'} />
            {latest.note && <Alert kind={latest.status === 'rejected' ? 'error' : 'info'}>{latest.note}</Alert>}
          </div>
        )}
        {status === 'verified' && <Alert kind="success">{tr('Your business is verified.')}</Alert>}
        {status === 'pending' && <Alert kind="info">{tr('Your dossier is under review.')}</Alert>}
      </div>
      {status !== 'verified' && status !== 'pending' && (
        <div className="card">
          <h3>{tr('File the dossier')}</h3>
          <div className="grid cols-2">
            <Field label={tr('Legal name (raison sociale)')}>
              <Input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
            </Field>
            <Field label={tr('Trade register number (RCCM)')}>
              <Input value={form.registrationNumber} onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} placeholder={tr('CD/KIN/RCCM/…')} />
            </Field>
            <Field label={tr('Country')}>
              <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
                {(config?.countries ?? []).map((c) => (
                  <option key={c.code} value={c.code}>
                    {countryLabel(c.code, c.name)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('Activity (MCC or description)')}>
              <Input value={form.mcc} onChange={(e) => setForm({ ...form, mcc: e.target.value.slice(0, 8) })} placeholder="5411" />
            </Field>
          </div>
          <Field label={tr('Business address')}>
            <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <div className="grid cols-2">
            <Field label={tr('Expected monthly volume (base currency, minor units)')}>
              <Input type="number" min={0} value={form.expectedMonthlyVolume} onChange={(e) => setForm({ ...form, expectedMonthlyVolume: e.target.value })} />
            </Field>
            <Field label={tr('Sector licence reference (optional)')}>
              <Input value={form.licenceRef} onChange={(e) => setForm({ ...form, licenceRef: e.target.value })} />
            </Field>
          </div>
          <Field label={tr('Directors and beneficial owners')}>
            {directors.map((d, i) => (
              <div key={i} className="row" style={{ marginBottom: 6 }}>
                <Input value={d.name} placeholder={tr('Full name')} onChange={(e) => setDirectors(directors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input value={d.role} placeholder={tr('Role')} onChange={(e) => setDirectors(directors.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
                {directors.length > 1 && (
                  <Button size="sm" variant="ghost" onClick={() => setDirectors(directors.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                )}
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setDirectors([...directors, { name: '', role: '' }])}>
              {tr('+ Add a person')}
            </Button>
          </Field>
          <Field label={tr('Documents')} hint={tr('Reference and/or file (PDF or image, under 2.5 MB). Files are encrypted at rest.')}>
            {documents.map((d, i) => (
              <div key={i} className="row wrap" style={{ marginBottom: 6 }}>
                <Select value={d.kind} onChange={(e) => setDocuments(documents.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                  {DOCUMENT_KINDS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {tr(label)}
                    </option>
                  ))}
                </Select>
                <Input value={d.ref} placeholder={tr('Reference / number')} onChange={(e) => setDocuments(documents.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))} />
                <input type="file" accept="image/*,.pdf" onChange={file(i)} />
                {d.data && <Chip kind="success">{d.fileName || tr('file attached')}</Chip>}
                {documents.length > 1 && (
                  <Button size="sm" variant="ghost" onClick={() => setDocuments(documents.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                )}
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setDocuments([...documents, { kind: 'other', ref: '', data: '', fileName: '' }])}>
              {tr('+ Add a document')}
            </Button>
          </Field>
          <Button onClick={submit} disabled={busy || !canSubmit}>
            {tr('Submit the dossier')}
          </Button>
        </div>
      )}
    </div>
  );
}
