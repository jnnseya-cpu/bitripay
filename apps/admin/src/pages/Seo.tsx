import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, ConfirmButton, Field, Input, KV, Modal, PageHeader, Select, Switch, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

/**
 * Blog & SEO console: articles (write, review, publish, schedule), the AI content agent (draft, keywords, audit,
 * social pack), dynamic hyperlink rules, backlinks and outreach, page views, feeds and IndexNow, settings.
 */
export function Seo() {
  const { toast, can } = useStore();
  const data = useAsync(() => api.get<any>('/api/admin/seo'), []);
  const ok = (m: string) => { toast(m, 'success'); data.reload(); };
  const err = (e: any) => toast(e.message, 'error');
  const [tab, setTab] = useState<'posts' | 'agent' | 'links' | 'backlinks' | 'settings'>('posts');
  const [edit, setEdit] = useState<any>(null);
  const [draft, setDraft] = useState({ topic: '', keywords: '', language: 'en', extraInstructions: '' });
  const [seed, setSeed] = useState('');
  const [ideas, setIdeas] = useState<any[]>([]);
  const [audit, setAudit] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rule, setRule] = useState<any>(null);
  const [backlink, setBacklink] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const d = data.data;
  const agent = d?.agent;
  const posts: any[] = d?.posts ?? [];
  const openEditor = async (id?: string) => {
    if (!id) return setEdit({ title: '', slug: '', excerpt: '', bodyMd: '', category: 'guides', tags: '', keywords: '', metaTitle: '', metaDescription: '', status: 'draft', faq: [], sources: [] });
    const r = await api.get<any>(`/api/admin/blog/posts/${id}`);
    const p = r.post;
    setEdit({ ...p, tags: p.tags.join(', '), keywords: p.keywords.join(', ') });
  };
  const savePost = async () => {
    const body: any = { title: edit.title, slug: edit.slug || null, excerpt: edit.excerpt || null, bodyMd: edit.bodyMd, category: edit.category, tags: String(edit.tags).split(',').map((x: string) => x.trim()).filter(Boolean), keywords: String(edit.keywords).split(',').map((x: string) => x.trim()).filter(Boolean), metaTitle: edit.metaTitle || null, metaDescription: edit.metaDescription || null, status: edit.status, faq: edit.faq ?? [], sources: edit.sources ?? [], coverUrl: edit.coverUrl || null, coverAlt: edit.coverAlt || null, scheduledFor: edit.status === 'scheduled' ? edit.scheduledFor || null : null };
    try {
      if (edit.id) await api.patch(`/api/admin/blog/posts/${edit.id}`, body);
      else await api.post('/api/admin/blog/posts', body);
      setEdit(null);
      ok('Article saved');
    } catch (e) { err(e); }
  };
  const run = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn(); } catch (e) { err(e); } finally { setBusy(null); } };
  const statusChip = (s: string) => <Chip kind={s === 'published' ? 'success' : s === 'review' ? 'warning' : s === 'archived' ? 'danger' : undefined}>{s}</Chip>;

  return (
    <div>
      <PageHeader title="Blog & SEO" subtitle="Articles written by editors or drafted by the AI agent, dynamic internal links, backlinks, feeds and structured data. Everything the search engines, social networks and AI answer engines read is rendered on the server." actions={<><Button variant="secondary" onClick={() => setTab('agent')}>✨ Ask the agent</Button><Button onClick={() => openEditor()}>+ New article</Button></>} />
      {agent && <Alert kind={agent.keyConfigured ? 'success' : 'warning'}>{agent.keyConfigured ? <>Content agent <b>live</b> on {agent.model}. Drafts go to review{agent.autoPublish ? ' and are published automatically' : ' until an editor publishes them'}; {agent.postsPerWeek} article(s) per week from a backlog of {agent.topicsQueued} topic(s).</> : <>Content agent in <b>offline mode</b>: no Anthropic API key configured, so drafts, keyword ideas and audits use built-in templates and checks. Add the key under Settings to switch to the live model ({agent.model}).</>}</Alert>}
      <Tabs tabs={[{ id: 'posts', label: `Articles (${posts.length})` }, { id: 'agent', label: 'AI content agent' }, { id: 'links', label: 'Dynamic links' }, { id: 'backlinks', label: 'Backlinks & outreach' }, { id: 'settings', label: 'SEO settings' }]} value={tab} onChange={(v) => setTab(v as any)} />

      {tab === 'posts' && (
        <>
          <div className="grid cols-4 mb">
            <div className="card"><KV k="Published" v={posts.filter((p) => p.status === 'published').length} /></div>
            <div className="card"><KV k="In review" v={posts.filter((p) => p.status === 'review').length} /></div>
            <div className="card"><KV k="Views (30 days)" v={d?.views?.total ?? 0} /></div>
            <div className="card"><KV k="Feeds" v={<span className="tiny"><a href="/sitemap.xml" target="_blank" rel="noreferrer">sitemap</a> · <a href="/feed.xml" target="_blank" rel="noreferrer">rss</a> · <a href="/llms.txt" target="_blank" rel="noreferrer">llms.txt</a></span>} /></div>
          </div>
          <div className="card">
            <Table head={['Title', 'Status', 'Source', 'Tags', 'Views', 'Published', '']} rows={posts.map((p) => [<div><b>{p.title}</b><div className="tiny muted">/blog/{p.slug} · {p.readingMinutes} min</div></div>, statusChip(p.status), p.source === 'agent' ? <Chip kind="primary">agent</Chip> : p.source, <span className="tiny">{p.tags.join(', ')}</span>, p.views, fmtDate(p.publishedAt), <div className="row wrap"><Button size="sm" variant="secondary" onClick={() => openEditor(p.id)}>Edit</Button>{p.status !== 'published' && <Button size="sm" variant="success" onClick={() => api.patch(`/api/admin/blog/posts/${p.id}`, { status: 'published' }).then(() => ok('Published')).catch(err)}>Publish</Button>}{p.status === 'published' && <a className="btn sm ghost" href={`/blog/${p.slug}`} target="_blank" rel="noreferrer">View</a>}<Button size="sm" variant="ghost" onClick={() => run(`audit:${p.id}`, () => api.post<any>(`/api/admin/seo/agent/audit/${p.id}`).then((r) => { setAudit({ post: p, ...r }); setTab('agent'); }))}>Audit</Button><ConfirmButton size="sm" variant="danger" onConfirm={() => api.del(`/api/admin/blog/posts/${p.id}`).then(() => ok('Deleted')).catch(err)}>Delete</ConfirmButton></div>])} empty="No articles yet" />
          </div>
        </>
      )}

      {tab === 'agent' && (
        <div className="grid cols-2">
          <div className="card">
            <h4>Draft an article</h4>
            <p className="tiny muted">The agent writes for the site's audience with the site's facts, proposes internal links and a social pack, and files the draft for review. It never invents numbers, partners or licences.</p>
            <Field label="Topic or working title"><Input value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} placeholder="How to pay school fees with mobile money" /></Field>
            <Field label="Target keywords (comma-separated, optional)"><Input value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} /></Field>
            <div className="grid cols-2"><Field label="Language"><Select value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })}><option value="en">English</option><option value="fr">Français</option><option value="sw">Kiswahili</option><option value="ln">Lingala</option></Select></Field></div>
            <Field label="Editor notes (optional)"><Textarea rows={2} value={draft.extraInstructions} onChange={(e) => setDraft({ ...draft, extraInstructions: e.target.value })} /></Field>
            <Button loading={busy === 'draft'} disabled={draft.topic.length < 4} onClick={() => run('draft', () => api.post<any>('/api/admin/seo/agent/draft', { topic: draft.topic, keywords: draft.keywords.split(',').map((x) => x.trim()).filter(Boolean), language: draft.language, extraInstructions: draft.extraInstructions || null }).then((r) => { ok(`Draft "${r.post.title}" filed for review (${r.run.status})`); setDraft({ ...draft, topic: '' }); setTab('posts'); }))}>Draft with the agent</Button>
            <div className="divider" />
            <h4>Keyword ideas</h4>
            <div className="row"><Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="Seed topic, e.g. school fees" /><Button variant="secondary" loading={busy === 'kw'} disabled={seed.length < 2} onClick={() => run('kw', () => api.post<any>('/api/admin/seo/agent/keywords', { seed }).then((r) => setIdeas(r.ideas)))}>Suggest</Button></div>
            {ideas.length > 0 && <Table head={['Query', 'Intent', 'Difficulty', 'Angle', '']} rows={ideas.map((i) => [<b>{i.keyword}</b>, i.intent, <Chip kind={i.difficulty === 'low' ? 'success' : i.difficulty === 'high' ? 'danger' : 'warning'}>{i.difficulty}</Chip>, <span className="tiny">{i.angle}</span>, <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, topic: i.keyword, keywords: i.keyword })}>Use</Button>])} />}
          </div>
          <div className="card">
            {audit ? (
              <>
                <div className="row between"><h4>Audit · {audit.post.title}</h4><Chip kind={audit.audit.score >= 80 ? 'success' : audit.audit.score >= 60 ? 'warning' : 'danger'}>score {audit.audit.score}</Chip></div>
                <p className="tiny muted">{audit.audit.summary} {audit.run?.status === 'fallback' ? '(automated checks only)' : `(model: ${audit.run?.model})`}</p>
                <Table head={['Severity', 'Issue', 'Fix']} rows={audit.audit.issues.map((i: any) => [<Chip kind={i.severity === 'high' ? 'danger' : i.severity === 'medium' ? 'warning' : undefined}>{i.severity}</Chip>, i.issue, <span className="tiny">{i.fix}</span>])} empty="No issues found" />
                <KV k="Suggested title" v={audit.audit.suggestedTitle} /><KV k="Suggested description" v={<span className="tiny">{audit.audit.suggestedDescription}</span>} />
                <div className="row mt"><Button size="sm" variant="secondary" onClick={() => run('social', () => api.post<any>(`/api/admin/seo/agent/social/${audit.post.id}`).then(() => ok('Social pack written to the article')))}>Write social pack</Button><Button size="sm" variant="ghost" onClick={() => setAudit(null)}>Close</Button></div>
              </>
            ) : (
              <>
                <h4>Recent agent runs</h4>
                <Table head={['When', 'Task', 'Model', 'Tokens', 'Status', 'Article']} rows={(d?.runs ?? []).map((r: any) => [fmtDate(r.createdAt), r.task.replace(/_/g, ' '), r.model ?? '—', r.inputTokens + r.outputTokens || '—', <Chip kind={r.status === 'ok' ? 'success' : r.status === 'fallback' ? 'warning' : 'danger'} >{r.status}</Chip>, r.postId ? <span className="tiny">{posts.find((p) => p.id === r.postId)?.title ?? r.postId.slice(0, 8)}</span> : '—'])} empty="No runs yet" />
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'links' && (
        <div className="card">
          <div className="row between mb"><div><h4>Dynamic hyperlinks</h4><div className="tiny muted">Keywords that become links automatically wherever they appear in articles and policy pages (first N occurrences, never inside headings, code or existing links). Published articles also link to each other through their keywords.</div></div><Button onClick={() => setRule({ keyword: '', url: '/', title: '', kind: 'internal', maxPerPage: 1, priority: 50, enabled: true })}>+ Rule</Button></div>
          <Table head={['Keyword', 'Links to', 'Kind', 'Max / page', 'Priority', 'On', '']} rows={(d?.rules ?? []).map((r: any) => [<b>{r.keyword}</b>, <span className="tiny mono">{r.url}</span>, r.kind, r.maxPerPage, r.priority, r.enabled ? <Chip kind="success">on</Chip> : <Chip>off</Chip>, <div className="row"><Button size="sm" variant="secondary" onClick={() => setRule(r)}>Edit</Button><ConfirmButton size="sm" variant="danger" onConfirm={() => api.del(`/api/admin/seo/rules/${r.id}`).then(() => ok('Rule removed')).catch(err)}>Delete</ConfirmButton></div>])} empty="No link rules" />
        </div>
      )}

      {tab === 'backlinks' && (
        <>
          <div className="card mb">
            <div className="row between mb"><div><h4>Backlinks</h4><div className="tiny muted">Inbound links are discovered automatically from referrers; partner and outbound links are tracked and re-verified weekly.</div></div><div className="row"><Button variant="secondary" onClick={() => run('verify', () => api.post<any>('/api/admin/seo/backlinks/verify').then((r) => ok(`Checked ${r.checked}, lost ${r.lost}`)))}>Re-verify</Button><Button onClick={() => setBacklink({ direction: 'partner', sourceUrl: '', targetUrl: '/', anchor: '', status: 'pending', notes: '' })}>+ Backlink</Button></div></div>
            <Table head={['Direction', 'Source', 'Target', 'Status', 'Hits', 'Last seen', '']} rows={(d?.backlinks ?? []).map((b: any) => [<Chip kind={b.direction === 'inbound' ? 'success' : b.direction === 'partner' ? 'primary' : undefined}>{b.direction}</Chip>, <span className="tiny"><b>{b.sourceDomain}</b><br /><span className="mono">{b.sourceUrl.slice(0, 60)}</span></span>, <span className="tiny mono">{b.targetUrl.replace(/^https?:\/\/[^/]+/, '')}</span>, <Chip kind={b.status === 'live' ? 'success' : b.status === 'lost' ? 'danger' : 'warning'}>{b.status}</Chip>, b.hits, fmtDate(b.lastSeenAt), <div className="row"><Button size="sm" variant="secondary" onClick={() => setBacklink(b)}>Edit</Button><ConfirmButton size="sm" variant="danger" onConfirm={() => api.del(`/api/admin/seo/backlinks/${b.id}`).then(() => ok('Removed')).catch(err)}>Delete</ConfirmButton></div>])} empty="No backlinks recorded yet" />
          </div>
          <div className="card mb">
            <h4>Outreach candidates</h4>
            <p className="tiny muted">Sites our articles cite that do not link back yet. Citing them first is the honest way to ask for a link.</p>
            <Table head={['Domain', 'Cited in', 'Links back?']} rows={(d?.outreach ?? []).map((o: any) => [<b>{o.domain}</b>, <span className="tiny">{o.citedIn.join(' · ')}</span>, o.linksBack ? <Chip kind="success">yes</Chip> : <Chip kind="warning">not yet</Chip>])} empty="Publish articles with sources to build this list" />
          </div>
          <div className="card">
            <h4>Most viewed pages (30 days)</h4>
            <Table head={['Path', 'Views']} rows={(d?.views?.byPath ?? []).slice(0, 20).map((v: any) => [<span className="mono tiny">{v.path}</span>, v.views])} empty="No views yet" />
          </div>
        </>
      )}

      {tab === 'settings' && d && (
        <div className="card">
          {!settings && <Button variant="secondary" onClick={() => setSettings(JSON.parse(JSON.stringify(d.settings)))}>Edit settings</Button>}
          {settings && (
            <>
              <div className="grid cols-2">
                <Field label="Site name"><Input value={settings.siteName} onChange={(e) => setSettings({ ...settings, siteName: e.target.value })} /></Field>
                <Field label="Public site URL (canonical, sitemap)" hint="e.g. https://bitripay.app"><Input value={settings.siteUrl} onChange={(e) => setSettings({ ...settings, siteUrl: e.target.value })} /></Field>
                <Field label="Default title"><Input value={settings.defaultTitle} onChange={(e) => setSettings({ ...settings, defaultTitle: e.target.value })} /></Field>
                <Field label="Title suffix"><Input value={settings.titleSuffix} onChange={(e) => setSettings({ ...settings, titleSuffix: e.target.value })} /></Field>
                <Field label="Twitter / X handle"><Input value={settings.twitterHandle} onChange={(e) => setSettings({ ...settings, twitterHandle: e.target.value })} /></Field>
                <Field label="IndexNow key" hint="Any 8-64 character key; published at /<key>.txt and used to notify Bing, Yandex, Seznam and Naver on every publish"><Input value={settings.indexNowKey} onChange={(e) => setSettings({ ...settings, indexNowKey: e.target.value })} /></Field>
                <Field label="Languages (hreflang, comma-separated)"><Input value={(settings.languages ?? []).join(', ')} onChange={(e) => setSettings({ ...settings, languages: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
                <Field label="Legal name (structured data)"><Input value={settings.organization?.legalName ?? ''} onChange={(e) => setSettings({ ...settings, organization: { ...settings.organization, legalName: e.target.value } })} /></Field>
              </div>
              <Field label="Default description"><Textarea rows={2} value={settings.defaultDescription} onChange={(e) => setSettings({ ...settings, defaultDescription: e.target.value })} /></Field>
              <Field label="Social profiles (sameAs, one URL per line)"><Textarea rows={3} value={(settings.organization?.sameAs ?? []).join('\n')} onChange={(e) => setSettings({ ...settings, organization: { ...settings.organization, sameAs: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) } })} /></Field>
              <div className="divider" />
              <h4>AI content agent</h4>
              <div className="grid cols-2">
                <Field label="Anthropic API key" hint="Stored encrypted. Leave the dots to keep the current key."><Input type="password" value={settings.agent.apiKey} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, apiKey: e.target.value } })} /></Field>
                <Field label="Model"><Select value={settings.agent.model} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, model: e.target.value } })}><option value="claude-opus-5">claude-opus-5 (recommended)</option><option value="claude-sonnet-5">claude-sonnet-5</option><option value="claude-haiku-4-5">claude-haiku-4-5</option></Select></Field>
                <Field label="Articles per week from the backlog"><Input type="number" min={0} max={14} value={settings.agent.postsPerWeek} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, postsPerWeek: Number(e.target.value) } })} /></Field>
                <Field label="Markets (ISO countries)"><Input value={(settings.agent.markets ?? []).join(', ')} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, markets: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) } })} /></Field>
              </div>
              <div className="row wrap mb"><Switch on={settings.agent.enabled} onChange={(v) => setSettings({ ...settings, agent: { ...settings.agent, enabled: v } })} label="Agent enabled" /><Switch on={settings.agent.autoPublish} onChange={(v) => setSettings({ ...settings, agent: { ...settings.agent, autoPublish: v } })} label="Auto-publish agent drafts (otherwise they wait for an editor)" /></div>
              <Field label="Audience"><Textarea rows={2} value={settings.agent.audience} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, audience: e.target.value } })} /></Field>
              <Field label="Tone"><Input value={settings.agent.tone} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, tone: e.target.value } })} /></Field>
              <Field label="Topic backlog (one per line; the scheduler works from the top)"><Textarea rows={6} value={(settings.agent.topics ?? []).join('\n')} onChange={(e) => setSettings({ ...settings, agent: { ...settings.agent, topics: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) } })} /></Field>
              <div className="row"><Button disabled={!can('settings')} onClick={() => api.put('/api/admin/seo/settings', settings).then(() => { setSettings(null); ok('SEO settings saved'); }).catch(err)}>Save</Button><Button variant="ghost" onClick={() => setSettings(null)}>Cancel</Button></div>
            </>
          )}
        </div>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit article' : 'New article'} wide>
        {edit && (
          <>
            <div className="grid cols-2">
              <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
              <Field label="Slug"><Input value={edit.slug ?? ''} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} placeholder="auto from title" /></Field>
              <Field label="Category"><Input value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></Field>
              <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="draft">draft</option><option value="review">review</option><option value="scheduled">scheduled</option><option value="published">published</option><option value="archived">archived</option></Select></Field>
              {edit.status === 'scheduled' && <Field label="Publish at (ISO)"><Input value={edit.scheduledFor ?? ''} onChange={(e) => setEdit({ ...edit, scheduledFor: e.target.value })} placeholder="2026-10-01T08:00:00Z" /></Field>}
              <Field label="Tags (comma-separated)"><Input value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} /></Field>
              <Field label="Target keywords (comma-separated; other articles link to this one through them)"><Input value={edit.keywords} onChange={(e) => setEdit({ ...edit, keywords: e.target.value })} /></Field>
              <Field label="Meta title (≤ 60 chars)"><Input value={edit.metaTitle ?? ''} onChange={(e) => setEdit({ ...edit, metaTitle: e.target.value })} /></Field>
              <Field label="Meta description (120–155 chars)"><Input value={edit.metaDescription ?? ''} onChange={(e) => setEdit({ ...edit, metaDescription: e.target.value })} /></Field>
              <Field label="Cover image URL"><Input value={edit.coverUrl ?? ''} onChange={(e) => setEdit({ ...edit, coverUrl: e.target.value })} /></Field>
              <Field label="Cover alt text"><Input value={edit.coverAlt ?? ''} onChange={(e) => setEdit({ ...edit, coverAlt: e.target.value })} /></Field>
            </div>
            <Field label="Excerpt"><Textarea rows={2} value={edit.excerpt ?? ''} onChange={(e) => setEdit({ ...edit, excerpt: e.target.value })} /></Field>
            <Field label="Body (Markdown; use ## headings, lists, tables, links)"><Textarea rows={18} value={edit.bodyMd} onChange={(e) => setEdit({ ...edit, bodyMd: e.target.value })} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }} /></Field>
            <Field label="FAQ (one per line: question | answer)"><Textarea rows={4} value={(edit.faq ?? []).map((f: any) => `${f.question} | ${f.answer}`).join('\n')} onChange={(e) => setEdit({ ...edit, faq: e.target.value.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2).map((p) => ({ question: p[0].trim(), answer: p.slice(1).join('|').trim() })) })} /></Field>
            <Field label="Sources (one per line: title | url)"><Textarea rows={3} value={(edit.sources ?? []).map((s: any) => `${s.title} | ${s.url}`).join('\n')} onChange={(e) => setEdit({ ...edit, sources: e.target.value.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2).map((p) => ({ title: p[0].trim(), url: p.slice(1).join('|').trim() })) })} /></Field>
            <div className="row"><Button onClick={savePost} disabled={!edit.title || (edit.bodyMd ?? '').length < 20}>Save</Button>{edit.id && <Button variant="ghost" onClick={() => run('social2', () => api.post<any>(`/api/admin/seo/agent/social/${edit.id}`).then(() => ok('Social pack written')))}>Write social pack</Button>}</div>
            {edit.social && Object.keys(edit.social).length > 0 && <div className="card soft mt"><b className="small">Social pack</b>{Object.entries(edit.social).map(([k, v]) => <KV key={k} k={k} v={<span className="tiny">{String(v)}</span>} />)}</div>}
          </>
        )}
      </Modal>

      <Modal open={!!rule} onClose={() => setRule(null)} title="Dynamic link rule">
        {rule && (
          <>
            <div className="grid cols-2">
              <Field label="Keyword or phrase"><Input value={rule.keyword} onChange={(e) => setRule({ ...rule, keyword: e.target.value })} /></Field>
              <Field label="Links to (path or URL)"><Input value={rule.url} onChange={(e) => setRule({ ...rule, url: e.target.value })} /></Field>
              <Field label="Title attribute"><Input value={rule.title ?? ''} onChange={(e) => setRule({ ...rule, title: e.target.value })} /></Field>
              <Field label="Kind"><Select value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value })}><option value="internal">internal</option><option value="outbound">outbound (opens in new tab)</option></Select></Field>
              <Field label="Max links per page"><Input type="number" min={1} max={10} value={rule.maxPerPage} onChange={(e) => setRule({ ...rule, maxPerPage: Number(e.target.value) })} /></Field>
              <Field label="Priority (higher wins)"><Input type="number" min={0} max={100} value={rule.priority} onChange={(e) => setRule({ ...rule, priority: Number(e.target.value) })} /></Field>
            </div>
            <div className="mb"><Switch on={rule.enabled !== false} onChange={(v) => setRule({ ...rule, enabled: v })} label="Enabled" /></div>
            <Button onClick={() => api.put(`/api/admin/seo/rules/${rule.id ?? 'new'}`, { keyword: rule.keyword, url: rule.url, title: rule.title || null, kind: rule.kind, maxPerPage: rule.maxPerPage, priority: rule.priority, enabled: rule.enabled !== false }).then(() => { setRule(null); ok('Rule saved'); }).catch(err)}>Save</Button>
          </>
        )}
      </Modal>

      <Modal open={!!backlink} onClose={() => setBacklink(null)} title="Backlink">
        {backlink && (
          <>
            <div className="grid cols-2">
              <Field label="Direction"><Select value={backlink.direction} onChange={(e) => setBacklink({ ...backlink, direction: e.target.value })}><option value="partner">partner (they link to us)</option><option value="inbound">inbound (discovered)</option><option value="outbound">outbound (we link to them)</option></Select></Field>
              <Field label="Status"><Select value={backlink.status} onChange={(e) => setBacklink({ ...backlink, status: e.target.value })}><option value="pending">pending</option><option value="live">live</option><option value="lost">lost</option><option value="rejected">rejected</option></Select></Field>
              <Field label="Source URL (the page that links)"><Input value={backlink.sourceUrl} onChange={(e) => setBacklink({ ...backlink, sourceUrl: e.target.value })} placeholder="https://…" /></Field>
              <Field label="Target (our page)"><Input value={backlink.targetUrl} onChange={(e) => setBacklink({ ...backlink, targetUrl: e.target.value })} /></Field>
              <Field label="Anchor text"><Input value={backlink.anchor ?? ''} onChange={(e) => setBacklink({ ...backlink, anchor: e.target.value })} /></Field>
            </div>
            <Field label="Notes"><Input value={backlink.notes ?? ''} onChange={(e) => setBacklink({ ...backlink, notes: e.target.value })} /></Field>
            <Button onClick={() => api.put(`/api/admin/seo/backlinks/${backlink.id ?? 'new'}`, { direction: backlink.direction, sourceUrl: backlink.sourceUrl, targetUrl: backlink.targetUrl, anchor: backlink.anchor || null, status: backlink.status, notes: backlink.notes || null }).then(() => { setBacklink(null); ok('Backlink saved'); }).catch(err)}>Save</Button>
          </>
        )}
      </Modal>
    </div>
  );
}
