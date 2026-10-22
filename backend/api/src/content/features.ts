/**
 * The feature catalogue: what BitriPay does, feature by feature, in the words of the person who would buy it.
 *
 * Every entry carries the one sentence a competitor cannot say (`usp`), the problem as the customer experiences it,
 * how the thing actually works, and `proof` — facts a reader can check against the running platform rather than
 * adjectives. The catalogue is the single source for the feature pages, the feature articles and the internal
 * linking, so a claim is written once and cannot drift between them.
 *
 * `module` binds a feature to the flag that decides whether it is switched on. Availability is never written into
 * the prose: the pages compute it from live state, so a capability that is built but not yet authorised reads as
 * exactly that instead of being sold as though it were running.
 */
import type { ModuleFlags } from '../services/modules';
import { FEATURES_FR } from './featuresFr';

export type FeatureCategory = 'accept' | 'build' | 'move' | 'reach' | 'operate' | 'trust';

export const FEATURE_CATEGORIES_FR: Record<FeatureCategory, { label: string; blurb: string }> = {
  accept: { label: 'Encaisser', blurb: 'Toutes les façons dont un client peut remettre de l’argent à une entreprise, du code imprimé au mur à la page de paiement hébergée.' },
  build: { label: 'Construire sur BitriPay', blurb: 'L’API, les notifications, les SDK et les extensions qui mettent le paiement à l’intérieur du produit de quelqu’un d’autre.' },
  move: { label: 'Faire circuler l’argent', blurb: 'Ce qui arrive à l’argent une fois reçu : portefeuilles, transferts, décaissements, espèces et le passage d’une frontière.' },
  reach: { label: 'Atteindre tout le monde', blurb: 'Les clients qu’une plateforme de paiement abandonne d’habitude : pas de smartphone, pas de données, pas de réseau, pas de lecture.' },
  operate: { label: 'Tenir l’entreprise', blurb: 'Les comptes, le règlement, les relevés, les litiges et les personnes qui s’en occupent.' },
  trust: { label: 'Le prouver', blurb: 'L’identité, le risque, les invariants du grand livre et les preuves qu’un régulateur demande à voir.' },
};

export const FEATURE_CATEGORIES: Record<FeatureCategory, { label: string; blurb: string }> = {
  accept: { label: 'Take the money', blurb: 'Every way a customer can hand money to a business, from a printed code on a wall to a hosted checkout.' },
  build: { label: 'Build on BitriPay', blurb: 'The API, the webhooks, the SDKs and the plugins that put payments inside somebody else’s product.' },
  move: { label: 'Move the money', blurb: 'What happens to money once it has arrived: wallets, transfers, payouts, cash and the journey across a border.' },
  reach: { label: 'Reach everyone', blurb: 'The customers a payment platform normally gives up on: no smartphone, no data, no signal, no electricity, no reading.' },
  operate: { label: 'Run the business', blurb: 'The books, the settlement, the statements, the disputes and the people who look after them.' },
  trust: { label: 'Prove it', blurb: 'Identity, risk, the ledger’s own invariants and the evidence a regulator asks to see.' },
};

export interface FeatureFaq {
  question: string;
  answer: string;
}

/**
 * The translatable half of a feature. English lives on the `Feature` itself; another language supplies the same
 * shape, so a page or an article is rendered from one object whichever language it is in and a missing field is a
 * test failure rather than a paragraph that silently stays English.
 */
export interface FeatureText {
  name: string;
  tagline: string;
  headline: string;
  excerpt: string;
  usp: string;
  audience: string;
  problem: string;
  how: string[];
  proof: string[];
  cost: string;
  faq: FeatureFaq[];
  article: string;
  /** The slug of the article in this language; the feature page keeps one canonical path and switches with ?lang=. */
  articleSlug: string;
}

export interface Feature {
  key: string;
  name: string;
  slug: string;
  category: FeatureCategory;
  /** The flag that switches this on; null for the platform's own machinery, which is always present. */
  module: keyof ModuleFlags | null;
  /** Other flags this same feature describes, so every module is covered without writing the same article twice. */
  alsoCovers?: (keyof ModuleFlags)[];
  /** One sentence: what this does that the alternatives do not. */
  usp: string;
  /** A short line for a card or a list. */
  tagline: string;
  /** The title of the article that sells this feature. */
  headline: string;
  /** The standfirst: why a reader should spend four minutes on it. */
  excerpt: string;
  /** Who would pay for this, named as they would name themselves. */
  audience: string;
  /** The problem in the customer's experience, not in ours. */
  problem: string;
  /** What happens, in order. */
  how: string[];
  /** Checkable facts about the running platform. No adjectives. */
  proof: string[];
  /** What it costs and where the limits are. */
  cost: string;
  faq: FeatureFaq[];
  keywords: string[];
  /** Keys of other features worth reading next. */
  related: string[];
  /** Where somebody who wants it should go. */
  cta: { label: string; href: string };
  /** The article, written for a reader. Markdown, no front matter, no availability claims. */
  article: string;
}

export const FEATURES: Feature[] = [
  // ----------------------------------------------------------------- accept
  {
    key: 'qr-payments',
    name: 'BitriQR payments',
    slug: 'qr-code-payments',
    category: 'accept',
    module: 'qrPayments',
    usp: 'One printed code that works for a customer with the app, a customer with only a camera, and a customer whose bank has never heard of BitriPay — because the code is EMVCo underneath and signed on top.',
    tagline: 'One code on the wall. Every payer it can reach.',
    headline: 'One printed code, every payer: how BitriQR works',
    excerpt:
      'A card machine has to be bought, charged and replaced. A QR code is a piece of paper. Here is what makes a printed code safe enough to nail to a wall, and why the sound matters more than the screen.',
    audience: 'Market traders, shops, pharmacies, schools, transport operators — anyone who wants to be paid without a card machine.',
    problem:
      'A card machine costs money, needs charging, needs a signal and needs reading. A plain mobile-money number means the customer types the amount themselves and you argue about what arrived. Neither works at a stall where the queue is six people long.',
    how: [
      'Print the code once. It never changes, so it can be laminated and nailed to the wall.',
      'For a specific amount, open the point of sale, type the total, and the screen shows a one-time code with the amount already in it.',
      'The customer scans. A BitriPay user pays in one tap; anyone else lands on a checkout page that offers the rails their own institution supports.',
      'The phone plays a loud alarm and vibrates when the money actually arrives — not when the customer says it did.',
    ],
    proof: [
      'The payload is an EMVCo merchant-presented QR with a CRC, so a wallet that already reads EMVCo codes can read it.',
      'A signed extension carries the merchant, the terminal and the amount, verified against an Ed25519 key registry that supports rotation.',
      'Every code can be revoked with a reason — lost, stolen, tampered, replaced, retired — and a revoked code stops resolving immediately.',
      'Scan analytics are kept per code, so a stall owner can see which printed sheet is actually being used.',
    ],
    cost: 'Receiving into a personal wallet is free. A merchant account pays the percentage shown in its dashboard before the sale, and a payment carried by the national switch carries the aggregation fee set in the console. Nothing is deducted that the dashboard did not show first.',
    faq: [
      {
        question: 'Does the customer need the BitriPay app?',
        answer:
          'No. A BitriPay user pays in one scan. Anyone else opens the same code in their phone camera and reaches a checkout page that offers the rails available to them, and the merchant still receives it the same way.',
      },
      {
        question: 'What stops somebody printing their own code and sticking it over mine?',
        answer:
          'The code carries a signature over the merchant and the amount, checked against a published key registry before anything is shown to the payer. A code that has been altered does not resolve, and the payer sees a refusal rather than a payment screen.',
      },
      {
        question: 'I cannot read well. How do I know I have been paid?',
        answer:
          'The phone plays a loud alarm and vibrates for several seconds, and the screen shows the amount in large figures with a green tick. If there is no sound, there is no money — a screenshot on the customer’s phone is not a payment.',
      },
    ],
    keywords: ['qr code payment', 'emvco qr', 'accept payments without a card machine', 'merchant qr code', 'static qr payment'],
    related: ['payment-links', 'point-of-sale', 'hosted-checkout'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `A card machine is a piece of equipment. A QR code is a piece of paper. That difference decides who can take a digital payment in most of the markets BitriPay serves, and it is the whole reason BitriQR exists.

## The problem with the alternatives

A terminal has to be bought, charged, carried home at night and replaced when it breaks. It needs a signal of its own. It assumes somebody at the stall can read the screen.

The usual answer is to paint a mobile-money number on a board. That works until the customer mistypes the amount, or pays the stall next door, or shows you a screenshot and walks off with the fish. You have no reference, no record and no argument.

## What a signed code changes

BitriQR is an EMVCo merchant-presented QR code — the same standard a bank wallet already reads — with a signed extension on top. The extension carries who the merchant is, which terminal it belongs to and, for a one-time code, the exact amount.

That signature is checked against a published key registry before the payer is shown anything. Alter a single character and the code stops resolving. Print your own and stick it over somebody else's and it does not become theirs; it becomes nothing.

Codes can be revoked with a reason — lost, stolen, tampered, replaced, retired — and a revoked code stops working the moment it is revoked, not the next day.

## Two codes, two jobs

**The stall code never changes.** Print it once, laminate it, nail it to the wall. The customer scans and types what they owe. This is the code for a trader with a queue.

**The one-time code carries the amount.** Open the point of sale, type the total, show the screen. The customer scans and the amount is already filled in. There is nothing to mistype, which means there is nothing to argue about. This is the code for a pharmacy, a school fee desk, a shop with prices.

## The sound is the receipt

When the money actually arrives, the phone plays a loud alarm and vibrates, and the screen shows the amount in large figures with a green tick and the payer's name. It is designed to be heard across a noisy market and understood without reading.

The rule for anyone taking payments is one sentence: **if there was no sound, there was no money.** A screenshot on the customer's phone is not a payment. It is a picture.

## What it costs

Receiving into a personal wallet is free. A merchant account pays the percentage its dashboard shows, and a payment carried by the national switch carries the aggregation fee set in the console. Both are visible before the sale, not discovered afterwards on a statement.

## Where to start

Open a merchant account, go to Receive, and press Enlarge. Print what you see. You are taking digital payments as soon as the ink is dry.`,
  },

  {
    key: 'payment-links',
    name: 'Payment links',
    slug: 'payment-links',
    category: 'accept',
    module: 'paymentLinks',
    usp: 'A link you can paste into WhatsApp that behaves like a full checkout — reusable or single-use, with an expiry, a reference and a webhook when it is paid.',
    tagline: 'Get paid by sending a message.',
    headline: 'Get paid in the chat where the sale happened',
    excerpt:
      'Most selling here happens in a chat window and ends with a mobile-money number nobody can match to an order. A payment link carries the reason with the money, so the order and the payment are the same record.',
    audience: 'Anyone who sells over WhatsApp, Facebook or the telephone: tailors, mechanics, consultants, online sellers, schools collecting fees.',
    problem:
      'Most selling in the region happens in a chat window. The seller has no website and no terminal, so the conversation ends with a mobile-money number and a promise. Nothing links the money to the order.',
    how: [
      'Create a link with an amount, a description and a reference — or leave the amount open and let the payer type it.',
      'Choose single-use for one invoice, or reusable for a product you sell again and again.',
      'Paste it into the chat. The payer opens a checkout page carrying your name and the reason for the payment.',
      'The payment arrives against your reference, so the order and the money are the same record.',
    ],
    proof: [
      'A link can be deactivated at any moment, and a deactivated link stops accepting payment immediately.',
      'Every link carries its own reference, which appears on the payment, the statement and the webhook.',
      'Links are created from the dashboard or from the API with one call, so a shop system can issue one per invoice.',
      'A paid link raises the same signed webhook as any other payment, so an order can be marked paid without anyone watching a screen.',
    ],
    cost: 'A link costs nothing to create. The payment it collects carries the ordinary merchant rate shown in the dashboard.',
    faq: [
      {
        question: 'Can I use one link for everything?',
        answer:
          'Yes — a reusable link with an open amount works as a general "pay me" link. For invoices, a single-use link with the amount and the reference already set is better, because the payment arrives matched to the order.',
      },
      {
        question: 'What if I send the link to the wrong person?',
        answer: 'Deactivate it. A deactivated link stops accepting payment at once, and the dashboard shows it as inactive with the time it was stopped.',
      },
      {
        question: 'Does the payer need an account?',
        answer: 'No. The link opens a hosted checkout that offers the rails available to that payer.',
      },
    ],
    keywords: ['payment link', 'get paid on whatsapp', 'invoice link', 'sell without a website', 'payment link api'],
    related: ['qr-payments', 'hosted-checkout', 'money-requests'],
    cta: { label: 'Create a payment link', href: '/register?role=merchant' },
    article: `Most selling in Kinshasa does not happen on a website. It happens in a chat window — a photograph of the goods, a price, an agreement, and then the awkward part: *send to this number*.

The awkward part is where the money and the order stop being the same thing.

## What goes wrong with a number

You post a mobile-money number. Three customers pay it the same afternoon. One pays the wrong amount, one pays from their cousin's phone, and one pays a number they screenshotted from an older message that belongs to somebody else.

Now you are a detective. Which payment was for which order? Who is owed goods? You have a list of amounts and no references, and the only way to match them is memory.

## A link carries the reason with the money

A payment link is a web address that already knows what it is for. It carries your name, the amount if you set one, a description the payer can read, and a reference of your choosing.

Paste it into the conversation where the sale happened. The customer taps it, lands on a checkout page that says who you are and what they are paying for, and pays with whatever rail is available to them.

The payment arrives **against your reference**. Order 1042 is paid by the person who was sent the link for order 1042. There is nothing to match by hand.

## Single-use or reusable

**Single-use** is for an invoice. One link, one payment, then it closes. If the customer forwards it to a friend, the friend cannot pay it twice.

**Reusable** is for a product you sell repeatedly — a haircut, a delivery fee, a monthly subscription to your service. Pin it in your shop's bio and let it work all year.

Either can be deactivated the moment you want it to stop. A deactivated link refuses payment immediately; it does not keep collecting while you sleep.

## For anyone running a shop system

Links are one API call. A shop, a school fee system or a billing tool can issue a fresh link per invoice, with the invoice number as the reference, and get a signed webhook the moment it is paid. The order is marked paid by software, not by somebody refreshing a page.

## What it costs

Making links is free. You pay the ordinary merchant rate on the money they collect, shown in your dashboard before you send anything.

## Where to start

Open a merchant account, go to Payment links, and make one for the thing you sell most often. Put it in your WhatsApp profile. It will still be working next year.`,
  },

  {
    key: 'money-requests',
    name: 'Money requests',
    slug: 'money-requests',
    category: 'accept',
    module: 'moneyRequests',
    usp: 'A request that arrives as a notification the other person can approve with a fingerprint, instead of a message they have to act on from memory.',
    tagline: 'Ask once. It waits for them.',
    headline: 'The polite way to be paid back',
    excerpt:
      'Asking someone you know for money costs more than the money. A request that waits in their app, that they approve with a fingerprint and that can never take anything by itself, changes the arithmetic.',
    audience: 'Anyone owed money by someone they know: landlords, tutors, saccos, friends splitting a bill, small suppliers.',
    problem: 'Asking for money by message is socially expensive and easy to ignore. You send a number, they say they will do it later, and later never has a reminder attached to it.',
    how: [
      'Choose who you are asking, the amount and the reason.',
      'They receive a notification with your name, the amount and the reason, and a single approve button.',
      'Approving takes a fingerprint or a PIN; the money moves on the ledger in one posting.',
      'Until they approve, the request sits in their app where they can see it, and in yours where you can cancel it.',
    ],
    proof: [
      'A request is never a debit: nothing moves until the other side approves it with their own credential.',
      'Both sides see the same record with the same status, so there is no argument about whether it was sent.',
      'A request can be cancelled by the person who sent it, and a cancelled request cannot be approved afterwards.',
      'The reason travels with the request and lands on both statements.',
    ],
    cost: 'Asking is free. The transfer that results carries the ordinary rate for a transfer between accounts, shown before approval.',
    faq: [
      {
        question: 'Can somebody take money from my account by sending a request?',
        answer: 'No. A request is an ask, not a debit. Nothing leaves your account until you approve it with your own fingerprint or PIN, and you can refuse it.',
      },
      {
        question: 'What if they ignore it?',
        answer: 'It stays in their app as an open request they can see every time they open it, which is considerably harder to forget than a message that has scrolled away.',
      },
      {
        question: 'Can I cancel one I sent by mistake?',
        answer: 'Yes, and once cancelled it cannot be approved. Both of you see that it was cancelled and when.',
      },
    ],
    keywords: ['request money', 'ask for money app', 'split a bill', 'collect rent', 'payment request'],
    related: ['payment-links', 'qr-payments'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Asking someone you know for money is the most awkward transaction in finance. There is no invoice, no terms, no collections department — just you, deciding how many times you can bring it up before it costs you the relationship.

## Why a message does not work

You send the number. They say *sure, tonight*. The message scrolls away. A week later you have to decide whether to raise it again, and that decision is the expensive part. Most people simply do not, and the money quietly becomes a gift.

The problem is not that they are dishonest. It is that a chat message has no state. It does not sit anywhere. It does not wait.

## A request waits

A money request arrives as a notification carrying your name, the amount and the reason. It does not scroll away. It sits in their app as an open item, visible every time they open it, with a single approve button.

That changes the social arithmetic completely. You asked once. The reminding is done by the software, which has no feelings about it and never gets tired.

## It cannot take anything

This is the part worth being precise about, because it is what makes the feature safe to use between people who are not family.

A request is an **ask**, never a debit. Nothing leaves the other person's account until they approve it with their own fingerprint or PIN. They can refuse it. Someone who sends you a request has gained no access to your money whatsoever — they have sent you a question.

## Both sides see the same thing

You see what you sent and its status. They see what was asked and by whom. When it is approved, both statements carry the same reason you typed.

If you sent it by mistake, cancel it. A cancelled request cannot be approved afterwards, and both of you can see that it was cancelled and when. There is no version of events to disagree about.

## Who this is really for

Landlords chasing rent from tenants they see every day. Tutors paid monthly by parents. Savings groups collecting a weekly contribution. Suppliers who deliver first and invoice after. Anyone whose relationship with the debtor survives the debt and therefore cannot afford a confrontation.

## What it costs

Asking is free. The transfer that follows carries the ordinary rate for a transfer between accounts, shown to the payer before they approve.`,
  },

  {
    key: 'hosted-checkout',
    name: 'Hosted checkout',
    slug: 'hosted-checkout',
    category: 'accept',
    module: 'merchantGateway',
    usp: 'A checkout that offers the payer only the rails that can actually complete their payment, decided at the moment they arrive rather than listed hopefully on a page.',
    tagline: 'A page that only offers what will work.',
    headline: 'A checkout that only offers what will actually work',
    excerpt:
      'Every failed checkout loses a customer who had already said yes. Instead of listing eight logos and hoping, the page works out which rails can complete this payment, for this payer, at this minute — and shows only those.',
    audience: 'Online shops, marketplaces, billing systems, booking sites and any business sending customers somewhere to pay.',
    problem:
      'A checkout that lists ten logos and fails on eight of them teaches customers to abandon the page. Worse, it fails after they have committed, which is the most expensive moment to lose them.',
    how: [
      'Create a payment intent or a checkout session with the amount, the currency and your reference.',
      'Send the customer to the URL it returns, or show the QR payload it returns.',
      'The page works out which rails can carry this payment, for this payer, right now — and shows only those.',
      'When it is paid, you get a signed webhook and the customer goes back to your success page.',
    ],
    proof: [
      'The rails offered are computed per payment, from the corridor, the currency, the payer and the live health of each connector.',
      'A rail whose circuit breaker is open is not offered, so a customer is never sent down a path that is currently failing.',
      'Under the aggregator perimeter the checkout offers the switch rail alone and refuses the rest, rather than showing options the platform may not operate.',
      'The session carries line items with VAT where the merchant uses them, so the customer sees what they are being charged for.',
    ],
    cost: 'The hosted checkout is part of the merchant gateway; there is no separate charge for it. You pay the rate for the rail that carries the payment, shown in the dashboard.',
    faq: [
      {
        question: 'Can I put my own branding on it?',
        answer: 'The page carries your business name, your reference and your line items, and returns the customer to your own success and cancel URLs.',
      },
      {
        question: 'What happens if a rail goes down mid-sale?',
        answer:
          'A connector whose circuit breaker has opened stops being offered, so new customers are routed around it rather than into it. A payment already in flight follows its own state machine and is never marked paid without confirmation.',
      },
      {
        question: 'Do I have to use the hosted page?',
        answer: 'No. The same intent can be rendered as a QR payload, embedded with a publishable key, or driven entirely from the API if you want to build the screen yourself.',
      },
    ],
    keywords: ['hosted checkout', 'online payment page', 'checkout session', 'payment intent', 'accept payments online drc'],
    related: ['qr-payments', 'payment-links', 'developer-api'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `Every failed checkout has the same shape. The customer has decided to buy. They have reached for their phone. And then the page offers them eight ways to pay, of which two will actually work, and they find that out one failure at a time.

That is the most expensive place in the whole funnel to lose somebody, because it is the one place where they had already said yes.

## Lists are optimistic. Routing is not.

Most checkouts show a fixed list of logos. The list is a statement of what the business has signed up for, not what will work for the person standing there.

BitriPay's checkout asks a different question: *for this payment, this currency, this payer, at this minute — what can actually complete?* It answers from the corridor the payment belongs to, the currency, and the live health of every connector, and it shows only what survives that test.

A connector whose circuit breaker has opened is not on the page. Not greyed out — absent. The customer is routed around a failing rail instead of into it, and never learns that it was failing.

## It refuses rather than pretends

This matters more than it sounds. Under the aggregator perimeter the checkout offers the switch rail alone and refuses everything else outright, because the platform may not operate the rest until the corresponding authorisation exists.

A checkout that offered those options anyway would be making a promise the platform is not allowed to keep. Ours would rather show one working option than four hopeful ones.

## What the customer sees

Your business name, your reference, and your line items with VAT where you use them — so they are looking at what they are buying, not at a bare amount they have to take on trust.

When they have paid, they go back to your own success page, and you get a signed webhook carrying the reference you set. Your order is marked paid by software.

## You do not have to use the page

The same payment intent can be a hosted page, a QR payload, an embedded panel driven by a publishable key, or raw API calls into a screen you built yourself. The routing is the same in every case; only the surface changes.

## What it costs

The hosted checkout is part of the merchant gateway. There is no charge for the page. You pay the rate for whichever rail carried the payment, and your dashboard shows that rate before the sale rather than after it.`,
  },

  {
    key: 'point-of-sale',
    name: 'Point of sale',
    slug: 'point-of-sale',
    category: 'accept',
    module: 'merchantGateway',
    usp: 'A till that runs on the phone already in the shopkeeper’s hand, with line items and VAT, and no hardware to buy, charge or replace.',
    tagline: 'The till is the phone you already own.',
    headline: 'Your till is the phone in your pocket',
    excerpt:
      'A till does three jobs: add up the parts, get the tax right, produce a receipt both sides accept. None of them need hardware. Line items, VAT per line, a total nobody types, and staff logins that do not hand over the business.',
    audience: 'Shops, pharmacies, restaurants, hardware stores and any business that sells more than one thing at a time.',
    problem:
      'A business that sells several items at once cannot be paid with a single number. It needs a total built from parts, a tax line that is correct, and a receipt the customer accepts — and the usual way to get that is a machine that costs more than a month of profit.',
    how: [
      'Add the items to the sale on the phone, with quantities.',
      'VAT is applied per line at the rate set for the business, and the total is built from the lines rather than typed.',
      'Show the one-time code; the customer scans and the amount is already filled in.',
      'The receipt carries the lines, the tax and the reference, and is kept against the sale.',
    ],
    proof: [
      'Line items carry quantity and a VAT rate per line, so the tax on a mixed basket is right rather than approximated.',
      'The total is computed from the lines, so a mistyped total is not possible.',
      'The receipt and the checkout detail show the same lines the customer agreed to.',
      'Staff can be given their own logins with a cashier role whose refund limit is set per organisation.',
    ],
    cost: 'No hardware and no licence. The sale carries the ordinary merchant rate shown in the dashboard.',
    faq: [
      {
        question: 'Can my staff use it without seeing everything?',
        answer:
          'Yes. A cashier signs in with their own account and can take payments and refund up to the limit the business sets, but cannot change settlement instructions, read API secrets or export customers.',
      },
      {
        question: 'Does it work for a business with no VAT?',
        answer: 'Set the rate to zero and the lines carry no tax. The totals and the receipt work the same way.',
      },
      {
        question: 'What if the customer wants a paper receipt?',
        answer: 'The receipt is a page that can be printed or shown on screen, and it carries the same lines, tax and reference that are held against the sale.',
      },
    ],
    keywords: ['mobile point of sale', 'pos on a phone', 'till with vat', 'shop payment system drc', 'line items receipt'],
    related: ['qr-payments', 'hosted-checkout', 'team-and-roles'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `A trader selling one thing can be paid with one number. A pharmacy cannot. A hardware shop cannot. A restaurant certainly cannot. The moment a sale is made of parts, you need a till — and a till has always meant hardware.

## What the hardware was actually for

Strip away the plastic and a till does three jobs: it adds up the parts, it gets the tax right, and it produces a receipt both sides accept.

None of those three require a machine. They require software and a screen. The shopkeeper is already holding a screen.

## Built from the lines, not typed

The sale is assembled from items with quantities. VAT is applied per line, at the rate set for the business, so a basket mixing taxed and untaxed goods comes out right rather than roughly right.

The total is then **computed from the lines**. Nobody types it. This sounds small until you count how many disputes in a small shop come down to a total that was typed wrong and noticed too late.

Then the phone shows a one-time code with the amount already in it. The customer scans and pays. There is no number to read out, no amount to mistype, and no argument about what was owed.

## The receipt is the record

What the customer sees on the receipt — the lines, the quantities, the tax, the reference — is what is held against the sale in your records. Print it or show it on screen. It is the same record either way.

## Staff without handing over the business

This is where most small shops get stuck: the owner cannot be at the counter all day, but giving an employee the phone usually means giving them everything.

Staff get their own logins with a cashier role. A cashier takes payments and can refund up to a limit the business sets. A cashier cannot change where settlement money goes, cannot read API secrets, and cannot export the customer list. The owner sets the refund limit; the software enforces it, every time, without a conversation.

## What it costs

No hardware, no licence, no monthly rental. You pay the ordinary merchant rate on what you sell, shown in your dashboard.

The till you have been saving for is the phone in your pocket.`,
  },

  // ------------------------------------------------------------------ build
  {
    key: 'developer-api',
    name: 'The gateway API',
    slug: 'payments-api',
    category: 'build',
    module: null,
    usp: 'A payments API whose documentation is generated from the same table that serves the requests, so the reference can never describe an endpoint the platform does not have.',
    tagline: 'Three calls and a webhook.',
    headline: 'Three calls and a webhook: the BitriPay API',
    excerpt:
      'The documentation is generated from the same table that serves the requests, so it cannot describe an endpoint that does not exist. Idempotency that refuses rather than duplicates, errors you can branch on, and a sandbox that fails properly.',
    audience: 'Developers integrating payments into a shop, a billing system, a marketplace, a school platform or an institution’s own software.',
    problem:
      'Integrating payments usually means reading documentation that was true last quarter, discovering the real behaviour from error messages, and building retry logic because the provider’s idea of idempotency is a suggestion.',
    how: [
      'Create a payment intent with an amount, a currency and your reference.',
      'Send the customer to its checkout URL, or render its QR payload.',
      'Act on the signed webhook when the payment succeeds or settles.',
      'Reconcile against the statement; every object carries the reference you gave it.',
    ],
    proof: [
      'The OpenAPI document and the human reference are generated from one operation table, so they cannot disagree.',
      'Every money-moving POST requires an Idempotency-Key: a replay returns the original object, and the same key with a different body is refused.',
      'Webhooks are signed twice — HMAC-SHA256 over the timestamped body, and an Ed25519 platform signature — and retried on a published schedule across 24 hours.',
      'Errors carry a descriptive code and a stable numeric family, so software can branch on the family without parsing English.',
      'A sandbox with documented magic numbers drives the real state machine, including the failures, without touching an operator.',
    ],
    cost: 'The API costs nothing to use. You pay for the payments it moves, at the rate on your account.',
    faq: [
      {
        question: 'How do I test a failure?',
        answer:
          'The sandbox publishes magic numbers that drive specific outcomes — success, insufficient funds, a timeout that later succeeds — through the same attempt machine production uses. You test the unhappy paths without an operator and without pretending.',
      },
      {
        question: 'What happens if my server retries a payment?',
        answer:
          'Send the same Idempotency-Key and you get the original object back rather than a second payment. The same key with a different body is refused outright, which turns a dangerous bug into a readable error.',
      },
      {
        question: 'How do I know a webhook is really from you?',
        answer:
          'Each delivery carries a timestamped HMAC over the exact body using your endpoint secret, plus an Ed25519 signature from the platform key you can fetch from the key registry. Verify either or both, and reject anything older than five minutes.',
      },
    ],
    keywords: ['payments api', 'openapi payments', 'idempotency key', 'signed webhooks', 'payment intent api', 'drc payment api'],
    related: ['webhooks', 'connected-accounts', 'hosted-checkout'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `Most payment integrations are archaeology. You read the documentation, discover it describes last year's API, and learn the real behaviour from error messages in production at eleven at night.

We took one decision early that removes most of that: **the documentation is generated from the same table that serves the requests.**

## One table, two renderings

There is a single list of operations inside the platform. The OpenAPI document is generated from it. The human-readable reference is generated from it. The requests are served from it.

This is not a documentation policy, it is an architectural one, and it has a specific consequence: the reference cannot describe an endpoint that does not exist, and an endpoint cannot exist without appearing in the reference. They are the same object rendered twice.

## Idempotency that actually refuses

Every money-moving POST requires an \`Idempotency-Key\`.

Send the same key twice with the same body and you get the original object back — no second payment. Send the same key with a *different* body and the request is **refused**, with a specific error, rather than quietly creating something.

That second rule is the one that matters. A key collision in your code is a bug that would otherwise surface as a mysterious duplicate charge weeks later. Here it surfaces as a 409 with a readable message, in testing, where bugs are cheap.

## Webhooks signed twice

Each delivery carries a timestamped HMAC-SHA256 over the exact body, using your endpoint's own secret. It also carries an Ed25519 signature from the platform key, which you can fetch from a public key registry that supports rotation.

Verify either. Verify both. Reject anything with a timestamp older than five minutes and you have closed replay.

Delivery is at-least-once on a published retry schedule stretching across 24 hours, and every event has an id so you can deduplicate. We tell you it is at-least-once because it is; a provider that promises exactly-once is describing something it cannot deliver.

## Errors you can branch on

Every failure returns \`error.code\` — descriptive, for a human reading a log — and \`error.bp\`, a stable numeric family: authentication, validation, ledger, rail, compliance, intelligence.

Branch on the family. It does not change when we improve a message, and it does not require your code to parse English.

## A sandbox that fails properly

Test keys drive the same state machine as production. The sandbox publishes magic numbers for specific outcomes: success, insufficient funds, a timeout that later succeeds.

That last one is the one nobody else gives you, and it is the one that finds the bug in your retry logic before your customers do.

## Where to start

The reference is at **/developers/api** — every operation with its scope, its parameters, its body fields and a copy-ready example. The machine-readable document is the same content as OpenAPI 3.1.

Three calls and a webhook. The coffee will still be warm.`,
  },

  {
    key: 'webhooks',
    name: 'Signed webhooks',
    slug: 'signed-webhooks',
    category: 'build',
    module: null,
    usp: 'Deliveries you can verify two independent ways, replay yourself from the dashboard, and receive on a built-in inbox if you have nowhere to host an endpoint yet.',
    tagline: 'Your software finds out before your customer does.',
    headline: 'Webhooks you can trust, and cannot lose',
    excerpt:
      'A webhook is worth what your ability to verify it and survive missing one. Two independent signatures, a published retry schedule across 24 hours, event ids for deduplication, and an inbox for before your server exists.',
    audience: 'Any developer whose system has to react when money moves: order systems, school platforms, accounting tools, dispatch systems.',
    problem:
      'Polling is wasteful, late and fragile. Webhooks solve that only if you can tell a real one from a forged one, and only if a delivery that fails while your server is down is not simply lost.',
    how: [
      'Register an endpoint and choose the events you care about.',
      'Verify the signature on arrival, answer quickly, and do your work afterwards.',
      'Deduplicate on the event id, because delivery is at-least-once by design.',
      'Replay anything from the dashboard when you need to.',
    ],
    proof: [
      'Two signatures per delivery: an HMAC-SHA256 over the timestamped body with your endpoint secret, and an Ed25519 signature from the platform key registry.',
      'Retries follow a published schedule across 24 hours; deliveries are not dropped because your server was restarting.',
      'Every event carries an id so a repeated delivery can be recognised and ignored.',
      'A built-in inbox receives events for an account that has nowhere to host an endpoint yet, so the integration can be built before the server exists.',
    ],
    cost: 'Included. There is no per-delivery charge.',
    faq: [
      {
        question: 'Why at-least-once and not exactly-once?',
        answer:
          'Because exactly-once delivery over a network does not exist, and a provider claiming it is describing something else. Every event has an id; deduplicate on it and you get exactly-once processing, which is the thing you actually wanted.',
      },
      {
        question: 'My server was down for an hour. What did I lose?',
        answer: 'Nothing that happened inside the retry window. Deliveries are retried on a published schedule across 24 hours, and you can replay anything from the dashboard afterwards.',
      },
      {
        question: 'I have not built my server yet.',
        answer: 'Use the built-in inbox. Events for your account land somewhere you can read them, so you can see the exact shape of a real event before you write a line of handling code.',
      },
    ],
    keywords: ['webhook signature', 'hmac webhook', 'ed25519 webhook', 'webhook retries', 'payment notifications api'],
    related: ['developer-api', 'connected-accounts'],
    cta: { label: 'See the event catalogue', href: '/developers/api' },
    article: `A webhook is a promise that your software will find out before your customer does. That promise is worth exactly as much as your ability to trust the message and to survive missing one.

## Trusting it: two signatures

Every delivery carries two independent proofs.

The first is an **HMAC-SHA256** over the timestamped body, using the secret belonging to your endpoint. If you can verify it, the message came from someone holding that secret and the body has not been altered.

The second is an **Ed25519 signature** from the platform's own key, which you fetch from a public registry that supports rotation. This one does not depend on your endpoint secret at all, which matters if that secret has ever been in a place you are no longer sure about.

Verify either. Verify both. Then reject anything whose timestamp is older than five minutes, and replay is closed.

## Surviving it: retries and ids

Delivery is **at-least-once**. We say that plainly because it is true, and because the alternative claim is marketing.

Your server will be down sometimes. Deployments happen. When a delivery fails, it is retried on a published schedule stretching across 24 hours — not dropped because you were restarting.

The consequence of at-least-once is that you will occasionally receive the same event twice. Every event carries an id. Keep the ids you have processed and ignore repeats, and you have turned at-least-once delivery into exactly-once *processing*, which is the thing you actually wanted all along.

## Answer fast, work slowly

Acknowledge the delivery quickly, then do your work. If you mark the order, email the customer and update the warehouse before replying, a slow step somewhere in that chain turns into a retry, which turns into a duplicate, which turns into a second email.

Take the event, store it, reply, and process from your own queue.

## Replay is yours

Anything can be replayed from the dashboard. If you shipped a bug that silently dropped an hour of events, you do not need to ask anyone for help — you replay the window yourself.

## Before your server exists

The awkward part of any integration is that you need to see a real event to write the handler, and you need the handler to receive a real event.

There is a built-in inbox. Events for your account land somewhere you can read them, so you can look at the exact shape of a genuine event — the real fields, the real values — before writing a line of code against it.`,
  },

  {
    key: 'connected-accounts',
    name: 'Connected accounts',
    slug: 'connected-accounts',
    category: 'build',
    module: 'merchantGateway',
    usp: 'Create your customers’ merchant accounts by API, take payments for them with your own key, keep your fee — and hand the account over whenever they are ready, keys and history intact.',
    tagline: 'Onboard your customers by API. Hand over when they are ready.',
    headline: 'Take payments for your customers without becoming a payment business',
    excerpt:
      "Every successful platform reaches the day it starts collecting on behalf of its customers. Pool it and you are holding other people's money without a licence. Here is the third option: they are the merchant of record, and they can remove you whenever they like.",
    audience: 'Marketplaces, SaaS products, billing systems, cooperatives, school platforms and institutions that take payments on behalf of others.',
    problem:
      'A platform that collects on behalf of its customers either becomes an unlicensed payment business or forces every customer through a signup it does not control. Neither is a good place to be.',
    how: [
      'Create the customer’s merchant account with one call; they get a claim link to own it.',
      'Take payments for them with your own key by adding the account header to any operation.',
      'Keep your fee as a transparent split taken at capture and shown on both statements.',
      'Send the claim link whenever they should sign in themselves; detach when the relationship ends.',
    ],
    proof: [
      'The customer is the merchant of record: their money lands in their wallet and settles by their settlement profile.',
      'Your fee is a split on the payment, paid at capture, visible on both sides rather than netted invisibly.',
      'Any operation your key may perform for you, it performs for a connected account with one header; scopes still apply.',
      'When the customer claims the account they see you under Team as an administrator, and they can remove you at any time. Keys, wallets and history stay theirs.',
    ],
    cost: 'No charge for creating or holding accounts. Payments carry the ordinary rate, and your platform fee is yours.',
    faq: [
      {
        question: 'Who is the regulated party?',
        answer:
          'BitriPay holds the authorisation and remains the regulated party. Each of your customers is the merchant of record for their own payments, with their own wallets, settlement profile, statements and verification.',
      },
      {
        question: 'What happens when a customer leaves me?',
        answer: 'They detach you, or you detach yourself. Their account, keys, money and history stay with them. Nothing of theirs was ever held in your name, so there is nothing to unwind.',
      },
      {
        question: 'Can I take a fee?',
        answer:
          'Yes. Set a default fee in basis points on the account, or a fixed amount per payment. It is taken at capture as a split and appears on both statements, so your customer can see exactly what you charged.',
      },
    ],
    keywords: ['platform payments api', 'marketplace payments', 'connected accounts', 'merchant of record', 'onboard merchants by api'],
    related: ['developer-api', 'webhooks', 'team-and-roles'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `There is a moment in every successful platform's life where it starts collecting money on behalf of its customers, and discovers that it has accidentally become a payment business.

The two usual escapes are both bad. Pool everything through your own account and you are holding other people's money without a licence. Send every customer off to sign up with a processor themselves and you lose half of them at a form you do not control.

## A third option

Create the account by API. One call, with their business name, type and country, and the customer has a real merchant account — their own wallets, their own settlement profile, their own statements and their own verification record.

Then take payments for them with **your** key, by adding one header. Everything your key may do for you, it does for that account. Your scopes still apply.

## They are the merchant of record

This is the part that makes it legally sane rather than merely convenient.

The money lands in **their** wallet. It settles by **their** settlement profile, to **their** instructions. Their statements are theirs. BitriPay holds the authorisation and remains the regulated party; you are an integrator, not a custodian.

You never hold their money, so there is never a day when a regulator asks why you are holding it.

## Your fee is visible

Set a default fee in basis points on the account, or a fixed amount per payment. It is taken at capture as a transparent split and appears on **both** statements — yours and theirs.

That visibility is deliberate. A platform fee netted invisibly out of a customer's settlement is the kind of arrangement that feels clever until the customer works it out. One that appears as a line both parties can read survives the conversation.

## Hand-over is built in, not negotiated

Send the customer a one-time claim link whenever they should own the account themselves. They set a password, sign in, and see you under Team as an administrator.

And then — this is the important bit — **they can remove you.** At any time, without asking you, without a support ticket. Their keys, wallets and history stay theirs.

That sounds like a feature against your interests. It is the opposite. A customer who knows they can leave without losing anything is a customer who does not spend the relationship planning their escape.

## Their events reach you

Payments on a connected account raise webhooks to your endpoints carrying the account id, so your system knows whose payment it was without asking.

## What it costs

Nothing to create accounts or hold them. Payments carry the ordinary rate. Your platform fee is yours.`,
  },

  // ---------------------------------------------------------------- operate
  {
    key: 'team-and-roles',
    name: 'Team and roles',
    slug: 'team-and-roles',
    category: 'operate',
    module: null,
    usp: 'Staff get their own sign-in with a role the software enforces every time, including a refund limit the owner sets — so delegating the counter does not mean handing over the business.',
    tagline: 'Delegate the counter, not the business.',
    headline: 'How to let staff take payments without handing over the business',
    excerpt:
      'The owner cannot stand at the counter all day, and handing an employee the phone usually means handing them everything. Roles with a refund limit the software enforces, and an audit trail that names who did what.',
    audience: 'Any business with more than one person: shops with cashiers, schools with a fees desk, cooperatives, NGOs, platforms with a developer who is not an employee.',
    problem:
      'Small businesses share one login because the alternative is doing everything themselves. One shared password means no idea who refunded what, no way to remove a leaver, and a settlement account anybody could change.',
    how: [
      'Invite the person by email or phone; they get their own account and sign in as themselves.',
      'Give them a role: cashier, finance manager, operations manager, developer, read-only, administrator.',
      'Set the cashier refund limit for the organisation; the software refuses anything above it.',
      'Every action is written to the audit trail under their name, and removing them takes effect at once.',
    ],
    proof: [
      'A cashier takes payments and refunds up to the organisation\u2019s limit, and is refused settlement instructions, API secrets, statements, customer exports and member management.',
      'A finance manager changes settlement instructions and refunds above the cashier limit, but never sees API keys.',
      'A developer manages keys and webhooks and cannot issue refunds; the keys stay with the business when the developer leaves.',
      'The owner is immutable: the role cannot be removed by anybody, including an administrator.',
      'Business units can be linked to locations, so a payment taken at a branch carries the unit it belongs to.',
    ],
    cost: 'Included. There is no per-seat charge, and a business can invite as many people as it needs.',
    faq: [
      {
        question: 'What stops a cashier refunding a sale into their own account?',
        answer:
          'Two things. A refund returns money to the payer of the original payment, not to an address the cashier chooses; and a cashier may only refund up to the limit the business sets, above which the refund is refused and has to be made by someone with the authority.',
      },
      {
        question: 'An employee has left. What do I have to change?',
        answer: 'Remove them. It takes effect at once, and their past actions stay in the audit trail under their own name. No password has to be changed, because they never had yours.',
      },
      {
        question: 'My developer is not an employee. Can I give them access safely?',
        answer:
          'Give them the developer role. They manage API keys and webhooks and can create payments, but cannot touch settlement, payouts or customer exports. Every action is attributed to them, and the keys stay with your business after they go.',
      },
    ],
    keywords: ['staff accounts', 'cashier role', 'refund limit', 'business roles and permissions', 'shared login problem'],
    related: ['point-of-sale', 'connected-accounts'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `Almost every small business starts with one login, because the alternative is that the owner stands at the counter for every hour the shop is open.

Then the shop grows, and the shared password quietly becomes the biggest unmanaged risk in the business.

## What a shared login actually costs

You cannot tell who refunded the sale that does not add up. You cannot remove the cousin who worked two weekends in March. The settlement account \u2014 the one that says where all your money goes at the end of the day \u2014 can be changed by anyone who has ever seen the phone.

None of that is theoretical. The shared login is usually fine right up until the week it is extremely not.

## Roles the software enforces

Everyone gets their own sign-in and a role. The role is not a policy on a wall; it is enforced on every request.

**A cashier** takes payments and refunds up to a limit you set. They are refused settlement instructions, API secrets, statements, customer exports and member management \u2014 not hidden from them, refused.

**A finance manager** changes settlement instructions and refunds above the cashier limit, and never sees API keys.

**A developer** manages keys and webhooks and cannot issue refunds.

**Read-only** sees and touches nothing.

## The refund limit is the one that matters

Refunds are where a counter leaks. Set the cashier limit at whatever a genuine mistake looks like in your shop \u2014 a wrong quantity, a duplicate scan. Anything above that is refused and has to be done by someone with the authority.

It is worth being clear about what a refund can and cannot do: it returns money to the payer of the original payment. It is not a way to send money to an address of the cashier\u2019s choosing. The limit and the destination together are what make the counter safe.

## The owner cannot be removed

The owner role is immutable. Not by an administrator, not by another owner, not by anybody. This closes the oldest ugly scenario in shared-account businesses: a falling-out in which somebody with access locks everyone else out of the money.

## Leavers are a click

Remove the person. It takes effect immediately. Their past actions stay in the audit trail under their own name, which is the point \u2014 you keep the history and lose the access.

No password to change, no scramble to work out what they could reach, because they never had yours.

## Branches

Business units can be linked to locations, so a payment taken at a branch carries the unit it belongs to. Two shops, one account, and figures you can actually compare.

## What it costs

Nothing per person. Invite as many people as the business needs.`,
  },

  // ------------------------------------------------------------------- move
  {
    key: 'wallets-and-transfers',
    name: 'Wallets and transfers',
    slug: 'wallets-and-transfers',
    category: 'move',
    module: 'transfers',
    usp: 'A transfer between two accounts is one balanced posting on a double-entry ledger, not a message between two systems that might later disagree.',
    tagline: 'Money that arrives the moment it leaves.',
    headline: 'Why a transfer should be one posting, not two messages',
    excerpt:
      'Most "instant" transfers are two systems sending each other messages and reconciling later. When the money has left one balance and not arrived at the other, somebody is holding it. On one ledger there is no gap for it to sit in.',
    audience: 'Anyone paying someone else on the same platform: families, employers paying staff, businesses paying suppliers, savings groups.',
    problem:
      'Between two institutions, a transfer is a message. The sender sees a debit, the receiver sees nothing, and a support agent is asked where the money is. The honest answer is usually "in a file that gets processed tonight".',
    how: [
      'Choose the person by their tag, their phone number or by scanning their code.',
      'The screen shows the amount, the fee and what will actually arrive, before anything moves.',
      'Approve with a fingerprint or a PIN.',
      'One posting debits one wallet and credits the other; both statements show it at the same instant.',
    ],
    proof: [
      'Every movement is a balanced double-entry posting: the sum of the entries is zero, and a transaction that would not balance is refused rather than written.',
      'Balances are derived from the entries, so a balance cannot be edited — only posted to.',
      'A reversal is a new opposing posting, never a deletion, so the history of what happened stays readable.',
      'The ledger is reconciled against itself: every wallet balance must equal the sum of its own postings, and a mismatch is an alert rather than a rounding difference.',
      'Limits are enforced per account and per tier before the posting, not discovered afterwards.',
    ],
    cost: 'The fee is shown before you approve, with the amount that will actually arrive. There is no second fee at the other end and no deduction the screen did not name.',
    faq: [
      {
        question: 'How long does it take?',
        answer: 'Between two BitriPay accounts it is one posting, so the receiver sees it as the sender’s screen confirms. There is no window where it has left one side and not reached the other.',
      },
      {
        question: 'I sent it to the wrong person.',
        answer:
          'A transfer to another account is final once posted, exactly as handing over cash is final. This is why the confirmation screen shows the recipient’s name and not only their number: read the name before you approve.',
      },
      {
        question: 'What stops someone draining my wallet?',
        answer: 'Nothing leaves without your own fingerprint or PIN, limits apply per account and per verification tier, and a new recipient can require a step-up before a large amount moves.',
      },
    ],
    keywords: ['send money instantly', 'wallet transfer', 'double entry ledger', 'peer to peer payment', 'transfer between accounts'],
    related: ['money-requests', 'ledger', 'agents-and-cash'],
    cta: { label: 'Open an account', href: '/register' },
    article: `"Instant transfer" usually means something quite specific and not very instant: two institutions exchange a message, each writes it down in its own books, and the two sets of books are compared later that night.

Most of the time this works. The interesting question is what happens in the gap.

## The gap

The sender sees a debit. The receiver sees nothing. Somewhere between the two, the money exists in a message rather than in an account.

Then one of three things happens. It arrives. It fails and is returned, hours later. Or it enters the state every support agent dreads, where one system says sent and the other says nothing arrived, and the resolution is a file, a phone call and a week.

The gap is not a bug in anyone’s implementation. It is what you get when two sets of books have to agree with each other about the same money.

## One set of books

Between two accounts on BitriPay there is one ledger. A transfer is a single posting: one wallet is debited, the other credited, in the same transaction.

There is no moment when the money has left and not arrived, because there is nowhere for it to be in between.

That is the entire claim, and it is worth exactly as much as the ledger underneath it.

## What makes the ledger worth it

**Every posting balances.** The entries of a transaction sum to zero, and a transaction that would not balance is refused rather than written. The books cannot be out by construction.

**Balances are derived, not stored and edited.** A wallet balance is the sum of its own postings. Nobody — no administrator, no support agent, no job at two in the morning — can set a balance to a number. They can only post to it.

**Corrections are postings too.** A reversal is a new, opposing entry, never a deletion. If something was wrong and then fixed, both facts stay in the history. A ledger you can quietly edit is a ledger nobody should trust, including you.

**It checks itself.** Every wallet balance must equal the sum of its own entries. That is reconciled, and a mismatch raises an alert rather than being absorbed as a rounding difference.

## Before you approve

The screen shows the recipient’s **name**, the amount, the fee and what will actually arrive. Read the name. A transfer between accounts is final once posted, in the same way handing somebody cash is final — which is precisely why the name is on the screen and not just the number.

## What it costs

The fee is on the confirmation screen, with the arriving amount. No second fee at the other end, and nothing deducted that the screen did not name.`,
  },

  {
    key: 'agents-and-cash',
    name: 'Agents and cash',
    slug: 'agents-and-cash',
    category: 'move',
    module: 'agents',
    usp: 'Cash in and out through a human being near you, with the agent paid a commission the app shows before you confirm and a float the platform watches so the agent does not run dry mid-queue.',
    tagline: 'The last mile is a person.',
    headline: 'Digital money is only as good as the place you can turn it back into cash',
    excerpt:
      'A balance you cannot spend at the market is not money, it is a promise. The agent network is the last mile — and the thing that decides whether it works is not the app, it is whether the agent has float at four in the afternoon.',
    audience: 'Anyone who needs cash in hand: market traders, families, people paid digitally who buy from sellers who are not.',
    problem: 'An agent who has run out of cash is worse than no agent, because the customer has already walked there. Most networks discover an agent is dry when a customer complains.',
    how: [
      'Find a nearby agent in the app, with the amount you want.',
      'The commission is shown before you confirm, so you know the cost of the cash before you walk.',
      'Approve with your fingerprint; the agent sees the request and the code.',
      'Cash changes hands when the app shows the payout as settled — not before.',
    ],
    proof: [
      'The commission is shown to the customer before confirmation rather than deducted afterwards.',
      'An agent’s float is held in its own ledger account, so what the agent can pay out is a balance rather than an estimate.',
      'Float intelligence watches the pattern of an agent’s business and flags the ones heading for empty before a customer arrives.',
      'An agent’s trust score and commission are driven by measured behaviour, not negotiated per agent.',
      'A payout that fails is reversed on the ledger; the customer’s balance is not left in a cash-out that silently died.',
    ],
    cost: 'The agent earns a commission the app shows before you confirm. Where a platform fee applies it appears on the same screen.',
    faq: [
      {
        question: 'How do I know the agent will have cash?',
        answer:
          'The platform watches each agent’s float against the pattern of their business and flags the ones running low, so an agent can be topped up before the queue forms rather than after a customer has walked there for nothing.',
      },
      {
        question: 'When do I hand over, or take, the cash?',
        answer: 'When the app shows the payout as settled. Not on a screenshot, not on the agent saying it has gone through. The settled state is the only receipt either of you should accept.',
      },
      {
        question: 'Can an agent charge me more than the app says?',
        answer: 'The commission on the screen is the commission. Anything on top of it is not part of the service and should be reported to support.',
      },
    ],
    keywords: ['cash out mobile money', 'mobile money agent', 'agent float', 'cash in cash out', 'turn balance into cash'],
    related: ['wallets-and-transfers', 'withdrawals'],
    cta: { label: 'Become an agent', href: '/register?role=agent' },
    article: `There is a sentence that decides whether digital money is real to somebody: *can I turn this into cash before the market closes?*

If the answer is no, the balance is not money. It is a promise, and promises do not buy fish.

## The last mile is a person

In the markets BitriPay serves, the last mile is not an ATM. It is a person with a cash box — in a kiosk, a pharmacy, a phone shop — who takes your digital balance and hands you notes, or takes your notes and credits your balance.

Everything about the technology is downstream of whether that person has cash at four in the afternoon.

## The real failure is an empty agent

An agent who has run out of cash is worse than no agent at all, because the customer has already made the journey. They have spent the walk. They now have a balance, a story about an app that does not work, and no fish.

Most networks find out an agent is dry the same way: a customer complains.

## Float you can see

An agent’s float is held in its own ledger account. What the agent can pay out is therefore a **balance**, not an estimate, and both the agent and the platform can see it.

On top of that, float intelligence watches the pattern of each agent’s business — what they usually pay out, on which days, at which hours — and flags the ones heading for empty **before** the queue forms. The agent is told to rebalance while there is still time to do it.

It is a small thing that quietly decides whether the network is trusted.

## Commission before the walk

The commission is shown to the customer **before** they confirm, so the cost of the cash is known before the journey rather than deducted at the counter.

The commission on the screen is the commission. Anything an agent asks for on top is not part of the service.

## The rule for both sides

Cash changes hands when the app shows the payout as **settled**.

Not on a screenshot. Not on *it has gone through, I promise*. Not on a message from an unknown number. The settled state is the receipt, and it is the same receipt for both the customer and the agent, which is what makes it an answer rather than an argument.

A payout that fails is reversed on the ledger, so the customer is not left with money stranded in a cash-out that quietly died.

## For agents

An agent earns on volume, and the trust score and commission are driven by measured behaviour rather than negotiated case by case. Keep float, serve customers, and the numbers follow.`,
  },

  {
    key: 'add-money',
    name: 'Adding money',
    slug: 'adding-money',
    category: 'move',
    module: 'addMoney',
    usp: 'Funding that is confirmed by evidence from the operator or the bank, not by the customer saying they paid — so a balance never appears that no money backs.',
    tagline: 'Nothing appears until something arrived.',
    headline: 'Why your balance only moves when the money actually did',
    excerpt:
      'The fastest way to destroy a payment platform is to credit a balance on a customer’s word. Here is what has to be true before a figure on a screen goes up, and why an issuance rule beats a trusting support agent.',
    audience: 'Anyone putting money into an account: customers topping up, merchants funding float, businesses loading a wallet.',
    problem:
      'Funding is where fraud lives. A screenshot is not a payment, a reference typed by hand is not proof, and a support agent under pressure is the weakest link in any platform that lets a human credit a balance.',
    how: [
      'Choose how you are funding: an operator collection number, a bank instruction, a card, or an agent.',
      'Pay as the instruction says, quoting the reference it gives you.',
      'The platform matches the operator or bank confirmation to your reference.',
      'The balance moves when the evidence does — and the ledger records which evidence it was.',
    ],
    proof: [
      'Funding is matched against operator or bank evidence, and a confirmation that cannot be matched becomes a case rather than a credit.',
      'Evidence is deduplicated, so the same confirmation cannot be used twice to credit two balances.',
      'E-money may not be issued beyond cleared, safeguarded funds: the issuance rule refuses, rather than warning, when the backing is not there.',
      'Every credit names its authority — external funding, an administrator, liquidity, a programme — so no balance exists without a reason attached to it.',
      'A manual credit is maker-checker: the person who proposes it is not the person who approves it.',
    ],
    cost: 'Funding costs depend on how the money arrives; the screen shows the charge before you pay, and an agent shows a commission before you confirm.',
    faq: [
      {
        question: 'I paid but my balance has not moved.',
        answer:
          'The credit waits for the operator or bank confirmation to be matched to your reference. If the reference was wrong or missing, it becomes a case for a human rather than a quiet credit — contact support with the time and amount and it can be matched.',
      },
      {
        question: 'Can a support agent just add money to my account?',
        answer:
          'Not alone. A manual credit is proposed by one administrator and approved by another, it names its authority, and it is subject to the same rule as every other issuance: it cannot exceed the cleared funds backing the currency.',
      },
      {
        question: 'Why can you not just trust my screenshot?',
        answer:
          'Because a screenshot can be edited in a minute by anyone, and a platform that credits balances on them stops being able to back the balances it has issued. The delay for an honest customer is minutes; the alternative costs everybody.',
      },
    ],
    keywords: ['add money to wallet', 'fund account', 'deposit confirmation', 'e-money issuance', 'top up wallet drc'],
    related: ['emoney-and-safeguarding', 'agents-and-cash', 'wallets-and-transfers'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Every payment platform that has collapsed, collapsed at the same place: the moment a number on a screen went up without money arriving to back it.

Funding is therefore the least glamorous and most load-bearing part of the whole system.

## A screenshot is not a payment

It takes under a minute to edit a screenshot convincingly. It takes less to forward somebody else’s.

So the screenshot cannot be the trigger. Neither can a reference typed by hand into a chat, nor a support agent’s judgement at the end of a long shift — not because agents are dishonest, but because a system where a tired human can create money is a system that will eventually create money by accident.

## Evidence, matched

The balance moves when **evidence** arrives from the operator or the bank, and that evidence is matched to the reference you were given.

Evidence is deduplicated, so the same confirmation cannot be used twice to credit two different balances. A confirmation that cannot be matched to anything does not become a quiet credit — it becomes a **case**, which a human looks at with the facts in front of them.

That is the difference between a platform that occasionally makes a customer wait twenty minutes and a platform that occasionally issues money that does not exist.

## The rule underneath

There is an issuance rule the platform enforces rather than monitors:

> e-money may not be issued beyond cleared, safeguarded funds in the same currency.

Not a target. Not a dashboard with a red light. A refusal. If the backing is not there, the issuance does not happen, and the person trying to make it happen gets an error rather than a warning they could click past.

## Every credit has an author

No balance exists without a reason attached. Each credit names its authority — external funding, an administrator, liquidity, a programme — and that stays in the ledger permanently.

A manual credit, when one is genuinely needed, is **maker-checker**: one administrator proposes, a different one approves. One person cannot create money alone, which is a sentence worth reading twice if you have ever worked somewhere one person could.

## What this costs you, the honest customer

Minutes, occasionally. Your funding is confirmed when the operator or bank confirms it, not when you say so.

What you get for those minutes is that every other balance on the platform is backed too — including, on the day it matters, yours.`,
  },

  {
    key: 'withdrawals',
    name: 'Withdrawals and payouts',
    slug: 'withdrawals-and-payouts',
    category: 'move',
    module: 'withdrawals',
    usp: 'A payout that is held against your balance the moment you request it, executed under four eyes above a threshold, and reversed on the ledger if the rail refuses — so money is never both spent and still spendable.',
    tagline: 'Held, executed, or returned. Never lost in between.',
    headline: 'What happens to your money between "withdraw" and the cash',
    excerpt:
      'Between pressing withdraw and money arriving, your balance has to be somewhere. Here is what a hold is, why a large payout needs two people, and what happens on the ledger when a rail says no.',
    audience: 'Merchants settling takings, customers cashing out, businesses paying suppliers and staff.',
    problem:
      'If a platform decrements your balance and then the payout fails, you are owed money by a system that no longer thinks it owes you. If it does not decrement, you can spend the same money twice while the payout is in flight.',
    how: [
      'Request the payout; the amount is held against your balance immediately.',
      'Your available balance drops by the held amount, so the same money cannot be spent twice.',
      'Above the threshold the business sets, a second person approves before it executes.',
      'On success the hold is settled; on refusal it is released and your balance is whole again.',
    ],
    proof: [
      'A hold reduces available balance without removing the money, so a payout in flight can neither be spent again nor disappear.',
      'Payouts above the configured threshold require a second approver; the proposer cannot approve their own.',
      'A failed payout is reversed by an opposing posting, so the ledger shows the attempt and the return rather than hiding both.',
      'Destination changes are protected: altering where settlement money goes is a controlled action, not a profile edit.',
      'Every payout carries a reference that appears on the statement and on the rail’s own confirmation.',
    ],
    cost: 'The payout fee is shown before you confirm, with the amount that will arrive at the other end.',
    faq: [
      {
        question: 'My payout failed. Where is my money?',
        answer:
          'Back in your available balance. A failed payout is reversed by an opposing posting, and both the attempt and the return are visible on your statement — so you can see what happened rather than having to ask.',
      },
      {
        question: 'Why does a big payout need someone else to approve it?',
        answer:
          'Because the single most effective control against both fraud and catastrophic mistakes is that one person cannot move large sums alone. The threshold is set by the business, so day-to-day amounts are not slowed down.',
      },
      {
        question: 'Someone changed my settlement account. How?',
        answer:
          'They should not be able to quietly. Changing where settlement money goes is a protected action with its own controls, separate from editing an ordinary profile detail, precisely because it is the single most valuable field in the account.',
      },
    ],
    keywords: ['withdraw money', 'payout', 'settlement payout', 'four eyes approval', 'failed payout refund'],
    related: ['settlement-and-statements', 'agents-and-cash', 'ledger'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Press withdraw and your money enters a gap. It has not reached the bank, the wallet or the agent yet, but it should not still be sitting in your spendable balance either.

What a platform does with that gap tells you most of what you need to know about it.

## Two ways to get it wrong

**Decrement immediately and hope.** Your balance drops. The rail refuses. Now the platform has taken money off you for a payout that never happened, and getting it back depends on somebody noticing.

**Decrement only on success.** Your balance stays whole while the payout is in flight — so you can spend the same money again, and now two things are true at once, which is the kind of problem that ends up in a ledger that no longer balances.

## A hold is the third answer

When you request a payout, the amount is **held**.

The money is still yours and still in your account. But your *available* balance drops by the held amount, so it cannot be spent while the payout is in flight. Nothing has been taken, and nothing can be double-spent.

Then exactly one of two things happens:

- **The payout succeeds.** The hold settles into a real movement.
- **The rail refuses.** The hold is released and your available balance is whole again, immediately.

Both outcomes are postings on the ledger. The attempt and the return are both visible on your statement, which means you can see what happened without asking anybody.

## Why a large payout waits for a second person

Above a threshold the business sets, a payout needs a second approver, and the person who proposed it cannot be the person who approves it.

This is the oldest control in finance and still the most effective, against fraud and against expensive mistakes equally. It does not slow down the day-to-day, because the threshold is yours to set — it slows down exactly the payments that are worth slowing down.

## The field worth protecting

The single most valuable field in any merchant account is the settlement destination: where all the money goes at the end of the day.

Changing it is a protected action with its own controls, not an ordinary profile edit. An attacker who gets into an account should not be able to redirect the business’s income by typing in a new account number.

## What it costs

The fee is shown before you confirm, along with the amount that will actually arrive.`,
  },

  {
    key: 'remittance',
    name: 'Remittance',
    slug: 'remittance',
    category: 'move',
    module: 'remittance',
    usp: 'A quoted rate that is locked for the life of the quote, with the margin stated in basis points — so the family at the other end gets the number you were shown, not whatever the rate became.',
    tagline: 'The number on the screen is the number they get.',
    headline: 'The real cost of sending money home is the rate, not the fee',
    excerpt:
      'Everyone compares transfer fees. Almost nobody compares the exchange rate, which is where most of the money actually goes. A quote with an expiry and a stated margin makes the comparison possible.',
    audience: 'The diaspora sending money home, and the families receiving it.',
    problem: 'A service advertises a low fee and makes it back on a rate the sender never sees quoted against a reference. The family receives less than expected and nobody can say exactly why.',
    how: [
      'Ask for a quote: how much you send, in which currency, to which destination.',
      'The quote shows the rate, the mid rate it was built from, the margin in basis points, the fee and the exact arriving amount.',
      'It carries an expiry. Pay within it and that is the rate that applies.',
      'If you pay after it expires, you are re-quoted or refunded — never silently converted at a different rate.',
    ],
    proof: [
      'A quote carries its rate, the mid rate behind it and the margin in basis points, so the cost of conversion is a number rather than an impression.',
      'Quotes have an expiry, and a payment against an expired quote is re-quoted or refunded instead of being converted at whatever the rate has become.',
      'The arriving amount is shown in the recipient’s currency before the sender commits.',
      'Each corridor records its licence basis and its partners, and only a corridor an administrator has marked live may carry real customer funds.',
      'Conversions that are posted carry their margin into the ledger, so the true cost of a corridor is measurable rather than estimated.',
    ],
    cost: 'Two numbers, both quoted up front: the fee, and the margin on the exchange rate in basis points. The arriving amount is shown before you pay.',
    faq: [
      {
        question: 'Why does the mid rate matter?',
        answer:
          'The mid rate is the reference the margin is measured against. Without it, a rate is just a number and you cannot tell a good one from a bad one. With it, the cost of conversion is explicit and you can compare services properly.',
      },
      {
        question: 'What if the rate moves while I am paying?',
        answer:
          'Your quote is locked for its lifetime. Pay within it and that is the rate. Pay after it has expired and you are re-quoted or refunded — you are never silently converted at a rate you did not agree to.',
      },
      {
        question: 'Who actually holds the money on the way?',
        answer:
          'Each corridor records its licence basis and the partners on both legs. A corridor only carries real customer funds once an administrator has marked it live against those records, which is a deliberately slow and documented step.',
      },
    ],
    keywords: ['send money to congo', 'remittance exchange rate', 'cost of sending money home', 'fx margin basis points', 'diaspora transfer'],
    related: ['exchange', 'corridor-network', 'agents-and-cash'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Ask somebody how much it costs to send money home and they will tell you the fee. Three pounds. Five dollars. A flat rate on a poster.

The fee is rarely where the money goes.

## Where it actually goes

Imagine two services. One charges a flat fee and converts at a rate two percent away from the market. The other charges more in fees and converts at a rate half a percent away.

On anything but a tiny amount, the one with the higher fee is cheaper — often considerably. But the posters compare fees, so the comparison people actually make is the wrong one.

This is not an accident. The fee is the number on the poster precisely because it is the number that can be made to look small.

## A quote with its working shown

A BitriPay quote carries four things:

- **The rate** you are being given.
- **The mid rate** it was built from — the reference.
- **The margin**, in basis points, between the two.
- **The fee**, and the **exact amount** that will arrive in the recipient’s currency.

The margin is the important one. It turns "the rate" from a number you cannot evaluate into a cost you can compare against anybody else — if they will tell you theirs.

## The quote expires, and that is a feature

Every quote carries an expiry.

Pay within it and that rate applies, whatever the market did in the meantime. Pay after it has expired and you are **re-quoted or refunded** — never silently converted at whatever the rate has become.

That last clause is the one that matters. Silent re-conversion is how a sender ends up explaining to their mother why less arrived than they promised, with no way to find out why.

## Who holds it on the way

Every corridor records its licence basis and the partners on both legs — who collects, who pays out, under whose authorisation.

A corridor carries real customer funds only once an administrator has marked it live against those records. That step is deliberately slow and deliberately documented, because a corridor running without a clear answer to *whose licence is this under* is a corridor nobody should be sending their family’s money through.

## What to ask any service

Three questions, and you will know most of what matters:

1. What is your mid rate, and what is your margin on it?
2. How long is the quote locked, and what happens if I pay late?
3. Who is authorised at each end of this corridor?

A service that cannot answer the first one is answering it anyway.`,
  },

  {
    key: 'exchange',
    name: 'Currency exchange',
    slug: 'currency-exchange',
    category: 'move',
    module: 'exchange',
    usp: 'Conversion quoted against a published mid rate with the margin in basis points, posted to the ledger as two linked legs so the cost of every conversion stays measurable afterwards.',
    tagline: 'A rate you can audit, not just accept.',
    headline: 'A currency conversion should leave a trail you can check',
    excerpt:
      'Holding two currencies is normal here. What is not normal is being able to see, afterwards, exactly what each conversion cost you. Two linked legs and a stated margin make that possible.',
    audience: 'Anyone holding more than one currency: traders buying stock abroad, families receiving in one currency and spending in another, businesses pricing in USD and paying in CDF.',
    problem:
      'A conversion usually appears on a statement as a single line with a new amount in it. The rate is gone, the reference is gone, and there is no way to tell later whether it was a good one.',
    how: [
      'Ask for a quote between the two currencies and the amount.',
      'The quote shows the rate, the mid rate, the margin in basis points and the resulting amount.',
      'Approve it, and the conversion posts as two linked legs: a sale in one currency and a purchase in the other.',
      'Both legs carry the quote, so the statement still explains itself a year later.',
    ],
    proof: [
      'A conversion is two postings linked by one quote, never a single line with a new number in it.',
      'The margin travels into the ledger with the posting, so the cost of conversions is a figure that can be summed rather than an impression.',
      'Rates come from versioned provider snapshots, so the rate used at a moment can be produced again afterwards.',
      'A quote has an expiry, and an expired quote is re-quoted rather than applied.',
    ],
    cost: 'The margin, in basis points, shown on the quote before you approve it. There is no separate conversion fee hidden inside the rate.',
    faq: [
      {
        question: 'Why does the statement show two lines for one conversion?',
        answer:
          'Because that is what a conversion is: money leaves one currency and arrives in another. Two linked legs keep both currencies’ books correct and keep the rate attached to the movement, so the line still explains itself later.',
      },
      {
        question: 'Can I see what rate I got last month?',
        answer: 'Yes. The quote is kept with the posting, including the mid rate and the margin, and rate snapshots are versioned, so the rate in force at that moment can be produced again.',
      },
      { question: 'Is there a fee as well as the margin?', answer: 'The margin on the quote is the cost. Where any separate fee applies it is shown on the same screen before you approve.' },
    ],
    keywords: ['currency exchange', 'usd cdf rate', 'fx margin', 'convert currency wallet', 'exchange rate history'],
    related: ['remittance', 'ledger', 'settlement-and-statements'],
    cta: { label: 'Open an account', href: '/register' },
    article: `In Kinshasa, holding two currencies is not exotic. Prices are quoted in dollars, change comes in francs, and everybody is doing arithmetic in their head all day.

What is harder is finding out, afterwards, what the arithmetic cost you.

## The single-line problem

On most statements, a conversion is one line. Money went in as one currency and came out as another, and the only thing recorded is the result.

The rate is gone. The reference is gone. Six weeks later, when you are trying to work out whether your supplier payments are eating your margin, the statement cannot tell you — because the information was never written down.

## Two legs, one quote

A conversion here posts as **two linked legs**: a sale in the currency you are leaving and a purchase in the currency you are entering, tied together by the quote that priced them.

That keeps both currencies’ books correct — which is the technical reason — but it also keeps the **rate attached to the movement**, which is the reason that matters to you.

## The margin goes into the ledger

The quote carries the rate, the mid rate it was built from, and the margin between them in basis points. When the conversion posts, the margin goes with it.

This sounds like bookkeeping pedantry. It is the difference between these two sentences:

- *"I think we are losing something on conversions."*
- *"We converted 48,000 dollars last quarter at an average margin of 61 basis points, which cost 293 dollars."*

Only one of those lets you do anything about it.

## Rates you can reproduce

Rates come from versioned provider snapshots. The rate in force at a given moment can be produced again afterwards, rather than being a number that existed once and then changed.

If you need to explain a conversion to an auditor, a partner or a business partner who thinks they were short-changed, the answer exists.

## Quotes expire

A quote has an expiry and is honoured within it. An expired quote is re-quoted, not applied at whatever the rate has since become. You are never converted at a price you did not see.

## What it costs

The margin on the quote, in basis points, before you approve. No separate fee buried inside the rate.`,
  },

  // ---------------------------------------------------------------- operate
  {
    key: 'ledger',
    name: 'The ledger',
    slug: 'the-ledger',
    category: 'operate',
    module: null,
    usp: 'A double-entry ledger where balances are derived from postings rather than stored, corrections are opposing entries rather than edits, and invariants are enforced at write time instead of checked by a nightly job.',
    tagline: 'Books that cannot be quietly edited.',
    headline: 'The part of a payment platform nobody markets, and everybody depends on',
    excerpt:
      'Features are what you buy. The ledger is what decides whether the features can be trusted. Balanced postings, derived balances, reversals instead of edits, and invariants that refuse rather than warn.',
    audience: 'Finance teams, auditors, regulators, and any business whose books have to survive a question.',
    problem:
      'Many systems keep a balance as a number and update it. The moment a balance can be set rather than posted to, the books stop being evidence and become an opinion that somebody with database access can revise.',
    how: [
      'Every money movement is a transaction made of entries.',
      'The entries of a transaction sum to zero per currency; one that would not balance is refused, not written.',
      'A balance is the sum of its wallet’s entries — derived, never stored and edited.',
      'A correction is a new opposing transaction, so both the mistake and the fix remain visible.',
    ],
    proof: [
      'Postings are balanced per currency at write time; an unbalanced transaction is refused rather than written and fixed later.',
      'Reconciliation recomputes every wallet balance from its entries and reports any mismatch, rather than trusting the stored figure.',
      'Reversals are opposing postings; nothing is deleted, so the history of what happened stays readable.',
      'Guardian invariants watch for states that should be impossible — such as a payment captured without a posting — and can halt the platform rather than continue past them.',
      'Every state change is written to a hash-chained event log, so the record can be shown not to have been rewritten afterwards.',
    ],
    cost: 'Included. It is not a feature so much as the floor everything else stands on.',
    faq: [
      {
        question: 'Can an administrator change my balance?',
        answer:
          'They can post to it, with an authority recorded and — for issuance — a second administrator approving. They cannot set it to a number, because a balance is not stored as a number: it is the sum of its own postings.',
      },
      {
        question: 'What happens when something goes genuinely wrong?',
        answer:
          'A correcting transaction is posted in the opposite direction. The original stays. Anyone reading the history later sees the mistake and the correction, which is what makes the books evidence rather than a story.',
      },
      {
        question: 'What is a Guardian halt?',
        answer:
          'An invariant watches for states that should be impossible. If one appears, the platform can stop rather than keep processing on top of a contradiction. Stopping is expensive; continuing on broken books is far more expensive.',
      },
    ],
    keywords: ['double entry ledger', 'payment ledger', 'immutable ledger', 'audit trail payments', 'ledger invariants'],
    related: ['wallets-and-transfers', 'settlement-and-statements', 'emoney-and-safeguarding'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `Nobody chooses a payment platform because of its ledger. Everybody depends on it.

It is the part that decides whether every other feature can be trusted, and it is almost never the part anyone asks about.

## The stored-balance mistake

A great many systems keep a balance as a column. A payment arrives, the column goes up. A payout leaves, the column goes down.

This works until something interrupts it halfway, or two things update it at once, or somebody with database access decides to help. And the moment a balance can be **set** rather than **posted to**, the books have stopped being evidence. They are now an opinion, held by whoever last had write access.

## Derived, not stored

Here, a balance is the sum of its wallet’s own entries. It is computed, not kept.

That one decision removes an entire category of problem. There is no number to drift, no number to correct, and no way to assign a balance a value. You can only post to it — and a posting has to balance.

## Balanced at write time

Every transaction is made of entries that sum to zero per currency. A transaction that would not balance is **refused**, not written and cleaned up later.

The books cannot go out of balance, not because a job checks them each night, but because an unbalanced state is not a thing that can be written.

## Corrections are postings

When something is genuinely wrong, the fix is a new transaction in the opposite direction. The original stays exactly where it was.

Anyone reading the history later sees both: what happened, and what was done about it. A ledger whose mistakes can be made to disappear is a ledger nobody should trust — including the people who run it, because they lose the ability to prove their own good faith.

## It checks itself

Reconciliation recomputes every balance from its entries and reports mismatches. It does not trust the stored figure, because there is no stored figure to trust.

Above that sit invariants — statements about things that should never be true, such as a payment captured without a posting. If one of them becomes true, the platform can **halt** rather than keep processing on top of a contradiction.

Halting is expensive. Continuing to process on broken books is the kind of expensive that ends companies.

## And it is hash-chained

Every state change goes into an event log where each entry is chained to the one before it. The record can be shown not to have been rewritten afterwards — which is the question an auditor is really asking when they ask for the audit trail.

## What it costs

Nothing. It is the floor, not a feature.`,
  },

  {
    key: 'settlement-and-statements',
    name: 'Settlement and statements',
    slug: 'settlement-and-statements',
    category: 'operate',
    module: null,
    usp: 'A settlement statement that is numbered, hashed and reproducible, showing the provider fee, the platform fee and the tax on it as separate lines rather than one net figure.',
    tagline: 'Know what was taken, not just what arrived.',
    headline: 'A net figure is not a statement',
    excerpt:
      'Most merchants learn what a payment cost them by subtracting what arrived from what they charged. Separate lines for the provider fee, the platform fee and the tax turn that guesswork into accounting.',
    audience: 'Merchants, finance teams, accountants and anybody who has to file something based on what the platform paid them.',
    problem:
      'When settlement arrives as a single net amount, the merchant cannot see what was deducted or by whom, cannot reconcile it to their own sales, and cannot produce the tax breakdown their accountant needs.',
    how: [
      'Set a settlement profile per currency and rail: the schedule, the cut-off hour, the destination and a minimum.',
      'A cycle collects what was taken between two cut-offs, net of fees, refunds, splits and holds.',
      'The cycle closes into an obligation and a numbered statement.',
      'Paying the obligation goes through the payout workflow with its approvals.',
    ],
    proof: [
      'Statements are numbered in sequence and hashed, and are produced as JSON, CSV or PDF from the same figures.',
      'The provider fee, the platform fee and the tax on that fee are separate lines, not one net deduction.',
      'Where the settlement currency differs from the collection currency, the conversion is disclosed with its rate, mid rate and margin.',
      'A cycle can be previewed before it closes, so a merchant can see what the next settlement will contain.',
      'Schedules run per profile — same day, next day, two days, weekly or manual — rather than one cadence for everybody.',
    ],
    cost: 'Settlement itself is not charged separately; the fees shown on the statement are the fees on the payments it covers.',
    faq: [
      {
        question: 'Why is the tax on the fee a separate line?',
        answer: 'Because your accountant needs it separately and you cannot recover what you cannot identify. A net deduction forces somebody to reverse-engineer the tax, usually wrongly.',
      },
      {
        question: 'Can I see what the next settlement will be before it closes?',
        answer: 'Yes. A profile can be previewed, showing the collection-currency totals with the fee lines and, where currencies differ, the conversion with its rate and margin.',
      },
      {
        question: 'What does hashing a statement achieve?',
        answer:
          'It lets you show a statement has not been altered since it was issued. Combined with sequential numbering, it also makes a missing statement obvious, which matters more than it sounds during an audit.',
      },
    ],
    keywords: ['settlement statement', 'merchant settlement', 'payout schedule', 'fee breakdown', 'reconcile merchant payments'],
    related: ['ledger', 'withdrawals', 'disputes'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `Ask a merchant what their payments cost them and most will do the same calculation out loud: *well, I charged this much, and this much arrived, so…*

That subtraction is not accounting. It is an estimate dressed as a fact, and it cannot be filed, recovered or disputed.

## What a net figure hides

A single net settlement amount hides at least three different things: what the provider kept, what the platform kept, and what tax was charged on the platform’s fee.

Those three are not interchangeable. One may be negotiable. One may be recoverable. One belongs on a tax return. Collapsed into a single deduction, none of them can be acted on, and your accountant ends up reverse-engineering a figure they will probably get wrong.

## Separate lines

A BitriPay statement shows the **provider fee**, the **platform fee** and the **tax on that fee** as separate lines.

And where the money settled in a different currency from the one it was collected in, the conversion is disclosed too — the rate, the mid rate behind it, and the margin. The thing most likely to quietly cost you the most is the thing stated most explicitly.

## Numbered and hashed

Statements are numbered in sequence and hashed.

The numbering means a missing statement is obvious. The hash means you can show a statement has not been altered since it was issued. Both matter during an audit, and neither is something you can add afterwards if the platform did not do it at the time.

The same figures produce JSON, CSV or PDF — one for your system, one for your spreadsheet, one for the person who wants a document.

## Your cadence, not ours

A settlement profile is set per currency and per rail: the schedule — same day, next day, two days, weekly or manual — the cut-off hour, the destination, and a minimum below which it waits.

A busy shop settling daily and a project settling weekly are different businesses, and should not be forced onto the same calendar.

## Preview before it closes

A profile can be previewed. Before the cycle closes you can see what the next settlement will contain: the collection-currency totals, the fee lines, and the conversion if there is one.

Surprises in settlement are almost always unpleasant, and almost always avoidable.

## Paying out

Closing a cycle creates an obligation. Paying it goes through the payout workflow with its own approvals — the same controls as any other movement of money out of the platform.

## What it costs

Settlement is not charged separately. The fees on the statement are the fees on the payments it covers, and now you can see them.`,
  },

  // ------------------------------------------------------------------ trust
  {
    key: 'emoney-and-safeguarding',
    name: 'E-money and safeguarding',
    slug: 'emoney-and-safeguarding',
    category: 'trust',
    module: null,
    usp: 'An issuance rule the platform refuses on rather than reports on: e-money cannot be issued beyond cleared safeguarded funds, checked at the moment of issuance rather than at the end of the month.',
    tagline: 'Every balance is backed, by construction.',
    headline: 'What stands behind the number in your account',
    excerpt:
      'A balance is a claim on somebody. Whether that claim is worth anything depends on rules nobody sees. Here is the rule, where the money sits, and what happens daily to prove it is still there.',
    audience: 'Customers who want to know their money is real, and regulators, partners and auditors who need it demonstrated.',
    problem:
      'E-money failures do not usually begin with theft. They begin with balances that are not fully backed, nobody noticing for months, and a reconciliation that was a report rather than a control.',
    how: [
      'Each currency has a programme naming the legal issuer and the safeguarding arrangement.',
      'Funds are recorded as cleared only when they have actually cleared.',
      'Issuance is refused if it would exceed cleared funds less redemptions pending and exposure reserved.',
      'A daily check compares what customers are owed with what is actually held, and a shortfall is remedied the same day.',
    ],
    proof: [
      'The issuance rule is enforced at the point of issuance, not reported afterwards: it refuses rather than warns.',
      'Two reconciliations run daily and separately — internal (every wallet against its own postings) and external (the requirement against the designated accounts) — because they fail for different reasons.',
      'A shortfall is remedied from own funds the same day, through the existing maker-checker on reserve movements.',
      'A resolution pack is generated daily and hash-chained: every holder, their balance, the accounts behind them and the procedure to return the money.',
      'Balances are electronic money, a redeemable claim on the authorised issuer — not a bank deposit, and the product says so rather than implying otherwise.',
    ],
    cost: 'Not a chargeable feature. It is the condition on which balances exist at all.',
    faq: [
      {
        question: 'Is my balance a bank deposit?',
        answer:
          'No, and anybody telling you otherwise is wrong in a way that matters. It is electronic money: a redeemable claim on the authorised issuer, backed by safeguarded funds held for that purpose. It is not covered by deposit insurance, and it does not earn interest.',
      },
      {
        question: 'What is a resolution pack?',
        answer:
          'The document an administrator would use to return customer funds if the firm stopped trading: every holder, their balance, the accounts behind them and the procedure. It is regenerated daily and hash-chained, so it is current and can be shown not to have been edited.',
      },
      {
        question: 'What happens if there is a shortfall?',
        answer:
          'It is remedied from own funds the same day, and the remedy goes through the same two-person control as any other reserve movement. The daily check is release-blocking rather than advisory — a shortfall stops things rather than appearing in a report.',
      },
    ],
    keywords: ['e-money safeguarding', 'is my balance safe', 'electronic money backing', 'safeguarding reconciliation', 'redeemable claim'],
    related: ['ledger', 'add-money', 'risk-and-compliance'],
    cta: { label: 'Read how funds are safeguarded', href: '/legal/safeguarding' },
    article: `The number in your account is a claim on somebody. Whether that claim is worth what it says depends entirely on rules you will never see operating.

So here they are.

## It is not a bank deposit

Let us be exact, because the imprecise version is how people get hurt.

Your balance is **electronic money**: a redeemable claim on the authorised issuer, backed by funds safeguarded for that purpose. It is not a bank deposit. It is not covered by deposit insurance. It does not earn interest.

Anybody who tells you otherwise is either confused or selling something.

## How e-money firms actually fail

Not usually by theft. The pattern is duller and far more common: balances that are not quite fully backed, a gap nobody notices because the reconciliation is a monthly report rather than a control, and then an event — a surge of redemptions, a partner failing — that turns a quiet gap into an insolvency.

Every part of that is preventable, and none of it is prevented by good intentions.

## A rule that refuses

> E-money may not be issued beyond cleared, safeguarded funds in the same currency, less redemptions pending and exposure reserved.

That rule is enforced **at the moment of issuance**. It is not a target, a dashboard or a monthly report. If the backing is not there, the issuance does not happen and the person attempting it receives an error.

Note *cleared*. Money that has been promised, or is in transit, or is expected tomorrow, does not count. Only money that has actually arrived backs anything.

## Two reconciliations, daily, kept apart

They are kept separate because they fail for completely different reasons.

**Internal:** every customer wallet balance must equal the sum of its own postings. A failure here is a defect in the books themselves — an engineering problem.

**External:** what customers are owed must equal what is actually held in the designated accounts. A failure here is **money** — a treasury problem.

Run them together and you learn that something is wrong. Run them apart and you know what.

A shortfall is remedied from own funds the **same day**, through the same two-person control as any other reserve movement. And the daily check is release-blocking: a shortfall stops things, rather than appearing in a report somebody reads on Friday.

## The pack for the worst day

Every day, a resolution pack is generated: every holder, their balance, the accounts standing behind those balances, and the procedure for returning the money.

It is hash-chained to the previous day’s, so it can be shown not to have been edited afterwards.

It describes the day nobody wants. Having it ready, current and tamper-evident is the difference between an orderly return of funds and a long, expensive argument conducted in the dark.

## What it costs

Nothing. It is the condition on which balances exist at all.`,
  },

  {
    key: 'kyc-and-identity',
    name: 'Identity and tiers',
    slug: 'identity-and-tiers',
    category: 'trust',
    module: 'kyc',
    usp: 'Tiers that let somebody start with a phone number and grow into higher limits, so verification is a ladder rather than a wall at the front door.',
    tagline: 'Start with a phone. Grow into the limits.',
    headline: 'Identity checks should be a ladder, not a wall',
    excerpt:
      'Demanding full documentation before anyone can receive a single payment excludes exactly the people digital money is supposed to reach. Tiers let somebody start small and verify as the amounts grow.',
    audience: 'Anyone opening an account, and the compliance teams who have to stand behind the decision to let them.',
    problem:
      'Many people in the markets BitriPay serves do not have the document a form demands, on the day it demands it. A platform that requires everything up front simply does not serve them — while a platform that requires nothing cannot operate legally.',
    how: [
      'Open at the lowest tier with a phone number, and receive within that tier’s limits.',
      'Add an identity document to move up a tier and unlock higher limits.',
      'Add address and source of funds for the highest tier.',
      'Limits are enforced per tier at the moment of the transaction, not reviewed afterwards.',
    ],
    proof: [
      'Limits per tier and per corridor are configuration rather than code, so they move when a rule moves.',
      'A transaction beyond a tier’s limit is refused with a readable reason naming the tier, not silently held.',
      'Screening runs against official sanctions lists at onboarding and again daily, not once at signup.',
      'Business verification checks the registry, the beneficial owners above the declared threshold and the directors, and assigns a risk tier that is reviewed.',
      'Every verification decision is recorded with who made it, so the file can be read later without reconstructing it.',
    ],
    cost: 'Verification is free. Higher tiers unlock higher limits rather than cheaper pricing.',
    faq: [
      {
        question: 'Why can I not just send what I want straight away?',
        answer:
          'Because the limits that apply to an unverified account are the condition on which an unverified account is allowed to exist at all. Verifying moves you up a tier and the limits move with you — usually in minutes.',
      },
      {
        question: 'I do not have the document you are asking for.',
        answer:
          'You can still open an account and receive within the lowest tier’s limits. That is the point of tiers: a missing document limits what you can do, rather than stopping you from starting.',
      },
      {
        question: 'How often do you check sanctions lists?',
        answer: 'At onboarding and daily thereafter, against the official consolidated lists. A customer who becomes listed after joining is found by the daily rescreen, not by chance.',
      },
    ],
    keywords: ['kyc tiers', 'identity verification', 'account limits', 'sanctions screening', 'open account without documents'],
    related: ['risk-and-compliance', 'emoney-and-safeguarding', 'wallets-and-transfers'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Every compliance team has met the same argument. The business says the form is costing them customers. Compliance says the form is what keeps the licence. Both are right, which is why the argument never ends.

Tiers end it.

## The wall at the front door

A platform that demands full documentation before anyone can receive a single payment has made a choice, whether or not it realises it: it will not serve people who do not have that document today.

In the markets BitriPay operates in, that is not a small group. It is often the group digital money was supposed to reach — the trader, the rider, the person whose identity document is with a relative in another province.

They do not go without payments. They go back to cash.

## The other wall

The opposite approach — ask for nothing — is not an option either, and not only because a regulator will eventually stop it. A platform with no idea who its customers are is a platform being used for things its founders would not choose.

## A ladder instead

**Tier 0** is a phone number. You can receive, within limits that are small enough to be proportionate to knowing almost nothing about you.

**Tier 1** adds an identity document and the limits rise.

**Tier 2** adds address and source of funds, and the limits rise again.

Nobody is turned away at the door. What somebody can do is proportionate to what is known about them, and they can change that in minutes whenever they choose.

## Limits refuse, visibly

A transaction beyond a tier’s limit is **refused**, with a readable reason naming the tier — not silently held in a queue while the customer wonders.

Being told *"this is above your tier’s limit; add a document to raise it"* is a useful sentence. Being told nothing is how people conclude the app is broken.

Limits are configuration, not code. When a rule changes, the limits change, without waiting for a release.

## Screening is daily, not once

Sanctions screening runs at onboarding **and again every day** against the official consolidated lists.

This matters more than it sounds. A customer who was clean when they joined and appears on a list eighteen months later is found by the daily rescreen. A platform that screens only at signup finds out when somebody else tells it.

## Businesses

Business verification checks the registry, the beneficial owners above the declared threshold and the directors, and assigns a risk tier that gets reviewed rather than set once and forgotten.

Every decision is recorded with who made it, so the file can be read later by somebody who was not there — which is the actual test of a compliance file.

## What it costs

Nothing. Higher tiers unlock higher limits, not better pricing.`,
  },

  {
    key: 'risk-and-compliance',
    name: 'Risk and compliance',
    slug: 'risk-and-compliance',
    category: 'trust',
    module: null,
    usp: 'A sanctions screen that runs inside the posting, before money moves, so a blocked payment is refused rather than recalled — and every alert becomes a case with a decision and a name against it.',
    tagline: 'Refused before, not recalled after.',
    headline: 'The difference between blocking a payment and regretting one',
    excerpt:
      'Screening after the money has moved is an apology. Screening inside the posting is a control. Here is where the check sits, why that placement is the whole point, and what happens to an alert afterwards.',
    audience: 'Compliance officers, risk teams, partners performing due diligence and regulators.',
    problem: 'Many platforms screen asynchronously: the payment goes, a job runs, and a hit becomes a recall request and a difficult letter. By then the money has usually moved again.',
    how: [
      'A pre-commit hook screens both parties inside the posting, before any entry is written.',
      'A hit refuses the transaction and opens a case rather than letting it settle.',
      'Monitoring rules watch velocity, structuring below limits, bursts to new recipients and high-risk corridors.',
      'Every alert becomes a case with a decision, a reviewer and a record of why.',
    ],
    proof: [
      'Screening is a pre-commit hook on the ledger posting: the check happens before entries are written, not after they settle.',
      'Official consolidated sanctions sources are registered on first start and refreshed daily.',
      'Monitoring produces cases, not just flags; a case carries the decision, the reviewer and the reasoning.',
      'A beneficiary added for the first time can require a step-up and a cooling-off before a large amount moves to it.',
      'Settlement destination changes are a protected action, separate from ordinary profile edits.',
    ],
    cost: 'Not charged separately. It is a condition of operating, not an upsell.',
    faq: [
      {
        question: 'Why was my payment refused?',
        answer:
          'A refusal with a compliance code means the transaction did not pass a check. Support cannot always explain which one — that is a legal constraint, not evasiveness — but a case exists and is reviewed by a person.',
      },
      {
        question: 'Does screening slow every payment down?',
        answer:
          'The check runs inside the posting, so it costs the time of a lookup rather than the time of a batch job. Customers do not experience it as a delay; they experience it only when something is refused.',
      },
      {
        question: 'What stops a legitimate customer being blocked forever?',
        answer:
          'Every alert becomes a case with a reviewer and a decision, not a permanent silent flag. Cases are worked by people, and the decision is recorded with its reasoning so it can be revisited rather than guessed at.',
      },
    ],
    keywords: ['sanctions screening', 'transaction monitoring', 'aml controls', 'compliance case management', 'pre-commit screening'],
    related: ['kyc-and-identity', 'ledger', 'emoney-and-safeguarding'],
    cta: { label: 'Read the compliance policies', href: '/policies' },
    article: `There are two places to put a sanctions check, and the gap between them is the difference between a control and an apology.

## After the money moves

The common pattern: the payment settles, a job runs some minutes or hours later, and a hit produces an alert.

Now somebody has to recall money that has already arrived — and very often already moved again. The platform writes a difficult letter. The compliance officer explains to a regulator why a prohibited payment completed. Everyone agrees to review the process.

The check ran. It just ran too late to be a control.

## Inside the posting

Here, screening is a **pre-commit hook on the ledger posting**. It runs before any entry is written.

A hit means the transaction is **refused**. Not settled and flagged. Not queued for recall. Refused — no entries, no money moved, nothing to recall.

That placement is the entire feature. Everything else is detail.

## Lists that are actually current

The official consolidated sources are registered when the platform first starts and refreshed daily.

A list that is eighteen months old is worse than no list, because it produces confidence without protection.

## Monitoring is about patterns

Screening catches named parties. Monitoring catches behaviour: velocity, structuring just below a limit, bursts of payments to recipients never seen before, activity on high-risk corridors.

These rules do not refuse payments. They raise alerts — and crucially, an alert becomes a **case**.

## A case has a name on it

This is the part that separates a compliance function from a pile of flags.

Every alert becomes a case carrying the decision, the reviewer and the reasoning. Somebody looked at this. They decided this. Here is why.

Months later, when a regulator or a partner asks about a particular customer, the answer is a file rather than an archaeology project. And because the decision was recorded with reasoning, it can be **revisited** when circumstances change, rather than leaving a customer under a silent flag nobody remembers setting.

## Two quieter controls

A **new beneficiary** can require a step-up and a cooling-off before a large amount moves to it. Most account-takeover losses go to an address added minutes earlier; a short delay on first use removes most of that value.

**Settlement destination changes** are protected, separate from ordinary profile edits — because redirecting a business’s income is the single most valuable thing an attacker can do inside an account.

## What it costs

Nothing. This is a condition of operating, not an upsell.`,
  },

  {
    key: 'disputes',
    name: 'Refunds and disputes',
    slug: 'refunds-and-disputes',
    category: 'operate',
    module: null,
    usp: 'A refund that reserves the money atomically before it is promised, and a dispute that is an object with a timetable rather than an email thread somebody is supposed to remember.',
    tagline: 'A promise you can actually keep.',
    headline: 'A refund you cannot fund is worse than a refusal',
    excerpt:
      'Promising a refund and then discovering the balance is not there turns a disappointed customer into an angry one. Reserving first, and treating disputes as objects with deadlines, fixes both halves.',
    audience: 'Merchants handling returns, support teams, and customers who were charged for something they did not get.',
    problem:
      'Refunds are usually promised and then attempted. If the merchant balance has already settled out, the refund fails after the customer has been told it is coming — and disputes live in inboxes where deadlines are missed.',
    how: [
      'A refund reserves the amount atomically before it is accepted — the money is secured, then the promise is made.',
      'Refund up to what is still refundable on the original payment; the remaining amount is shown.',
      'A dispute is an object with a state, a deadline and the evidence attached.',
      'Split payments are allocated back pro rata, or absorbed by the merchant, according to the policy set.',
    ],
    proof: [
      'A refund reserves the amount atomically; a refund that cannot be funded is refused at the point of request rather than failing later.',
      'The refundable balance of a payment is a figure the API reports, so partial refunds cannot quietly exceed the original.',
      'Disputes are objects with states and deadlines, not email threads, so a missed deadline is visible before it is missed.',
      'Where a payment was split between recipients, refunds are allocated pro rata or absorbed by the merchant according to the recorded policy, and failed recoveries can be retried.',
      'A cashier can refund only up to the limit the business sets; above it the refund is refused.',
    ],
    cost: 'Refunding returns the money to the payer. Where a provider fee on the original payment is not returned by the provider, the statement shows that rather than absorbing it silently.',
    faq: [
      {
        question: 'Can I refund more than once on the same payment?',
        answer: 'Yes, up to what is still refundable. The remaining refundable amount is reported, so a series of partial refunds cannot quietly exceed the original payment.',
      },
      {
        question: 'What happens to a refund on a payment that was split?',
        answer:
          'It follows the policy recorded on the payment: each recipient gives back their share pro rata, or the merchant absorbs the whole amount. A recovery that fails can be retried rather than silently abandoned.',
      },
      {
        question: 'Why was my refund refused?',
        answer:
          'Most often because the amount could not be reserved — the funds were not available at the moment of the request. Being refused at that point is deliberately better than being promised a refund that fails afterwards.',
      },
    ],
    keywords: ['payment refund', 'chargeback', 'dispute management', 'partial refund', 'split payment refund'],
    related: ['settlement-and-statements', 'team-and-roles', 'ledger'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `There is one thing worse than telling a customer you cannot refund them: telling them you can, and then failing.

The first is a disappointment. The second is a complaint, a review and usually a chargeback.

## Why refunds fail late

The usual order is: accept the refund, tell the customer, then attempt it.

By the time it is attempted, the merchant’s balance may have settled out to their bank. The refund fails. The customer has already been told. Nobody involved has done anything wrong, and yet here you are.

## Reserve first, promise second

A refund here **reserves the amount atomically** before it is accepted.

If the money cannot be reserved, the refund is refused **at the point of request** — while you are still talking to the customer, when you can say *"I need to arrange this, give me an hour"* instead of *"it has been sent"* followed by silence.

Being refused early is worse than being accepted and working. It is much better than being accepted and failing.

## Partial refunds that cannot overrun

Every payment reports how much of it is still refundable.

Refund half today, a quarter next week, and the remaining figure is a number the system knows — not something your support team tracks in a spreadsheet and occasionally gets wrong in the customer’s favour.

## Splits

Where a payment was split between several recipients — a marketplace, a platform taking a fee, a cooperative sharing proceeds — a refund has to come from somewhere.

The policy is recorded on the payment: each recipient gives back their share **pro rata**, or the merchant **absorbs** the whole amount. Both are legitimate; what matters is that it was decided in advance rather than argued afterwards.

A recovery that fails — a recipient whose balance is short — can be retried, rather than being silently abandoned and discovered during a year-end reconciliation.

## Disputes are objects, not inboxes

A dispute lives in an inbox at most companies. Inboxes do not have deadlines; people do, and people forget.

Here a dispute is an **object**: a state, a timetable, the evidence attached to it. A deadline approaching is visible **before** it is missed, which is the only time that information is useful.

## The cashier limit applies here too

A cashier can refund up to the limit the business sets. Above it, the refund is refused and has to be made by somebody with the authority.

Refunds are where a counter leaks, and the limit is what stops a slow leak becoming a flood.

## What it costs

A refund returns money to the payer. Where a provider’s fee on the original payment is not returned by that provider, the statement shows it rather than absorbing it quietly — so you know the real cost of a return.`,
  },

  {
    key: 'corridor-network',
    name: 'Corridor network',
    slug: 'corridor-network',
    category: 'operate',
    module: 'corridorNetwork',
    usp: 'A corridor records which phase it is in, under whose licence and with which custody model — as data, so moving from an orchestrator to a licensed issuer changes rows rather than code.',
    tagline: 'Regulatory posture as configuration.',
    headline: 'Building a payment network in four phases, without rewriting it each time',
    excerpt:
      'Most payment companies rebuild themselves at every regulatory step. If the posture of a corridor is data rather than branches in the code, moving from orchestrating to issuing changes rows and nothing else.',
    audience: 'Boards, regulators, sponsor banks, investors and the engineers who would otherwise be asked to rebuild the platform every eighteen months.',
    problem:
      'A payment business changes shape as it gains licences. If custody, licence basis and permitted rails are hard-coded assumptions, each step is a rewrite, and each rewrite is a chance to get a regulated behaviour wrong.',
    how: [
      'Each corridor records its phase, its regulatory mode, the licence it runs under and who holds the funds.',
      'The rails it may use, its limits and the settlement mechanisms permitted on it are declared alongside.',
      'A corridor cannot go live while its posture is incomplete, and the refusal names what is missing.',
      'Settlement mechanisms needing a decision stay off until that decision is recorded, with the reason kept.',
    ],
    proof: [
      'Phase, regulatory mode, licence basis, custody model, rails and limits are rows, not branches in code.',
      'A corridor is refused the live state until its posture is complete, and the refusal lists exactly what is missing.',
      'Counterparty positions net what a partner received against what it paid, and prefunding is deliberately excluded so no movement is counted twice.',
      'Settlement batches are proposed by one administrator and approved by another, and the rail is re-checked at the moment of instruction.',
      'Phase gates are met only against a measurement and the evidence behind it, and the open questions blocking a phase are recorded with what each one blocks.',
    ],
    cost: 'Not a customer-facing product. It is the machinery a corridor runs on, and the discipline a board uses to decide whether the next phase is funded.',
    faq: [
      {
        question: 'Why would a payments company publish its own phase gates?',
        answer:
          'Because the alternative is deciding whether to spend the next tranche on a feeling. A gate met against a measurement, with the evidence recorded, is a decision somebody can defend — to a board, an investor or a regulator.',
      },
      {
        question: 'What does "regulatory posture as data" actually mean?',
        answer:
          'That whether a corridor is custodial, whose licence it runs under and which settlement mechanisms it may use are rows in a register rather than assumptions compiled into the software. Changing posture is then an administrative act with an audit trail, not a release.',
      },
      {
        question: 'Why is prefunding kept out of the position?',
        answer:
          'Because placing BitriPay’s own liquidity at a partner is a treasury movement, not something the partner owes. Counting it in both places would make every position wrong — there is a test that exists purely to keep that true.',
      },
    ],
    keywords: ['payment corridor', 'regulatory posture', 'counterparty settlement', 'prefunding treasury', 'phase gates fintech'],
    related: ['remittance', 'settlement-and-statements', 'emoney-and-safeguarding'],
    cta: { label: 'Read the corridor network document', href: '/features' },
    article: `Payment companies change shape as they gain licences. They start by orchestrating somebody else’s rails, then take a corridor end to end, then hold their own authorisation.

The usual cost of each step is a rewrite, and the usual risk of each rewrite is that a regulated behaviour quietly changes along the way.

## The assumption that becomes a rebuild

Early on, somebody writes code that assumes the platform does not hold customer funds. It is true, so it is not written down anywhere — it is simply what the code does.

Two years later the company is authorised to hold funds, and that assumption is distributed across hundreds of files as the absence of something. Now it is a rewrite, conducted under commercial pressure, in the part of the system where errors are least forgiving.

## Posture as rows

A corridor here records, as data:

- which **phase** it is in,
- its **regulatory mode** — non-custodial, partner custody, own authorisation, network operator,
- the **licence basis** it runs under and who holds the funds,
- the **rails** it may use and the **limits** that apply,
- which **settlement mechanisms** are permitted on it.

Moving from one phase to the next changes rows. The code does not have an opinion about custody, because custody is a field.

## Incomplete postures cannot go live

A corridor is refused the live state while its posture is incomplete, and the refusal **names what is missing**: no licence basis, no payout rail, no daily limit.

This is a small mechanism with a large consequence. The commonest regulatory failure in payments is not defiance; it is a corridor that went live while somebody was still chasing a document, and nobody noticed because nothing stopped it.

## Settlement that cannot be counted twice

Counterparty positions net what a partner received for you against what it paid out for you.

**Prefunding is deliberately excluded.** Placing your own liquidity at a partner is a treasury movement, not a debt the partner owes you. Counting it in both places makes every position wrong — quietly, and in your favour, which is the worst direction for a mistake to run.

There is a test whose only job is to keep that true.

## Mechanisms that stay off

A settlement mechanism that requires a decision — a sponsored participation, a settlement token — is **off on every corridor** until that decision is recorded, with the reason kept against it.

Not off by convention. Off by refusal.

## Gates with evidence

A phase gate is met only against a **measurement** and the **evidence** behind it. Both are required; a gate cannot be marked met because somebody is confident.

Alongside sit the open questions, each recording what it blocks. A board deciding whether to fund the next phase can see what is genuinely answered and what is still a hope.

That is an uncomfortable document to maintain. It is a considerably more uncomfortable conversation to have without one.`,
  },

  // ------------------------------------------------------------------ reach
  {
    key: 'ussd-and-sms',
    name: 'USSD and SMS',
    slug: 'ussd-and-sms',
    category: 'reach',
    module: null,
    usp: 'The same ledger, the same balances and the same limits reached from a feature phone with no data — not a reduced product for poorer customers, the same product through a different door.',
    tagline: 'No smartphone. No data. Same account.',
    headline: 'The customers everyone else designs out',
    excerpt:
      'Every payment product assumes a smartphone and a data bundle. Most of the people who most need digital money have neither. USSD and SMS are not a downgrade — they are the same account through a different door.',
    audience: 'Anyone on a feature phone, anyone out of data, anyone in a place where the signal carries voice but not much else.',
    problem:
      'A product that requires an app and a data bundle has quietly decided who its customers are. In much of the region that decision excludes most of the market, and it excludes it permanently rather than temporarily.',
    how: [
      'Dial the short code from any phone, including a feature phone with no data.',
      'Move through a numbered menu: balance, send, request, pay a code.',
      'Confirm with the same PIN that guards the account in the app.',
      'A command can also be sent by SMS, for places where even a session is unreliable.',
    ],
    proof: [
      'USSD and SMS reach the same accounts, the same ledger and the same limits as the app — not a parallel system with its own balances.',
      'The transaction PIN that protects the account in the app is the PIN that protects it over USSD.',
      'A session that drops mid-flow does not leave a half-made payment: the posting either happened or it did not.',
      'The command channel is simulated in the console, so a change can be tested without a handset.',
    ],
    cost: 'Operator charges for the session apply as they do for any USSD. BitriPay does not add a charge for using this door rather than the app.',
    faq: [
      {
        question: 'Is this a cut-down version with lower limits?',
        answer: 'No. Same account, same ledger, same limits, same PIN. The menu is smaller because a feature phone screen is smaller, not because the customer is worth less.',
      },
      {
        question: 'My session dropped in the middle. Did I pay twice?',
        answer: 'No. The posting either happened or it did not; there is no half-made payment. Check your balance and the last transaction, and you will see which.',
      },
      {
        question: 'Why bother, when everyone is getting a smartphone?',
        answer:
          'Because "eventually" is not a payment strategy for somebody who needs to send money to their mother this afternoon. And a smartphone owner out of data is, for that afternoon, exactly the same customer.',
      },
    ],
    keywords: ['ussd payments', 'feature phone mobile money', 'sms banking', 'send money without internet', 'ussd short code'],
    related: ['bitripay-lite', 'offline-payments', 'agents-and-cash'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Open almost any payment product’s onboarding and the first assumption is a smartphone. The second is a data bundle. Neither is stated, because neither is noticed.

In much of the region BitriPay serves, those two unstated assumptions exclude most of the market.

## The decision nobody writes down

A product that requires an app has decided who its customers are. Not deliberately — nobody held a meeting about it — but the decision is made and it is permanent.

The people excluded are not an edge case. They are the trader with a feature phone that lasts five days on a charge, the grandmother receiving money from her son, the rider whose data ran out on Tuesday and whose next bundle is Friday.

They have money. They need to move it. They are not served.

## Same account, different door

USSD is the point here, and the point is worth stating precisely: **it is not a reduced product.**

The same account. The same ledger. The same limits. The same transaction PIN that guards the account in the app.

The menu is shorter because a feature phone screen is shorter. That is the whole difference. A customer on a feature phone is not worth less and does not get less.

## Dropped sessions

USSD sessions drop. The signal goes, the operator times out, somebody walks behind a wall.

The question that matters is what happens to a payment that was halfway through. The answer is that there is no halfway: the posting either happened or it did not. Check the balance and the last transaction and you will know which.

This is not special handling for USSD — it is what a balanced posting on a single ledger gives you for nothing. A payment that cannot be half-written cannot be half-written over a dropped session either.

## SMS, for when even a session is too much

Some places have a signal that carries a text and not much else. A command can be sent by SMS for exactly those places.

It is the least elegant channel in the product and occasionally the only one that works.

## And the smartphone owner with no data

Worth saying, because it is easy to think of this as a feature for other people.

A smartphone owner who has run out of data is, until Friday, exactly the same customer as somebody who has never owned one. The door that exists for one of them serves both.

## What it costs

The operator charges for the session, as they do for any USSD. BitriPay adds nothing for using this door rather than the app.`,
  },

  {
    key: 'bitripay-lite',
    name: 'BitriPay Lite',
    slug: 'bitripay-lite',
    category: 'reach',
    module: null,
    usp: 'A full web app that works with JavaScript switched off entirely, rendered on the server, so it loads on a slow connection and an old browser instead of showing a spinner.',
    tagline: 'Works on the connection you actually have.',
    headline: 'A payment app that works when the connection does not',
    excerpt:
      'A modern web app assumes megabytes of JavaScript and a connection that delivers them. Lite is the same account rendered on the server, no JavaScript at all, for the days the network is having one of those afternoons.',
    audience: 'Anyone on a slow or expensive connection, an old phone, a cheap browser, or a network that is having a bad day.',
    problem: 'A single-page app that fails to download is a blank screen. On a congested network that is not rare, and the customer concludes the service is broken rather than the connection.',
    how: [
      'Open the Lite address instead of the app.',
      'Pages are rendered on the server and delivered as plain HTML.',
      'Everything works through ordinary links and form submissions.',
      'Nothing depends on JavaScript, so nothing breaks when it fails to arrive.',
    ],
    proof: [
      'Lite is server-rendered and requires no JavaScript at all — not a degraded fallback, a working surface.',
      'It reaches the same accounts and the same ledger as the full app.',
      'Pages are small enough to arrive on a congested connection where a single-page bundle would not.',
      'It works in browsers too old for a modern application framework.',
    ],
    cost: 'Free, and it uses markedly less data than the full app — which on a metered connection is the point.',
    faq: [
      {
        question: 'Is it less secure because it is simpler?',
        answer:
          'No. The same sign-in, the same PIN, the same limits and the same server-side checks apply. Nothing about security lives in the JavaScript of the full app — if it did, that would be the problem, not Lite.',
      },
      {
        question: 'Can I do everything in it?',
        answer: 'The things that matter on a bad connection: balance, receiving, paying, requesting, and your statement. It is built for the afternoon when the network is bad.',
      },
      {
        question: 'Why not just make the main app faster?',
        answer: 'We do that too. But there is a level of connection below which no amount of optimisation delivers a megabyte of JavaScript, and above zero customers are at that level every day.',
      },
    ],
    keywords: ['lightweight web app', 'no javascript web app', 'works on slow connection', 'low data payment app', 'server rendered app'],
    related: ['ussd-and-sms', 'offline-payments', 'notifications'],
    cta: { label: 'Open an account', href: '/register' },
    article: `There is a particular failure that teaches customers a service is broken, and it is not an error message. It is a white screen.

The application’s JavaScript did not finish downloading. Nothing rendered. There is nothing to read, nothing to tap and nothing to explain what went wrong.

## Why it happens so often here

A modern web application is a few megabytes of JavaScript that must arrive before anything appears on screen.

On a good connection this is invisible. On a congested cell at five in the afternoon, on a bundle that has nearly run out, on a phone three generations old, it is a white screen for twenty seconds followed by a customer who has given up.

Optimisation helps. It does not help below a certain floor, and a meaningful number of people are below that floor every single day.

## Rendered where the computer is

Lite is the same account, rendered on the server and delivered as plain HTML.

No JavaScript. Not *degrades gracefully without JavaScript* — **none at all**. Ordinary links. Ordinary forms. The web as it worked before it needed a build step.

A page arrives in kilobytes and renders the instant it lands. There is no bundle to wait for, because there is no bundle.

## Not a lesser product

It reaches the same accounts, the same ledger, the same balances. The same sign-in, the same PIN, the same limits, the same server-side checks.

Nothing about the security of the full app lives in its JavaScript. If it did, that would be a defect in the full app rather than a reason to distrust Lite.

## Old browsers

Cheap phones ship with browsers that are already years behind, and they do not get updated. A framework that needs a current browser has excluded those customers as surely as if it had asked for a passport.

Server-rendered HTML works in all of them, because it is the thing browsers have always done.

## The data argument

On a metered bundle, the difference between kilobytes and megabytes is not an engineering nicety. It is whether checking your balance costs you something you were saving for something else.

## When to use it

Keep the full app for ordinary days. Open Lite when the network is having one of those afternoons, when the bundle is nearly gone, or when you are using a phone that is not yours.

It is the one that works when the other one does not.`,
  },

  {
    key: 'offline-payments',
    name: 'Offline payments',
    slug: 'offline-payments',
    category: 'reach',
    module: null,
    usp: 'A signed promise exchanged between two phones with no network at all, with counters and nonces so the same promise cannot be spent twice when the signal returns.',
    tagline: 'Trade when the network is gone.',
    headline: 'Paying when there is no network at all',
    excerpt:
      'Networks fail at exactly the wrong moments. A signed, counted promise exchanged between two phones lets a sale complete now and settle when the signal returns — without creating a way to spend the same money twice.',
    audience: 'Traders in places with no reliable signal, markets that lose coverage at peak hours, anyone whose business stops when the network does.',
    problem:
      'When the network goes, digital payment stops and everybody falls back to cash. The obvious fix — let the phones agree and sync later — is also the obvious way to let somebody spend the same balance in four places.',
    how: [
      'The payer’s phone produces a signed promise carrying the amount, a nonce and a counter.',
      'The merchant’s phone verifies the signature and records it, with no network involved.',
      'Both sides see the payment as pending confirmation — and the screen says so rather than claiming it is done.',
      'When either phone reaches a signal, promises are synchronised and settled, and gaps in the counter are visible.',
    ],
    proof: [
      'A promise is signed by the payer’s enrolled device key, so it cannot be fabricated by the merchant’s phone.',
      'Each promise carries a nonce and a per-device counter; a replayed promise is recognised and a missing counter value shows as a gap.',
      'The pending state is shown to both sides in plain words rather than being presented as a completed payment.',
      'Promises have an expiry, so an unsynchronised promise does not sit indefinitely as an open claim.',
      'Counter gaps are listed per device, so a device that has stopped synchronising is visible rather than assumed healthy.',
    ],
    cost: 'No additional charge. The payment is priced as an ordinary payment when it settles.',
    faq: [
      {
        question: 'What stops somebody spending the same money twice offline?',
        answer:
          'Each promise carries a nonce and a per-device counter. Replays are recognised, and a gap in the counter is visible when the device synchronises. It is not possible to make offline spending risk-free — which is why the exposure is bounded by limits and expiry, and why both sides are told the payment is pending rather than complete.',
      },
      {
        question: 'Does the merchant have to trust the customer?',
        answer:
          'Less than with cash, and considerably less than with a screenshot. The promise is signed by the payer’s enrolled device and cannot be fabricated by the merchant’s phone — but it is a promise until it settles, and the screen says exactly that.',
      },
      {
        question: 'What if a phone never comes back online?',
        answer: 'Promises expire, and counter gaps per device are listed, so a device that has stopped synchronising is visible rather than quietly assumed to be fine.',
      },
    ],
    keywords: ['offline payment', 'pay without internet', 'offline qr payment', 'signed payment promise', 'double spend offline'],
    related: ['qr-payments', 'ussd-and-sms', 'bitripay-lite'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Networks fail at the worst possible moments: market day, the hour before closing, the afternoon everyone is paid.

When the signal goes, digital payment stops and everyone returns to cash — which is exactly when a trader is carrying the most of it.

## The obvious fix and its obvious hole

Let the two phones agree between themselves and synchronise later.

This works beautifully until somebody realises they can make the same offline promise to four different merchants in four different parts of the market, and be gone before any of the phones find a signal.

Offline payment is easy. Offline payment that is not a double-spend machine is the actual problem.

## A signed, counted promise

The payer’s phone produces a promise carrying the amount, a **nonce** and a **per-device counter**, signed by the device’s enrolled key.

The merchant’s phone verifies that signature with no network at all. It cannot fabricate a promise, because it does not hold the payer’s key.

The nonce means a replayed promise is recognised. The counter means a **gap** is visible: if a device synchronises promises 41, 42 and 44, somebody is holding 43 and the system knows to look for it.

## The honest part

You cannot make offline spending risk-free. Anybody claiming otherwise is selling something.

What you can do is bound the exposure and tell the truth about it:

- **Limits** cap how much can be promised offline before synchronising.
- **Expiry** means an unsynchronised promise does not sit forever as an open claim.
- **Counter gaps** are listed per device, so a phone that has stopped synchronising is visible rather than assumed healthy.
- And both sides see the words **pending confirmation** rather than a green tick.

That last one matters most. A merchant who knows a payment is a promise can decide whether to hand over the goods based on the size and the customer. A merchant shown a tick that means nothing has been lied to.

## Which is still better than cash

Cash on market day means carrying notes through a crowd and keeping them overnight. A signed promise from an enrolled device, pending confirmation, bounded by a limit, is a smaller risk than a full cash box — and considerably smaller than a screenshot on a stranger’s phone.

## When the signal returns

Promises synchronise and settle. Both sides see the payment move from pending to settled, and the merchant sees the money.

The sale happened when the customer was standing there. The settlement happened when the network allowed it. Those are two different events, and the product does not pretend they are one.`,
  },

  {
    key: 'notifications',
    name: 'Alerts you cannot miss',
    slug: 'alerts',
    category: 'reach',
    module: null,
    usp: 'A loud alarm and a long vibration designed to be heard across a market and understood without reading, because the sound is the receipt a trader actually relies on.',
    tagline: 'If there was no sound, there was no money.',
    headline: 'Why the sound matters more than the screen',
    excerpt:
      'A trader with a queue does not read a notification. They hear one, or they do not. Making the alert loud, long and unmistakable is not polish — it is the control that stops screenshot fraud.',
    audience: 'Market traders, riders, shopkeepers, agents — anyone taking payments with their hands full and their eyes elsewhere.',
    problem:
      'The standard fraud at a stall is a screenshot. The customer shows a convincing picture of a payment that never happened and walks off with the goods. A discreet notification is no defence; it was never seen.',
    how: [
      'A payment arrival plays a loud alarm and vibrates for several seconds, not a short chime.',
      'The screen shows the amount in large figures, a green tick and the payer’s name.',
      'The alert can be tested from settings, so the sound is familiar before it matters.',
      'The same alert reaches the phone app, the web app and the payout device.',
    ],
    proof: [
      'The alert is designed to be audible in a noisy market and to be understood without reading the screen.',
      'It fires on the money arriving, not on a payment being started, so it cannot be triggered by a customer’s action alone.',
      'It can be tested from settings, so a trader learns the sound before the first real payment.',
      'The same event reaches every surface, so a merchant watching a till screen and a trader holding a phone hear the same thing.',
    ],
    cost: 'Included on every account and every surface. There is no premium tier that makes the alert louder, because an alert a trader cannot hear is not worth selling.',
    faq: [
      {
        question: 'Can a customer fake the sound?',
        answer:
          'They can play a recording, which is why the sound comes from your phone and not theirs. Never accept a sound, a screen or a screenshot from the payer’s device — the alert that counts is the one your own phone makes.',
      },
      {
        question: 'It is too loud / not loud enough.',
        answer: 'Test it from settings and set the phone’s volume so you can hear it across your stall. Familiarity is the point: you should recognise it without looking.',
      },
      {
        question: 'What if I genuinely did not hear it?',
        answer: 'Check the transaction list before handing over goods. The rule is about what you can rely on in a hurry, not a reason to skip looking when you are unsure.',
      },
    ],
    keywords: ['payment alert', 'loud payment notification', 'screenshot fraud', 'merchant payment confirmation', 'mobile money alert'],
    related: ['qr-payments', 'point-of-sale', 'agents-and-cash'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `A trader with six people in the queue does not read notifications. Their hands are full, their eyes are on the goods and the money, and the phone is somewhere on the table.

They hear a sound, or they do not.

## The fraud this exists to stop

It is the simplest one in the market, and it works constantly.

The customer taps at their phone for a moment, turns the screen around, and shows a convincing picture of a completed payment. The trader is busy. The picture looks right. The goods go across the table.

The picture was a screenshot of somebody else’s payment, or an edited image, or a payment to a different number entirely.

A discreet notification is no defence at all against this, because the discreet notification was never seen.

## Loud, long, and from your own phone

The alert is a genuine alarm and a vibration lasting several seconds. The screen shows the amount in large figures, a green tick and the payer’s name.

It is designed to be heard across a noisy market and understood without reading, because a significant number of the people relying on it do not read easily, and none of them are looking at the screen when it matters.

## One rule, for everybody

> If there was no sound, there was no money.

That is the whole of it, and it fits on a sign above a stall.

Not a screenshot. Not the customer’s screen. Not *it has gone through, I promise*. Not a message from a number you do not know. **Your** phone makes the sound, or no money has arrived.

## Why your phone and not theirs

Anything the payer’s device shows you is a thing the payer controls — a screenshot, a recording, an edited image, a lookalike app.

The alert that counts is the one your own phone makes, because that one comes from the payment actually arriving.

## Test it before you need it

There is a test alert in settings. Use it. Set your volume so you can hear it from the far end of your stall.

The point is familiarity: you should know that sound without looking up, the way you know the sound of your own name.

## Everywhere at once

The same event reaches the phone app, the web app and the payout device, so a shopkeeper watching a till and a trader holding a phone are hearing the same thing about the same money.

## What it costs

Nothing. It is the receipt.`,
  },

  {
    key: 'smart-route',
    name: 'Smart Route',
    slug: 'smart-route',
    category: 'build',
    module: null,
    usp: 'Routing scored from measured success rates, cost and latency per connector, with a circuit breaker that takes a failing rail out before your customers find it.',
    tagline: 'The rail that will work, not the rail that is first.',
    headline: 'How a payment decides which way to go',
    excerpt:
      'A payment can usually travel several ways, and they are not equally good at two in the morning. Routing on measured success, cost and latency — with a breaker on failing rails — is the difference between resilience and a bad night.',
    audience: 'Merchants who lose sales to failed payments, and developers who would otherwise build failover themselves.',
    problem: 'Most integrations hard-code one provider. When it degrades, every payment degrades with it, and the business finds out from customers rather than from a dashboard.',
    how: [
      'Candidate connectors are assembled from what can actually carry this payment.',
      'Each is scored on measured success rate, total cost, and observed latency.',
      'The circuit breaker removes a connector that is failing, and lets it back gradually once it recovers.',
      'A merchant policy can bias the choice towards cheapest, fastest or most reliable.',
    ],
    proof: [
      'Scores come from telemetry kept in fifteen-minute buckets over twenty-four hours, optionally keyed by amount band and prefix, rather than from a static preference list.',
      'The breaker moves closed → open after consecutive faults → half-open after a cooldown → closed on the next success, so a recovering rail is tested with one payment rather than all of them.',
      'Health is a state per connector — healthy, degraded, unavailable, maintenance — derived from the circuit, the last probe and recent success.',
      'Failover only happens for errors that guarantee no money moved; anything ambiguous triggers a status check first.',
      'A merchant can bias routing towards cheapest, fastest or most reliable per payment.',
    ],
    cost: 'Included. You pay the rate of whichever rail carried the payment, and the dashboard shows which one did.',
    faq: [
      {
        question: 'Could a retry charge my customer twice?',
        answer:
          'Failover happens only for errors that guarantee no money moved. For anything ambiguous — a timeout, an unknown code — the status is checked first. Not retrying is better than retrying into a double charge.',
      },
      {
        question: 'Can I force a particular rail?',
        answer:
          'You can bias the routing policy towards cheapest, fastest or most reliable, and restrict which rails a payment may use. What you cannot do is force a rail whose breaker is open, which is the point of having one.',
      },
      {
        question: 'How do I know which rail was used?',
        answer: 'Every payment records the connector that carried it, along with the attempts before it. The dashboard shows the route a payment actually took, not the one it was supposed to take.',
      },
    ],
    keywords: ['payment routing', 'smart routing', 'circuit breaker payments', 'payment failover', 'connector health'],
    related: ['developer-api', 'hosted-checkout', 'national-switch'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `Most payment integrations contain a decision nobody revisits: the provider chosen in the first week.

It works. Then one night it does not — not down, just slow and failing one payment in five — and every payment degrades with it. The business finds out from customers.

## Routing is a measurement problem

A payment can usually go several ways. The ways are not equally good, and which one is best changes by the hour.

So the question is not *which provider did we pick* but *which of these can carry this payment, right now, best*.

## Scored on what actually happened

Each candidate connector is scored on three measured things: its recent **success rate**, the **total cost** of using it, and its observed **latency**.

Those numbers come from telemetry kept in fifteen-minute buckets over twenty-four hours — optionally keyed by amount band and prefix, because a rail that is excellent for small local payments is not necessarily excellent for large ones.

It is a measurement, not a preference list somebody wrote once.

## The breaker

A connector that fails repeatedly has its circuit **opened**: it stops being offered at all.

After a cooldown it goes **half-open** — one payment is allowed through as a test. If that succeeds the circuit closes and normal traffic resumes. If it fails, back to open.

The effect is that a recovering rail is tested with a single payment rather than with all of your customers.

## Failover that will not double-charge

This is where naive retry logic causes real damage.

Failover happens **only** for errors that guarantee no money moved. For anything ambiguous — a timeout, an unknown response code — the status is checked first.

A payment that might have succeeded is not retried. Losing a sale to caution is recoverable. Charging a customer twice is a refund, a complaint and a reputation.

## Your policy

A merchant can bias routing towards **cheapest**, **fastest** or **most reliable**, and restrict which rails a payment may use at all.

What you cannot do is force a rail whose breaker is open. That is not a limitation; it is the entire value of having a breaker.

## You can see what happened

Every payment records the connector that carried it and the attempts before it. The dashboard shows the route the payment actually took — not the route it was supposed to take, which is the number most systems give you and the one that is useless during an incident.

## What it costs

Nothing extra. You pay the rate of whichever rail carried the payment, and the dashboard tells you which one did.`,
  },

  {
    key: 'national-switch',
    name: 'National switch connection',
    slug: 'national-switch',
    category: 'build',
    module: null,
    usp: 'An adapter written against an internal contract rather than a protocol, with a simulator that reproduces the awkward cases — a timeout after a financial effect, a contradictory late rejection — before a real connection exists.',
    tagline: 'Built to connect, and built to be tested first.',
    headline: 'How to build for a switch you are not connected to yet',
    excerpt:
      'Waiting for a scheme to publish its profile before writing any code wastes a year. Writing against an internal contract, with a simulator for the ugly cases, means the connection becomes a codec rather than a rebuild.',
    audience: 'Banks, e-money issuers and institutions that need to reach or join a national scheme, and the regulators supervising them.',
    problem:
      'Integrations with a scheme are usually written against its protocol. When the profile changes, or a second scheme appears, the business logic has to be rewritten because the protocol leaked into it.',
    how: [
      'Payments are expressed in an internal canonical form that presumes no particular protocol.',
      'An adapter translates between that form and whatever the scheme actually speaks.',
      'A simulator reproduces the awkward outcomes, labelled as simulation throughout.',
      'The certified codec is loaded only for a connection whose certification is recorded.',
    ],
    proof: [
      'The internal contract presumes nothing about the wire format — not ISO 8583, not ISO 20022, not REST — so the protocol never reaches the business logic.',
      'The simulator reproduces a timeout after a financial effect, a provisional not-found, a duplicate success, a contradictory late rejection, an invalid signature and an acknowledgement without completion.',
      'Everything the simulator produces is labelled as simulation and it never attests certification.',
      'A certified adapter is loaded only for a connection whose certification state says so.',
      'Aggregation fees on switch payments are accrued per completed payment and invoiced per period, never posted onto the payment itself.',
    ],
    cost: 'Scheme and aggregation fees are set in the console and shown on the merchant’s statement as their own line.',
    faq: [
      {
        question: 'Why build before the profile is published?',
        answer:
          'Because the hard part is not the wire format — it is the behaviour around it: what happens on a timeout that had a financial effect, or a rejection that contradicts an earlier success. Those can be built and tested now, and the format becomes a codec later.',
      },
      {
        question: 'Does the simulator prove you are certified?',
        answer:
          'No, and it says so on everything it produces. It proves the behaviour was built and tested. Certification is a separate, recorded state, and the certified adapter loads only for a connection that has it.',
      },
      {
        question: 'How are the switch fees charged?',
        answer:
          'Accrued per completed payment and invoiced per period and per currency. They are never posted onto the payment itself, so the payment amount is the payment amount and the fee is a separate, visible obligation.',
      },
    ],
    keywords: ['national payment switch', 'iso 20022 adapter', 'switch certification', 'interoperability', 'scheme connection'],
    related: ['smart-route', 'corridor-network', 'developer-api'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `There are two ways to build for a national scheme you are not yet connected to.

The common one: wait for the profile, then write the integration against it. This is safe, and it costs a year, and at the end of the year you discover the interesting problems for the first time.

## The protocol is the easy part

Translating between message formats is work, but it is known work. Any competent team can do it once the specification exists.

The hard part is the behaviour around the edges, and none of it depends on the format:

- The switch **times out** — but the money moved.
- A payment is reported **not found**, provisionally, and then found.
- A **duplicate success** arrives for something already settled.
- A **late rejection** contradicts a success you already acted on.
- An acknowledgement arrives with **no completion** behind it.

Every one of those is a decision about money, and every one can be designed, built and tested before anybody publishes anything.

## An internal contract

Payments are expressed in a canonical internal form that presumes nothing about the wire: not ISO 8583, not ISO 20022, not REST, not SOAP.

An adapter translates between that form and whatever the scheme speaks. The protocol never reaches the business logic, which has two consequences:

1. A change to the profile is a change to a codec.
2. A second scheme, in a second country, is a second adapter rather than a second platform.

## The simulator is for the ugly cases

Our simulator does not simulate a successful payment, which is the easy case and tells you nothing.

It reproduces the timeout after a financial effect. The provisional not-found. The duplicate success. The contradictory late rejection. The invalid signature. The acknowledgement with nothing behind it. The authorisation that never completes.

These are the scenarios that, met for the first time in production, turn into a month of reconciliation and a difficult conversation with a regulator.

## It never pretends

Everything the simulator produces is labelled as simulation, and it never attests certification.

This is a deliberate line. A simulator that could be mistaken for a certified connection is a liability — to us, and to anyone reading a report produced from it. Certification is a separate recorded state, and the certified adapter loads only for a connection that has it.

## Fees stay off the payment

Aggregation fees on switch payments are accrued per completed payment and invoiced per period and per currency.

They are never posted onto the payment itself. The payment amount is the payment amount; the fee is a separate, visible obligation on a statement. A merchant can see what they were charged without reverse-engineering it from a net figure.`,
  },

  {
    key: 'virtual-cards',
    name: 'Virtual cards',
    slug: 'virtual-cards',
    category: 'move',
    module: 'virtualCards',
    usp: 'A card number for the sites that only take cards, issued against your own balance, with the card details never stored by BitriPay in a form that could be taken from it.',
    tagline: 'A card number, without a bank card.',
    headline: 'The internet still asks for a card number',
    excerpt: 'Half the internet refuses mobile money and demands sixteen digits. A virtual card issued against your own balance closes that gap, with a spending limit and no plastic to lose.',
    audience: 'Anyone buying online who has a wallet but no bank card: freelancers paying for software, students paying fees, traders buying stock from foreign sites.',
    problem:
      'Mobile money is how people here pay each other, and it is not how the internet takes payment. A great many online services simply cannot be bought without a card number, whatever else you hold.',
    how: [
      'Create a card against your balance and set a limit for it.',
      'Use it where a card number is required.',
      'Each payment is authorised against the balance behind it, so it cannot spend money you do not have.',
      'Freeze or destroy the card at any moment; the balance stays with you.',
    ],
    proof: [
      'Card details are handled so that BitriPay does not retain the sensitive values in a form that could be taken from it.',
      'A card is backed by your balance, so a card payment cannot exceed what is actually there.',
      'A card can be frozen or destroyed instantly, and destroying it does not touch the money behind it.',
      'A separate card per subscription confines a leak or a rogue merchant to that one card.',
    ],
    cost: 'Card issuance and usage are priced in the dashboard before you create one, including any foreign-currency charge, so the cost of a purchase is known before it is made.',
    faq: [
      {
        question: 'Why would I use several cards?',
        answer:
          'One per subscription confines any problem to one card. A leak, a merchant that will not let you cancel, a price rise you did not agree to — destroy that card and the problem ends, without touching anything else you pay for.',
      },
      {
        question: 'Can it go overdrawn?',
        answer: 'No. Each payment is authorised against the balance behind the card, so it cannot spend money that is not there. The failure mode is a declined card, not a debt.',
      },
      {
        question: 'I lost my phone.',
        answer: 'Freeze the card from any other device you can sign in on. A virtual card has no plastic to lose, which is most of its security advantage over the alternative.',
      },
    ],
    keywords: ['virtual card', 'online shopping without bank card', 'card from mobile money', 'prepaid virtual card', 'card for subscriptions'],
    related: ['wallets-and-transfers', 'restricted-wallets', 'add-money'],
    cta: { label: 'Open an account', href: '/register' },
    article: `The internet was built on card numbers and has never really got over it.

You can hold a perfectly good balance, usable at every shop in your city, and still be unable to buy a software subscription, a plane ticket or a textbook, because the checkout wants sixteen digits and a date.

## The gap

Mobile money is how people here pay each other. It is not how the internet takes payment. Those two sentences describe most of the frustration of being online in this region with money that works everywhere except where you need it.

A virtual card closes the gap. It is a card number issued against your own balance — no bank account, no credit check, no plastic.

## It cannot go overdrawn

Each payment is authorised against the balance behind the card. There is nothing to spend beyond what is there.

The failure mode is a **declined card**, which is annoying for an afternoon. The alternative failure mode, on a credit product, is a **debt**, which is a different kind of problem entirely.

For most people, a card that can be declined is considerably safer than one that cannot.

## Use more than one

This is the habit worth forming: a separate card for each subscription.

One card for your software. One for the streaming service. One for the site you are not sure about.

Then when something goes wrong — a leak, a merchant that makes cancelling impossible, a price rise nobody agreed to — you destroy **that** card. The problem ends immediately and nothing else you pay for is disturbed.

Compare that with a single bank card feeding fifteen subscriptions, where cancelling one thing means replacing the card and re-entering it in fourteen places.

## Freeze from anywhere

Lost your phone? Freeze the card from any device you can sign in on.

There is no plastic to lose in the first place, which removes an entire category of risk that the physical version carries by design.

## About the card details

Card data is handled so that BitriPay does not retain the sensitive values in a form that could be taken from it.

That is a deliberately precise sentence. The strongest security claim anyone can honestly make about stored card data is that they are not storing the part that matters — and any company telling you their stored card data is unbreakable is telling you something nobody can know.

## What it costs

Issuance and usage are priced in the dashboard before you create a card, including any foreign-currency charge. You know what a purchase costs before you make it.`,
  },

  {
    key: 'restricted-wallets',
    name: 'Restricted wallets',
    slug: 'restricted-wallets',
    category: 'move',
    module: 'restrictedWallets',
    usp: 'Money that can only be spent on what it was given for, enforced at the posting rather than trusted to the recipient — so a school allowance buys school things.',
    tagline: 'Give money for a purpose, not just to a person.',
    headline: 'Giving money that can only be spent on what it was meant for',
    excerpt:
      'Parents, employers, NGOs and government programmes all face the same problem: money given for one thing gets spent on another. A wallet that refuses the wrong purchase solves it without anybody checking receipts.',
    audience: 'Parents sending allowances, employers paying expenses, NGOs distributing aid, government programmes and cooperatives.',
    problem: 'Money given for school fees, medicine or seed is fungible the moment it lands. The usual controls are receipts collected afterwards, which is slow, humiliating and easy to defeat.',
    how: [
      'Create a restricted wallet and say what it may be spent on — which merchants, which categories.',
      'Fund it like any other wallet.',
      'A purchase outside the restriction is refused at the posting, not flagged afterwards.',
      'The holder sees what the wallet is for, so a refusal is understood rather than mysterious.',
    ],
    proof: [
      'The restriction is enforced as a posting policy, so a purchase outside it is refused rather than recorded and reviewed later.',
      'The holder can see the restriction, so a refusal explains itself instead of looking like a fault.',
      'A restricted wallet is a wallet on the same ledger, with the same statements and the same reconciliation.',
      'Restrictions are configuration on the wallet, so a programme can change what is permitted without a release.',
    ],
    cost: 'No charge for creating or holding restricted wallets. Payments from them carry the ordinary rate.',
    faq: [
      {
        question: 'Is this not paternalistic?',
        answer:
          'It can be, and whoever creates the wallet should think about that. It is also what makes some money exist at all: an employer, a donor or a programme that cannot give cash can often give restricted funds. The alternative is frequently nothing rather than unrestricted money.',
      },
      {
        question: 'What does the holder see?',
        answer:
          'What the wallet is for. A refusal then explains itself — "this wallet is for school expenses" — instead of looking like a broken payment, which is the difference between a control and an indignity.',
      },
      {
        question: 'Can the restriction be changed later?',
        answer: 'Yes, by whoever administers the wallet. It is configuration, so a programme can widen or narrow what is permitted without waiting for a software release.',
      },
    ],
    keywords: ['restricted wallet', 'purpose-bound money', 'allowance control', 'aid distribution', 'expense wallet'],
    related: ['wallets-and-transfers', 'virtual-cards', 'savings'],
    cta: { label: 'Open an account', href: '/register' },
    article: `A parent sends a student money for fees and books. An employer advances money for travel. An NGO distributes money for seed before planting season.

In every case the money is given **for** something, and the moment it lands it is just money.

## The usual control, and why it fails

Collect receipts afterwards.

This is slow, it is humiliating for the recipient, it arrives far too late to change anything, and it is trivially defeated by anybody who wants to. It also poisons the relationship: the student is a suspect, the employee is audited, the farmer is inspected.

## Refuse at the posting

A restricted wallet carries what it may be spent on — which merchants, which categories.

A purchase outside that is **refused at the posting**. Not recorded and reviewed. Not flagged for somebody to chase next month. Refused, at the moment, before anything moves.

Nobody collects receipts because there is nothing to check. The control happened instead of the purchase.

## The holder knows

This is the part that decides whether the feature is dignified or insulting.

The holder of the wallet can see what it is for. So when a purchase is refused, the phone says *this wallet is for school expenses* — and the person understands immediately, rather than standing at a counter with a payment that failed for no visible reason.

A control the subject can see is a rule. One they cannot is a trap.

## It is honestly paternalistic

Worth saying plainly, because pretending otherwise would be dishonest.

Restricting how somebody may spend money is a constraint on them, and whoever creates the wallet should think about whether it is warranted.

The counter-argument is simply that restricted money frequently exists where unrestricted money does not. An employer who cannot hand over cash can often give an expense wallet. A donor with reporting obligations can fund a restricted programme and not an unrestricted one. For the recipient the real comparison is usually not *restricted money versus free money* — it is *restricted money versus nothing*.

## Still an ordinary wallet

A restricted wallet sits on the same ledger as every other, with the same statements and the same reconciliation. The restriction is a policy on the posting, not a separate system with its own books.

## What it costs

Nothing to create or hold. Payments from them carry the ordinary rate.`,
  },

  {
    key: 'savings',
    name: 'Goal savings',
    slug: 'goal-savings',
    category: 'move',
    module: 'savings',
    usp: 'Savings kept in a separate balance with a named goal, so the money is out of the way of daily spending — and described honestly as a set-aside balance rather than an interest-bearing account.',
    tagline: 'Money with a name on it.',
    headline: 'Saving works better when the money is out of reach',
    excerpt: 'The hardest part of saving is not earning more; it is not spending what you have already set aside. A separate balance with the goal written on it does most of that work.',
    audience: 'Anyone saving for something specific: school fees, stock, a deposit, a wedding, an emergency fund.',
    problem: 'Money saved inside a spending balance gets spent. Not through weakness — through the ordinary arithmetic of a difficult week, where the money is right there and the need is right now.',
    how: [
      'Create a goal with a name and, if you want, a target.',
      'Move money into it; it leaves your spendable balance.',
      'The goal shows what has been set aside and how close it is.',
      'Take it back whenever you need to — it is your money, held aside, not locked away.',
    ],
    proof: [
      'A goal balance is held apart from the spendable balance, so it does not appear as money available to spend.',
      'It is on the same ledger with the same statements — saving is a set-aside, not a separate product with separate books.',
      'The money is yours and withdrawable; nothing is locked and nothing is lent out.',
      'A goal is described as a set-aside balance, not as an interest-bearing or investment account, because it is not one.',
    ],
    cost: 'Free to create and hold. Moving money in and out of a goal is a movement within your own account.',
    faq: [
      {
        question: 'Does it pay interest?',
        answer:
          'No, and we will not imply otherwise. It is a set-aside balance: your own money, held apart from your spending balance so that it is harder to spend by accident. Anything describing a product like this as earning returns is describing something different.',
      },
      {
        question: 'Can I take it out early?',
        answer: 'Whenever you like. It is your money. The separation is psychological and practical, not a lock — and a savings product that traps people is not one we want to run.',
      },
      {
        question: 'Why does a separate balance help at all?',
        answer:
          'Because the hardest moment in saving is a difficult Tuesday when the money is visible in the same place you pay for lunch. Moving it somewhere with a name on it adds a deliberate step, and a deliberate step is usually enough.',
      },
    ],
    keywords: ['savings goal', 'set money aside', 'save for school fees', 'savings wallet', 'emergency fund'],
    related: ['wallets-and-transfers', 'restricted-wallets'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Almost nobody fails to save because they do not know they should. They fail on a Tuesday, when something is needed now and the money set aside is sitting in the same balance they pay for lunch from.

That is not weakness. It is arithmetic. The money is there, the need is real, and the saving was never defended by anything except intention.

## A name and a different place

A goal is a separate balance with a name on it: *school fees*, *new freezer*, *emergency*.

Money you move into it leaves your spendable balance. It does not show up when you are deciding what you can afford, because it is not, in the sense that matters, available.

That is almost the entire mechanism, and it works better than it has any right to. The step of deliberately taking money **back out** of the goal is enough friction to make most people stop and think — and stopping to think is the whole battle.

## Nothing is locked

You can take it back whenever you want. It is your money.

The separation is practical and psychological, not a lock. A savings product that traps people is a product that makes money from their emergencies, and that is not a business worth being in.

## It does not pay interest, and we will not imply it does

A goal is a **set-aside balance**: your own money, held apart from your spending balance.

It does not earn interest. It is not invested. It is not lent out while you are not looking.

Anybody describing a product like this with words like *returns*, *growth* or *yield* is describing something materially different, and the difference will eventually matter to somebody who did not read carefully.

## Same ledger, same statements

A goal is on the same ledger as everything else, with the same statements and the same reconciliation. It is a set-aside, not a separate product with separate books that have to be kept in step.

## How to actually use it

Two things work better than any feature:

**Move money the day it arrives**, not at the end of the week. What is still there on Friday was never really saved.

**Give it a specific name.** *School fees, January* defends itself on a difficult Tuesday in a way that *savings* does not.

## What it costs

Nothing to create or hold.`,
  },

  {
    key: 'bills-and-topup',
    name: 'Bills, airtime and vouchers',
    slug: 'bills-airtime-and-vouchers',
    category: 'move',
    module: 'billPay',
    alsoCovers: ['mobileTopup'],
    usp: 'Fulfilment that is confirmed by evidence from the biller or the operator before it is called done, with the money returned automatically when the confirmation never comes.',
    tagline: 'Paid means confirmed, not attempted.',
    headline: 'When a bill payment fails, where does the money go?',
    excerpt:
      'Buying airtime or paying a bill is the commonest digital transaction there is, and the commonest place money gets stuck. Confirming on evidence — and returning it automatically when evidence does not arrive — is the whole feature.',
    audience: 'Anyone paying a utility, buying airtime or data, or topping up somebody else’s phone.',
    problem:
      'The money leaves, the airtime does not arrive, and the customer is told to wait and then to contact the operator. The transaction sits in limbo because nothing in the system decides what to do about it.',
    how: [
      'Choose the biller or operator, the account or number and the amount.',
      'The screen shows the total including any charge, before you confirm.',
      'The payment completes when the biller or operator confirms fulfilment.',
      'If confirmation does not arrive within the window, the money is returned rather than left pending.',
    ],
    proof: [
      'Fulfilment is confirmed against evidence from the biller or the operator, not assumed from a successful request.',
      'A transaction without confirmation is reversed by an opposing posting rather than left pending indefinitely.',
      'The charge is shown before confirmation, so the total is known before the money moves.',
      'The reference appears on the statement and on the fulfilment record, so a disputed top-up can be traced rather than argued about.',
    ],
    cost: 'The amount plus any charge, both shown before you confirm. Where a biller sets its own fee, it is shown as its own line.',
    faq: [
      {
        question: 'I paid and the airtime never arrived.',
        answer:
          'If fulfilment was not confirmed within the window, the money is returned to your balance automatically and both the attempt and the return appear on your statement. If it shows as confirmed and the airtime is genuinely missing, the reference on the statement is what the operator needs to trace it.',
      },
      {
        question: 'Can I top up somebody else’s number?',
        answer: 'Yes. Enter their number instead of yours. The reference on your statement records which number was topped up, which settles most arguments about whether it was sent.',
      },
      {
        question: 'Why is there sometimes a delay?',
        answer:
          'Because the payment waits for the biller or operator to confirm, rather than being marked done on a hopeful request. The wait is the reason the money is not lost when something goes wrong.',
      },
    ],
    keywords: ['buy airtime', 'pay bills', 'mobile data top up', 'utility payment', 'failed airtime refund'],
    related: ['wallets-and-transfers', 'add-money', 'disputes'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Buying airtime is the commonest digital transaction in the region. It is also the commonest place that money quietly disappears for a week.

The pattern is familiar to everybody: the balance goes down, the airtime does not arrive, the app shows *pending*, and somebody suggests you contact the operator.

## Why it gets stuck

Most systems treat the request as the event. They send the instruction, it is accepted, and they mark the payment done.

But accepted is not fulfilled. If the operator never actually credits the number, there is now a transaction that the platform believes succeeded and the customer knows did not — and nothing in the system is responsible for resolving that disagreement.

So it sits. Pending forever is not a state anyone designed; it is what you get when nobody decided what should happen.

## Confirmed, or returned

Here, the payment completes when the biller or the operator **confirms fulfilment**.

And if confirmation does not arrive within the window, the money is **returned** — by an opposing posting, automatically, without anybody raising a ticket.

Both the attempt and the return appear on your statement. You can see what happened rather than having to ask what happened.

That is the entire feature. It is not clever. It is just the thing somebody has to decide in advance, and that most systems never do.

## The total before you confirm

The amount plus any charge is shown before the money moves. Where a biller sets its own fee, it is its own line rather than being folded into the total.

You should not learn the cost of a transaction from your statement afterwards.

## Topping up somebody else

Enter their number instead of yours. Your statement records which number was topped up.

That record settles the argument that follows roughly one top-up in fifty — *I sent it*, *I did not receive it* — with a fact instead of two memories.

## When it genuinely goes wrong

If a top-up shows as confirmed and the airtime is really missing, the reference on your statement is what the operator needs to trace it on their side.

You are not asking them to take your word for it. You are giving them the reference their own system issued.

## What it costs

The amount, plus any charge, both shown before you confirm.`,
  },

  {
    key: 'p2p-marketplace',
    name: 'P2P marketplace',
    slug: 'p2p-marketplace',
    category: 'move',
    module: 'p2p',
    usp: 'Trades between people where the money is held in escrow until both sides have done their part, and a dispute goes to a human with the evidence already attached.',
    tagline: 'Trade with a stranger, safely.',
    headline: 'Trading with someone you have never met',
    excerpt:
      'Every peer-to-peer trade has the same standoff: whoever moves first can be cheated. Escrow removes the standoff, and a dispute process with the evidence already attached removes most of what follows it.',
    audience: 'Anyone buying or selling between individuals: currency, goods, services, anything arranged between two people who do not know each other.',
    problem: 'One side has to go first. Whoever that is carries all the risk, and the usual resolution — argue in a chat, then give up — favours whoever is most willing to behave badly.',
    how: [
      'Agree the trade and open it; the buyer’s money moves into escrow.',
      'The seller can see the money is held, so they deliver.',
      'The buyer confirms, and escrow releases to the seller.',
      'If they disagree, it goes to a dispute where a person looks at the evidence attached to the trade.',
    ],
    proof: [
      'Escrowed money is held on the ledger, not held as a promise — both sides can see it is there.',
      'Release requires the buyer’s confirmation or a dispute decision; neither side can take it unilaterally.',
      'A dispute carries the trade’s own evidence and history, so a reviewer is not reconstructing it from screenshots.',
      'Counterparty history is visible, so a pattern of disputes is apparent before a trade rather than after.',
    ],
    cost: 'The fee for a completed trade is shown before you open it. A trade that is cancelled before delivery returns the escrowed money.',
    faq: [
      {
        question: 'What stops the buyer taking the goods and refusing to confirm?',
        answer:
          'A dispute. Escrow does not release on silence — it goes to a person who reviews the evidence attached to the trade. A buyer who refuses to confirm a delivered trade is making a case they have to win rather than simply walking away with it.',
      },
      {
        question: 'How is a dispute actually decided?',
        answer: 'By a person, on the evidence attached to the trade and the history of both parties. It is not an algorithm, and it is not whoever complains loudest.',
      },
      {
        question: 'Can I see who I am trading with?',
        answer: 'You can see their trading history, including disputes. A pattern is visible before you trade, which is considerably more useful than discovering it afterwards.',
      },
    ],
    keywords: ['p2p trading', 'escrow payment', 'peer to peer marketplace', 'safe trade with stranger', 'dispute resolution'],
    related: ['disputes', 'wallets-and-transfers', 'kyc-and-identity'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Every trade between two people who have never met contains the same standoff.

If the buyer pays first, the seller can keep the money. If the seller delivers first, the buyer can keep the goods. Somebody has to go first, and whoever it is carries all of the risk.

The usual resolution is an argument in a chat window followed by one party giving up, which systematically favours whoever is most comfortable behaving badly.

## Escrow removes the standoff

The buyer’s money moves into escrow when the trade opens. It is held on the ledger — genuinely held, not promised — and **both sides can see it is there**.

The seller is no longer being asked to trust the buyer. They can see the money. So they deliver.

The buyer confirms, and escrow releases.

Neither side can take it unilaterally, which is the property that makes the whole thing work.

## Silence is not a strategy

The obvious attack: the buyer takes delivery and simply never confirms.

Escrow does not release on silence. It goes to a **dispute**, where a person reviews it.

So a buyer in that position is not quietly walking away with goods and money. They are making a case, in front of somebody, that they have to win. That changes the arithmetic of trying it.

## Disputes with the evidence already there

A dispute carries the trade’s own history and the evidence attached to it. A reviewer is not reassembling events from screenshots sent by two people with opposite interests.

It is decided by a **person**, on that evidence and on the history of both parties. Not by an algorithm, and not by whoever complains most persistently.

## History is visible before you trade

You can see a counterparty’s trading history, including disputes.

A pattern is apparent **before** you trade. Most bad actors are not clever; they are repetitive, and repetition is visible when history is.

## When to use it

Any trade with somebody you do not know and have no way to pursue if it goes wrong — currency, goods, services, anything arranged between two individuals.

For a trade with your cousin, this is overhead. For one arranged in a group chat with a stranger, it is the difference between a trade and a hope.

## What it costs

The fee for a completed trade is shown before you open it. A trade cancelled before delivery returns the escrowed money.`,
  },

  {
    key: 'open-banking',
    name: 'Bank connections',
    slug: 'bank-connections',
    category: 'move',
    module: 'openBanking',
    usp: 'Linking a bank account to pay by bank and to verify income, with consent that is explicit, scoped and revocable from inside the app rather than buried on somebody else’s site.',
    tagline: 'Your bank data, on your terms.',
    headline: 'Connecting a bank account without signing away the keys',
    excerpt: 'Bank connections let you pay by bank and prove income without uploading statements. The question worth asking is what you consented to, for how long, and how you take it back.',
    audience: 'Anyone with a bank account who wants to fund from it, pay from it, or prove their income without printing anything.',
    problem: 'Bank connections are usually agreed once, in a hurry, on a screen nobody reads, with no clear way to see later what was shared or to stop it.',
    how: [
      'Link the account through your bank’s own authorisation.',
      'The consent names what is shared and for how long.',
      'Use it to pay by bank, or to verify income without uploading statements.',
      'Revoke it from inside the app whenever you choose.',
    ],
    proof: [
      'Consent is explicit, scoped and time-limited rather than open-ended.',
      'It can be revoked from inside the app, not only on the bank’s site.',
      'Income verification uses the connection rather than asking you to upload documents that then have to be stored somewhere.',
      'A mandate for recurring collection is a separate consent from reading the account, because they are different things.',
    ],
    cost: 'Linking is free. Where paying by bank carries a charge it is shown before you confirm.',
    faq: [
      {
        question: 'What exactly can you see?',
        answer:
          'What the consent says, for the period it covers, and nothing else. The consent names the scope before you agree to it, and you can read it again afterwards rather than having to remember.',
      },
      {
        question: 'How do I stop it?',
        answer: 'Revoke it in the app. It should not require finding a setting on your bank’s website — a consent that is hard to withdraw is not really a consent.',
      },
      {
        question: 'Is a mandate the same as letting you read my account?',
        answer:
          'No, and they are kept separate deliberately. Reading an account and being allowed to collect from it are different permissions, and agreeing to one should never quietly grant the other.',
      },
    ],
    keywords: ['open banking', 'pay by bank', 'link bank account', 'income verification', 'revoke bank consent'],
    related: ['add-money', 'credit-readiness', 'kyc-and-identity'],
    cta: { label: 'Open an account', href: '/register' },
    article: `A bank connection is genuinely useful. You can fund an account without typing a reference, pay directly from your bank, and prove your income without printing six months of statements and carrying them somewhere.

It is also the permission people give with the least attention, on a screen designed to be clicked through.

## Three questions worth asking

Of any service asking to connect to your bank:

1. **What exactly are you going to see?**
2. **For how long?**
3. **How do I stop it, and where is that button?**

A service that cannot answer all three plainly has told you something about how it intends to use the answer.

## Scoped and time-limited

The consent names what is shared and for how long, before you agree, and you can read it again afterwards rather than relying on memory of a screen you saw once.

Open-ended consent — everything, forever — is the industry’s default and it should not be.

## Revocable where you are

Revoke it **in the app**.

Not by finding a buried page on your bank’s website. Not by emailing support and waiting. A consent that is hard to withdraw is not a consent; it is a signature you cannot take back, and the difficulty is usually deliberate.

## Income without documents

Verifying income through the connection means you do not upload bank statements — which also means nobody has to store those statements, and nobody can later lose them.

The safest copy of a document is the one that was never made.

## Reading is not collecting

A **mandate** — permission to collect money from your account on a schedule — is a separate consent from reading the account.

They are kept separate deliberately. Agreeing to let a service see your balance should never quietly include letting it take money, and anywhere those two are bundled into one tick box, somebody has made a choice you would not have made.

## What it costs

Linking is free. Where paying by bank carries a charge, it is shown before you confirm.`,
  },

  {
    key: 'credit-readiness',
    name: 'Credit readiness',
    slug: 'credit-readiness',
    category: 'trust',
    module: 'creditScore',
    usp: 'A signal built from your own payment history that you choose to share with a lender — not a score held about you, sold about you, and used to refuse you without explanation.',
    tagline: 'Your history, shared on your terms.',
    headline: 'Being invisible to lenders is not the same as being a bad risk',
    excerpt:
      'Millions of people with perfectly good payment histories cannot borrow, because their history is not written anywhere a lender can read. A signal you own and choose to share changes who can be seen.',
    audience: 'Traders and small businesses who need working capital, and the lenders who cannot currently assess them.',
    problem:
      'A trader who has taken payments reliably for three years has a record of exactly that — and no way to show it to anybody. Lenders see no file and decline, not because the risk is bad but because it is unreadable.',
    how: [
      'Your payment history on the platform produces a readiness signal.',
      'You see it, and what moves it.',
      'You choose whether to share it with a specific lender.',
      'The lender receives the signal you consented to share, not a file they hold about you.',
    ],
    proof: [
      'The signal is informational and is described as such; it is not a credit bureau score and does not pretend to be.',
      'It is shared only on your consent, with the party you choose, rather than sold on.',
      'It is built from your own activity on the platform, which you can see in your own statements.',
      'A lender’s access is scoped: reading a shared readiness signal is a specific permission, not general access to an account.',
    ],
    cost: 'Free to see and free to share. BitriPay does not sell it, and a lender’s own charges are a matter between you and them.',
    faq: [
      {
        question: 'Is this a credit score?',
        answer:
          'No, and the distinction matters. A credit bureau score is held about you by somebody else and sold to people who ask. This is a signal from your own activity, that you see, and that you choose to share with a specific lender.',
      },
      {
        question: 'Can it be used against me?',
        answer: 'Only if you share it. If you never do, no lender receives it. That is the difference between a signal you control and a file that exists whether you like it or not.',
      },
      {
        question: 'Will it get me a loan?',
        answer:
          'It is informational, not a decision. Lending is the lender’s decision on their own criteria. What this changes is whether you have anything to show at all — which for many people is the actual barrier.',
      },
    ],
    keywords: ['credit readiness', 'alternative credit data', 'thin file borrower', 'working capital small business', 'share payment history'],
    related: ['open-banking', 'kyc-and-identity', 'settlement-and-statements'],
    cta: { label: 'Open an account', href: '/register' },
    article: `A trader has taken payments six days a week for three years. Their takings are steady, their season is predictable, their customers come back.

They apply for working capital and are declined in under a minute, because the lender has no file on them.

The decline is not a judgement about the risk. It is a statement that the risk could not be read.

## Invisible is not the same as bad

This is the distinction the whole thing turns on, and it gets lost constantly.

A thin file means **no information**. Lenders, reasonably, treat no information as risk — and so millions of people with genuinely good histories are indistinguishable from people with genuinely bad ones.

The history exists. It is simply not written anywhere a lender can read.

## A signal from your own activity

Your payment history on the platform produces a readiness signal. You can see it, and you can see what moves it.

That second part matters more than it sounds. A number you cannot influence and cannot interrogate is not information you can act on — it is a verdict.

## You decide who sees it

This is where it differs from a credit bureau, and the difference is the point.

A bureau score is held **about** you by somebody else, and sold to whoever asks. You may not see it. You generally cannot correct it. You certainly did not agree to each disclosure.

This signal is shared **only when you share it**, with the lender you choose. If you never share it, no lender receives it.

Your data is not a product being sold over your head.

## It is not a decision

It is informational, and described as such.

Lending remains the lender’s decision on their own criteria, and anyone promising that a score guarantees credit is misleading you.

What changes is whether you have **anything to show at all**. For a trader who has been declined for three years because there was no file, that is not a marginal improvement. It is the whole barrier.

## What it costs

Free to see and free to share. BitriPay does not sell it. What a lender charges is between you and them.`,
  },

  {
    key: 'gift-cards',
    name: 'Gift cards and vouchers',
    slug: 'gift-cards-and-vouchers',
    category: 'move',
    module: 'giftCards',
    usp: 'A voucher that is a claim on the issuer recorded on the ledger, redeemable once and traceable — not a code in a message that may already have been spent by somebody else.',
    tagline: 'A code that can only be spent once.',
    headline: 'The problem with sending somebody a code',
    excerpt:
      'A voucher code in a message can be forwarded, screenshotted and redeemed by whoever gets there first. A voucher recorded on the ledger can be redeemed once, by one person, and you can see when it was.',
    audience: 'Anyone giving money for an occasion, employers giving staff a bonus, businesses running promotions, and NGOs distributing value.',
    problem: 'A voucher code is bearer value in plain text. Forwarded to a group, photographed over a shoulder or intercepted, it is gone — and nobody can prove who used it.',
    how: [
      'Issue a voucher for an amount, with an expiry if you want one.',
      'It is recorded as a claim on the issuer, not just a string.',
      'The holder redeems it into their balance; redemption happens once.',
      'A second attempt is refused, and the record shows when and by whom it was redeemed.',
    ],
    proof: [
      'A voucher is recorded on the ledger as a claim, so issuing it and redeeming it are postings rather than a database flag.',
      'Redemption is single-use: a second attempt is refused rather than silently ignored.',
      'The redemption record shows when it was redeemed and into which account.',
      'Promotional value is tracked separately from customer e-money, because a marketing liability is not a redeemable claim and must not be counted as one.',
    ],
    cost: 'Issuing is priced in the dashboard before you create vouchers. Redeeming into a balance is free to the holder.',
    faq: [
      {
        question: 'Somebody else used my code.',
        answer:
          'A voucher is bearer value, so whoever redeems it first gets it — which is exactly why it should be sent to one person rather than posted in a group. The record shows when it was redeemed and into which account, so it can at least be traced.',
      },
      {
        question: 'Can a voucher be redeemed twice?',
        answer: 'No. Redemption is single-use, and a second attempt is refused rather than quietly ignored. The failure is visible to whoever tried.',
      },
      {
        question: 'Why is promotional value tracked separately?',
        answer:
          'Because credit you were given as a promotion is a marketing liability of the platform, and money you put in is a redeemable claim. Counting them together would overstate what customers are owed and understate what has to be backed.',
      },
    ],
    keywords: ['gift card', 'voucher code', 'digital voucher', 'single use code', 'promotional credit'],
    related: ['wallets-and-transfers', 'emoney-and-safeguarding', 'referrals'],
    cta: { label: 'Open an account', href: '/register' },
    article: `A voucher code is bearer value written in plain text. Whoever has the string has the money.

That is fine when it travels from one person to one person. It is not fine in a group chat, in a photograph taken over a shoulder, or in a message forwarded once too often.

## What goes wrong with a plain code

The usual story: a code is posted somewhere slightly too public. Somebody who was not the intended recipient redeems it. The intended recipient finds an expired code and a conversation nobody can resolve, because there is no record of who used it.

The code did its job perfectly. The job was simply never a safe one.

## A claim on the ledger

Here, a voucher is recorded as a **claim on the issuer** — a posting, not a flag in a table.

Issuing it is a posting. Redeeming it is a posting. Both exist in the books, which means both can be examined later.

## Redeemed once, visibly

Redemption is single-use. A second attempt is **refused**, not silently ignored, so the person attempting it sees that it has already gone rather than wondering whether the app is working.

And the record shows when it was redeemed and into which account.

That does not undo a code posted in the wrong place — bearer value is bearer value — but it turns *somebody took it and we will never know* into a traceable fact.

## Send it to a person

The practical advice is dull and worth repeating: send a voucher to one person, in a message to that person.

Not a group. Not a photograph. Not a caption. The security of a bearer instrument is entirely a matter of who can see it.

## Promotional value is not your money

Worth explaining, because it is the kind of accounting distinction that matters enormously and is invisible from outside.

Credit the platform **gives** you as a promotion is a marketing liability of the platform. Money you **put in** is a redeemable claim backed by safeguarded funds.

They are tracked separately. Counting them together would overstate what customers are owed and understate what has to be backed — and a platform that blurs them is a platform whose backing figure cannot be trusted.

## What it costs

Issuing is priced in the dashboard before you create vouchers. Redeeming into a balance is free to the holder.`,
  },

  {
    key: 'referrals',
    name: 'Referrals and growth',
    slug: 'referrals',
    category: 'operate',
    module: 'referrals',
    usp: 'Rewards that pay on a real outcome, not a signup, with the attribution and the reward both visible to the person who earned them.',
    tagline: 'Paid for customers, not for clicks.',
    headline: 'Referral programmes fail when they pay for the wrong thing',
    excerpt:
      'Pay for signups and you get signups: empty accounts, invented people, and a budget spent on nothing. Paying on a real outcome, with attribution anybody can audit, is the whole difference.',
    audience: 'Merchants growing by word of mouth, agents building a customer base, influencers and partners with an audience.',
    problem:
      'A referral programme that pays on registration is an invitation to create registrations. The budget goes to whoever automates fastest, and the genuine referrer who brought three real customers gets the same as a script.',
    how: [
      'Share your referral link or code.',
      'A person who joins through it is attributed to you.',
      'The reward pays when the condition is met — an outcome, not an arrival.',
      'You can see who was attributed and what was earned.',
    ],
    proof: [
      'Attribution and rewards are visible to the referrer, so earnings can be checked rather than taken on trust.',
      'Rewards are configured per programme and paid against the recorded outcome, not against a signup event.',
      'Referred accounts go through the same identity checks as any other, so a referral cannot bypass verification.',
      'Partner attribution is recorded for campaigns, so a channel’s real contribution is measurable rather than claimed.',
    ],
    cost: 'Rewards are paid by the programme that sets them. Referring costs nothing.',
    faq: [
      {
        question: 'When do I actually get paid?',
        answer: 'When the condition the programme sets is met — a real outcome rather than an arrival. The condition is visible before you refer anybody, so you are not guessing what counts.',
      },
      {
        question: 'Can I see whether somebody used my link?',
        answer: 'Yes. Attribution and earnings are visible to you, which is the only way a referral programme is checkable rather than something you hope is working.',
      },
      {
        question: 'Do referred accounts skip verification?',
        answer: 'No. A referred account goes through exactly the same identity checks as any other. A referral is a route in, not a shortcut past the controls.',
      },
    ],
    keywords: ['referral programme', 'refer a friend', 'affiliate attribution', 'growth rewards', 'partner attribution'],
    related: ['gift-cards', 'kyc-and-identity', 'agents-and-cash'],
    cta: { label: 'Open an account', href: '/register' },
    article: `Most referral programmes pay for a signup. Most referral budgets are therefore spent on signups, and signups are the cheapest thing in the world to manufacture.

## What paying for arrivals buys you

Empty accounts. Invented people. Real people persuaded to register who never return.

The money goes disproportionately to whoever automates fastest, and the person who genuinely told three neighbours about something useful gets the same reward as a script — which is to say, they stop bothering.

The programme has not failed because referrals do not work. It has failed because it was paying for the wrong event.

## Pay on an outcome

A reward here pays when the condition the programme sets is **met** — something real happening, not somebody arriving.

The condition is visible before you refer anybody, so you are not guessing what counts and then feeling cheated.

This is slower to pay. It is also the only version where the budget reaches the people actually growing the business.

## Attribution you can check

You can see who was attributed to you and what was earned.

That sounds minor and is not. A referral programme whose workings are invisible to the referrer is one they have to take on trust, and people stop extending trust to systems that pay them unpredictable amounts for reasons they cannot inspect.

If somebody used your link and you cannot see it, you will assume the system lost it — and you will be right often enough to stop referring.

## Referrals do not skip the door

A referred account goes through exactly the same identity checks as any other.

This occasionally annoys referrers, who feel their recommendation should count for something. It should, and it does — but not as a shortcut past verification, because a referral route that bypassed controls would immediately become the preferred route for everybody with a reason to avoid them.

## For partners and campaigns

Partner attribution is recorded for campaigns, so a channel’s real contribution is measurable rather than claimed in a quarterly review by whoever presents most confidently.

## What it costs

Nothing to refer. Rewards are paid by the programme that sets them.`,
  },

  {
    key: 'support',
    name: 'Support and help',
    slug: 'support',
    category: 'operate',
    module: 'support',
    alsoCovers: ['liveChat'],
    usp: 'Support that can see the same ledger and the same events you can, so an answer is read off the record rather than guessed — and cannot change your balance to make a problem go away.',
    tagline: 'Answers from the record, not from guesswork.',
    headline: 'Why support should not be able to fix your balance',
    excerpt:
      'The fastest way to resolve a complaint is to let an agent adjust the number. It is also how platforms lose the ability to trust their own books. Support that can read everything and change nothing is the harder, better answer.',
    audience: 'Every customer who has had a payment go wrong, and every operator who has to answer for what their support team did.',
    problem:
      'Support teams under pressure are given tools to make problems go away. An agent who can adjust a balance can be socially engineered, can make mistakes, and leaves a platform unable to prove what actually happened.',
    how: [
      'Open a ticket, or chat where that is available.',
      'The agent can see the payment, its attempts, its events and its state.',
      'The answer is read from the record rather than estimated.',
      'Where money genuinely needs to move, it is a posting under the ordinary controls — not an edit.',
    ],
    proof: [
      'Agents read the ledger and the hash-chained event log; they cannot set a balance, because balances are derived from postings rather than stored.',
      'A correction is a posting under the ordinary authority and maker-checker rules, so a fix is as auditable as the original.',
      'Every payment carries its attempts and its state changes, so an agent can say what happened rather than what probably happened.',
      'Administrative actions are written to the audit trail under the agent’s own name.',
    ],
    cost: 'Support is included. There is no paid priority queue that moves a customer with a broken payment behind one who paid more.',
    faq: [
      {
        question: 'Why can support not just put the money back?',
        answer:
          'Because an agent who can set a balance can be talked into setting it by somebody who is not you, and because a platform whose balances can be edited cannot prove what it owes anybody. A genuine correction is a posting, under the same controls as any other movement.',
      },
      {
        question: 'Will they actually know what happened to my payment?',
        answer:
          'They can see the payment, every attempt, every state change and the events around it. The answer comes from the record. Where the record genuinely does not say, they will tell you that rather than invent a reason.',
      },
      {
        question: 'Is there a faster queue if I pay?',
        answer: 'No. A broken payment is more urgent than a large account, and a priority queue that reorders those two is selling the wrong thing.',
      },
    ],
    keywords: ['payment support', 'dispute a payment', 'customer service fintech', 'audit trail support', 'cannot edit balance'],
    related: ['ledger', 'disputes', 'risk-and-compliance'],
    cta: { label: 'Contact support', href: '/contact' },
    article: `Every support team eventually gets asked the same question by its own management: why can you not just fix it?

A customer is upset. The amount is small. The agent can see the problem. Giving them a button that adjusts the balance would end the call in thirty seconds.

It is the single most tempting tool to build, and it should not exist.

## What that button costs

**It can be aimed at you.** An agent who can move balances is a target. Social engineering does not attack systems; it attacks people with permissions, under pressure, who want to be helpful.

**It hides the real problem.** If a bug underpays customers and agents quietly top them up, the bug is never found. It is being paid for, invisibly, out of goodwill.

**It destroys the books.** A platform whose balances can be edited cannot prove what it owes. Not to a regulator, not to an auditor, and ultimately not to itself.

## Read everything, change nothing

Support here can see the ledger, the payment, every attempt against it, every state change, and the hash-chained event log around it.

They cannot set a balance — and not because of a permission flag that could be changed on a bad day. They cannot because **balances are not stored**. A balance is the sum of its postings. There is no number to set.

## So what happens when you are genuinely owed money

A posting. Under the ordinary authority and maker-checker rules, with a reason recorded and — for anything material — a second person approving.

It is slower than a button. It is also auditable, reversible and attributable, which the button never was.

## The answer comes from the record

When you ask where your payment went, the agent is reading what happened: the attempts, the rail, the state changes, the timestamps.

Not an estimate. Not *it is probably still processing*. And where the record genuinely does not say, you should be told that — an honest *we do not know yet, here is what we are doing* is worth more than a confident guess that turns out wrong.

## Every action has a name on it

Administrative actions are written to the audit trail under the agent’s own name.

That protects you, and it protects them: an agent who did the right thing has a record proving it.

## What it costs

Nothing, and there is no paid priority queue. A broken payment is more urgent than a large account, and any system that reorders those two is optimising for the wrong customer.`,
  },

  {
    key: 'bulk-payouts',
    name: 'Bulk payouts',
    slug: 'bulk-payouts',
    category: 'operate',
    module: null,
    usp: 'A payout file that is validated before anybody approves it, approved as a batch, and reports per row — so one bad line does not fail the payroll and does not get paid twice on the retry.',
    tagline: 'Pay a hundred people without a bad evening.',
    headline: 'Paying many people at once, without paying anybody twice',
    excerpt: 'Bulk payouts fail in two directions: the whole file stops because of one bad row, or the retry pays the good rows again. Validating first and reporting per row removes both.',
    audience: 'Employers running payroll, NGOs distributing stipends, cooperatives paying members, platforms paying sellers.',
    problem:
      'A file of two hundred payments either fails entirely on one malformed line, or part-succeeds and leaves somebody guessing which half to re-run — and re-running the wrong half pays people twice.',
    how: [
      'Upload the file; it is validated and the errors are reported before anything is approved.',
      'Fix the rows that are wrong and re-upload, or proceed without them.',
      'Approve the batch; approval is a deliberate act, separate from uploading.',
      'The batch executes and reports per row: paid, failed, with the reason.',
    ],
    proof: [
      'The file is validated before approval, so errors are found while nothing has moved.',
      'Outcomes are per row, so a failure is attributable to a line rather than to the file.',
      'Approving is separate from uploading, so nobody pays two hundred people by pressing the wrong button once.',
      'A batch has a bounded number of rows and a documented column layout, so a file either conforms or is rejected with a reason.',
      'Batch events are published, so a payroll system can react to the outcome rather than polling somebody’s inbox.',
    ],
    cost: 'Payouts are priced individually at the ordinary rate for the rail; there is no separate charge for sending them as a batch.',
    faq: [
      {
        question: 'One row failed. Do I re-run the file?',
        answer: 'No — and this is the mistake that causes double payments. Outcomes are reported per row, so you re-run only the rows that failed. The file is not an all-or-nothing object.',
      },
      {
        question: 'Who can approve a batch?',
        answer: 'Approving is a separate action from uploading, so the person preparing payroll is not necessarily the person releasing it. For most organisations that separation is the point.',
      },
      {
        question: 'What happens if my file is wrong?',
        answer: 'You are told which rows and why, before anything is approved and before any money moves. Fix them and re-upload, or proceed without them.',
      },
    ],
    keywords: ['bulk payouts', 'payroll payments', 'mass payout file', 'csv payout', 'stipend distribution'],
    related: ['withdrawals', 'team-and-roles', 'webhooks'],
    cta: { label: 'Open a merchant account', href: '/register?role=merchant' },
    article: `Paying two hundred people at once has two classic failure modes, and most systems manage to have both.

## Failure one: all or nothing

Row 147 has a malformed phone number. The file is rejected.

Nobody is paid. It is the 28th. The finance officer now has an evening ahead of them, and two hundred people have a worse one.

## Failure two: the retry

The file part-succeeds. A hundred and eighty people are paid, twenty are not, and the report says *completed with errors*.

Somebody now has to work out which twenty. If they get it wrong and re-run the whole file, a hundred and eighty people are paid **twice** — and recovering an overpayment from someone who has already spent it is not a technical problem, it is a series of difficult conversations.

## Validate before anybody approves

The file is checked when it is uploaded, before approval and before anything moves.

Errors are reported with the row and the reason. Fix them and re-upload, or proceed without them. This is a two-minute correction at a desk rather than an incident at eight in the evening.

## Approval is a separate act

Uploading and approving are different actions, so nobody pays two hundred people by clicking the wrong thing once.

For most organisations this is also the control they actually want: the person who prepares payroll is not the person who releases it.

## Outcomes per row

Every row reports its own result: paid, or failed with a reason.

So re-running means re-running **the rows that failed** — not the file. The double-payment failure mode simply does not arise, because there is no reason for anybody to resend a batch wholesale.

## Events, not inboxes

Batch outcomes are published as events, so a payroll system can react to them.

Nobody should be refreshing a page to find out whether their staff were paid.

## What it costs

Payouts are priced individually at the ordinary rate for the rail. There is no surcharge for sending them together.`,
  },

  {
    key: 'subscriptions',
    name: 'Subscriptions and recurring billing',
    slug: 'subscriptions',
    category: 'operate',
    module: null,
    usp: 'Recurring collection on a mandate the customer confirmed, with dunning that retries on a published schedule and a cancellation that actually stops the money.',
    tagline: 'Recurring revenue, without trapping anybody.',
    headline: 'Recurring billing people do not have to fight to escape',
    excerpt:
      'Subscriptions fail twice: a payment that bounces loses a customer who wanted to stay, and a cancellation that does not work loses one for ever. Dunning fixes the first; honest cancellation prevents the second.',
    audience: 'Anyone billing the same customers repeatedly: software, schools, gyms, insurance, service contracts, membership organisations.',
    problem: 'A failed renewal usually ends a subscription that the customer intended to keep, and a cancellation that is hard to complete turns a lapsed customer into an angry one who tells people.',
    how: [
      'The customer confirms a mandate; that confirmation is what the collection rests on.',
      'Invoices are raised on the plan’s schedule and collected from the wallet.',
      'A failed collection enters dunning and is retried on a published schedule.',
      'Cancellation stops the next collection — from the customer’s side, not only yours.',
    ],
    proof: [
      'Collection rests on a mandate the customer confirmed, not on a card number kept on file.',
      'A failed collection is retried on a published dunning schedule rather than being abandoned on the first failure.',
      'Subscription lifecycle events — created, cancelled, invoice paid, payment failed — are published, so your system knows without polling.',
      'Usage can be recorded against a subscription where a plan is metered rather than flat.',
    ],
    cost: 'Subscriptions carry the ordinary rate on the payments they collect. There is no separate charge for the schedule.',
    faq: [
      {
        question: 'What happens when a payment fails?',
        answer:
          'It enters dunning and is retried on a published schedule. Most failed renewals are a temporary balance problem rather than a decision to leave, and abandoning on the first failure loses customers who wanted to stay.',
      },
      {
        question: 'How does a customer cancel?',
        answer:
          'From their own side, and it stops the next collection. Cancellation that requires contacting support, or a phone call during office hours, is a dark pattern — it buys one more month and costs the relationship.',
      },
      {
        question: 'Can I bill for usage rather than a flat amount?',
        answer: 'Yes. Usage can be recorded against a subscription, so a metered plan invoices for what was actually used.',
      },
    ],
    keywords: ['subscription billing', 'recurring payments', 'dunning retries', 'mandate', 'metered billing'],
    related: ['payment-links', 'webhooks', 'developer-api'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `Recurring revenue is the most attractive shape a business can have, which is why so many companies pursue it to the point of making their customers resent them.

There are two failures worth designing against, and they pull in opposite directions.

## The first failure: giving up too early

A renewal fails. The balance was short that morning. The subscription is cancelled, access stops, and a customer who fully intended to keep paying is gone.

Most failed renewals are not decisions. They are a Tuesday.

**Dunning** is the fix: a failed collection is retried on a published schedule rather than abandoned on the first attempt. Spread across days, most of those payments simply succeed, and the customer never knows there was a problem.

It is unglamorous and it is the single highest-return thing in recurring billing.

## The second failure: not letting go

The opposite temptation, and far more damaging: making cancellation difficult.

Hide the button. Require a phone call. Only during office hours. Offer three retention screens before the real one.

This works, in the sense that it buys one more month. It also produces a customer who tells everybody, and who will never come back — and increasingly, a regulator who takes an interest.

**Cancellation here stops the next collection, from the customer’s own side.** No call, no retention maze, no support ticket.

A business that only retains customers who cannot find the exit does not have recurring revenue. It has a countdown.

## A mandate, not a stored card

Collection rests on a **mandate the customer confirmed** — an explicit agreement to be charged on a schedule.

That is a different thing from keeping a card number on file and hoping it still works. The customer agreed to the arrangement, can see it, and can end it.

## Events, so your system knows

Created, cancelled, invoice paid, payment failed — all published as events.

Your product can suspend access when dunning finally fails, and restore it the moment a retry succeeds, without anybody polling anything.

## Metered plans

Usage can be recorded against a subscription, so a plan that charges for what was used invoices for what was used.

## What it costs

The ordinary rate on the payments collected. There is no charge for the schedule itself.`,
  },

  {
    key: 'plugins-and-sdks',
    name: 'SDKs and plugins',
    slug: 'sdks-and-plugins',
    category: 'build',
    module: null,
    usp: 'SDKs in three languages and a shop plugin generated against the same operation table as the API, so an SDK cannot describe a call the platform does not have.',
    tagline: 'Start from working code, not from a specification.',
    headline: 'The fastest integration is one you do not have to write',
    excerpt:
      'Most of an integration is the same every time: authentication, idempotency, signature verification, retries. SDKs and a shop plugin do that part, and they are built from the same table that serves the requests.',
    audience: 'Developers who would rather ship this week, and shop owners who want a checkout without hiring one.',
    problem:
      'Every integration re-implements the same plumbing, and each re-implementation is a fresh opportunity to get webhook verification subtly wrong in a way that nobody notices until it matters.',
    how: [
      'Install the SDK for your language, or the plugin for your shop.',
      'Authentication, idempotency and signature verification are handled for you.',
      'Create an intent and handle the webhook with typed objects rather than raw JSON.',
      'Test against the sandbox with the documented magic numbers before going near a real payment.',
    ],
    proof: [
      'SDKs are generated against the same operation table that serves the requests, so they cannot describe a call the platform does not have.',
      'Webhook signature verification is implemented in the SDK, which is where most hand-rolled integrations get it wrong.',
      'The shop plugin ships in the repository rather than being distributed separately, so its version matches the API it was built against.',
      'The Node SDK has no dependencies, so adding payments does not add a supply chain.',
    ],
    cost: 'Free. Open code in the repository, and no licence to use them.',
    faq: [
      {
        question: 'Do I have to use an SDK?',
        answer: 'No. The API is plain HTTP with JSON and is documented completely. The SDKs exist to save you from writing signature verification again, not to hide anything.',
      },
      {
        question: 'Which languages?',
        answer: 'Node, PHP and Python, plus a WooCommerce plugin for shops. The Node SDK deliberately has no dependencies.',
      },
      {
        question: 'Will the SDK fall behind the API?',
        answer:
          'It is generated against the same operation table the API is served from, so it cannot describe a call that does not exist. Where a brand-new capability has not reached an SDK yet, the raw call always works.',
      },
    ],
    keywords: ['payment sdk', 'woocommerce payment plugin', 'node payment library', 'php payment sdk', 'python payments'],
    related: ['developer-api', 'webhooks', 'hosted-checkout'],
    cta: { label: 'Read the API reference', href: '/developers/api' },
    article: `Look at any two payment integrations and most of the code is identical.

Authentication. Idempotency keys. Signature verification. Retries with backoff. Mapping errors onto something your application understands.

None of that is your product. All of it has to be right.

## The part that is always wrong

Webhook signature verification is where hand-written integrations fail, and they fail quietly.

Common mistakes, all seen in the wild: comparing signatures with a normal string comparison instead of a constant-time one; verifying against the parsed body rather than the raw bytes; forgetting to check the timestamp, which leaves replay wide open; checking the timestamp but never actually rejecting on it.

Each of these produces an integration that works perfectly in testing and is wrong in a way that only matters on the day somebody is attacking you.

The SDK does it correctly, once.

## Generated from the same table

The SDKs are generated against the same operation table that serves the requests and produces the documentation.

So an SDK **cannot** describe a call the platform does not have. It is not a hand-maintained wrapper drifting slowly out of date behind the API — it is another rendering of the same thing.

Where something brand new has not reached an SDK yet, the raw call always works. The SDK is a convenience, never a gate.

## No dependencies

The Node SDK has none.

Adding payments to your project should not add a supply chain, a monthly round of advisories, and an upgrade you have to schedule. The fewer things you install to take money, the fewer things can go wrong in a way you did not choose.

## For shops

The WooCommerce plugin ships in the repository rather than being published separately, so its version matches the API it was built against.

A shop owner installs it, enters a key, and takes payments. No developer required for the common case.

## Test the failures first

Every SDK works against the sandbox, and the sandbox publishes magic numbers for specific outcomes — including a timeout that later succeeds.

Write your handler against that one first. It is the case that will find the bug in your retry logic, and it is much cheaper to find on a Tuesday afternoon than during your first busy weekend.

## What it costs

Nothing. Open code in the repository, no licence.`,
  },
];

export type FeatureLang = 'en' | 'fr';

/** The English text of a feature, in the shape a translation supplies. */
export const englishText = (f: Feature): FeatureText => ({
  name: f.name,
  tagline: f.tagline,
  headline: f.headline,
  excerpt: f.excerpt,
  usp: f.usp,
  audience: f.audience,
  problem: f.problem,
  how: f.how,
  proof: f.proof,
  cost: f.cost,
  faq: f.faq,
  article: f.article,
  articleSlug: `${f.slug}-explained`,
});

/**
 * The text of a feature in one language. French falls back to English per field rather than per feature, so a
 * half-translated entry degrades to a readable page instead of an empty one — and a test fails on any field that
 * falls back, so the fallback is a safety net rather than a plan.
 */
export function featureText(f: Feature, lang: FeatureLang): FeatureText {
  const en = englishText(f);
  if (lang !== 'fr') return en;
  const fr = FEATURES_FR[f.key];
  return fr ? { ...en, ...fr } : en;
}

/** Which fields of a feature have no translation in this language. Empty is the only acceptable answer. */
export function missingTranslations(f: Feature, lang: FeatureLang): string[] {
  if (lang !== 'fr') return [];
  const fr = FEATURES_FR[f.key];
  if (!fr) return ['(the whole feature)'];
  const keys: (keyof FeatureText)[] = ['name', 'tagline', 'headline', 'excerpt', 'usp', 'audience', 'problem', 'how', 'proof', 'cost', 'faq', 'article', 'articleSlug'];
  return keys.filter((k) => {
    const v = fr[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
  });
}

export const FEATURE_BY_KEY: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.key, f]));
export const FEATURE_BY_SLUG: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.slug, f]));

export const featuresInCategory = (category: FeatureCategory): Feature[] => FEATURES.filter((f) => f.category === category);
