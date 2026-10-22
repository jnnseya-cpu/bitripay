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

export type FeatureCategory = 'accept' | 'build' | 'move' | 'operate' | 'trust';

export const FEATURE_CATEGORIES: Record<FeatureCategory, { label: string; blurb: string }> = {
  accept: { label: 'Take the money', blurb: 'Every way a customer can hand money to a business, from a printed code on a wall to a hosted checkout.' },
  build: { label: 'Build on BitriPay', blurb: 'The API, the webhooks, the SDKs and the plugins that put payments inside somebody else’s product.' },
  move: { label: 'Move the money', blurb: 'What happens to money once it has arrived: wallets, transfers, payouts, cash and the journey across a border.' },
  operate: { label: 'Run the business', blurb: 'The books, the settlement, the statements, the disputes and the people who look after them.' },
  trust: { label: 'Prove it', blurb: 'Identity, risk, the ledger’s own invariants and the evidence a regulator asks to see.' },
};

export interface FeatureFaq {
  question: string;
  answer: string;
}

export interface Feature {
  key: string;
  name: string;
  slug: string;
  category: FeatureCategory;
  /** The flag that switches this on; null for the platform's own machinery, which is always present. */
  module: keyof ModuleFlags | null;
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
];

export const FEATURE_BY_KEY: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.key, f]));
export const FEATURE_BY_SLUG: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.slug, f]));

export const featuresInCategory = (category: FeatureCategory): Feature[] => FEATURES.filter((f) => f.category === category);
