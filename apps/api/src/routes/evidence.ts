import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { ingestEvidence, registerDevice, listDevices, revokeDevice, getDevice, parseEvidenceText, evidenceCanonical } from '../services/evidence';

/**
 * No-API evidence ingestion.
 *   POST /api/evidence/sms        – signed receipt SMS forwarded by a registered device (no bearer token; the device key authenticates)
 *   POST /api/evidence/devices    – admins/agents register the SMS-forwarder device (Ed25519 public key)
 *   POST /api/evidence/parse-test – dry-run the parsing templates on a message (admins/agents)
 */
export const evidenceRouter = Router();

evidenceRouter.post(
  '/sms',
  rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'evidence' }),
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        deviceId: z.string().min(8),
        nonce: z.string().min(8).max(128),
        receivedAt: z.string().datetime({ offset: true }),
        from: z.string().max(40),
        operatorId: z.string().max(60).optional().nullable(),
        text: z.string().min(5).max(2000),
        signature: z.string().min(40).max(512),
      }),
      req.body,
    );
    const evidence = ingestEvidence({ source: 'signed_device', ...body, actor: { type: 'device', id: body.deviceId } });
    res.status(201).json({ evidence: { id: evidence.id, outcome: evidence.outcome, confidence: evidence.confidence, reasons: evidence.reasons, paymentId: evidence.paymentId } });
  }),
);

evidenceRouter.get('/canonical-format', (_req, res) => res.json({ algorithm: 'ed25519', canonical: 'deviceId\\nnonce\\nreceivedAt\\nfrom\\noperatorId\\ntext', example: evidenceCanonical({ deviceId: 'DEVICE_ID', nonce: 'NONCE', receivedAt: '2026-01-01T00:00:00.000Z', from: 'MPESA', operatorId: 'mpesa_ke', text: 'SMS TEXT' }) }));

evidenceRouter.use(requireAuth, requireRole('admin', 'agent'));
evidenceRouter.get('/devices', (req, res) => res.json({ items: listDevices(req.user!.role === 'admin' ? null : req.user!.id) }));
evidenceRouter.post(
  '/devices',
  wrap(async (req, res) => {
    const body = validate(z.object({ name: z.string().min(2).max(80), publicKey: z.string().min(32).max(2000), operatorIds: z.array(z.string()).max(50).optional().nullable() }), req.body);
    res.status(201).json({ device: registerDevice(req.user!, body, req.user!.id) });
  }),
);
evidenceRouter.delete('/devices/:id', (req, res) => {
  const device = getDevice(String(req.params.id));
  if (req.user!.role !== 'admin' && device.ownerUserId !== req.user!.id) return res.status(403).json({ error: { code: 'forbidden', message: 'Not your device' } });
  res.json({ device: revokeDevice(device.id, { type: req.user!.role === 'admin' ? 'admin' : 'agent', id: req.user!.id }, req.body?.reason) });
});
evidenceRouter.post('/parse-test', (req, res) => {
  const body = validate(z.object({ text: z.string().min(1).max(2000), operatorId: z.string().optional().nullable() }), req.body);
  res.json({ parsed: parseEvidenceText(body.text, body.operatorId) });
});
