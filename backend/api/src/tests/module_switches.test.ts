/**
 * Every module switch the console offers must mean something on the server.
 *
 * Two of them did not. `kyc` was read in exactly one place — the web app hid a settings tab — so an administrator who
 * switched KYC verification off saw it disappear from one interface while the API kept accepting submissions from
 * Lite, the phone app and any direct caller. `referrals` was read nowhere at all: switching the programme off left
 * rewards being paid out of the treasury on every registration and first deposit. A control that reports a state it
 * does not enforce is worse than no control, because somebody acts on it.
 *
 * These tests assert the switch, not the interface. The sweep at the end is the part that matters longest: it fails
 * if any future flag is added to the console without enforcement behind it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { setupApp, registerUser, adminToken } from './helpers';
import { setSetting } from '../services/settings';
import { DEFAULT_MODULES, type ModuleFlags } from '../services/modules';
import { referralStats } from '../services/referrals';

let app: ReturnType<typeof setupApp>;
let user: Awaited<ReturnType<typeof registerUser>>;

beforeAll(async () => {
  app = setupApp();
  await adminToken(app);
  user = await registerUser(app);
});
afterAll(() => setSetting('modules', DEFAULT_MODULES));

const withModule = async (key: keyof ModuleFlags, on: boolean, fn: () => Promise<void> | void) => {
  setSetting('modules', { ...DEFAULT_MODULES, [key]: on });
  try {
    await fn();
  } finally {
    setSetting('modules', DEFAULT_MODULES);
  }
};

describe('module switches are enforced on the server', () => {
  it('refuses the KYC route family when KYC verification is switched off', async () => {
    await withModule('kyc', true, async () => {
      expect((await request(app).get('/api/kyc').set(user.auth)).status).toBe(200);
    });
    await withModule('kyc', false, async () => {
      const res = await request(app).get('/api/kyc').set(user.auth);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.code).toBe('module_disabled');
      expect(res.body.error.details.module).toBe('kyc');
      // A submission is the one that mattered: hiding a tab never stopped it.
      const post = await request(app).post('/api/kyc').set(user.auth).send({ documentType: 'national_id', documentNumber: 'X1234567' });
      expect(post.status).toBe(422);
      expect(post.body.error.code).toBe('module_disabled');
    });
  });

  it('stops attributing and paying referral rewards when the programme is switched off', async () => {
    await withModule('referrals', false, () => {
      const stats = referralStats(user.user.id);
      // History stays readable — it was earned — but the caller is told the programme is not running, so no
      // interface can keep offering a share link that would attribute nobody.
      expect(stats.enabled).toBe(false);
      expect(Array.isArray(stats.rewards)).toBe(true);
    });
    await withModule('referrals', true, () => {
      expect(referralStats(user.user.id).enabled).toBe(true);
    });
  });

  it('every flag the console presents is read somewhere on the server', () => {
    const root = path.resolve(__dirname, '../..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'tests') walk(p);
        } else if (e.name.endsWith('.ts') && e.name !== 'modules.ts') files.push(p);
      }
    };
    walk(root);
    const corpus = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const unread = (Object.keys(DEFAULT_MODULES) as (keyof ModuleFlags)[]).filter((k) => !new RegExp(`requireModule\\('${k}'\\)|modules\\.${k}\\b|getModules\\(\\)\\.${k}\\b`).test(corpus));
    expect(unread, `console flags with no server-side reader: ${unread.join(', ')}`).toEqual([]);
  });
});
