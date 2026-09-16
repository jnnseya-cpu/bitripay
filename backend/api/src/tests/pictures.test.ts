/**
 * Profile and cover pictures for every account: saved on upload (no separate save step), served from a public
 * versioned URL that caches, checked by magic bytes, removable by the owner or an administrator, gone on closure.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, adminToken } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

// a valid 1 × 1 PNG and the same bytes mislabelled as JPEG
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const png = `data:image/png;base64,${PNG_1PX}`;
const notReallyJpeg = `data:image/jpeg;base64,${PNG_1PX}`;

describe('profile and cover pictures', () => {
  it('every role can set both pictures; they show on the public profile with a versioned URL and are served with cache headers', async () => {
    for (const role of ['user', 'merchant', 'agent'] as const) {
      const acct = await registerUser(app, role === 'user' ? {} : { role, businessName: `Shop ${role}` });
      expect(acct.user.pictureUrl ?? null).toBeNull();
      const put = await request(app).put('/api/account/picture/profile').set(acct.auth).send({ dataUrl: png });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body.version).toBe(1);
      expect(put.body.user.pictureUrl).toMatch(new RegExp(`/api/pictures/${acct.user.id}/profile\\?v=1$`));
      const cover = await request(app).put('/api/account/picture/cover').set(acct.auth).send({ dataUrl: png });
      expect(cover.status).toBe(200);
      expect(cover.body.user.coverUrl).toMatch(/\/cover\?v=1$/);

      // a counterparty sees the picture on the public profile (recipient lookup), never the bytes inline
      const other = await registerUser(app);
      const lookup = await request(app).get(`/api/account/lookup?q=${acct.user.tag}`).set(other.auth);
      expect(lookup.status).toBe(200);
      expect(lookup.body.user.pictureUrl).toContain(`/api/pictures/${acct.user.id}/profile?v=1`);
      expect(JSON.stringify(lookup.body)).not.toContain('base64');

      // public, cacheable, correct type, ETag round-trip
      const img = await request(app).get(`/api/pictures/${acct.user.id}/profile?v=1`);
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['cache-control']).toContain('immutable');
      expect(img.body.length ?? img.text.length).toBeGreaterThan(0);
      const again = await request(app).get(`/api/pictures/${acct.user.id}/profile?v=1`).set('If-None-Match', img.headers.etag);
      expect(again.status).toBe(304);

      // replacing bumps the version so the URL changes; removing clears it
      const put2 = await request(app).put('/api/account/picture/profile').set(acct.auth).send({ dataUrl: png });
      expect(put2.body.version).toBe(2);
      expect(put2.body.user.pictureUrl).toMatch(/v=2$/);
      const del = await request(app).delete('/api/account/picture/profile').set(acct.auth);
      expect(del.status).toBe(200);
      expect(del.body.user.pictureUrl).toBeNull();
      expect((await request(app).get(`/api/pictures/${acct.user.id}/profile`)).status).toBe(404);
    }
  });

  it('refuses a mislabelled file, a non-image, an unknown kind and an oversized picture', async () => {
    const acct = await registerUser(app);
    const bad = await request(app).put('/api/account/picture/profile').set(acct.auth).send({ dataUrl: notReallyJpeg });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('picture_format');
    expect((await request(app).put('/api/account/picture/profile').set(acct.auth).send({ dataUrl: 'data:text/html;base64,PGh0bWw+' })).status).toBe(400);
    expect((await request(app).put('/api/account/picture/banner').set(acct.auth).send({ dataUrl: png })).status).toBe(400);
    const big = `data:image/png;base64,${Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(1_600_000)]).toString('base64')}`;
    const tooBig = await request(app).put('/api/account/picture/profile').set(acct.auth).send({ dataUrl: big });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.code).toBe('picture_too_large');
  });

  it('an administrator can remove a picture (audited) and closing the account removes both', async () => {
    const acct = await registerUser(app);
    await request(app).put('/api/account/picture/profile').set(acct.auth).send({ dataUrl: png });
    await request(app).put('/api/account/picture/cover').set(acct.auth).send({ dataUrl: png });
    const admin = await adminToken(app);
    const removed = await request(app).delete(`/api/admin/users/${acct.user.id}/picture/cover`).set(admin.auth).send({ reason: 'not appropriate' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.user.coverUrl).toBeNull();
    expect(removed.body.user.pictureUrl).toMatch(/profile\?v=1$/);
    const logs = await request(app).get('/api/admin/audit-logs?limit=5').set(admin.auth);
    expect(JSON.stringify(logs.body)).toContain('user.picture_removed');

    const closed = await request(app).delete('/api/account').set(acct.auth).send({ password: 'Password123!', pin: '1234', confirm: 'CLOSE' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await request(app).get(`/api/pictures/${acct.user.id}/profile`)).status).toBe(404);
  });
});
