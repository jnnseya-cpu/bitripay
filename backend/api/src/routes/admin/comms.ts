/**
 * Communication event console: the catalogue with coverage and delivery statistics, the delivery log, rendered previews
 * (branded email HTML included) and test sends to the signed-in administrator across the event's channels.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import { COMMS_CATEGORIES, COMMS_CHANNELS, COMMS_EVENTS } from '../../services/comms/catalogue';
import { commsOverview, emit, listDeliveries, previewEvent } from '../../services/comms/engine';

export const adminCommsRouter = Router();

adminCommsRouter.get('/', requirePermission('settings'), (_req, res) =>
  res.json({ categories: COMMS_CATEGORIES, channels: COMMS_CHANNELS, events: COMMS_EVENTS, overview: commsOverview(), deliveries: listDeliveries({ limit: 30 }) }),
);
adminCommsRouter.get('/deliveries', requirePermission('settings'), (req, res) =>
  res.json({
    items: listDeliveries({
      eventId: req.query.eventId ? String(req.query.eventId) : null,
      channel: req.query.channel ? String(req.query.channel) : null,
      userId: req.query.userId ? String(req.query.userId) : null,
      limit: Number(req.query.limit) || 100,
    }),
  }),
);
adminCommsRouter.post('/preview', requirePermission('settings'), (req, res) => {
  const body = validate(z.object({ eventId: z.string().min(1), vars: z.record(z.string(), z.unknown()).optional(), lang: z.string().max(8).optional().nullable() }), req.body);
  res.json(previewEvent(body.eventId, body.vars, body.lang));
});
adminCommsRouter.post(
  '/test',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(z.object({ eventId: z.string().min(1), vars: z.record(z.string(), z.unknown()).optional() }), req.body);
    const p = previewEvent(body.eventId, body.vars);
    const deliveries = await emit(body.eventId, { userId: req.user!.id, vars: p.vars, force: true, test: true });
    audit(req.user!.id, 'comms.test_send', 'comms_event', body.eventId, { channels: deliveries.map((d) => `${d.channel}:${d.status}`) });
    res.json({ deliveries });
  }),
);
