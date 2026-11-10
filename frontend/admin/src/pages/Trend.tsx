import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, StepUpButton, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

type Tab = 'opportunities' | 'briefs' | 'sources' | 'claims' | 'audit';

const BAND_KIND: Record<string, 'success' | 'warning' | 'primary' | undefined> = { auto_eligible: 'success', brief: 'primary', watch: 'warning', archive: undefined };

/**
 * Trend intelligence: what the market is asking for, what the platform scored it at, and the one approved brief
 * that steers the content agent. Nothing here publishes — a brief changes what the agent is asked to write, and the
 * existing editorial review still decides whether a draft goes anywhere.
 */
export function Trend() {
  const { toast, config } = useStore();
  const [tab, setTab] = useState<Tab>('opportunities');
  const on = config?.modules?.trendIntelligence !== false;

  const overview = useAsync(() => (on ? api.get<any>('/api/admin/trend/overview') : Promise.resolve(null)), [on]);
  const uses = useAsync(() => (on && tab === 'audit' ? api.get<any>('/api/admin/trend/briefs/uses?limit=100') : Promise.resolve(null)), [on, tab]);
  const claims = useAsync(() => (on && tab === 'claims' ? api.get<any>('/api/admin/trend/claims') : Promise.resolve(null)), [on, tab]);

  const [scoring, setScoring] = useState<{ topicId: string; label: string; fit: string; commercialIntent: string; timing: string; readiness: string } | null>(null);
  const [drafting, setDrafting] = useState<any>(null);
  const [claim, setClaim] = useState<{ code: string; text: string; evidence: string; validUntil: string } | null>(null);

  const err = (e: any) => toast(e.message, 'error');
  const ok = (m: string) => {
    toast(m, 'success');
    overview.reload();
    uses.reload();
    claims.reload();
  };

  const o = overview.data;
  const steering = o?.steering;

  return (
    <div>
      <PageHeader
        title={tr('Trend intelligence')}
        subtitle={tr('Demand the platform can see in sources it already holds, scored the same way every time, and the one approved brief that steers the content agent.')}
        actions={
          on ? (
            <Button
              variant="secondary"
              onClick={() =>
                api
                  .post('/api/admin/trend/briefs/expire-lapsed', {})
                  .then(() => ok(tr('Lapsed briefs marked')))
                  .catch(err)
              }
            >
              {tr('Mark lapsed briefs')}
            </Button>
          ) : null
        }
      />

      {!on && (
        <Alert kind="warning">
          {tr(
            'Trend intelligence is switched off. Nothing is detected, scored or briefed while it is off, and the content agent runs on its own topic backlog. Switch it on under Modules & methods when you want the platform to start reading its own demand signals.',
          )}
        </Alert>
      )}

      {on && steering && (
        <Alert kind={steering.source === 'brief' ? 'success' : 'info'}>
          {steering.source === 'brief'
            ? `${tr('The content agent is steered by an approved brief')} — ${steering.topic} (${steering.language}). ${steering.detail}`
            : steering.source === 'backlog'
              ? `${tr('The content agent is running its own topic backlog')} — ${steering.topic}. ${steering.detail}`
              : tr('The content agent has nothing queued: no approved brief and an empty topic backlog.')}
        </Alert>
      )}

      {on && (
        <Tabs
          tabs={[
            { id: 'opportunities', label: tr('Opportunities') },
            { id: 'briefs', label: tr('Growth briefs') },
            { id: 'sources', label: tr('Sources') },
            { id: 'claims', label: tr('Claim registry') },
            { id: 'audit', label: tr('Why it wrote that') },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
      )}

      {on && tab === 'opportunities' && (
        <div className="card">
          <h4>{tr('Scored opportunities')}</h4>
          <p className="muted">
            {tr('A snapshot is frozen: the same inputs at the same window end always give the same row. Only a snapshot in the brief band can carry a brief — watch and archive exist to be read.')}
          </p>
          <Table
            head={[tr('Topic'), tr('Market'), tr('Opportunity'), tr('Confidence'), tr('Demand'), tr('Families'), tr('Band'), tr('Window end'), '']}
            rows={(o?.opportunities ?? []).map((row: any) => [
              row.label,
              row.market ?? '—',
              row.opportunity_score,
              row.confidence,
              row.demand,
              <Chip key="f">{(JSON.parse(row.families || '[]') as string[]).join(', ') || tr('none')}</Chip>,
              <Chip key="b" kind={BAND_KIND[row.band]}>
                {String(row.band).replace(/_/g, ' ')}
              </Chip>,
              fmtDate(row.window_end),
              row.band === 'brief' || row.band === 'auto_eligible' ? (
                <Button
                  key="d"
                  size="sm"
                  onClick={() =>
                    setDrafting({
                      topicId: row.topic_id,
                      opportunityId: row.id,
                      label: row.label,
                      market: row.market ?? 'CD',
                      locale: '',
                      audience: '',
                      intent: row.label,
                      objective: '',
                      ttlHours: '',
                    })
                  }
                >
                  {tr('Draft a brief')}
                </Button>
              ) : null,
            ])}
            empty={tr('No topic has been scored yet. Register a source, ingest observations, then score a topic.')}
          />
          <h4 className="mt">{tr('Score a topic')}</h4>
          <p className="muted">
            {tr(
              'Demand, source quality, corroboration, coverage and freshness are measured from the observations. Fit, commercial intent, timing and readiness come from this platform’s own mapping — a model never sets them.',
            )}
          </p>
          <Table
            head={[tr('Topic'), tr('Market'), tr('Terms'), tr('Updated'), '']}
            rows={(o?.topics ?? []).map((t: any) => [
              t.label,
              t.market,
              (JSON.parse(t.terms || '[]') as string[]).join(', '),
              fmtDate(t.updated_at),
              <Button key="s" size="sm" variant="secondary" onClick={() => setScoring({ topicId: t.id, label: t.label, fit: '', commercialIntent: '', timing: '', readiness: '' })}>
                {tr('Score now')}
              </Button>,
            ])}
            empty={tr('No topic yet.')}
          />
        </div>
      )}

      {on && tab === 'briefs' && (
        <div className="card">
          <h4>{tr('Growth briefs')}</h4>
          <p className="muted">
            {tr(
              'One approved brief per market, locale and topic, for a short window. Approval needs a different administrator under step-up, and binds to the exact payload shown here: editing a brief after approval invalidates it.',
            )}
          </p>
          <Table
            head={[tr('Topic / intent'), tr('Market'), tr('Version'), tr('Status'), tr('Opportunity'), tr('Confidence'), tr('Expires'), tr('Channels'), '']}
            rows={(o?.briefs ?? []).map((b: any) => [
              b.intent,
              `${b.market}${b.locale ? ` · ${b.locale}` : ''}`,
              `v${b.version}`,
              <StatusBadge key="s" status={b.expired && b.status === 'approved' ? 'expired' : b.status} />,
              b.opportunity_score,
              b.confidence,
              fmtDate(b.expires_at),
              (JSON.parse(b.allowed_channels || '[]') as string[]).join(', '),
              <div key="a" className="row">
                {b.status === 'draft' && (
                  <StepUpButton
                    size="sm"
                    title={tr('Approve this brief')}
                    onConfirm={(pin) =>
                      api
                        .post(`/api/admin/trend/briefs/${b.id}/approve`, { payloadHash: b.payloadHash, pin })
                        .then(() => ok(tr('Brief approved: it now steers the content agent')))
                        .catch(err)
                    }
                  >
                    {tr('Approve')}
                  </StepUpButton>
                )}
                {b.status === 'approved' && (
                  <StepUpButton
                    size="sm"
                    variant="danger"
                    title={tr('Revoke this brief')}
                    prompt={tr('Why is it being revoked?')}
                    onConfirm={(pin, reason) =>
                      api
                        .post(`/api/admin/trend/briefs/${b.id}/revoke`, { reason, pin })
                        .then(() => ok(tr('Brief revoked: the agent is back on its backlog')))
                        .catch(err)
                    }
                  >
                    {tr('Revoke')}
                  </StepUpButton>
                )}
              </div>,
            ])}
            empty={tr('No brief yet. Score a topic into the brief band, then draft one from the Opportunities tab.')}
          />
        </div>
      )}

      {on && tab === 'sources' && (
        <div className="card">
          <h4>{tr('Sources')}</h4>
          <p className="muted">
            {tr(
              'A source family contributes once however many records it sends, so four syndicated copies of one announcement are not four sources agreeing. A source whose terms this platform cannot meet is recorded as unavailable with its reason — never as a request for a new key.',
            )}
          </p>
          <Table
            head={[tr('Source'), tr('Family'), tr('Access'), tr('Quality'), tr('Stale after'), tr('State')]}
            rows={(o?.sources ?? []).map((s: any) => [
              s.name,
              s.family,
              String(s.access_path).replace(/_/g, ' '),
              s.quality,
              `${s.stale_after_hours} h`,
              s.enabled ? (
                <Chip key="e" kind="success">
                  {s.context_only ? tr('context only') : tr('contributing')}
                </Chip>
              ) : (
                <Chip key="u" kind="warning">
                  {s.unavailable_reason || tr('unavailable')}
                </Chip>
              ),
            ])}
            empty={tr('No source registered yet.')}
          />
        </div>
      )}

      {on && tab === 'claims' && (
        <div className="card">
          <h4>{tr('Claim registry')}</h4>
          <p className="muted">
            {tr(
              'The sentences this platform is prepared to stand behind, each with its evidence and its own validity window. A revision is never an edit in place: a brief approved citing one revision keeps meaning exactly what its approver read.',
            )}
          </p>
          <Button onClick={() => setClaim({ code: '', text: '', evidence: '', validUntil: '' })}>{tr('Register a claim')}</Button>
          <Table
            head={[tr('Code'), tr('Revision'), tr('Text'), tr('Evidence'), tr('Valid until'), tr('Registered')]}
            rows={(claims.data?.data ?? []).map((c: any) => [c.code, c.revision, c.text, c.evidence || '—', fmtDate(c.valid_until), fmtDate(c.created_at)])}
            empty={tr('No claim registered. A brief with no approved claim tells the writer to assert nothing.')}
          />
        </div>
      )}

      {on && tab === 'audit' && (
        <div className="card">
          <h4>{tr('Why it wrote that')}</h4>
          <p className="muted">{tr('Every time the content agent resolved a brief, and what it did. This is the answer to “where did this article come from”.')}</p>
          <Table
            head={[tr('When'), tr('Channel'), tr('Outcome'), tr('Brief'), tr('Detail'), tr('Article')]}
            rows={(uses.data?.data ?? []).map((u: any) => [
              fmtDate(u.resolved_at),
              u.channel,
              <StatusBadge key="o" status={u.outcome} />,
              u.brief_id ? `${u.brief_id.slice(0, 8)} v${u.brief_version}` : '—',
              u.detail || '—',
              u.post_id ? u.post_id.slice(0, 8) : '—',
            ])}
            empty={tr('The content agent has not run since trend intelligence was switched on.')}
          />
        </div>
      )}

      <Modal open={!!scoring} onClose={() => setScoring(null)} title={`${tr('Score')}: ${scoring?.label ?? ''}`}>
        <Alert kind="info">{tr('0 to 100, from this platform’s own mapping. Leave the platform honest: a figure you cannot justify is worse than a low one.')}</Alert>
        {(['fit', 'commercialIntent', 'timing', 'readiness'] as const).map((k) => (
          <Field
            key={k}
            label={
              k === 'fit'
                ? tr('Fit: how well what we already offer answers this')
                : k === 'commercialIntent'
                  ? tr('Commercial intent: how close this is to someone acting')
                  : k === 'timing'
                    ? tr('Timing: how much of the window is left')
                    : tr('Readiness: whether we could serve the demand today')
            }
          >
            <Input type="number" min={0} max={100} value={scoring?.[k] ?? ''} onChange={(e) => setScoring((s) => (s ? { ...s, [k]: e.target.value } : s))} />
          </Field>
        ))}
        <Button
          disabled={!scoring || (['fit', 'commercialIntent', 'timing', 'readiness'] as const).some((k) => scoring[k] === '')}
          onClick={() =>
            api
              .post(`/api/admin/trend/topics/${scoring!.topicId}/snapshot`, {
                fit: Number(scoring!.fit),
                commercialIntent: Number(scoring!.commercialIntent),
                timing: Number(scoring!.timing),
                readiness: Number(scoring!.readiness),
              })
              .then((r: any) => {
                setScoring(null);
                ok(`${tr('Scored')}: ${r.snapshot.band.replace(/_/g, ' ')} — ${tr('opportunity')} ${r.snapshot.opportunityScore}, ${tr('confidence')} ${r.snapshot.confidence}`);
              })
              .catch(err)
          }
        >
          {tr('Score')}
        </Button>
      </Modal>

      <Modal open={!!drafting} onClose={() => setDrafting(null)} title={`${tr('Draft a brief')}: ${drafting?.label ?? ''}`} wide>
        <Alert kind="info">{tr('A draft steers nothing. A different administrator approves it under step-up, and it then expires on its own.')}</Alert>
        <Field label={tr('Market (ISO country code)')}>
          <Input value={drafting?.market ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, market: e.target.value.toUpperCase().slice(0, 2) }))} />
        </Field>
        <Field label={tr('Locale')} hint={tr('For example fr-CD. A brief is not published in a language this platform has not enabled.')}>
          <Input value={drafting?.locale ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, locale: e.target.value }))} />
        </Field>
        <Field label={tr('Audience: who exactly this is for')}>
          <Input value={drafting?.audience ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, audience: e.target.value }))} />
        </Field>
        <Field label={tr('Search intent to answer completely')}>
          <Input value={drafting?.intent ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, intent: e.target.value }))} />
        </Field>
        <Field label={tr('What a reader should be able to do afterwards')}>
          <Input value={drafting?.objective ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, objective: e.target.value }))} />
        </Field>
        <Field label={tr('Claims the writer may state')} hint={tr('Codes from the claim registry, comma separated. Leave empty and the writer is told to assert nothing.')}>
          <Input value={drafting?.claimIds ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, claimIds: e.target.value }))} />
        </Field>
        <Field label={tr('Claims the writer must not make')} hint={tr('One per line.')}>
          <Textarea rows={3} value={drafting?.prohibited ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, prohibited: e.target.value }))} />
        </Field>
        <Field label={tr('Channels')}>
          <Select value={drafting?.channels ?? 'seo,content'} onChange={(e) => setDrafting((d: any) => ({ ...d, channels: e.target.value }))}>
            <option value="seo,content">{tr('SEO and content')}</option>
            <option value="seo">{tr('SEO only')}</option>
            <option value="content">{tr('Content only')}</option>
            <option value="seo,content,organic_social">{tr('SEO, content and organic social')}</option>
          </Select>
        </Field>
        <Field label={tr('Valid for (hours)')} hint={tr('Empty uses the standard window; a breaking topic should be short.')}>
          <Input type="number" min={1} value={drafting?.ttlHours ?? ''} onChange={(e) => setDrafting((d: any) => ({ ...d, ttlHours: e.target.value }))} />
        </Field>
        <Button
          disabled={!drafting?.audience || !drafting?.intent || !drafting?.objective || !drafting?.locale}
          onClick={() =>
            api
              .post('/api/admin/trend/briefs', {
                topicId: drafting.topicId,
                opportunityId: drafting.opportunityId,
                market: drafting.market,
                locale: drafting.locale,
                audience: drafting.audience,
                intent: drafting.intent,
                objective: drafting.objective,
                allowedChannels: String(drafting.channels ?? 'seo,content').split(','),
                approvedClaimIds: String(drafting.claimIds ?? '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                prohibitedClaims: String(drafting.prohibited ?? '')
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
                ...(drafting.ttlHours ? { ttlHours: Number(drafting.ttlHours) } : {}),
              })
              .then(() => {
                setDrafting(null);
                setTab('briefs');
                ok(tr('Draft created. A different administrator must approve it before it steers anything.'));
              })
              .catch(err)
          }
        >
          {tr('Create draft')}
        </Button>
      </Modal>

      <Modal open={!!claim} onClose={() => setClaim(null)} title={tr('Register a claim')}>
        <Alert kind="info">{tr('Write the sentence exactly as it may appear. Changing it later adds a revision rather than editing this one.')}</Alert>
        <Field label={tr('Code')}>
          <Input value={claim?.code ?? ''} onChange={(e) => setClaim((c) => (c ? { ...c, code: e.target.value } : c))} />
        </Field>
        <Field label={tr('Exact text')}>
          <Textarea rows={3} value={claim?.text ?? ''} onChange={(e) => setClaim((c) => (c ? { ...c, text: e.target.value } : c))} />
        </Field>
        <Field label={tr('Evidence: where this is verifiable')}>
          <Textarea rows={2} value={claim?.evidence ?? ''} onChange={(e) => setClaim((c) => (c ? { ...c, evidence: e.target.value } : c))} />
        </Field>
        <Field label={tr('Valid until')} hint={tr('Optional. After this the claim is refused in a new brief, because it stopped being true.')}>
          <Input type="datetime-local" value={claim?.validUntil ?? ''} onChange={(e) => setClaim((c) => (c ? { ...c, validUntil: e.target.value } : c))} />
        </Field>
        <Button
          disabled={!claim?.code || (claim?.text ?? '').length < 4}
          onClick={() =>
            api
              .post('/api/admin/trend/claims', {
                code: claim!.code,
                text: claim!.text,
                evidence: claim!.evidence || null,
                validUntil: claim!.validUntil ? new Date(claim!.validUntil).toISOString() : null,
              })
              .then(() => {
                setClaim(null);
                ok(tr('Claim registered'));
              })
              .catch(err)
          }
        >
          {tr('Register')}
        </Button>
      </Modal>

      {on && o && (
        <div className="card mt">
          <h4>{tr('How a score is reached')}</h4>
          <div className="grid cols-2">
            <KV k={tr('Scoring version')} v={o.scoringVersion} />
            <KV k={tr('Brief window')} v={`${tr('standard')} ${o.ttlHours.persistent} h · ${tr('breaking')} ${o.ttlHours.breaking} h`} />
          </div>
          <p className="muted">
            {tr(
              'A movement counts only with enough comparable history and a rise large enough not to be noise. One source family alone caps confidence, because syndication is not agreement. An indexed feed can raise a question but never set demand on its own.',
            )}
          </p>
        </div>
      )}
    </div>
  );
}
