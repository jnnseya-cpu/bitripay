import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { now } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { config } from '../config';

/**
 * Profile and cover pictures. Every account type has both; a picture is saved the moment it is chosen (the clients
 * upload on selection, there is no separate save step) and served from a versioned public URL so browsers and phones
 * cache it until it changes. The image is checked by its magic bytes, never by the declared type alone.
 */
export const PICTURE_KINDS = ['profile', 'cover'] as const;
export type PictureKind = (typeof PICTURE_KINDS)[number];

/** Upload ceilings after the client-side resize (profile 512 px square, cover 1600 × 600). */
export const PICTURE_LIMITS: Record<PictureKind, number> = { profile: 1_500_000, cover: 3_000_000 };

type Mime = 'image/jpeg' | 'image/png' | 'image/webp';

interface PictureRow {
  user_id: string;
  kind: PictureKind;
  mime: Mime;
  bytes: Buffer;
  size: number;
  sha256: string;
  updated_at: string;
}

export const isPictureKind = (v: unknown): v is PictureKind => (PICTURE_KINDS as readonly string[]).includes(String(v));

/** The declared type must match what the bytes say. */
function sniff(bytes: Buffer): Mime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Parse a `data:image/…;base64,…` URL into checked bytes. */
export function decodePictureDataUrl(dataUrl: string, kind: PictureKind): { mime: Mime; bytes: Buffer } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl ?? '');
  if (!m) throw badRequest('Send a JPEG, PNG or WebP image as a base64 data URL', 'picture_format');
  const declared = m[1] as Mime;
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw badRequest('The image is empty', 'picture_format');
  if (bytes.length > PICTURE_LIMITS[kind]) throw badRequest(`The ${kind} picture must be under ${Math.round((PICTURE_LIMITS[kind] / 1_000_000) * 10) / 10} MB`, 'picture_too_large');
  const actual = sniff(bytes);
  if (!actual || actual !== declared) throw badRequest('The file is not the image type it claims to be', 'picture_format');
  return { mime: actual, bytes };
}

const versionColumn = (kind: PictureKind) => (kind === 'profile' ? 'picture_version' : 'cover_version');

/** Save (or replace) a picture and bump its version so the public URL changes. Returns the new version. */
export function setPicture(userId: string, kind: PictureKind, dataUrl: string): number {
  const { mime, bytes } = decodePictureDataUrl(dataUrl, kind);
  const db = getDb();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO user_pictures (user_id, kind, mime, bytes, size, sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, size = excluded.size, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
    ).run(userId, kind, mime, bytes, bytes.length, sha256, now());
    const col = versionColumn(kind);
    db.prepare(`UPDATE users SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`).run(now(), userId);
    return (db.prepare(`SELECT ${col} v FROM users WHERE id = ?`).get(userId) as { v: number }).v;
  })();
}

/** Remove a picture (owner or an administrator). Version 0 means none; a later upload restarts from the old count + 1. */
export function removePicture(userId: string, kind: PictureKind): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM user_pictures WHERE user_id = ? AND kind = ?').run(userId, kind);
    db.prepare(`UPDATE users SET ${versionColumn(kind)} = 0, updated_at = ? WHERE id = ?`).run(now(), userId);
  })();
}

/** Both pictures go when an account is closed (right to erasure). */
export function removeAllPictures(userId: string): void {
  for (const kind of PICTURE_KINDS) removePicture(userId, kind);
}

export function getPicture(userId: string, kind: PictureKind): PictureRow {
  const row = getDb().prepare('SELECT * FROM user_pictures WHERE user_id = ? AND kind = ?').get(userId, kind) as PictureRow | undefined;
  if (!row) throw notFound('No such picture');
  return row;
}

/** Public, versioned URLs (null when the account has no picture of that kind). */
export function pictureUrls(row: { id: string; picture_version?: number | null; cover_version?: number | null }): { pictureUrl: string | null; coverUrl: string | null } {
  const url = (kind: PictureKind, v: number | null | undefined) => (v && v > 0 ? `${config.apiUrl}/api/pictures/${row.id}/${kind}?v=${v}` : null);
  return { pictureUrl: url('profile', row.picture_version), coverUrl: url('cover', row.cover_version) };
}
