import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap, parsePagination } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { createTicket, listTickets, getTicket, replyTicket, setTicketStatus, sendChat, chatHistory } from '../services/support';

export const supportRouter = Router();
supportRouter.use(requireAuth);

supportRouter.get('/tickets', (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ...listTickets(req.user!, { status: req.query.status ? String(req.query.status) : undefined, page, pageSize }), page, pageSize });
});
supportRouter.post(
  '/tickets',
  wrap(async (req, res) => {
    const body = validate(
      z.object({ subject: z.string().min(3).max(200), category: z.string().max(40).optional(), priority: z.enum(['low', 'normal', 'high']).optional(), body: z.string().min(3).max(5000) }),
      req.body,
    );
    res.status(201).json({ ticket: createTicket(req.user!, body) });
  }),
);
supportRouter.get('/tickets/:id', (req, res) => res.json({ ticket: getTicket(String(req.params.id), req.user!) }));
supportRouter.post(
  '/tickets/:id/reply',
  wrap(async (req, res) => {
    const body = validate(z.object({ body: z.string().min(1).max(5000) }), req.body);
    res.json({ ticket: replyTicket(String(req.params.id), req.user!, body.body) });
  }),
);
supportRouter.post('/tickets/:id/close', (req, res) => res.json({ ticket: setTicketStatus(String(req.params.id), req.user!, 'closed') }));

supportRouter.get('/chat', (req, res) => res.json({ items: chatHistory(req.user!.id, req.query.since ? String(req.query.since) : null, 'user') }));
supportRouter.post(
  '/chat',
  wrap(async (req, res) => {
    const body = validate(z.object({ body: z.string().min(1).max(2000) }), req.body);
    res.status(201).json({ message: sendChat(req.user!, body.body) });
  }),
);
