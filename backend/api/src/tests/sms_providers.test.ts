/**
 * SMS providers: Twilio and Africa's Talking are selected by SMS_PROVIDER (or the console settings), each called with
 * its own credentials and wire format. A provider that accepted the message reports its own name; one that refuses,
 * fails or has no credentials never makes the message disappear: it is queued for an enrolled phone, which sends it
 * from its own SIM (the countries these providers do not serve, the Democratic Republic of the Congo among them).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setupApp } from './helpers';
import { sendSms, smsProvider, africasTalkingUrl, listSmsOutbox } from '../services/messaging';
import { setSetting } from '../services/settings';
import { channelStatus } from '../services/comms/engine';

beforeAll(() => {
  setupApp();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setSetting('sms', { provider: 'console' });
});

describe('SMS providers', () => {
  it("sends through Africa's Talking with its wire format and reads the per-recipient status", async () => {
    setSetting('sms', { provider: 'africastalking', africasTalkingUsername: 'bitripay', africasTalkingApiKey: 'atsk_test', africasTalkingFrom: 'BitriPay' });
    expect(smsProvider().africasTalking).toEqual({ username: 'bitripay', apiKey: 'atsk_test', from: 'BitriPay' });
    expect(channelStatus().sms).toEqual({ wired: true, detail: "Africa's Talking (live, sender BitriPay)" });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: 101, status: 'Success', number: '+243810000000' }] } }), { status: 201 });
    });
    const r = await sendSms('+243810000000', 'Your BitriPay code is 123456');
    expect(r).toEqual({ delivered: true, via: 'africastalking' });
    expect(calls[0].url).toBe('https://api.africastalking.com/version1/messaging');
    expect((calls[0].init.headers as Record<string, string>).apiKey).toBe('atsk_test');
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get('username')).toBe('bitripay');
    expect(body.get('to')).toBe('+243810000000');
    expect(body.get('from')).toBe('BitriPay');
    expect(body.get('message')).toContain('123456');
  });

  it('queues a refused message for an enrolled phone and targets the sandbox host for the sandbox username', async () => {
    setSetting('sms', { provider: 'africastalking', africasTalkingUsername: 'sandbox', africasTalkingApiKey: 'atsk_sandbox' });
    expect(africasTalkingUrl('sandbox')).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(channelStatus().sms.detail).toBe("Africa's Talking (sandbox)");
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ SMSMessageData: { Message: 'InvalidPhoneNumber', Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber' }] } }), { status: 201 }),
    );
    const before = listSmsOutbox().length;
    expect(await sendSms('+243810000009', 'Refusé par le fournisseur')).toEqual({ delivered: true, via: 'africastalking_to_device' });
    const queued = listSmsOutbox();
    expect(queued.length).toBe(before + 1);
    expect(queued[0]).toMatchObject({ to: '+243810000009', status: 'queued' });
  });

  it('keeps Twilio as before and queues for an enrolled phone when the selected provider has no credentials', async () => {
    setSetting('sms', { provider: 'twilio', twilioSid: 'AC1', twilioToken: 't', twilioFrom: '+15550000000' });
    expect(channelStatus().sms).toEqual({ wired: true, detail: 'Twilio' });
    vi.stubGlobal('fetch', async (url: string) => new Response(url.includes('api.twilio.com/2010-04-01/Accounts/AC1/Messages.json') ? '{}' : 'wrong', { status: 201 }));
    expect(await sendSms('+243810000000', 'hi')).toEqual({ delivered: true, via: 'twilio' });
    setSetting('sms', { provider: 'africastalking' });
    expect(channelStatus().sms).toEqual({ wired: false, detail: 'africastalking: credentials missing, SMS wait in the outbox for an enrolled phone' });
    expect(await sendSms('+243810000000', 'hi')).toEqual({ delivered: true, via: 'africastalking_unconfigured_to_device' });
  });
});
