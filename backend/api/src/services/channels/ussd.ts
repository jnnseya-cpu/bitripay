/**
 * USSD channel for people without a smartphone or data. The menu is driven by the inputs the aggregator relays
 * (Africa's Talking sends the whole "1*2*..." path on every request; generic gateways send one input per request, so
 * the path is kept in ussd_sessions). Every action goes through the same services, limits and PIN checks as the app:
 * nothing is possible here that is not possible in the app, and less is (no cards, no FX, no admin).
 */
import { getDb } from '../../db';
import { config } from '../../config';
import { uuid, now } from '../../lib/ids';
import { parseJson } from '../../lib/json';
import { createUser, findUserByIdentifier, findUserByPhone, normalizePhone, updateUser, type UserRow } from '../users';
import { listWallets } from '../wallets';
import { listTransactions, calculateFee } from '../ledger';
import { sendMoney } from '../transfers';
import { createCashOutRequest, confirmCashOut } from '../agents';
import { assertPin, setPin } from '../auth';
import { convert, formatMinor, getCurrency, listCurrencies } from '../currencies';
import { getChannelSettings, getAppSettings } from '../settings';
import { recordEvent } from '../events';
import { getSiteSettingsSafe } from '../settings';

export interface UssdReply {
  text: string;
  end: boolean;
}

const L = {
  en: {
    welcome: 'Welcome to BitriPay',
    menu: '1 Balance\n2 Send money\n3 My code\n4 Cash out at agent\n5 Pay merchant\n6 Mini statement\n7 Language\n0 Help',
    register: '1 Register\n2 Help',
    name: 'Your full name:',
    pin: 'Choose a 4-digit PIN:',
    pin2: 'Repeat PIN:',
    enterPin: 'Enter PIN:',
    recipient: 'Recipient (@tag or phone):',
    amount: 'Amount',
    agent: 'Agent (@tag or phone):',
    merchant: 'Merchant (@tag or phone):',
    confirm: 'Confirm',
    fee: 'fee',
    wrongPin: 'Wrong PIN.',
    unknown: 'Unknown option.',
    bye: 'Thank you for using BitriPay.',
    code: 'Your BitriPay code is',
    codeHelp: 'Others can send to this code or your phone number. Agents cash in to it.',
    sent: 'Sent',
    cashCode: 'Cash-out code',
    showAgent: 'Show it to the agent within 30 minutes.',
    lang: '1 English\n2 Français\n3 Kiswahili',
    langSet: 'Language set.',
    help: 'Send money to any @code or phone. Cash in and out at any BitriPay agent. Help:',
    balance: 'Balance',
    noWallet: 'No wallet yet. Cash in at an agent to start.',
    currency: 'Currency',
    registered: 'Welcome',
    tooMuch: 'Amount above the USSD limit',
    notFound: 'Not found',
    closed: 'Registration is closed. Use the app.',
    off: 'This service is not available right now.',
    invalidAmount: 'Invalid amount.',
    pinMismatch: 'PINs do not match.',
    last: 'Last transactions',
  },
  fr: {
    welcome: 'Bienvenue sur BitriPay',
    menu: '1 Solde\n2 Envoyer\n3 Mon code\n4 Retrait agent\n5 Payer marchand\n6 Mini relevé\n7 Langue\n0 Aide',
    register: "1 S'inscrire\n2 Aide",
    name: 'Votre nom complet:',
    pin: 'Choisissez un PIN à 4 chiffres:',
    pin2: 'Répétez le PIN:',
    enterPin: 'Entrez le PIN:',
    recipient: 'Destinataire (@code ou téléphone):',
    amount: 'Montant',
    agent: 'Agent (@code ou téléphone):',
    merchant: 'Marchand (@code ou téléphone):',
    confirm: 'Confirmer',
    fee: 'frais',
    wrongPin: 'PIN incorrect.',
    unknown: 'Option inconnue.',
    bye: "Merci d'utiliser BitriPay.",
    code: 'Votre code BitriPay est',
    codeHelp: "On peut vous envoyer de l'argent avec ce code ou votre numéro. Les agents déposent dessus.",
    sent: 'Envoyé',
    cashCode: 'Code de retrait',
    showAgent: "Montrez-le à l'agent dans les 30 minutes.",
    lang: '1 English\n2 Français\n3 Kiswahili',
    langSet: 'Langue définie.',
    help: 'Envoyez à tout @code ou téléphone. Dépôt et retrait chez tout agent BitriPay. Aide:',
    balance: 'Solde',
    noWallet: 'Pas encore de portefeuille. Déposez chez un agent.',
    currency: 'Devise',
    registered: 'Bienvenue',
    tooMuch: 'Montant au-dessus de la limite USSD',
    notFound: 'Introuvable',
    closed: "Inscription fermée. Utilisez l'application.",
    off: 'Service indisponible pour le moment.',
    invalidAmount: 'Montant invalide.',
    pinMismatch: 'Les PIN ne correspondent pas.',
    last: 'Dernières transactions',
  },
  sw: {
    welcome: 'Karibu BitriPay',
    menu: '1 Salio\n2 Tuma pesa\n3 Kodi yangu\n4 Toa pesa kwa wakala\n5 Lipa mfanyabiashara\n6 Taarifa fupi\n7 Lugha\n0 Msaada',
    register: '1 Jisajili\n2 Msaada',
    name: 'Jina lako kamili:',
    pin: 'Chagua PIN ya tarakimu 4:',
    pin2: 'Rudia PIN:',
    enterPin: 'Weka PIN:',
    recipient: 'Mpokeaji (@kodi au simu):',
    amount: 'Kiasi',
    agent: 'Wakala (@kodi au simu):',
    merchant: 'Mfanyabiashara (@kodi au simu):',
    confirm: 'Thibitisha',
    fee: 'ada',
    wrongPin: 'PIN si sahihi.',
    unknown: 'Chaguo halijulikani.',
    bye: 'Asante kwa kutumia BitriPay.',
    code: 'Kodi yako ya BitriPay ni',
    codeHelp: 'Wengine wanaweza kutuma kwa kodi hii au namba yako ya simu. Mawakala huweka pesa humo.',
    sent: 'Imetumwa',
    cashCode: 'Kodi ya kutoa pesa',
    showAgent: 'Mwonyeshe wakala ndani ya dakika 30.',
    lang: '1 English\n2 Français\n3 Kiswahili',
    langSet: 'Lugha imewekwa.',
    help: 'Tuma pesa kwa @kodi au simu yoyote. Weka na toa pesa kwa wakala yeyote wa BitriPay. Msaada:',
    balance: 'Salio',
    noWallet: 'Hakuna pochi bado. Weka pesa kwa wakala kuanza.',
    currency: 'Sarafu',
    registered: 'Karibu',
    tooMuch: 'Kiasi kinazidi kikomo cha USSD',
    notFound: 'Haipatikani',
    closed: 'Usajili umefungwa. Tumia programu.',
    off: 'Huduma haipatikani kwa sasa.',
    invalidAmount: 'Kiasi si sahihi.',
    pinMismatch: 'PIN hazilingani.',
    last: 'Miamala ya mwisho',
  },
} as const;
type Lang = keyof typeof L;
const langOf = (u: UserRow | undefined): Lang => (((u?.language ?? 'en').slice(0, 2) as Lang) in L ? ((u?.language ?? 'en').slice(0, 2) as Lang) : 'en');

const CON = (text: string): UssdReply => ({ text, end: false });
const END = (text: string): UssdReply => ({ text, end: true });

const money = formatMinor;
function defaultCurrency(user: UserRow): string {
  const w = listWallets(user.id);
  if (w.length) return w.sort((a, b) => b.balance - a.balance)[0].currency;
  return listCurrencies(true).some((c) => c.code === config.baseCurrency) ? config.baseCurrency : (listCurrencies(true)[0]?.code ?? 'USD');
}
function parseAmount(text: string, currency: string): number | null {
  const n = Number(String(text).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10 ** getCurrency(currency).decimals);
}
function withinLimit(minor: number, currency: string): boolean {
  const s = getChannelSettings().ussd;
  let cap: number;
  try {
    cap = convert(s.maxPerTransaction, s.maxPerTransactionCurrency, currency);
  } catch {
    cap = s.maxPerTransaction;
  }
  return minor <= cap;
}
function pinOk(user: UserRow, pin: string): boolean {
  try {
    assertPin(user, pin);
    return true;
  } catch {
    return false;
  }
}
function contact(): string {
  const site = getSiteSettingsSafe();
  return site?.contactEmail ?? getAppSettings().supportEmail ?? 'support@bitripay.com';
}

/** Pure menu logic: the phone number and the inputs so far → the next screen. */
export function ussdHandle(phoneRaw: string, inputs: string[]): UssdReply {
  const s = getChannelSettings().ussd;
  if (!s.enabled) return END(L.en.off);
  const phone = normalizePhone(phoneRaw) ?? phoneRaw;
  const user = findUserByPhone(phone);
  const t = L[langOf(user)];
  const [a, b, c, d, e] = inputs;

  if (!user) {
    if (!s.allowRegistration) return END(t.closed);
    if (a === undefined) return CON(`${t.welcome}\n${t.register}`);
    if (a === '2') return END(`${t.help} ${contact()}`);
    if (a !== '1') return END(t.unknown);
    if (b === undefined) return CON(t.name);
    if (b.trim().length < 2) return END(t.unknown);
    if (c === undefined) return CON(t.pin);
    if (!/^\d{4,6}$/.test(c)) return END(t.unknown);
    if (d === undefined) return CON(t.pin2);
    if (d !== c) return END(t.pinMismatch);
    const created = createUser({ fullName: b.trim().slice(0, 80), phone, phoneVerified: true, country: null });
    setPin(created, c);
    recordEvent('auth', created.id, 'ussd.registered', { type: 'user', id: created.id }, { phone: phone.slice(0, 6) + '…' });
    return END(`${t.registered} ${created.full_name}. ${t.code} @${created.tag}. ${t.codeHelp}`);
  }

  if (a === undefined) return CON(`${t.welcome} ${user.full_name.split(' ')[0]}\n${t.menu}`);
  switch (a) {
    case '1': {
      if (b === undefined) return CON(t.enterPin);
      if (!pinOk(user, b)) return END(t.wrongPin);
      const ws = listWallets(user.id);
      if (!ws.length) return END(t.noWallet);
      return END(`${t.balance}: ${ws.map((w) => `${money(w.balance, w.currency)}${w.frozen_at ? ' (frozen)' : ''}`).join(', ')}`);
    }
    case '2':
    case '5': {
      const label = a === '2' ? t.recipient : t.merchant;
      if (b === undefined) return CON(label);
      const recipient = findUserByIdentifier(b.trim());
      if (!recipient || recipient.is_system || recipient.id === user.id) return END(`${t.notFound}: ${b}`);
      const currency = defaultCurrency(user);
      if (c === undefined) return CON(`${t.amount} (${currency}):`);
      const minor = parseAmount(c, currency);
      if (!minor) return END(t.invalidAmount);
      if (!withinLimit(minor, currency)) return END(`${t.tooMuch}.`);
      const fee = calculateFee(a === '2' ? 'transfer' : 'merchant_payment', minor, currency);
      if (d === undefined)
        return CON(`${t.confirm}: ${money(minor, currency)} → ${recipient.business_name || recipient.full_name} (@${recipient.tag}), ${t.fee} ${money(fee, currency)}.\n${t.enterPin}`);
      if (!pinOk(user, d)) return END(t.wrongPin);
      try {
        const tx = sendMoney(user, {
          to: `@${recipient.tag}`,
          amount: minor,
          currency,
          note: a === '5' ? 'USSD merchant payment' : 'USSD transfer',
          type: a === '5' ? 'merchant_payment' : 'transfer',
          idempotencyKey: `ussd:${phone}:${inputs.join('*')}:${now().slice(0, 13)}`,
        });
        return END(`${t.sent} ${money(minor, currency)} → @${recipient.tag}. Ref ${tx.id.slice(0, 8).toUpperCase()}.`);
      } catch (err: any) {
        return END(String(err?.message ?? 'Failed').slice(0, 140));
      }
    }
    case '3':
      return END(`${t.code} @${user.tag}. ${t.codeHelp}`);
    case '4': {
      if (user.role === 'agent') {
        // Agents confirm a customer's cash-out code from a feature phone too.
        if (b === undefined) return CON(`${t.cashCode}:`);
        if (c === undefined) return CON(t.enterPin);
        if (!pinOk(user, c)) return END(t.wrongPin);
        try {
          const tx = confirmCashOut(user, b.trim());
          return END(`OK ${money(tx.amount, tx.currency)} → ${t.cashCode} ${b.trim().toUpperCase()}.`);
        } catch (err: any) {
          return END(String(err?.message ?? 'Failed').slice(0, 140));
        }
      }
      if (b === undefined) return CON(t.agent);
      const agent = findUserByIdentifier(b.trim());
      if (!agent || agent.role !== 'agent') return END(`${t.notFound}: ${b}`);
      const currency = defaultCurrency(user);
      if (c === undefined) return CON(`${t.amount} (${currency}):`);
      const minor = parseAmount(c, currency);
      if (!minor) return END(t.invalidAmount);
      if (!withinLimit(minor, currency)) return END(`${t.tooMuch}.`);
      if (d === undefined) return CON(t.enterPin);
      if (!pinOk(user, d)) return END(t.wrongPin);
      try {
        const r = createCashOutRequest(user, { agent: `@${agent.tag}`, amount: minor, currency });
        return END(`${t.cashCode} ${r.code} (${money(minor, currency)}, ${t.fee} ${money(r.fee, currency)}). ${t.showAgent}`);
      } catch (err: any) {
        return END(String(err?.message ?? 'Failed').slice(0, 140));
      }
    }
    case '6': {
      if (b === undefined) return CON(t.enterPin);
      if (!pinOk(user, b)) return END(t.wrongPin);
      const items = listTransactions({ userId: user.id, page: 1, pageSize: 5 }).items;
      if (!items.length) return END(`${t.last}: -`);
      return END(
        `${t.last}:\n${items.map((x) => `${x.createdAt.slice(5, 10)} ${x.direction === 'in' ? '+' : '-'}${money(x.amount, x.currency)} ${x.counterparty ? '@' + x.counterparty.tag : x.type.replace(/_/g, ' ')}`).join('\n')}`.slice(
          0,
          180,
        ),
      );
    }
    case '7': {
      if (b === undefined) return CON(t.lang);
      const code = ({ '1': 'en', '2': 'fr', '3': 'sw' } as Record<string, string>)[b];
      if (!code) return END(t.unknown);
      updateUser(user.id, { language: code });
      return END(L[code as Lang].langSet);
    }
    case '0':
      return END(`${t.help} ${contact()}. ${s.serviceCode}`);
    default:
      return END(t.unknown);
  }
  void e;
}

/** Session-aware entry point: keeps the input path for gateways that only send the latest input. */
export function ussdRequest(input: { sessionId: string; phone: string; text: string; provider?: string; fullPath?: boolean }): UssdReply {
  const db = getDb();
  const s = getChannelSettings().ussd;
  const provider = input.provider ?? s.provider;
  const fullPath = input.fullPath ?? provider === 'africastalking';
  let inputs: string[];
  const row = db.prepare('SELECT * FROM ussd_sessions WHERE id = ?').get(input.sessionId) as any;
  const fresh = !row || row.ended || new Date(row.updated_at).getTime() < Date.now() - s.sessionTtlMinutes * 60_000;
  if (fullPath) inputs = input.text === '' ? [] : input.text.split('*');
  else {
    inputs = fresh ? [] : parseJson<string[]>(row.inputs, []);
    if (input.text !== '') inputs = [...inputs, input.text];
  }
  const reply = ussdHandle(input.phone, inputs);
  const phone = normalizePhone(input.phone) ?? input.phone;
  if (fresh)
    db.prepare('INSERT OR REPLACE INTO ussd_sessions (id, phone, provider, inputs, last_response, ended, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.sessionId,
      phone,
      provider,
      JSON.stringify(inputs),
      reply.text,
      reply.end ? 1 : 0,
      now(),
      now(),
    );
  else db.prepare('UPDATE ussd_sessions SET inputs = ?, last_response = ?, ended = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(inputs), reply.text, reply.end ? 1 : 0, now(), input.sessionId);
  return reply;
}

export function recentUssdSessions(limit = 30) {
  return (getDb().prepare('SELECT * FROM ussd_sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as any[]).map((r) => ({
    id: r.id,
    phone: r.phone,
    provider: r.provider,
    inputs: parseJson<string[]>(r.inputs, []),
    lastResponse: r.last_response,
    ended: !!r.ended,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
export function ussdSessionId() {
  return `sim_${uuid().slice(0, 8)}`;
}
