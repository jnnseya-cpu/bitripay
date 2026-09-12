/**
 * CMP-12 evidence vault: the raw bytes needed for an investigation (switch responses, inbound messages, imported
 * reports) are stored append-only, encrypted at rest with the platform key and addressed by their SHA-256. They
 * live apart from technical logs, are never edited, and are exported only through audited admin reads. Sensitive
 * authentication data is never accepted here.
 */
import { getDb } from '../../db';
import { now, shortCode } from '../../lib/ids';
import { encrypt, decrypt, sha256 } from '../../lib/crypto';
import { notFound } from '../../lib/errors';
import { parseJson } from '../../lib/json';

export interface VaultEntry {
  id: string;
  kind: string;
  subjectId: string | null;
  sha256: string;
  bytes: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** Store raw bytes (base64) and return the vault reference. Identical bytes for the same subject are stored once. */
export function storeEvidence(kind: string, subjectId: string | null, rawBase64: string, meta: Record<string, unknown> = {}): string {
  const db = getDb();
  const digest = sha256(rawBase64);
  const existing = db.prepare('SELECT id FROM evidence_vault WHERE sha256 = ? AND subject_id IS ? AND kind = ?').get(digest, subjectId, kind) as any;
  if (existing) return existing.id;
  const id = `ev_${shortCode(16).toLowerCase()}`;
  db.prepare('INSERT INTO evidence_vault (id, kind, subject_id, sha256, ciphertext, bytes, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, kind, subjectId, digest, encrypt(rawBase64), Buffer.from(rawBase64, 'base64').length, JSON.stringify(meta), now());
  return id;
}

export function vaultEntry(id: string): VaultEntry {
  const r = getDb().prepare('SELECT id, kind, subject_id, sha256, bytes, meta, created_at FROM evidence_vault WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Evidence not found', 'evidence_not_found');
  return { id: r.id, kind: r.kind, subjectId: r.subject_id, sha256: r.sha256, bytes: r.bytes, meta: parseJson(r.meta, {}), createdAt: r.created_at };
}

/** Decrypt for an authorised export; the caller audits the access. */
export function readEvidence(id: string): { entry: VaultEntry; rawBase64: string } {
  const r = getDb().prepare('SELECT * FROM evidence_vault WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Evidence not found', 'evidence_not_found');
  const rawBase64 = decrypt(r.ciphertext);
  if (sha256(rawBase64) !== r.sha256) throw new Error(`evidence ${id} failed its integrity check`);
  return { entry: vaultEntry(id), rawBase64 };
}

export function listEvidence(subjectId: string): VaultEntry[] {
  return (getDb().prepare('SELECT id, kind, subject_id, sha256, bytes, meta, created_at FROM evidence_vault WHERE subject_id = ? ORDER BY created_at').all(subjectId) as any[]).map((r) => ({ id: r.id, kind: r.kind, subjectId: r.subject_id, sha256: r.sha256, bytes: r.bytes, meta: parseJson(r.meta, {}), createdAt: r.created_at }));
}

/** Integrity sweep for the console: every entry must still hash to its recorded digest. */
export function verifyVault(limit = 500): { checked: number; broken: string[] } {
  const rows = getDb().prepare('SELECT id, sha256, ciphertext FROM evidence_vault ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
  const broken: string[] = [];
  for (const r of rows) {
    try {
      if (sha256(decrypt(r.ciphertext)) !== r.sha256) broken.push(r.id);
    } catch {
      broken.push(r.id);
    }
  }
  return { checked: rows.length, broken };
}
