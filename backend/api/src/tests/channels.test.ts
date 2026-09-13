/** Feature-phone channels: USSD registration and money menu, agent cash-out confirmation, SMS commands, webhook formats and the Lite web. */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund, adminToken } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});
const phone = () => `+2439${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
/** Africa's Talking style: the aggregator resends the whole path each time. */
const at = (sessionId: string, phoneNumber: string, text: string) => request(app).post('/api/ussd').type('form').send({ sessionId, serviceCode: '*384*247#', phoneNumber, text });
/** Generic gateway: one input per request, the API keeps the path. */
const gen = (sessionId: string, ph: string, input: string) => request(app).post('/api/ussd?format=json').send({ sessionId, phone: ph, input });

describe('USSD', () => {
  it('registers a new phone with a name and PIN, then serves balance, code and help from the menu', async () => {
    const ph = phone();
    const sid = `s${Date.now()}`;
    let r = await at(sid, ph, '');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^CON Welcome to BitriPay\n1 Register/);
    r = await at(sid, ph, '1');
    expect(r.text).toBe('CON Your full name:');
    r = await at(sid, ph, '1*Mama Chantal');
    expect(r.text).toBe('CON Choose a 4-digit PIN:');
    r = await at(sid, ph, '1*Mama Chantal*2468');
    expect(r.text).toBe('CON Repeat PIN:');
    r = await at(sid, ph, '1*Mama Chantal*2468*2468');
    expect(r.text).toMatch(/^END Welcome Mama Chantal\. Your BitriPay code is @/);
    const tag = r.text.match(/@([a-z0-9_.-]+)/)![1];
    // registered: main menu, balance under PIN, my code, help
    r = await at('s2', ph, '');
    expect(r.text).toMatch(/^CON Welcome to BitriPay Mama\n1 Balance/);
    r = await at('s2', ph, '1');
    expect(r.text).toBe('CON Enter PIN:');
    r = await at('s2', ph, '1*0000');
    expect(r.text).toBe('END Wrong PIN.');
    r = await at('s3', ph, '1*2468');
    expect(r.text).toMatch(/^END (Balance: \$0\.00|No wallet yet)/);
    r = await at('s4', ph, '3');
    expect(r.text).toContain(`END Your BitriPay code is @${tag}`);
    r = await at('s5', ph, '0');
    expect(r.text).toMatch(/^END Send money to any @code or phone/);
    // the account is a normal BitriPay account: the app can sign in with the phone + a password set later, and the tag resolves
    const admin = await adminToken(app);
    const found = await request(app).get(`/api/admin/users?search=${encodeURIComponent(tag)}`).set(admin.auth);
    expect(found.status).toBe(200);
  });

  it('sends money, pays a merchant and creates an agent cash-out code from a feature phone, within the USSD limit', async () => {
    const senderPhone = phone();
    const sender = await registerUser(app, { phone: senderPhone });
    await fund(app, sender.user.id, '100.00', 'USD');
    const friend = await registerUser(app);
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Kiosk Deux' });
    const agentPhone = phone();
    const agent = await registerUser(app, { role: 'agent', phone: agentPhone });
    // send: 2 → recipient → amount → PIN
    let r = await gen('g1', senderPhone, '');
    expect(r.body.end).toBe(false);
    r = await gen('g1', senderPhone, '2');
    expect(r.body.text).toBe('Recipient (@tag or phone):');
    r = await gen('g1', senderPhone, `@${friend.user.tag}`);
    expect(r.body.text).toBe('Amount (USD):');
    r = await gen('g1', senderPhone, '12.50');
    expect(r.body.text).toMatch(/^Confirm: \$12\.50 → User \d+ \(@/);
    r = await gen('g1', senderPhone, '1234');
    expect(r.body.end).toBe(true);
    expect(r.body.text).toMatch(/^Sent \$12\.50 → @/);
    const fw = await request(app).get('/api/wallets').set(friend.auth);
    expect(fw.body.items.find((w: any) => w.currency === 'USD').balance).toBe(1_250);
    // pay merchant
    r = await at('p1', senderPhone, `5*@${merchant.user.tag}*3*1234`);
    expect(r.text).toMatch(/^END Sent \$3\.00 → @/);
    // above the channel ceiling
    r = await at('p2', senderPhone, `2*@${friend.user.tag}*5000*1234`);
    expect(r.text).toMatch(/^END Amount above the USSD limit/);
    // cash-out code for an agent, then the agent confirms it from their own phone
    r = await at('c1', senderPhone, `4*@${agent.user.tag}*20*1234`);
    expect(r.text).toMatch(/^END Cash-out code [A-Z0-9]{6} \(\$20\.00/);
    const code = r.text.match(/code ([A-Z0-9]{6})/)![1];
    const confirm = await at('c2', agentPhone, `4*${code}*1234`);
    expect(confirm.text, confirm.text).toMatch(/^END OK \$20\.00/);
    const aw = await request(app).get('/api/wallets').set(agent.auth);
    expect(aw.body.items.find((w: any) => w.currency === 'USD').balance).toBeGreaterThan(0);
    // mini statement and language switch
    r = await at('m1', senderPhone, '6*1234');
    expect(r.text).toMatch(/^END Last transactions:/);
    r = await at('l1', senderPhone, '7*2');
    expect(r.text).toBe('END Langue définie.');
    r = await at('l2', senderPhone, '');
    expect(r.text).toMatch(/^CON Bienvenue sur BitriPay/);
  });

  it('protects the webhook with a shared secret when one is configured', async () => {
    const admin = await adminToken(app);
    await request(app).put('/api/admin/channels/settings').set(admin.auth).send({ ussd: { secret: 'top-secret' } });
    const denied = await at('x1', phone(), '');
    expect(denied.status).toBe(403);
    const ok = await request(app).post('/api/ussd?secret=top-secret').type('form').send({ sessionId: 'x2', phoneNumber: phone(), text: '' });
    expect(ok.status).toBe(200);
    await request(app).put('/api/admin/channels/settings').set(admin.auth).send({ ussd: { secret: '' } });
    const view = await request(app).get('/api/admin/channels').set(admin.auth);
    expect(view.body.settings.ussd.secret).toBe('');
    expect(view.body.ussdSessions.length).toBeGreaterThan(0);
  });
});

describe('SMS commands', () => {
  it('answers BAL, SEND, CODE, STMT and HELP with PIN checks, and replies in the aggregator format', async () => {
    const ph = phone();
    const u = await registerUser(app, { phone: ph });
    await fund(app, u.user.id, '50.00', 'USD');
    const friend = await registerUser(app);
    const sms = (text: string, extra: Record<string, string> = {}) => request(app).post('/api/sms/inbound').type('form').send({ from: ph, text, ...extra });
    let r = await sms('HELP');
    expect(r.text).toContain('BAL <PIN>');
    r = await sms('BAL 9999');
    expect(r.text).toBe('Wrong PIN. Format: BAL <PIN>');
    r = await sms('bal 1234');
    expect(r.text).toBe('Balance: $50.00');
    r = await sms(`SEND 7.25 @${friend.user.tag} 1234`);
    expect(r.text).toMatch(/^Sent \$7\.25 to @/);
    expect(r.text).toContain('New balance: $42.');
    r = await sms(`SEND 900 @${friend.user.tag} 1234`);
    expect(r.text).toMatch(/^Amount above the SMS limit/);
    r = await sms('CODE');
    expect(r.text).toBe(`Your BitriPay code is @${u.user.tag}. Others can send to it or to your phone number.`);
    r = await sms('STMT 1234');
    expect(r.text).toMatch(/^Last: /);
    // Twilio field names get TwiML back
    const tw = await request(app).post('/api/sms/inbound').type('form').send({ From: ph, Body: 'CODE' });
    expect(tw.headers['content-type']).toContain('text/xml');
    expect(tw.text).toContain('<Message>Your BitriPay code is');
    // unknown numbers are invited to register, and can
    const newPhone = phone();
    const unknown = await request(app).post('/api/sms/inbound?format=json').send({ phone: newPhone, message: 'BAL 1234' });
    expect(unknown.body.reply).toContain('not registered');
    const reg = await request(app).post('/api/sms/inbound?format=json').send({ phone: newPhone, message: 'REG Papa Jean 5555' });
    expect(reg.body.reply).toMatch(/^Welcome Papa Jean\. Your BitriPay code is @/);
    const admin = await adminToken(app);
    const log = await request(app).get('/api/admin/channels').set(admin.auth);
    expect(log.body.sms.some((m: any) => m.direction === 'in' && m.body === 'REG Papa Jean 5555')).toBe(true);
    const sim = await request(app).post('/api/admin/channels/sms/simulate').set(admin.auth).send({ phone: newPhone, text: 'BAL 5555' });
    expect(sim.body.reply).toMatch(/^(Balance: \$0\.00|No wallet yet)/);
  });
});

describe('Lite web', () => {
  const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  it('signs in with phone and PIN, shows balances, sends money and downloads a statement without any JavaScript', async () => {
    const ph = phone();
    const u = await registerUser(app, { phone: ph });
    await fund(app, u.user.id, '30.00', 'USD');
    const friend = await registerUser(app);
    const login = await request(app).get('/lite');
    expect(login.status).toBe(200);
    expect(login.text).toContain('<form method="post" action="/lite/login">');
    expect(login.text).not.toContain('<script');
    expect(login.text.length).toBeLessThan(6000);
    const bad = await request(app).post('/lite/login').type('form').send({ identifier: ph, secret: '0000' });
    expect(bad.headers.location).toContain('/lite?err=');
    const ok = await request(app).post('/lite/login').type('form').send({ identifier: ph, secret: '1234' });
    expect(ok.headers.location).toBe('/lite/home');
    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/^bp_lite=/);
    const home = await request(app).get('/lite/home').set('Cookie', cookie);
    expect(home.text).toContain('$30.00');
    expect(home.text).toContain(`@${u.user.tag}`);
    const send = await request(app).post('/lite/send').set('Cookie', cookie).type('form').send({ to: `@${friend.user.tag}`, amount: '4.50', currency: 'USD', note: 'bread', pin: '1234' });
    expect(send.headers.location).toMatch(/^\/lite\/home\?ok=Sent/);
    const after = await request(app).get('/lite/history').set('Cookie', cookie);
    expect(after.text).toContain('bread');
    const csv = await request(app).get('/lite/statement?currency=USD&from=2020-01-01&to=2099-01-01&format=csv').set('Cookie', cookie);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('bread');
    const html = await request(app).get('/lite/statement?currency=USD&from=2020-01-01&to=2099-01-01').set('Cookie', cookie);
    expect(html.text).toContain('Closing');
    const out = await request(app).get('/lite/logout').set('Cookie', cookie);
    expect(out.headers.location).toBe('/lite');
    const gone = await request(app).get('/lite/home').set('Cookie', cookie);
    expect(gone.headers.location).toContain('/lite?next=');
    // registration from a basic browser
    const reg = await request(app).post('/lite/register').type('form').send({ fullName: 'Maman Grace', phone: phone(), pin: '4321' });
    expect(reg.headers.location).toMatch(/^\/lite\/home\?ok=Welcome/);
  });
});
