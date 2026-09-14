/**
 * Rails provisioned from the environment: credentials present → connectivity check → enabled only when the check
 * passes, recorded as a system event; absent credentials leave the rail untouched; direct mobile-money rails from
 * MOMO_DIRECT_RAILS; the go-live checklist names every rail and the production URLs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { setupApp, adminToken } from './helpers';
import { provisionRailsFromEnvironment, getGateway, listGateways } from '../payments';
import { provisionDirectRailsFromEnvironment, listOperators } from '../services/momo';
import { goLiveChecklist } from '../services/goLive';
import { getDb } from '../db';

let app: ReturnType<typeof setupApp>;
let btcpay: http.Server;
let btcpayUrl = '';
beforeAll(async () => {
  app = setupApp();
  // a minimal BTCPay Greenfield stand-in: server info and one store, token-authenticated
  btcpay = http.createServer((req, res) => {
    if (req.headers.authorization !== 'token test-key') {
      res.writeHead(401).end(JSON.stringify({ message: 'unauthorized' }));
      return;
    }
    if (req.url === '/api/v1/server/info')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '2.0.0', supportedPaymentMethods: ['BTC-CHAIN', 'BTC-LN'] }));
    if (req.url === '/api/v1/stores/store-1') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'store-1', name: 'BitriPay' }));
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => btcpay.listen(0, '127.0.0.1', r));
  btcpayUrl = `http://127.0.0.1:${(btcpay.address() as { port: number }).port}`;
});
afterAll(() => btcpay.close());

describe('rails from the environment', () => {
  it('leaves every rail untouched when nothing is configured', async () => {
    const before = listGateways().map((g) => [g.id, g.enabled]);
    const results = await provisionRailsFromEnvironment({ credentials: {} });
    expect(results.every((r) => r.outcome === 'skipped')).toBe(true);
    expect(listGateways().map((g) => [g.id, g.enabled])).toEqual(before);
  });

  it('enables the Bitcoin rail when BTCPay credentials pass the connectivity check and records a system event', async () => {
    expect(getGateway('bitcoin')!.enabled).toBe(false);
    const results = await provisionRailsFromEnvironment({
      credentials: { bitcoin: { mode: 'btcpay', serverUrl: btcpayUrl, storeId: 'store-1', apiKey: 'test-key', webhookSecret: 'whs', network: 'testnet' } },
      autoEnable: true,
    });
    const btc = results.find((r) => r.provider === 'bitcoin')!;
    expect(btc.outcome, btc.message).toBe('enabled');
    expect(getGateway('bitcoin')!.enabled).toBe(true);
    expect(getGateway('bitcoin')!.lastHealth?.ok).toBe(true);
    const ev = getDb().prepare("SELECT * FROM event_log WHERE event = 'gateway.enabled_from_environment' AND subject_id = 'bitcoin'").get() as any;
    expect(ev).toBeTruthy();
    expect(ev.actor_type).toBe('system');
    // idempotent: a second run reports configured, never a second enable event
    const again = await provisionRailsFromEnvironment({ credentials: { bitcoin: { mode: 'btcpay', serverUrl: btcpayUrl, storeId: 'store-1', apiKey: 'test-key', network: 'testnet' } } });
    expect(again.find((r) => r.provider === 'bitcoin')!.outcome).toBe('configured');
    expect((getDb().prepare("SELECT COUNT(*) c FROM event_log WHERE event = 'gateway.enabled_from_environment' AND subject_id = 'bitcoin'").get() as any).c).toBe(1);
  });

  it('never enables a rail whose check fails and respects RAILS_AUTO_ENABLE=0', async () => {
    getDb().prepare("UPDATE gateways SET enabled = 0 WHERE id = 'bitcoin'").run();
    const bad = await provisionRailsFromEnvironment({
      credentials: { bitcoin: { mode: 'btcpay', serverUrl: btcpayUrl, storeId: 'store-1', apiKey: 'wrong-key', network: 'testnet' } },
      autoEnable: true,
    });
    expect(bad.find((r) => r.provider === 'bitcoin')!.outcome).toBe('failed');
    expect(getGateway('bitcoin')!.enabled).toBe(false);
    const manual = await provisionRailsFromEnvironment({
      credentials: { bitcoin: { mode: 'btcpay', serverUrl: btcpayUrl, storeId: 'store-1', apiKey: 'test-key', network: 'testnet' } },
      autoEnable: false,
    });
    expect(manual.find((r) => r.provider === 'bitcoin')!.outcome).toBe('configured');
    expect(getGateway('bitcoin')!.enabled).toBe(false);
  });

  it('opens direct mobile-money rails from MOMO_DIRECT_RAILS without overwriting an administrator’s collection number', () => {
    const r1 = provisionDirectRailsFromEnvironment([
      { operatorId: 'orange_cd', collectionNumber: '+243890000100', collectionName: 'BitriPay SARL' },
      { operatorId: 'no_such_operator', collectionNumber: '+10000000', collectionName: null },
    ]);
    expect(r1.provisioned).toEqual(['orange_cd']);
    expect(r1.unknown).toEqual(['no_such_operator']);
    const orange = listOperators({ onlyDirect: true }).find((o) => o.id === 'orange_cd')!;
    expect(orange.collectionNumber).toBe('+243890000100');
    expect(orange.collectionName).toBe('BitriPay SARL');
    // an administrator changed the number afterwards: the environment does not override it
    getDb().prepare("UPDATE momo_operators SET collection_number = '+243899999999' WHERE id = 'orange_cd'").run();
    const r2 = provisionDirectRailsFromEnvironment([{ operatorId: 'orange_cd', collectionNumber: '+243890000100', collectionName: null }]);
    expect(r2.kept).toEqual(['orange_cd']);
    expect(listOperators({ onlyDirect: true }).find((o) => o.id === 'orange_cd')!.collectionNumber).toBe('+243899999999');
  });

  it('shows rails, direct rails, the switch and the public URLs on the go-live checklist', async () => {
    const check = goLiveChecklist();
    const ids = check.items.map((i) => i.id);
    for (const id of ['rails', 'direct_rails', 'switch', 'public_urls', 'processor', 'secrets']) expect(ids).toContain(id);
    expect(check.items.find((i) => i.id === 'direct_rails')!.ok).toBe(true);
    expect(check.items.find((i) => i.id === 'switch')!.detail).toMatch(/simulation/);
    const admin = await adminToken(app);
    const res = await request(app).get('/api/admin/go-live').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toContain('rails');
  });
});
