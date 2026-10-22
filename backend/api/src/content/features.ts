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
];

export const FEATURE_BY_KEY: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.key, f]));
export const FEATURE_BY_SLUG: Record<string, Feature> = Object.fromEntries(FEATURES.map((f) => [f.slug, f]));

export const featuresInCategory = (category: FeatureCategory): Feature[] => FEATURES.filter((f) => f.category === category);
