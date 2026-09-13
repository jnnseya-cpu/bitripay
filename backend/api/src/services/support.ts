import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { forbidden, notFound, unprocessable } from '../lib/errors';
import { findUserById, toPublicUser, type UserRow } from './users';
import { notify } from './notifications';
import { getModules } from './modules';

export function toTicket(r: any, messages?: any[]) {
  return {
    id: r.id,
    userId: r.user_id,
    subject: r.subject,
    category: r.category,
    priority: r.priority,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    user: findUserById(r.user_id) ? toPublicUser(findUserById(r.user_id)!) : null,
    messages: messages?.map(toMessage),
  };
}

function toMessage(m: any) {
  return { id: m.id, senderId: m.sender_id, isAdmin: !!m.is_admin, body: m.body, createdAt: m.created_at, sender: findUserById(m.sender_id) ? toPublicUser(findUserById(m.sender_id)!) : null };
}

export function createTicket(user: UserRow, input: { subject: string; category?: string; priority?: string; body: string }) {
  if (!getModules().support) throw unprocessable('Support tickets are currently disabled', 'module_disabled');
  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO support_tickets (id, user_id, subject, category, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    user.id,
    input.subject.trim(),
    input.category || 'general',
    input.priority || 'normal',
    'open',
    now(),
    now(),
  );
  db.prepare('INSERT INTO support_messages (id, ticket_id, sender_id, is_admin, body, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(uuid(), id, user.id, input.body.trim(), now());
  return getTicket(id, user);
}

export function listTickets(user: UserRow, filter: { status?: string; all?: boolean; page: number; pageSize: number }) {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (!(filter.all && user.role === 'admin')) {
    where.push('user_id = ?');
    params.push(user.id);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM support_tickets ${whereSql}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM support_tickets ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize);
  return { items: rows.map((r) => toTicket(r)), total };
}

export function getTicket(id: string, user: UserRow) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Ticket not found');
  if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
  const messages = db.prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(id);
  return toTicket(row, messages);
}

export function replyTicket(id: string, user: UserRow, body: string) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Ticket not found');
  const isAdmin = user.role === 'admin';
  if (row.user_id !== user.id && !isAdmin) throw forbidden();
  if (row.status === 'closed') throw unprocessable('This ticket is closed');
  db.prepare('INSERT INTO support_messages (id, ticket_id, sender_id, is_admin, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uuid(), id, user.id, isAdmin ? 1 : 0, body.trim(), now());
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(isAdmin ? 'answered' : 'open', now(), id);
  if (isAdmin) notify(row.user_id, 'Support replied', `Support replied to your ticket "${row.subject}".`, { kind: 'support', ticketId: id });
  return getTicket(id, user);
}

export function setTicketStatus(id: string, user: UserRow, status: 'open' | 'answered' | 'closed') {
  const db = getDb();
  const row = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Ticket not found');
  if (row.user_id !== user.id && user.role !== 'admin') throw forbidden();
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  return getTicket(id, user);
}

// ----- Live chat (user <-> support team) -----
export function sendChat(user: UserRow, body: string, targetUserId?: string) {
  if (!getModules().liveChat) throw unprocessable('Live chat is currently disabled', 'module_disabled');
  const db = getDb();
  const isAdmin = user.role === 'admin';
  const conversationUserId = isAdmin ? targetUserId : user.id;
  if (!conversationUserId) throw notFound('Conversation not found');
  const id = uuid();
  db.prepare('INSERT INTO chat_messages (id, user_id, sender_id, is_admin, body, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(
    id,
    conversationUserId,
    user.id,
    isAdmin ? 1 : 0,
    body.trim().slice(0, 2000),
    now(),
  );
  if (isAdmin) notify(conversationUserId, 'New message from support', body.trim().slice(0, 120), { kind: 'chat' });
  return chatMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));
}

function chatMessage(m: any) {
  return { id: m.id, senderId: m.sender_id, isAdmin: !!m.is_admin, body: m.body, read: !!m.read, createdAt: m.created_at };
}

export function chatHistory(conversationUserId: string, since?: string | null, markReadAs?: 'admin' | 'user') {
  const db = getDb();
  const rows = since
    ? db.prepare('SELECT * FROM chat_messages WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 200').all(conversationUserId, since)
    : db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 100) ORDER BY created_at ASC').all(conversationUserId);
  if (markReadAs === 'admin') db.prepare('UPDATE chat_messages SET read = 1 WHERE user_id = ? AND is_admin = 0').run(conversationUserId);
  if (markReadAs === 'user') db.prepare('UPDATE chat_messages SET read = 1 WHERE user_id = ? AND is_admin = 1').run(conversationUserId);
  return rows.map(chatMessage);
}

export function chatConversations() {
  const rows = getDb()
    .prepare(
      `SELECT user_id, MAX(created_at) last_at, SUM(CASE WHEN is_admin = 0 AND read = 0 THEN 1 ELSE 0 END) unread,
              (SELECT body FROM chat_messages c2 WHERE c2.user_id = c.user_id ORDER BY created_at DESC LIMIT 1) last_body
       FROM chat_messages c GROUP BY user_id ORDER BY last_at DESC LIMIT 100`,
    )
    .all() as any[];
  return rows.map((r) => ({ userId: r.user_id, lastAt: r.last_at, unread: r.unread, lastBody: r.last_body, user: findUserById(r.user_id) ? toPublicUser(findUserById(r.user_id)!) : null }));
}
