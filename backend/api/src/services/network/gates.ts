/**
 * Phase gates, kill-or-pivot criteria and the register of open questions.
 *
 * A phase is funded only when the previous one's gates are met, and a gate is met only when a measurement is
 * recorded against it with the evidence behind it. The same table holds the kill-or-pivot criteria, because they are
 * read on the same day and by the same people: one says what unlocks the next phase, the other what ends the current
 * one.
 *
 * The open questions are the ones that can change scope or cost. Each names what it blocks, so a piece of work can
 * say which answers it is waiting for — and `blockingQuestions()` answers that question in one call.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { badRequest, notFound } from '../../lib/errors';
import { recordEvent } from '../events';
import { NETWORK_PHASES, SEED_GATES, SEED_QUESTIONS } from '../../content/corridorNetwork';
import type { UserRow } from '../users';

export type GateStatus = 'not_started' | 'in_progress' | 'met' | 'missed';
export type GateKind = 'gate' | 'kill_or_pivot';
export type QuestionStatus = 'open' | 'answered' | 'blocked';

export interface NetworkGate {
  id: string;
  code: string;
  phase: number;
  kind: GateKind;
  criterion: string;
  target: string;
  unit: string | null;
  measured: string | null;
  status: GateStatus;
  evidence: string | null;
  owner: string | null;
  checkedBy: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkQuestion {
  id: string;
  ref: string;
  area: string;
  question: string;
  phase: number;
  owner: string | null;
  status: QuestionStatus;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  blocks: string | null;
  createdAt: string;
  updatedAt: string;
}

const gateRow = (r: any): NetworkGate => ({
  id: r.id,
  code: r.code,
  phase: r.phase,
  kind: r.kind,
  criterion: r.criterion,
  target: r.target,
  unit: r.unit ?? null,
  measured: r.measured ?? null,
  status: r.status,
  evidence: r.evidence ?? null,
  owner: r.owner ?? null,
  checkedBy: r.checked_by ?? null,
  checkedAt: r.checked_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const questionRow = (r: any): NetworkQuestion => ({
  id: r.id,
  ref: r.ref,
  area: r.area,
  question: r.question,
  phase: r.phase,
  owner: r.owner ?? null,
  status: r.status,
  answer: r.answer ?? null,
  answeredBy: r.answered_by ?? null,
  answeredAt: r.answered_at ?? null,
  blocks: r.blocks ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Insert only what is missing: a measurement, an answer or an owner an administrator set is never overwritten. */
export function seedGatesAndQuestions(): { gates: number; questions: number } {
  const db = getDb();
  const ts = now();
  let gates = 0;
  let questions = 0;
  for (const g of SEED_GATES) {
    if (db.prepare('SELECT 1 FROM network_gates WHERE code = ?').get(g.code)) continue;
    db.prepare(
      `INSERT INTO network_gates (id, code, phase, kind, criterion, target, unit, status, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?)`,
    ).run(uuid(), g.code, g.phase, g.kind, g.criterion, g.target, g.unit, g.owner, ts, ts);
    gates += 1;
  }
  for (const q of SEED_QUESTIONS) {
    if (db.prepare('SELECT 1 FROM network_questions WHERE ref = ?').get(q.ref)) continue;
    db.prepare(
      `INSERT INTO network_questions (id, ref, area, question, phase, owner, status, blocks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(uuid(), q.ref, q.area, q.question, q.phase, q.owner, q.blocks, ts, ts);
    questions += 1;
  }
  return { gates, questions };
}

export function listGates(filter: { phase?: number | null; kind?: GateKind | null } = {}): NetworkGate[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.phase) {
    where.push('phase = ?');
    args.push(filter.phase);
  }
  if (filter.kind) {
    where.push('kind = ?');
    args.push(filter.kind);
  }
  const sql = `SELECT * FROM network_gates ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY phase, kind DESC, code`;
  return (
    getDb()
      .prepare(sql)
      .all(...args) as any[]
  ).map(gateRow);
}

export function getGate(codeOrId: string): NetworkGate {
  const r = getDb().prepare('SELECT * FROM network_gates WHERE id = ? OR code = ?').get(codeOrId, codeOrId) as any;
  if (!r) throw notFound('Unknown gate', 'gate_not_found');
  return gateRow(r);
}

/** Record where a gate stands, with what was measured and where that measurement came from. */
export function recordGate(codeOrId: string, input: { status: GateStatus; measured?: string | null; evidence?: string | null; owner?: string | null }, admin: UserRow): NetworkGate {
  const g = getGate(codeOrId);
  if (!['not_started', 'in_progress', 'met', 'missed'].includes(input.status)) throw badRequest('Unknown gate status');
  if ((input.status === 'met' || input.status === 'missed') && !(input.measured ?? g.measured))
    throw badRequest('A gate is met or missed against a measurement; say what was measured.', 'measurement_required');
  if ((input.status === 'met' || input.status === 'missed') && !(input.evidence ?? g.evidence))
    throw badRequest('Say where the measurement comes from, so the next reader can check it.', 'evidence_required');
  getDb()
    .prepare(
      'UPDATE network_gates SET status = ?, measured = COALESCE(?, measured), evidence = COALESCE(?, evidence), owner = COALESCE(?, owner), checked_by = ?, checked_at = ?, updated_at = ? WHERE id = ?',
    )
    .run(input.status, input.measured ?? null, input.evidence ?? null, input.owner ?? null, admin.id, now(), now(), g.id);
  recordEvent('network', g.id, `network.gate.${input.status}`, { type: 'admin', id: admin.id }, { code: g.code, phase: g.phase, measured: input.measured ?? g.measured });
  return getGate(g.id);
}

export function listQuestions(filter: { status?: QuestionStatus | null; phase?: number | null; area?: string | null } = {}): NetworkQuestion[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  if (filter.phase) {
    where.push('phase = ?');
    args.push(filter.phase);
  }
  if (filter.area) {
    where.push('area = ?');
    args.push(filter.area);
  }
  const sql = `SELECT * FROM network_questions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY phase, ref`;
  return (
    getDb()
      .prepare(sql)
      .all(...args) as any[]
  ).map(questionRow);
}

export function getQuestion(refOrId: string): NetworkQuestion {
  const r = getDb().prepare('SELECT * FROM network_questions WHERE id = ? OR ref = ?').get(refOrId, refOrId) as any;
  if (!r) throw notFound('Unknown question', 'question_not_found');
  return questionRow(r);
}

export function addQuestion(input: { ref: string; area: string; question: string; phase: number; owner?: string | null; blocks?: string | null }, admin: UserRow): NetworkQuestion {
  if (getDb().prepare('SELECT 1 FROM network_questions WHERE ref = ?').get(input.ref)) throw badRequest(`Question ${input.ref} already exists.`, 'duplicate_ref');
  if (!NETWORK_PHASES.some((p) => p.phase === input.phase)) throw badRequest('Phase must be 1, 2, 3 or 4');
  const ts = now();
  const id = uuid();
  getDb()
    .prepare(`INSERT INTO network_questions (id, ref, area, question, phase, owner, status, blocks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(id, input.ref, input.area, input.question, input.phase, input.owner ?? null, input.blocks ?? null, ts, ts);
  recordEvent('network', id, 'network.question.added', { type: 'admin', id: admin.id }, { ref: input.ref, area: input.area });
  return getQuestion(id);
}

/** Answer a question of record. The answer is what the work that was waiting on it is built against. */
export function answerQuestion(refOrId: string, answer: string, admin: UserRow): NetworkQuestion {
  const q = getQuestion(refOrId);
  if (!answer.trim()) throw badRequest('An answer of record cannot be empty.');
  getDb().prepare("UPDATE network_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?, updated_at = ? WHERE id = ?").run(answer, admin.id, now(), now(), q.id);
  recordEvent('network', q.id, 'network.question.answered', { type: 'admin', id: admin.id }, { ref: q.ref, area: q.area });
  return getQuestion(q.id);
}

export function setQuestionStatus(refOrId: string, status: QuestionStatus, admin: UserRow, note?: string | null): NetworkQuestion {
  const q = getQuestion(refOrId);
  if (status === 'answered') throw badRequest('Answer the question instead: an answer of record needs the answer.', 'answer_required');
  getDb().prepare('UPDATE network_questions SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), q.id);
  recordEvent('network', q.id, `network.question.${status}`, { type: 'admin', id: admin.id }, { ref: q.ref, note: note ?? null });
  return getQuestion(q.id);
}

/**
 * The questions still open for a phase: what must be answered before that phase is built. `within` lets a caller
 * that has already read the register filter it rather than query again.
 */
export function blockingQuestions(phase: number, within?: NetworkQuestion[]): NetworkQuestion[] {
  const list = within ?? listQuestions({ phase });
  return list.filter((q) => q.phase === phase && q.status !== 'answered');
}

export interface PhaseReadiness {
  phase: number;
  name: string;
  window: string;
  role: string;
  holdsCustomerFunds: string;
  gates: { total: number; met: number; missed: number; outstanding: NetworkGate[] };
  killCriteria: NetworkGate[];
  openQuestions: NetworkQuestion[];
  /** A phase is clear to be funded when every gate of the PREVIOUS phase is met and no question of this one is open. */
  clearToFund: boolean;
  blockedBy: string[];
}

export function phaseReadiness(): PhaseReadiness[] {
  const gates = listGates();
  const questions = listQuestions();
  return NETWORK_PHASES.map((p) => {
    const own = gates.filter((g) => g.phase === p.phase && g.kind === 'gate');
    const previous = gates.filter((g) => g.phase === p.phase - 1 && g.kind === 'gate');
    const open = blockingQuestions(p.phase, questions);
    const previousUnmet = previous.filter((g) => g.status !== 'met');
    const blockedBy = [
      ...previousUnmet.map((g) => `Phase ${p.phase - 1} gate not met: ${g.criterion}`),
      ...open.map((q) => `${q.ref} unanswered: ${q.question}`),
      ...gates.filter((g) => g.phase === p.phase && g.kind === 'kill_or_pivot' && g.status === 'missed').map((g) => `Kill-or-pivot triggered: ${g.criterion}`),
    ];
    return {
      phase: p.phase,
      name: p.name,
      window: p.window,
      role: p.role,
      holdsCustomerFunds: p.holdsCustomerFunds,
      gates: { total: own.length, met: own.filter((g) => g.status === 'met').length, missed: own.filter((g) => g.status === 'missed').length, outstanding: own.filter((g) => g.status !== 'met') },
      killCriteria: gates.filter((g) => g.phase === p.phase && g.kind === 'kill_or_pivot'),
      openQuestions: open,
      clearToFund: blockedBy.length === 0,
      blockedBy,
    };
  });
}
