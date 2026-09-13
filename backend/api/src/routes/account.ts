import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import * as auth from '../services/auth';
import { toUser, updateUser, normalizeTag, findUserByTag, findUserByIdentifier, toPublicUser } from '../services/users';
import { badRequest, conflict } from '../lib/errors';
import { listNotifications, markRead, registerPushToken, removePushToken, unreadCount, setLoudAlerts } from '../services/notifications';
import { referralStats } from '../services/referrals';
import { poolsForOwner, listPromoCredits } from '../services/emoney';
import { qrDataUrl } from '../services/qr';
import { listLanguages } from '../services/cms';
import { COUNTRY_BY_CODE } from '@bitripay/shared';

export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.patch(
  '/profile',
  wrap(async (req, res) => {
    const body = validate(
      z.object({
        fullName: z.string().min(2).max(120).optional(),
        tag: z.string().min(3).max(20).optional(),
        country: z.string().length(2).optional().nullable(),
        businessName: z.string().max(120).optional().nullable(),
        language: z.string().min(2).max(5).optional(),
        avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        loudAlerts: z.boolean().optional(),
      }),
      req.body,
    );
    const fields: Record<string, unknown> = {};
    if (body.loudAlerts !== undefined) setLoudAlerts(req.user!.id, body.loudAlerts);
    if (body.fullName) fields.full_name = body.fullName.trim();
    if (body.tag) {
      const tag = normalizeTag(body.tag);
      if (!/^[a-z0-9_]{3,20}$/.test(tag)) throw badRequest('Tag must be 3-20 characters: letters, numbers, underscore');
      const existing = findUserByTag(tag);
      if (existing && existing.id !== req.user!.id) throw conflict('This tag is already taken', 'tag_taken');
      fields.tag = tag;
    }
    if (body.country !== undefined) {
      if (body.country && !COUNTRY_BY_CODE[body.country.toUpperCase()]) throw badRequest('Unknown country');
      fields.country = body.country?.toUpperCase() ?? null;
    }
    if (body.businessName !== undefined) fields.business_name = body.businessName;
    if (body.language) {
      if (!listLanguages().some((l) => l.code === body.language && l.enabled)) throw badRequest('Language not available');
      fields.language = body.language;
    }
    if (body.avatarColor) fields.avatar_color = body.avatarColor;
    res.json({ user: toUser(updateUser(req.user!.id, fields)) });
  }),
);

accountRouter.post(
  '/password',
  wrap(async (req, res) => {
    const body = validate(z.object({ currentPassword: z.string().default(''), newPassword: z.string().min(8) }), req.body);
    auth.changePassword(req.user!, body.currentPassword, body.newPassword);
    res.json({ ok: true });
  }),
);

accountRouter.post(
  '/pin',
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string().regex(/^\d{4,6}$/), currentPin: z.string().optional() }), req.body);
    auth.setPin(req.user!, body.pin, body.currentPin);
    res.json({ ok: true });
  }),
);

accountRouter.post(
  '/pin/verify',
  wrap(async (req, res) => {
    const body = validate(z.object({ pin: z.string() }), req.body);
    auth.assertPin(req.user!, body.pin, req);
    res.json({ ok: true });
  }),
);

accountRouter.post(
  '/verify/request',
  wrap(async (req, res) => {
    const body = validate(z.object({ channel: z.enum(['email', 'sms']) }), req.body);
    res.json(await auth.requestVerification(req.user!, body.channel));
  }),
);

accountRouter.post(
  '/verify/confirm',
  wrap(async (req, res) => {
    const body = validate(z.object({ channel: z.enum(['email', 'sms']), code: z.string().min(4).max(8) }), req.body);
    res.json({ user: toUser(auth.confirmVerification(req.user!, body.channel, body.code)) });
  }),
);

accountRouter.post(
  '/2fa/setup',
  wrap(async (req, res) => {
    const setup = auth.beginTwoFactorSetup(req.user!);
    res.json({ ...setup, qr: await qrDataUrl(setup.otpauth) });
  }),
);
accountRouter.post(
  '/2fa/enable',
  wrap(async (req, res) => {
    const body = validate(z.object({ code: z.string().min(6).max(8) }), req.body);
    auth.enableTwoFactor(req.user!, body.code);
    res.json({ ok: true });
  }),
);
accountRouter.post(
  '/2fa/disable',
  wrap(async (req, res) => {
    const body = validate(z.object({ code: z.string().min(6).max(8) }), req.body);
    auth.disableTwoFactor(req.user!, body.code);
    res.json({ ok: true });
  }),
);

/** Distribution pools this user owns (institutions, master agents) and their promotional credit register. */
accountRouter.get('/pools', (req, res) => res.json({ items: poolsForOwner(req.user!) }));
accountRouter.get('/promo', (req, res) => res.json({ items: listPromoCredits(req.user!.id) }));
accountRouter.get('/notifications', (req, res) => res.json({ items: listNotifications(req.user!.id), unread: unreadCount(req.user!.id) }));
accountRouter.post('/notifications/read', (req, res) => {
  markRead(req.user!.id, typeof req.body?.id === 'string' ? req.body.id : undefined);
  res.json({ ok: true });
});
accountRouter.post(
  '/push-tokens',
  wrap(async (req, res) => {
    const body = validate(z.object({ token: z.string().min(10), platform: z.enum(['ios', 'android', 'web']).default('android') }), req.body);
    registerPushToken(req.user!.id, body.token, body.platform);
    res.json({ ok: true });
  }),
);
accountRouter.delete('/push-tokens/:token', (req, res) => {
  removePushToken(String(String(req.params.token)));
  res.json({ ok: true });
});

accountRouter.get('/referrals', (req, res) => res.json(referralStats(req.user!.id)));

/** Look up another user by tag / email / phone (public profile only). */
accountRouter.get('/lookup', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw badRequest('q is required');
  const user = findUserByIdentifier(q);
  if (!user || user.is_system || user.status !== 'active') return res.status(404).json({ error: { code: 'user_not_found', message: 'No user found' } });
  res.json({ user: toPublicUser(user) });
});
