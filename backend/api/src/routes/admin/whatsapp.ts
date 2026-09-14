/**
 * WhatsApp channel administration: the Meta Cloud API settings (secrets masked on read and kept when the mask is sent
 * back), the webhook URL to paste into the Meta app dashboard, recent traffic, the outbound outbox and a simulator that
 * drives the real handler without Meta.
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { validate, wrap } from '../../lib/http';
import { requirePermission } from '../../middleware/permissions';
import { audit } from '../../services/audit';
import {
  DEFAULT_WHATSAPP,
  MASK,
  WHATSAPP_SECRET_FIELDS,
  getWhatsAppSettings,
  maskWhatsAppSettings,
  setWhatsAppSettings,
  recentWhatsApp,
  recentWhatsAppOutbox,
  whatsappHandle,
  sendWhatsAppTemplate,
  type WhatsAppSettings,
} from '../../services/channels/whatsapp';

export const adminWhatsAppRouter = Router();

/** What an operator still has to fill in before the channel can talk to Meta. */
function readiness(s: WhatsAppSettings) {
  return {
    verifyToken: !!s.verifyToken,
    appSecret: !!s.appSecret,
    accessToken: !!s.accessToken,
    phoneNumberId: !!s.phoneNumberId,
    canReceive: !!(s.enabled && s.verifyToken && s.appSecret),
    canSend: !!(s.accessToken && s.phoneNumberId),
  };
}

adminWhatsAppRouter.get('/', requirePermission('settings'), (_req, res) => {
  const s = getWhatsAppSettings();
  res.json({
    settings: maskWhatsAppSettings(s),
    readiness: readiness(s),
    webhookUrl: `${config.apiUrl}/api/whatsapp`,
    defaults: { apiVersion: DEFAULT_WHATSAPP.apiVersion, graphUrl: DEFAULT_WHATSAPP.graphUrl },
    messages: recentWhatsApp(40),
    outbox: recentWhatsAppOutbox(20),
  });
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  verifyToken: z.string().max(200).optional(),
  appSecret: z.string().max(200).optional(),
  accessToken: z.string().max(4000).optional(),
  phoneNumberId: z.string().max(40).optional(),
  apiVersion: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .optional(),
  graphUrl: z.string().url().optional(),
  payButtonText: z.string().max(20).optional(),
  footer: z.string().max(60).optional(),
});

adminWhatsAppRouter.put('/', requirePermission('settings'), (req, res) => {
  const body = validate(settingsSchema, req.body);
  const next = setWhatsAppSettings(body);
  const secretsChanged = WHATSAPP_SECRET_FIELDS.filter((f) => body[f] !== undefined && body[f] !== MASK);
  audit(req.user!.id, 'channels.whatsapp.settings.update', 'settings', 'whatsapp', { keys: Object.keys(body), secretsChanged });
  res.json({ settings: maskWhatsAppSettings(next), readiness: readiness(next) });
});

/** Simulator: run any text through the WhatsApp handler (command grammar or pay card) and return the reply payload. */
adminWhatsAppRouter.post(
  '/simulate',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(z.object({ phone: z.string().min(6).max(20), text: z.string().min(1).max(4096) }), req.body);
    const handled = await whatsappHandle(body.phone, body.text);
    res.json({ from: handled.from, kind: handled.kind, reply: handled.reply });
  }),
);

/** Send an approved Cloud API message template (operations checks and customer notices outside the 24-hour window). */
adminWhatsAppRouter.post(
  '/send-template',
  requirePermission('settings'),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        to: z.string().min(6).max(20),
        template: z.string().min(1).max(120),
        lang: z.string().min(2).max(10).default('en'),
        components: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      req.body,
    );
    const result = await sendWhatsAppTemplate(body.to, body.template, body.lang, body.components ?? []);
    audit(req.user!.id, 'channels.whatsapp.template_sent', 'whatsapp', body.to, { template: body.template, lang: body.lang });
    res.json({ result });
  }),
);
