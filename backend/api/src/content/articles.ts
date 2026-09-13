/** Launch articles: written for the people BitriPay serves, with real structure, FAQs and public references. */
import type { PostInput } from '../services/blog';

export const DEFAULT_ARTICLES: PostInput[] = [
  {
    title: 'How to get paid by QR code when you sell at the market',
    slug: 'get-paid-by-qr-code-at-the-market',
    excerpt: 'A market stall does not need a card machine. One printed QR code, a phone that rings when money arrives, and an agent nearby for cash. Here is how to set it up in an afternoon.',
    category: 'guides',
    tags: ['qr payments', 'market traders', 'getting started'],
    keywords: ['qr code payment for market stall', 'accept mobile payments without a card machine', 'how to get paid by qr code', 'market trader mobile money'],
    metaTitle: 'Get paid by QR code at the market (no card machine)',
    metaDescription: 'Set up a printed QR code for your market stall, hear a loud alert when money arrives and turn balance into cash at an agent. Step-by-step, no card machine needed.',
    faq: [
      {
        question: 'Does the customer need the BitriPay app to pay my QR code?',
        answer:
          'A BitriPay user pays in one scan. Someone without the app can open the same code in their phone camera and pay by card, mobile money or bank transfer through the checkout page, and you still receive it as balance.',
      },
      {
        question: 'What if I cannot read well?',
        answer:
          'The stall QR code never changes, so you print it once. When a payment arrives the phone rings loudly and vibrates, and the screen shows the amount in large numbers with a green tick. You do not have to read anything else.',
      },
      {
        question: 'How do I turn the balance into cash?',
        answer:
          'Go to Agents & cash, choose a nearby agent and the amount, approve with your fingerprint, and hand the code to the agent. The agent gives you the cash once the app shows the payout as settled.',
      },
      {
        question: 'What does it cost?',
        answer:
          'Receiving into your wallet is free for you as a customer. Merchant accounts pay a small percentage shown in the dashboard, and agents charge the commission the app shows before you confirm.',
      },
    ],
    sources: [
      { title: 'GSMA – State of the Industry Report on Mobile Money', url: 'https://www.gsma.com/sotir/' },
      { title: 'World Bank – The Global Findex Database', url: 'https://www.worldbank.org/en/publication/globalfindex' },
    ],
    bodyMd: `Mama Nzuzi sells grilled fish and chikwangue near the Marché de la Liberté. Her customers increasingly want to pay from their phone, but she does not want a card machine she has to charge, cannot fix and cannot read. What she needs is one code on the wall and a sound she can trust. This is how to do that.

## What you need

- A phone that can run BitriPay (Android or iPhone) or the web app in a browser.
- A BitriPay account. A **personal** account is enough to start; switch to a **merchant** account later if you want a sales dashboard, staff logins or a point-of-sale screen.
- A printed copy of your **receive QR code** from the Receive page. Laminate it or put it in a plastic sleeve; it never changes.

## Step 1: print your QR code

Open BitriPay, tap **Receive** and then **Enlarge**. Print it, or ask an agent to print it for you. The same code also works as a link (\`bitripay.app/u/yourtag\`), so a customer with no camera can type it.

If you want the customer to see the amount before paying, use **Point of sale** on a merchant account: you type the amount, the phone shows a one-time code, the customer scans and the amount is already filled in.

## Step 2: know the sound

When a payment arrives the app plays a loud alarm and vibrates for several seconds, even in a noisy market. The screen shows the amount in large numbers with a green tick and the payer's name. If you did not hear the sound, the money did not arrive; do not hand over the goods on the strength of a screenshot from the customer's phone.

You can test the sound under Settings → Preferences → **Test alert**.

## Step 3: let people pay without the app

A customer who is not on BitriPay scans the same code with their phone camera. It opens a checkout page where they can pay by card, mobile money or bank transfer. You still receive balance, and the sound still plays. The fees they see are shown before they confirm.

## Step 4: turn balance into cash, or spend it

- **Cash:** go to **Agents & cash**, choose an agent close to you and the amount, approve with your fingerprint and show the agent the code. The agent hands over the cash when the app shows the payout as settled. Never hand over your phone.
- **Stock:** pay your wholesaler by scanning their QR code, or by sending to their @tag or phone number.
- **Airtime and bills:** from the Services menu, with no extra fee.

## Step 5: keep it safe

- Set a transaction PIN and turn on fingerprint or face approval. Nobody can move your money without your finger on your phone.
- BitriPay staff and agents never ask for your PIN.
- If your phone is lost, sign in on any other phone and freeze the account, or ask an agent to call support with you.

## A note on what your balance is

Your balance is electronic money backed one-to-one by safeguarded funds where BitriPay is authorised, and the app labels it clearly if a market is still in sandbox. You can read how that works in our [safeguarding of funds](/legal/safeguarding) page.

## When a merchant account is worth it

Move to a merchant account when you have more than one seller on the stall, want daily sales totals, or want customers to pay a fixed amount they cannot change. It adds a point-of-sale screen, payment links you can send on WhatsApp, and a settlement schedule to your bank or mobile money wallet.`,
  },
  {
    title: 'Moto-taxi riders: how to collect fares without carrying cash',
    slug: 'moto-taxi-riders-collect-fares-without-cash',
    excerpt:
      'Thirty small fares a day add up to a lot of cash on a motorbike. A wewa can be paid by QR code or @tag in seconds, hear every payment over the traffic, and cash out once at the end of the day.',
    category: 'guides',
    tags: ['moto-taxi', 'qr payments', 'daily earners'],
    keywords: ['moto taxi mobile payment', 'wewa payment app', 'get paid by passengers without cash', 'boda boda digital payments'],
    metaTitle: 'Moto-taxi fares without cash: a rider’s guide',
    metaDescription:
      'How wewa and boda riders take fares by QR code or @tag, hear every payment over the traffic, and cash out once a day at an agent. Fees, safety and what to do when a passenger claims they paid.',
    faq: [
      {
        question: 'What if the passenger says they paid but I heard nothing?',
        answer:
          'Money that arrived is on your screen with a green tick and your phone rang. If it is not there, the payment did not arrive. Ask them to show the transfer in their app: a payment that is still pending is not yours yet.',
      },
      {
        question: 'Can I be paid if I have no data?',
        answer: 'The passenger needs data to send. Your phone will show the payment and ring as soon as it reconnects, and the money is already in your balance in the meantime.',
      },
      {
        question: 'How do I get cash?',
        answer: 'Once a day, visit an agent: choose the amount in Agents & cash, approve with your fingerprint, show the code. The agent pays out when the app shows the payout as settled.',
      },
    ],
    sources: [
      { title: 'International Labour Organization – Motorcycle taxis in Africa', url: 'https://www.ilo.org/' },
      { title: 'GSMA Mobile Money Metrics', url: 'https://www.gsma.com/mobilemoneymetrics/' },
    ],
    bodyMd: `A rider in Kinshasa or Kampala might make thirty trips a day, most of them small. Carrying that in cash means change problems, arguments at every corner and a risk of theft on the ride home. Here is a way of working that riders in our early groups settled on.

## Set up once

1. Create a BitriPay account with your phone number and choose an **@tag** that is easy to say and spell, such as \`@papyKin\`.
2. Print your receive QR code and stick it on the fuel tank or inside the helmet strap; a small sticker is enough.
3. Turn on fingerprint approval so that sending money needs your finger, but receiving needs nothing.

## Taking a fare

- **Passenger with BitriPay:** they scan the sticker or type your @tag, enter the fare and confirm. Your phone rings loudly and vibrates. That sound is your receipt.
- **Passenger without BitriPay:** they scan the same sticker with their camera and pay by mobile money or card on the checkout page.
- **No sticker to hand:** tell them your phone number. Sending to a phone number works even if they saved you under a nickname.

Wait for the sound before you ride off. A screenshot is not a payment.

## End of the day

Go to **Agents & cash**, pick an agent on your route home, enter the amount, approve with your fingerprint and show the agent the code. The agent hands you the cash once the app shows the payout as settled; that usually takes a few seconds. Keep some balance for fuel, airtime and the association fee, which you can pay from the app.

## Fees and limits

Receiving fares into your wallet is free. Cash-out costs the agent commission shown before you confirm. While your account is unverified you have daily and monthly limits; verifying with your ID and a selfie raises them and lets you withdraw to a bank account or mobile money.

## Safety

- Nobody can send your money away without your finger on your phone.
- Lost phone: sign in from any phone and **freeze** the account; your balance is safe.
- Do not lend your phone or share your PIN with a colleague who "just wants to check".

## Why this is built for riders

We designed the loud alert, the sticker-sized QR code and the once-a-day cash-out around the rhythm of a rider's day. If something in the app gets in the way, tell us on Live chat; riders' feedback has already changed how the alert sounds.`,
  },
  {
    title: 'Sending money from the UK to Congo: what it really costs and how long it takes',
    slug: 'sending-money-uk-to-congo-costs-speed-safety',
    excerpt: 'Fees, exchange margins, mobile money versus bank payout, and the checks that protect your money on the way from a UK card to an Orange Money or Airtel Money wallet in the DRC.',
    category: 'remittance',
    tags: ['remittance', 'congo', 'uk', 'orange money'],
    keywords: ['send money to congo from uk', 'uk to drc money transfer', 'orange money congo transfer from london', 'cheapest way to send money to kinshasa'],
    metaTitle: 'Send money UK → Congo (DRC): fees, speed, safety',
    metaDescription:
      'How a UK card payment becomes an Orange Money or Airtel Money payout in Kinshasa: the real fees, the exchange margin, delivery times, recipient currency choice and the safety checks in between.',
    faq: [
      {
        question: 'Can my family receive US dollars instead of Congolese francs?',
        answer:
          'In the DRC many mobile money wallets hold USD. When the corridor permits it and there is prefunded USD liquidity, BitriPay offers USD as a receiving currency and, in regulated corridors, asks the recipient to confirm the currency before paying out. The local currency is always the default.',
      },
      {
        question: 'How long does it take?',
        answer:
          'Card funding is confirmed within seconds by the processor. The mobile money payout is then executed from a prefunded account in the DRC, typically within minutes during business hours, and you can follow every stage in the app.',
      },
      {
        question: 'What if the operator confirmation does not match?',
        answer:
          'The payout is held and reviewed by a person before anything is marked as delivered. Your money is never lost between stages; if the payout cannot complete you can cancel for a full refund.',
      },
      {
        question: 'Is it authorised?',
        answer:
          'Cross-border transfers are a regulated service. BitriPay offers each corridor for real money only once the licence, partners and safeguarded liquidity are in place; the app shows a corridor as sandbox until then.',
      },
    ],
    sources: [
      { title: 'World Bank – Remittance Prices Worldwide', url: 'https://remittanceprices.worldbank.org/' },
      { title: 'Financial Conduct Authority – Electronic money and payment institutions', url: 'https://www.fca.org.uk/firms/electronic-money-payment-institutions' },
      { title: 'Banque Centrale du Congo', url: 'https://www.bcc.cd/' },
    ],
    bodyMd: `The UK to DRC corridor is one of the more expensive in the world, and the cost is rarely where people think it is. This article walks through what happens between a debit card in Manchester and a phone in Kinshasa, so you can judge any quote, ours included.

## Where the cost hides

1. **The transfer fee.** Easy to see, usually small.
2. **The exchange margin.** The difference between the mid-market rate and the rate you get. This is where most of the cost sits, and many services do not show it. BitriPay shows the reference rate, its source and time, and the margin in basis points on every quote.
3. **Card fees.** Paying by card costs the processor's fee, shown separately.
4. **Payout fees.** Some operators charge the recipient to cash out. We show the payout fee where one applies.

The World Bank's Remittance Prices Worldwide database tracks the total cost per corridor and is a good sanity check for any quote.

## How the transfer moves

BitriPay does not send money through a chain of correspondent banks. The path is:

| Stage | What happens | How it is confirmed |
|---|---|---|
| Quoted | You see the amount, fees, rate, margin, guaranteed recipient amount and expiry | Shown before you approve |
| Approved | You approve with fingerprint, face or passkey | On your phone |
| Funded | The card processor confirms the payment into safeguarded funds | Signed processor message |
| FX reserved | The rate is locked and local liquidity reserved | In the ledger |
| Payout routed | The instruction goes to a prefunded Orange Money or Airtel Money account in the DRC | Payout device queue |
| Payout sent | A secured payout device or approved agent executes the transfer | USSD from the merchant SIM |
| Verified | The operator's own confirmation SMS is signed and matched: amount, reference, recipient, SIM, time | Cryptographic check |
| Settled | The recipient has the money and the ledger is posted | Immutable record |

If any check fails the transfer stops in a review state rather than disappearing.

## Choosing the receiving currency

The Congolese franc is the default. Where the corridor permits USD payouts and a USD payout account is funded, the sender can choose USD; in regulated corridors the recipient confirms the currency through a link before the payout is executed. The app only offers a currency it can actually pay right now.

## Speed

Card funding: seconds. Payout: minutes during business hours, longer at night or when the local account needs prefunding, in which case the transfer waits safely in "insufficient liquidity" and resumes automatically.

## Safety checks you will notice

- New recipients may have a short cooling-off period.
- Large transfers ask for a source-of-funds declaration.
- Card-funded transfers to new recipients can be held for review before payout, because a card payment can be disputed after the money has left.

## What to do before you send

Check the recipient's number and operator, tell them to expect the operator's SMS, and keep the BP- reference. If they do not receive it, do not send again: open the transfer in the app and use Live chat.`,
  },
  {
    title: 'What safeguarding means for your e-money balance',
    slug: 'what-safeguarding-means-for-your-balance',
    excerpt: 'Your BitriPay balance is not a bank deposit. It is electronic money backed one-to-one by funds held apart from the company. Here is what that protects you from, and what it does not.',
    category: 'trust',
    tags: ['safeguarding', 'e-money', 'trust'],
    keywords: ['what is e-money safeguarding', 'is my mobile wallet balance safe', 'e-money vs bank deposit', 'safeguarded funds explained'],
    metaTitle: 'Safeguarding explained: is your e-money balance safe?',
    metaDescription:
      'E-money is not a bank deposit. Learn how safeguarding keeps customer funds apart from the company, how BitriPay reconciles reserves daily, and what promotional and sandbox balances are.',
    faq: [
      { question: 'Do I earn interest on my balance?', answer: 'No. E-money does not earn interest; the safeguarded funds belong to customers and are not lent out.' },
      { question: 'What happens if BitriPay closed down?', answer: 'Safeguarded funds are held apart from the company’s own money and are returned to customers ahead of other creditors.' },
      { question: 'What is promotional credit?', answer: 'A reward that can only be used against BitriPay fees. It is not money, it expires, and it cannot be withdrawn or sent.' },
    ],
    sources: [
      { title: 'FCA – Safeguarding customer funds', url: 'https://www.fca.org.uk/firms/safeguarding-customer-funds' },
      { title: 'Bank of England – Money creation in the modern economy', url: 'https://www.bankofengland.co.uk/quarterly-bulletin/2014/q1/money-creation-in-the-modern-economy' },
    ],
    bodyMd: `People ask two questions about a wallet balance: "is it real money?" and "what if the company disappears?". Both have precise answers.

## E-money is a claim, not a deposit

When a bank takes your deposit it can lend it out; that is how banks create money, as the Bank of England explains in its well-known bulletin. An e-money issuer is different. It may not lend your money. It must hold the funds behind every balance in **safeguarding accounts**, separate from its own money, so that the balance is always redeemable.

Your BitriPay balance is that kind of claim. It is not a bank deposit, it earns no interest, and it is not covered by a deposit guarantee scheme. It is protected by safeguarding instead.

## The one rule

Inside BitriPay's ledger there is a rule that cannot be switched off by an administrator:

> Issued e-money must never exceed cleared safeguarded funds, less redemptions in progress and reserved exposure.

Nobody can type an amount into existence. Reserve funding is recorded by one treasury administrator and confirmed by another against the bank statement; issuance requests are checked against the reserve at request time and again when a second person approves them; every step is written to an immutable register.

## Daily reconciliation

Each day the platform compares all customer balances with the funds in safeguarding. If they ever fail to match, issuance suspends itself and administrators are alerted loudly. That is also what our auditors and regulators look at.

## Balances that are not money

- **Promotional credit** covers BitriPay fees only. It expires and cannot be sent or withdrawn. Your statement lists it separately.
- **Sandbox balances** exist in markets where BitriPay is not yet authorised, so people can learn the app. They have no value and the app says so on the balance card.

## How to check

Your statement shows the balance type on every page. The [regulatory information](/legal/regulatory) page lists the issuer and the safeguarding institution for each currency, and the [safeguarding of funds](/legal/safeguarding) page describes the arrangements in full.`,
  },
  {
    title: 'Mobile money agents: how the float works and how to stay liquid',
    slug: 'mobile-money-agents-float-and-liquidity',
    excerpt: 'An agent is the bank in a place that has none. This guide explains float, prefunding, daily reconciliation and the habits that keep an agent liquid on market day.',
    category: 'agents',
    tags: ['agents', 'liquidity', 'cash'],
    keywords: ['mobile money agent float', 'how to become a mobile money agent', 'agent liquidity management', 'cash in cash out agent'],
    metaTitle: 'Agent float and liquidity: a practical guide',
    metaDescription: 'How BitriPay agents hold float, prefund it, execute cash-in and cash-out approved on the customer’s own phone, reconcile daily and stay liquid on the busiest days.',
    faq: [
      {
        question: 'Do I need a shop?',
        answer: 'No. Many agents work from a kiosk, a pharmacy counter or a phone-charging stand. You need an ID, a business registration where the law requires one, a phone and a starting float.',
      },
      {
        question: 'Who confirms a cash-out?',
        answer:
          'The customer approves it on their own phone with their fingerprint or PIN. You never touch their phone or their PIN, and you hand over cash only when your app shows the payout as settled.',
      },
      {
        question: 'What happens to the money I pay out?',
        answer: 'Your float is a prefunded balance reconciled against the platform every day. Each payout reduces it and each cash-in increases it, and you can see every movement in your history.',
      },
    ],
    sources: [
      { title: 'CGAP – Agent network management', url: 'https://www.cgap.org/topics/collections/agent-networks' },
      { title: 'GSMA – Mobile money agent networks', url: 'https://www.gsma.com/mobilefordevelopment/mobile-money/' },
    ],
    bodyMd: `Every digital payment system that works for ordinary people has agents at its edge: the person who turns cash into balance in the morning and balance into cash in the evening. Being that person is a business, and like any business it runs on liquidity.

## What float is

Your float is the balance you hold with BitriPay to serve customers. When a customer deposits cash, your float goes down and their balance goes up. When a customer withdraws, your float goes up and you hand out cash. You need both cash and float, and on a busy day one of them runs out first.

## Prefunding

You prefund your float by paying into the platform through a bank transfer, a mobile-money payment or a master agent. The platform reconciles the float with safeguarded funds daily, so the balance you hold is always backed.

## Every transaction is approved by the customer

- **Cash-in:** the customer shows you their @tag or QR code; you enter the amount; they approve on **their** phone. Their balance is credited and your float is debited.
- **Cash-out:** the customer creates a cash-out code in their app for the amount; you enter or scan it; you hand over cash **only once your app shows it as settled**.

You never handle the customer's phone and you never learn their PIN. Your commission is shown to both of you before confirmation.

## Staying liquid on market day

1. Look at last week's pattern in your history and prefund the night before the busiest day.
2. Keep a cash buffer for the evening cash-out rush; early-day deposits usually cover it.
3. Agree a rebalancing routine with a master agent or the nearest bank branch.
4. Use limits: your daily and per-transaction limits protect you from one customer draining your float.

## Executing payouts for remittances

Approved agents can also execute mobile-money payouts for transfers coming from abroad. The instruction appears in your queue with a loud alert; you send from the merchant SIM, and the operator's confirmation SMS is forwarded and verified automatically by the payout device app, or entered by you and checked by a second person. You are paid a fee per settled payout.

## Rules that protect you

- Charge only the commission shown in the app.
- Do not hand over cash before "settled".
- Keep your SIM and payout device to yourself.
- Report a suspicious customer through the app; you are never expected to argue with anyone.

## Becoming an agent

Register with an **agent** account, upload your ID and business documents, and a BitriPay onboarding officer will visit or call. Training takes about an hour, and you keep a printed guide with the steps above.`,
  },
  {
    title: 'Virtual cards for online shopping without a bank card',
    slug: 'virtual-cards-online-shopping-without-bank-card',
    excerpt: 'A BitriPay virtual card lets you pay online, subscribe to services and shop at BitriPay merchants from your wallet balance, with a card you can freeze, refill or close in a tap.',
    category: 'guides',
    tags: ['virtual cards', 'online shopping', 'getting started'],
    keywords: ['virtual card without bank account', 'how to get a virtual card in africa', 'prepaid virtual card for online shopping', 'freeze virtual card'],
    metaTitle: 'Virtual cards without a bank card: how they work',
    metaDescription: 'Issue a virtual card from your BitriPay balance, fund only what you plan to spend, freeze it when you are not using it and reveal the details only with your PIN.',
    faq: [
      {
        question: 'Where can I use it?',
        answer:
          'At any merchant that accepts BitriPay checkout, and, where a card programme is live in your country, at online merchants that accept the card network. The app tells you which applies to your card.',
      },
      { question: 'Is my main balance at risk?', answer: 'No. The card only holds what you moved onto it. Freeze it when you are not shopping and move any balance back to your wallet at any time.' },
      { question: 'What does it cost?', answer: 'Issuing a card is free. Some online merchants charge their own fees; the app never adds hidden ones.' },
    ],
    sources: [{ title: 'PCI Security Standards Council', url: 'https://www.pcisecuritystandards.org/' }],
    bodyMd: `Many people who have never had a bank card have paid for a phone subscription, a course or a bus ticket online through someone else's card. A virtual card gives you your own.

## What it is

A card number, expiry date and CVV that live in your app. You fund it from your balance, spend online, and move any leftover back. The number is stored encrypted and shown only after your PIN or fingerprint.

## Issue one

Go to **Virtual cards → New virtual card**, choose the currency and a label such as "Subscriptions", and confirm with your PIN. The card appears immediately with a zero balance.

## Fund it for what you plan to spend

Tap **Fund** and move exactly what you need. Because the card holds only that amount, a merchant cannot take more than you put on it. Refunds from merchants land back on the card; **Withdraw** moves them to your wallet.

## Freeze and close

**Freeze** stops all spending instantly; unfreeze when you shop again. **Close** ends the card for good and returns the balance to your wallet. Card details are revealed only with your PIN, and the loud alert tells you about every charge.

## Where it works

At BitriPay merchant checkouts everywhere, and, in countries where a card programme with a licensed issuer is live, at online merchants on the card network. Your card's page states which of the two applies. We do not claim network acceptance where a programme is not yet live.

## Safety habits

- Fund per purchase, not per month.
- Keep the card frozen between uses.
- Never share the CVV over chat; a merchant checkout never asks for it in a message.`,
  },
];
