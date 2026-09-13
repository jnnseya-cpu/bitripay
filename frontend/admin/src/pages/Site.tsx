import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, PageHeader, Switch, Tabs, Textarea, useAsync, Select } from '../components/ui';

function ImageField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <Field label={label}>
      <div className="row">
        {value && <img src={value} alt="" style={{ height: 40, borderRadius: 6, background: '#fff' }} />}
        <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => onChange(String(r.result)); r.readAsDataURL(f); }} />
        {value && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Remove</Button>}
      </div>
    </Field>
  );
}

export function Site() {
  const { toast, refresh, config } = useStore();
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const [site, setSite] = useState<any>(null);
  const [tab, setTab] = useState<'basic' | 'seo' | 'apps' | 'onboarding' | 'links' | 'gdpr'>('basic');
  useEffect(() => { if (settings.data) setSite(settings.data.site); }, [settings.data]);
  if (!site) return null;
  const save = async () => {
    try {
      await api.put('/api/admin/site', site);
      toast('Site settings saved', 'success');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const set = (k: string, v: unknown) => setSite({ ...site, [k]: v });
  return (
    <div>
      <PageHeader title="Web, SEO & app settings" subtitle="Branding, contact details, SEO, image assets, splash & onboarding screens, app URLs, useful links and GDPR cookie" actions={<Button onClick={save}>Save all</Button>} />
      <Tabs tabs={[{ id: 'basic', label: 'Basic web settings' }, { id: 'seo', label: 'SEO & images' }, { id: 'apps', label: 'App URLs & social' }, { id: 'onboarding', label: 'Splash & onboarding' }, { id: 'links', label: 'Useful links' }, { id: 'gdpr', label: 'GDPR cookie' }]} value={tab} onChange={(v) => setTab(v as any)} />
      <div className="card">
        {tab === 'basic' && (
          <div className="grid cols-2">
            <Field label="Site name"><Input value={site.siteName} onChange={(e) => set('siteName', e.target.value)} /></Field>
            <Field label="Tagline"><Input value={site.tagline} onChange={(e) => set('tagline', e.target.value)} /></Field>
            <Field label="Contact email"><Input value={site.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} /></Field>
            <Field label="Contact phone"><Input value={site.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} /></Field>
            <Field label="Address"><Input value={site.address} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label="Primary color"><Input type="color" value={site.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} /></Field>
            <Field label="Default language"><Select value={site.defaultLanguage} onChange={(e) => set('defaultLanguage', e.target.value)}>{(config?.languages ?? []).map((l: any) => <option key={l.code} value={l.code}>{l.name}</option>)}</Select></Field>
            <div><Switch on={site.darkModeDefault} onChange={(v) => set('darkModeDefault', v)} label="Dark mode by default" /></div>
            <div style={{ gridColumn: 'span 2' }}><Field label="Description (landing page)"><Textarea value={site.description} onChange={(e) => set('description', e.target.value)} /></Field></div>
          </div>
        )}
        {tab === 'seo' && (
          <div>
            <div className="grid cols-2">
              <Field label="SEO title"><Input value={site.seo.title} onChange={(e) => set('seo', { ...site.seo, title: e.target.value })} /></Field>
              <Field label="Keywords"><Input value={site.seo.keywords} onChange={(e) => set('seo', { ...site.seo, keywords: e.target.value })} /></Field>
            </div>
            <Field label="Meta description"><Textarea value={site.seo.description} onChange={(e) => set('seo', { ...site.seo, description: e.target.value })} /></Field>
            <h4>Image assets</h4>
            <div className="grid cols-3">
              <ImageField label="Logo" value={site.logoUrl} onChange={(v) => set('logoUrl', v)} />
              <ImageField label="Favicon" value={site.faviconUrl} onChange={(v) => set('faviconUrl', v)} />
              <ImageField label="Social share image (og:image)" value={site.seo.ogImage} onChange={(v) => set('seo', { ...site.seo, ogImage: v })} />
            </div>
          </div>
        )}
        {tab === 'apps' && (
          <div className="grid cols-2">
            {Object.keys(site.appUrls).map((k) => <Field key={k} label={`${k} URL`}><Input value={site.appUrls[k]} onChange={(e) => set('appUrls', { ...site.appUrls, [k]: e.target.value })} /></Field>)}
            {Object.keys(site.social).map((k) => <Field key={k} label={k}><Input value={site.social[k]} onChange={(e) => set('social', { ...site.social, [k]: e.target.value })} /></Field>)}
          </div>
        )}
        {tab === 'onboarding' && (
          <div>
            <h4>Splash screen (mobile)</h4>
            <div className="grid cols-3">
              <Field label="Headline"><Input value={site.splash.headline} onChange={(e) => set('splash', { ...site.splash, headline: e.target.value })} /></Field>
              <Field label="Sub-headline"><Input value={site.splash.subheadline} onChange={(e) => set('splash', { ...site.splash, subheadline: e.target.value })} /></Field>
              <Field label="Background color"><Input type="color" value={site.splash.backgroundColor} onChange={(e) => set('splash', { ...site.splash, backgroundColor: e.target.value })} /></Field>
            </div>
            <ImageField label="Splash image" value={site.splash.imageUrl} onChange={(v) => set('splash', { ...site.splash, imageUrl: v })} />
            <h4>Onboarding screens</h4>
            {site.onboarding.map((o: any, i: number) => (
              <div key={i} className="card soft compact mb">
                <div className="grid cols-3">
                  <Field label="Title"><Input value={o.title} onChange={(e) => set('onboarding', site.onboarding.map((x: any, j: number) => (j === i ? { ...x, title: e.target.value } : x)))} /></Field>
                  <Field label="Body"><Input value={o.body} onChange={(e) => set('onboarding', site.onboarding.map((x: any, j: number) => (j === i ? { ...x, body: e.target.value } : x)))} /></Field>
                  <Field label="Color"><Input type="color" value={o.color} onChange={(e) => set('onboarding', site.onboarding.map((x: any, j: number) => (j === i ? { ...x, color: e.target.value } : x)))} /></Field>
                </div>
                <div className="row"><ImageField label="Illustration" value={o.imageUrl} onChange={(v) => set('onboarding', site.onboarding.map((x: any, j: number) => (j === i ? { ...x, imageUrl: v } : x)))} /><Button size="sm" variant="ghost" onClick={() => set('onboarding', site.onboarding.filter((_: any, j: number) => j !== i))}>Remove</Button></div>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('onboarding', [...site.onboarding, { title: '', body: '', imageUrl: null, color: '#2563eb' }])}>+ Add screen</Button>
          </div>
        )}
        {tab === 'links' && (
          <div>
            {site.usefulLinks.map((l: any, i: number) => <div key={i} className="row mb-sm"><Input value={l.label} placeholder="Label" onChange={(e) => set('usefulLinks', site.usefulLinks.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)))} /><Input value={l.url} placeholder="/pages/faq or https://…" onChange={(e) => set('usefulLinks', site.usefulLinks.map((x: any, j: number) => (j === i ? { ...x, url: e.target.value } : x)))} /><Button size="sm" variant="ghost" onClick={() => set('usefulLinks', site.usefulLinks.filter((_: any, j: number) => j !== i))}>✕</Button></div>)}
            <Button variant="secondary" size="sm" onClick={() => set('usefulLinks', [...site.usefulLinks, { label: '', url: '' }])}>+ Add link</Button>
          </div>
        )}
        {tab === 'gdpr' && (
          <div>
            <Switch on={site.gdpr.enabled} onChange={(v) => set('gdpr', { ...site.gdpr, enabled: v })} label="Show cookie consent banner" />
            <Field label="Message"><Textarea value={site.gdpr.message} onChange={(e) => set('gdpr', { ...site.gdpr, message: e.target.value })} /></Field>
            <Field label="Policy URL"><Input value={site.gdpr.policyUrl} onChange={(e) => set('gdpr', { ...site.gdpr, policyUrl: e.target.value })} /></Field>
          </div>
        )}
      </div>
    </div>
  );
}
