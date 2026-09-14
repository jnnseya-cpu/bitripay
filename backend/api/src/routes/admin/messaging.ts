import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { TEMPLATE_CHANNELS, TEMPLATE_EVENTS, listNotificationTemplates, upsertNotificationTemplate, renderTemplate, fillPlaceholders } from '../../services/notifications';

/** Messaging administration: the notification templates (per event, channel and language) behind every message the API sends. */
export const adminMessagingRouter = Router();

adminMessagingRouter.get('/templates', requirePermission('settings'), (req, res) => {
  const q = (k: string) => (req.query[k] ? String(req.query[k]) : null);
  res.json({
    items: listNotificationTemplates({ key: q('key'), channel: q('channel'), lang: q('lang') }),
    channels: TEMPLATE_CHANNELS,
    events: Object.entries(TEMPLATE_EVENTS).map(([key, e]) => ({ key, description: e.description, placeholders: Object.keys(e.sample), sample: e.sample })),
  });
});

const templateSchema = z.object({
  key: z.string().min(2).max(60),
  channel: z.enum(TEMPLATE_CHANNELS),
  lang: z.string().min(2).max(5).optional().nullable(),
  subject: z.string().max(200).optional().nullable(),
  body: z.string().max(4000).optional().nullable(),
  /** Restore the shipped default text for this key/channel. */
  reset: z.boolean().optional(),
});

adminMessagingRouter.put(
  '/templates',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(templateSchema, req.body);
    const template = upsertNotificationTemplate(body, req.user!.id);
    audit(req.user!.id, 'messaging.template.update', 'notification_template', template.id, { key: body.key, channel: body.channel, lang: template.lang, reset: !!body.reset });
    res.json({ template });
  }),
);

/** Renders a template with sample (or supplied) placeholder values without sending anything. */
adminMessagingRouter.post(
  '/templates/preview',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        key: z.string().min(2).max(60),
        channel: z.enum(TEMPLATE_CHANNELS),
        lang: z.string().min(2).max(5).optional().nullable(),
        vars: z.record(z.unknown()).optional(),
        /** Preview unsaved text: when given, this body/subject is rendered instead of the stored template. */
        body: z.string().max(4000).optional().nullable(),
        subject: z.string().max(200).optional().nullable(),
      }),
      req.body,
    );
    const vars = { ...(TEMPLATE_EVENTS[body.key]?.sample ?? {}), ...(body.vars ?? {}) };
    if (body.body != null) return res.json({ rendered: { subject: body.subject ? fillPlaceholders(body.subject, vars) : null, body: fillPlaceholders(body.body, vars) }, vars });
    res.json({ rendered: renderTemplate(body.key, body.channel, body.lang, vars), vars });
  }),
);
