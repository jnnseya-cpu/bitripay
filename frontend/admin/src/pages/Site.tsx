import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Field, Input, PageHeader, Switch, Tabs, Textarea, useAsync, Select } from '../components/ui';

function ImageField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <Field label={label}>
      <div className="row">
        {value && <img src={value} alt="" style={{ height: 40, borderRadius: 6, background: '#fff' }} />}
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = () => onChange(String(r.result));
            r.readAsDataURL(f);
          }}
        />
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            {tr('Remove')}
          </Button>
        )}
      </div>
    </Field>
  );
}

export function Site() {
  const { toast, refresh, config } = useStore();
  const settings = useAsync(() => api.get<any>('/api/admin/settings'), []);
  const [site, setSite] = useState<any>(null);
  const [tab, setTab] = useState<'basic' | 'seo' | 'apps' | 'onboarding' | 'links' | 'gdpr'>('basic');
  useEffect(() => {
    if (settings.data) setSite(settings.data.site);
  }, [settings.data]);
  if (!site) return null;
  const save = async () => {
    try {
      await api.put('/api/admin/site', site);
      toast(tr('Site settings saved'), 'success');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const set = (k: string, v: unknown) => setSite({ ...site, [k]: v });
  return (
    <div>
      <PageHeader
        title={tr('Web, SEO & app settings')}
        subtitle={tr('Branding, contact details, SEO, image assets, splash & onboarding screens, app URLs, useful links and GDPR cookie')}
        actions={<Button onClick={save}>{tr('Save all')}</Button>}
      />
      <Tabs
        tabs={[
          { id: 'basic', label: tr('Basic web settings') },
          { id: 'seo', label: tr('SEO & images') },
          { id: 'apps', label: tr('App URLs & social') },
          { id: 'onboarding', label: tr('Splash & onboarding') },
          { id: 'links', label: tr('Useful links') },
          { id: 'gdpr', label: tr('GDPR cookie') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      <div className="card">
        {tab === 'basic' && (
          <div className="grid cols-2">
            <Field label={tr('Site name')}>
              <Input value={site.siteName} onChange={(e) => set('siteName', e.target.value)} />
            </Field>
            <Field label={tr('Tagline')}>
              <Input value={site.tagline} onChange={(e) => set('tagline', e.target.value)} />
            </Field>
            <Field label={tr('Contact email')}>
              <Input value={site.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
            </Field>
            <Field label={tr('Contact phone')}>
              <Input value={site.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            </Field>
            <Field label={tr('Address')}>
              <Input value={site.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label={tr('Primary color')}>
              <Input type="color" value={site.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} />
            </Field>
            <Field label={tr('Default language')}>
              <Select value={site.defaultLanguage} onChange={(e) => set('defaultLanguage', e.target.value)}>
                {(config?.languages ?? []).map((l: any) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <Switch on={site.darkModeDefault} onChange={(v) => set('darkModeDefault', v)} label={tr('Dark mode by default')} />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <Field label={tr('Description (landing page)')}>
                <Textarea value={site.description} onChange={(e) => set('description', e.target.value)} />
              </Field>
            </div>
          </div>
        )}
        {tab === 'seo' && (
          <div>
            <div className="grid cols-2">
              <Field label={tr('SEO title')}>
                <Input value={site.seo.title} onChange={(e) => set('seo', { ...site.seo, title: e.target.value })} />
              </Field>
              <Field label={tr('Keywords')}>
                <Input value={site.seo.keywords} onChange={(e) => set('seo', { ...site.seo, keywords: e.target.value })} />
              </Field>
            </div>
            <Field label={tr('Meta description')}>
              <Textarea value={site.seo.description} onChange={(e) => set('seo', { ...site.seo, description: e.target.value })} />
            </Field>
            <h4>{tr('Image assets')}</h4>
            <div className="grid cols-3">
              <ImageField label={tr('Logo')} value={site.logoUrl} onChange={(v) => set('logoUrl', v)} />
              <ImageField label={tr('Favicon')} value={site.faviconUrl} onChange={(v) => set('faviconUrl', v)} />
              <ImageField label={tr('Social share image (og:image)')} value={site.seo.ogImage} onChange={(v) => set('seo', { ...site.seo, ogImage: v })} />
            </div>
          </div>
        )}
        {tab === 'apps' && (
          <div className="grid cols-2">
            {Object.keys(site.appUrls).map((k) => (
              <Field key={k} label={`${k} URL`}>
                <Input value={site.appUrls[k]} onChange={(e) => set('appUrls', { ...site.appUrls, [k]: e.target.value })} />
              </Field>
            ))}
            {Object.keys(site.social).map((k) => (
              <Field key={k} label={k}>
                <Input value={site.social[k]} onChange={(e) => set('social', { ...site.social, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
        )}
        {tab === 'onboarding' && (
          <div>
            <h4>{tr('Splash screen (mobile)')}</h4>
            <div className="grid cols-3">
              <Field label={tr('Headline')}>
                <Input value={site.splash.headline} onChange={(e) => set('splash', { ...site.splash, headline: e.target.value })} />
              </Field>
              <Field label={tr('Sub-headline')}>
                <Input value={site.splash.subheadline} onChange={(e) => set('splash', { ...site.splash, subheadline: e.target.value })} />
              </Field>
              <Field label={tr('Background color')}>
                <Input type="color" value={site.splash.backgroundColor} onChange={(e) => set('splash', { ...site.splash, backgroundColor: e.target.value })} />
              </Field>
            </div>
            <ImageField label={tr('Splash image')} value={site.splash.imageUrl} onChange={(v) => set('splash', { ...site.splash, imageUrl: v })} />
            <h4>{tr('Onboarding screens')}</h4>
            {site.onboarding.map((o: any, i: number) => (
              <div key={i} className="card soft compact mb">
                <div className="grid cols-3">
                  <Field label={tr('Title')}>
                    <Input
                      value={o.title}
                      onChange={(e) =>
                        set(
                          'onboarding',
                          site.onboarding.map((x: any, j: number) => (j === i ? { ...x, title: e.target.value } : x)),
                        )
                      }
                    />
                  </Field>
                  <Field label={tr('Body')}>
                    <Input
                      value={o.body}
                      onChange={(e) =>
                        set(
                          'onboarding',
                          site.onboarding.map((x: any, j: number) => (j === i ? { ...x, body: e.target.value } : x)),
                        )
                      }
                    />
                  </Field>
                  <Field label={tr('Color')}>
                    <Input
                      type="color"
                      value={o.color}
                      onChange={(e) =>
                        set(
                          'onboarding',
                          site.onboarding.map((x: any, j: number) => (j === i ? { ...x, color: e.target.value } : x)),
                        )
                      }
                    />
                  </Field>
                </div>
                <div className="row">
                  <ImageField
                    label={tr('Illustration')}
                    value={o.imageUrl}
                    onChange={(v) =>
                      set(
                        'onboarding',
                        site.onboarding.map((x: any, j: number) => (j === i ? { ...x, imageUrl: v } : x)),
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      set(
                        'onboarding',
                        site.onboarding.filter((_: any, j: number) => j !== i),
                      )
                    }
                  >
                    {tr('Remove')}
                  </Button>
                </div>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('onboarding', [...site.onboarding, { title: '', body: '', imageUrl: null, color: '#2563eb' }])}>
              {tr('+ Add screen')}
            </Button>
          </div>
        )}
        {tab === 'links' && (
          <div>
            {site.usefulLinks.map((l: any, i: number) => (
              <div key={i} className="row mb-sm">
                <Input
                  value={l.label}
                  placeholder={tr('Label')}
                  onChange={(e) =>
                    set(
                      'usefulLinks',
                      site.usefulLinks.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  value={l.url}
                  placeholder="/pages/faq or https://…"
                  onChange={(e) =>
                    set(
                      'usefulLinks',
                      site.usefulLinks.map((x: any, j: number) => (j === i ? { ...x, url: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    set(
                      'usefulLinks',
                      site.usefulLinks.filter((_: any, j: number) => j !== i),
                    )
                  }
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('usefulLinks', [...site.usefulLinks, { label: '', url: '' }])}>
              {tr('+ Add link')}
            </Button>
          </div>
        )}
        {tab === 'gdpr' && (
          <div>
            <Switch on={site.gdpr.enabled} onChange={(v) => set('gdpr', { ...site.gdpr, enabled: v })} label={tr('Show cookie consent banner')} />
            <Field label={tr('Message')}>
              <Textarea value={site.gdpr.message} onChange={(e) => set('gdpr', { ...site.gdpr, message: e.target.value })} />
            </Field>
            <Field label={tr('Policy URL')}>
              <Input value={site.gdpr.policyUrl} onChange={(e) => set('gdpr', { ...site.gdpr, policyUrl: e.target.value })} />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}
