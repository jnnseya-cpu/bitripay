/**
 * Default legal, company and contact pages. They are real policy texts written for an e-money and money-transfer
 * platform serving people who may be reading on a small phone; an administrator edits them in Admin → Pages.
 * Country-specific details (regulator, licence numbers, safeguarding bank) are filled in from the go-live records.
 */
export interface DefaultPage {
  slug: string;
  title: string;
  content: string;
}

const CONTACT = 'You can reach us at hello@bitripay.app, in the app under Support → Live chat, or by post at the registered address shown in the Regulatory information page.';

export const DEFAULT_PAGES: DefaultPage[] = [
  {
    slug: 'about',
    title: 'About BitriPay',
    content: `## Money that works for everyone

BitriPay exists for one reason: **electronic payment should be available and usable by everyone**, not only people with a bank account, a laptop and a good signal.

We build for the mother selling grilled fish at the market who cannot read the small print but can recognise a green tick and hear a sound when money arrives. We build for the *wewa*, the moto-taxi rider in Kinshasa who collects thirty small fares a day and should not have to carry them home as cash. We build for the corner shop that wants to accept a payment without buying a card machine, for the agent with a float who is the bank in a village that has none, and for the sister in London or Paris sending money home on a Friday night.

## What we do differently

- **A QR code and a phone number are enough.** No card reader, no printer, no app store account for the person paying: they scan, confirm with their finger or face, and the money is there.
- **Sound and vibration you cannot miss.** When money arrives the phone rings loudly and vibrates for several seconds, because a notification you did not notice is a payment you cannot trust.
- **Cash stays part of the system.** Agents turn cash into balance and balance into cash. Nobody is forced to leave cash behind before they are ready.
- **Local rails, no fragile integrations.** Mobile-money payouts are executed from prefunded local accounts by secured payout devices and confirmed by the operator's own message, so a transfer to a village works even where no operator API exists.
- **Every fee is shown before you confirm.** The exchange rate, the margin, the charges and what the recipient gets are on the screen before your fingerprint touches it.
- **Your balance is a claim on safeguarded money.** Where BitriPay operates as an authorised e-money institution or the distributor of a licensed issuer, every balance is backed one-to-one by funds held apart from our own. Where we are not yet authorised, the app says so clearly and runs in sandbox mode.

## How we are run

BitriPay is operated by a small team with roots in Central and East Africa and in Europe. Money movement is governed by maker-checker controls: no single person, including our founders, can create balance, release a payout or change a rate on their own. Every action is written to an immutable, hash-chained audit log that our auditors and regulators can read.

## Who we serve today

Individuals, market traders, moto-taxi and delivery riders, small merchants, mobile-money agents and diaspora senders in the corridors listed on the Regulatory information page. New corridors open only once the regulatory arrangements, the payout partners and the safeguarded liquidity are in place.

## Talk to us

${CONTACT} We answer in English, French, Lingala and Swahili.`,
  },
  {
    slug: 'contact',
    title: 'Contact us',
    content: `## We are here to help

- **In the app:** Support → Live chat, seven days a week. This is the fastest way to solve a problem with a payment.
- **Email:** hello@bitripay.app for general questions, support@bitripay.app for account help, complaints@bitripay.app for formal complaints, press@bitripay.app for media, partners@bitripay.app for agents, merchants and payout partners.
- **Phone and post:** the numbers and addresses for each country we operate in are listed on the Regulatory information page.

## Before you write

If it is about a specific payment, have the reference (it starts with BP-) ready. It is on the transaction in the app and on your statement.

## Lost or stolen phone

Sign in on another device and freeze your account under Settings → Security, or write to support@bitripay.app with your @tag and the last four digits of your phone number. We will block the old device immediately.

## Reporting a security issue

Write to security@bitripay.app. We acknowledge reports within two working days and do not take action against researchers who report responsibly.`,
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    content: `## Who we are

BitriPay ("we", "us") provides a digital wallet, payment and money-transfer service. This policy explains what personal data we collect, why, how long we keep it and the rights you have. It applies to the app, the website, agents acting for us and our support channels. The legal entity responsible for your data and its address are listed on the Regulatory information page.

## What we collect

- **Identity and contact:** name, phone number, email, country, date of birth, and the identity document and selfie you give us for verification (KYC).
- **Account and transactions:** balances, payments sent and received, recipients, references, the device and location country used to approve a payment, and the operator confirmation messages that settle mobile-money payouts.
- **Device and security:** device model, operating system, app version, push token, IP address, and the public key of any passkey or payout device you register. **We never store fingerprints or face images.** Biometric checks happen on your phone; we only receive a yes or no.
- **Support:** messages you send us and call notes.
- **Cookies and analytics on the website:** see the Cookie policy. We count page views without identifying you.

## Why we use it

| Purpose | Legal basis |
|---|---|
| Opening and running your account, executing payments | Performance of a contract |
| Identity verification, sanctions screening, fraud and anti-money-laundering monitoring | Legal obligation |
| Keeping records for regulators and auditors | Legal obligation |
| Sending payment notifications, including loud alerts you can switch off | Contract / legitimate interest |
| Improving the service and keeping it secure | Legitimate interest |
| Marketing messages | Consent (you can withdraw it any time) |

## Who we share it with

Identity-verification and sanctions-screening providers; card processors and banks that move your money; mobile-money operators and payout partners in the destination country; agents who serve you in person (they see only what they need to complete your transaction); cloud hosting providers; auditors, regulators and law enforcement where the law requires. We do not sell personal data.

## International transfers

Money transfers require sending recipient details to the destination country. Other data stays in the region where the service is operated. Where data leaves that region we use contractual safeguards recognised by the relevant regulator.

## How long we keep it

Account, identity and transaction records are kept for the period required by anti-money-laundering law (normally five years after the account closes, longer where a regulator or court requires). Support conversations are kept for two years. Analytics are aggregated after thirteen months.

## Your rights

You can ask for a copy of your data, correct it, ask us to delete what we are not required to keep, object to marketing, and complain to the data-protection authority in your country. Write to privacy@bitripay.app. We answer within one month.

## Children

BitriPay is for people aged 18 or over, or the age of majority where you live.

## Changes

We will tell you in the app at least thirty days before a material change to this policy takes effect.`,
  },
  {
    slug: 'terms',
    title: 'Terms of service',
    content: `## 1. The agreement

These terms are a contract between you and BitriPay for the use of the BitriPay app, website and services. By opening an account you accept them. Read them together with the Privacy policy, the Fees & charges page and, if you are an agent or merchant, the Agent & merchant agreement.

## 2. Your account

You must be 18 or older, give accurate information and complete identity verification when asked. One person, one account. Keep your PIN, passkeys and phone secure; you are responsible for payments approved with them unless you told us the device was lost or stolen before the payment. We may limit, suspend or close an account to comply with the law, prevent fraud or protect other customers, and we will tell you why unless the law prevents it.

## 3. Your balance is electronic money

Your BitriPay balance is electronic money issued by the authorised issuer named on the Regulatory information page. It is not a bank deposit, it earns no interest and it is not covered by a deposit-guarantee scheme. Instead, the funds behind it are safeguarded as described in the Safeguarding of funds page, so that they can be returned to you if the issuer fails. **Promotional credit is not money**: it can only be used against BitriPay fees, it expires, and it cannot be withdrawn or sent. **Sandbox balances have no value** and exist only to try the service.

## 4. Payments

A payment is executed when you approve it with your fingerprint, face, passkey or PIN. Before you approve, the app shows the amount, all fees, the exchange rate and what the recipient will get. Wallet-to-wallet payments are final once made; ask the recipient to send the money back if you made a mistake. Transfers to a bank account, mobile-money wallet or cash agent can be cancelled for a full refund until the local payout is executed; once the operator has paid the recipient, the money cannot be recalled. We may hold a payment for review where the law or our risk rules require and will tell you in the app.

## 5. Fees and exchange rates

Fees are those shown on the Fees & charges page and on the screen before you confirm. Exchange rates are shown with their source and our margin. When a live rate is locked for the quote period the recipient amount is guaranteed; otherwise it is indicative and the app says so.

## 6. Cross-border transfers

Transfers between countries are a regulated money-transfer service provided through the corridors listed on the Regulatory information page. Where a corridor is not yet authorised, it is not offered for real money.

## 7. What you must not do

See the Acceptable use policy. In short: no unlawful use, no payments for prohibited goods, no use of someone else's identity, no attempts to interfere with the service.

## 8. Our liability

We are liable for payments not executed or executed incorrectly because of our fault, and we will restore your balance and any charges. We are not liable for losses caused by you giving us wrong recipient details, by a recipient's bank or operator, or by events outside our control, and not for indirect or consequential loss. Nothing limits liability that cannot be limited by law.

## 9. Closing your account

You can close your account at any time from Settings; we will return any balance to a bank account or mobile-money wallet in your name after final checks. We keep records afterwards as the law requires.

## 10. Complaints and law

Complaints are handled as described in the Complaints page. These terms are governed by the law of the country of the BitriPay entity you contract with, shown on the Regulatory information page, and the courts of that country have jurisdiction, without removing protections you have as a consumer where you live.

## 11. Changes

We give thirty days' notice in the app before changing these terms, except where a change is required by law or is in your favour.`,
  },
  {
    slug: 'cookies',
    title: 'Cookie policy',
    content: `## What we use on the website

- **Strictly necessary:** the session that keeps you signed in and the setting that remembers whether you accepted this notice. They cannot be switched off.
- **Preferences:** your language and light/dark theme.
- **Measurement:** we count page views by page and by day. We do not use third-party advertising cookies and we do not build profiles of visitors.

## The app

The mobile and web apps store your session token, language, theme and the "loud alerts" preference on your device. The Android payout-device app stores its signing key in the secure store; it never leaves the phone.

## Your choices

You can delete cookies in your browser at any time. If you clear them you will be signed out. Questions: privacy@bitripay.app.`,
  },
  {
    slug: 'acceptable-use',
    title: 'Acceptable use policy',
    content: `## Using BitriPay responsibly

BitriPay may only be used for lawful purposes by the account holder personally (or by an authorised representative for a business account).

## You must not use BitriPay to

- Pay for or receive payment for illegal goods or services, counterfeit goods, stolen property or unlicensed gambling.
- Launder money, finance terrorism, evade sanctions or move the proceeds of crime.
- Run a scheme that misleads other people: pyramid schemes, fake investments, advance-fee fraud, romance or job scams.
- Sell or buy access to accounts, or let someone else use your account.
- Open several accounts to avoid limits or verification.
- Attempt to bypass identity checks, spoof a location, interfere with the app, the API or a payout device, or probe our systems without written permission.
- Harass, threaten or defraud agents, merchants or our staff.

## Agents and merchants additionally must not

- Charge customers more than the fees shown by the app.
- Complete a cash-in or cash-out that the customer has not approved on their own phone.
- Hand over cash before the app shows the payout as settled.
- Share operator confirmation messages, SIMs or payout devices with anyone.

## What happens if you break these rules

We may hold a payment, freeze a balance, suspend or close the account, report to the authorities and recover losses. Where the law allows, we tell you what we found and how to appeal through the Complaints process.`,
  },
  {
    slug: 'aml-kyc',
    title: 'Anti-money-laundering, KYC and sanctions policy',
    content: `## Our commitment

BitriPay does not want criminal money and does not do business with sanctioned people or countries. We apply the anti-money-laundering and counter-terrorist-financing laws of every country we operate in, and the stricter rule where they differ.

## Know your customer

- **Everyone** gives a name, phone number and country to open an account, and can hold a limited balance and send small amounts while unverified.
- **Verification** (an identity document plus a live selfie) is required before withdrawing, sending abroad, or exceeding the limits shown in the app. Businesses, agents and merchants additionally provide registration documents and the identity of their owners and directors.
- **Ongoing:** we screen every customer and every counterparty against sanctions lists at sign-up and on each transaction, and we refresh verification when documents expire or activity changes.

## Monitoring

Every transaction passes automated checks: velocity limits, new-beneficiary cooling-off, unusual patterns for the customer's profile, mismatches between funding and payout, and structuring below reporting thresholds. Alerts are reviewed by trained staff. Suspicious activity is reported to the financial intelligence unit of the relevant country, and we may be required not to tell you.

## Source of funds

For larger transfers the app asks you to declare where the money comes from and may ask for evidence.

## Agents and payout partners

Agents are identified, trained and supervised; their floats are reconciled daily and every cash-in and cash-out is approved on the customer's own phone. Payout partners and prefunded local accounts are contracted and reviewed before a corridor goes live.

## Records

Identity and transaction records are kept for at least five years after the relationship ends, as the law requires.

## Training and accountability

All staff complete AML training when they join and every year. The Money Laundering Reporting Officer is named on the Regulatory information page.`,
  },
  {
    slug: 'safeguarding',
    title: 'Safeguarding of funds',
    content: `## What safeguarding means

Your BitriPay balance is electronic money. The money behind it does not belong to us and is not used to run the business. It is held in **safeguarding accounts** at a credit institution, kept separate from BitriPay's own funds, so that if BitriPay were to become insolvent the safeguarded funds are returned to customers ahead of other creditors.

## The rule we live by

Issued e-money can never exceed the cleared funds in the safeguarding accounts, less redemptions in progress and reserved exposure. This rule is enforced inside our ledger: an administrator cannot create a balance without a confirmed, independently checked reserve, and every issuance is recorded in an immutable register.

## Daily reconciliation

Every day we compare total customer balances with the safeguarded funds. If the two ever fail to match, issuance is suspended automatically until the difference is explained and corrected, and the incident is reported to the regulator where required.

## Money in transit

When you fund a payment by card, the card processor holds the money until it settles to the safeguarding account; the app shows the transfer as "funding pending" until then. When we prefund a local payout account (for example a mobile-money merchant line in the destination country), that money leaves the safeguarding account only to pay out to recipients, and the float is reconciled against the operator's statements.

## What is not safeguarded

Promotional credit (it is not money) and sandbox balances (they have no value). Balances held with a partner issuer are safeguarded by that issuer under its own authorisation, and the app tells you who the issuer is.

## Where to check

The Regulatory information page lists the safeguarding institution for each currency. Your statement shows your balance type on every page.`,
  },
  {
    slug: 'refunds',
    title: 'Refunds and cancellations',
    content: `## Wallet-to-wallet payments

Payments to another BitriPay user, a merchant QR code or a payment link are final once approved. If you paid the wrong person or amount, ask the recipient to send it back; merchants can refund from their dashboard. If you believe the payment was fraudulent, contact us straight away and we will investigate and, where we can, hold the funds.

## Transfers to a bank, mobile money or a cash agent

You can cancel from the transfer screen for a **full refund of the amount** at any time before the local payout is executed. Non-refundable card-processor fees may be deducted; the app tells you before you cancel. Once the operator or bank has paid the recipient the transfer cannot be recalled. If a payout fails or the recipient does not collect within the time shown, the money returns to your balance automatically.

## Card and bank funding

If your card or bank payment is confirmed but the transfer cannot proceed, we refund to the same card or account. Refunds appear within 5–10 working days depending on your bank.

## Disputes and chargebacks

If you dispute a card payment with your bank, the related transfer is paused while the dispute is resolved. Balances that were paid out before the dispute may be recovered from your account.

## Virtual cards

Refunds from online merchants return to the virtual card balance. You can move that balance back to your wallet at any time.

## How to ask

Support → Live chat in the app, or support@bitripay.app with the BP- reference.`,
  },
  {
    slug: 'complaints',
    title: 'Complaints',
    content: `## We want to know

If something has gone wrong, tell us. You do not need to write in a particular way and you can complain in English, French, Lingala or Swahili, in the app, by email to complaints@bitripay.app, or by post to the address on the Regulatory information page.

## What happens next

1. We acknowledge your complaint within **two working days** with a reference.
2. A person who was not involved in the original decision investigates.
3. We send a final answer within **15 working days** (35 in exceptional cases, and we will tell you why). It explains what we found, what we will do, and how to take it further if you disagree.

## If you are not satisfied

You may refer the complaint to the ombudsman or dispute-resolution body of the country whose regulator authorises the service you used; their details are on the Regulatory information page and in our final answer. This is free.

## Complaints about an agent or merchant

Tell us the agent's name or the merchant's @tag and the BP- reference. Agents and merchants are bound by the Acceptable use policy and the Agent & merchant agreement.

## Learning from complaints

Complaint themes are reviewed monthly by the compliance team and the founders, and the changes they lead to are noted on the blog.`,
  },
  {
    slug: 'accessibility',
    title: 'Accessibility statement',
    content: `## Built for the people usually left out

BitriPay was designed with people who do not read easily, who share a phone, who are on a slow connection or who use a screen reader.

## What we do

- **Sound and vibration for money events** that can be heard across a busy market, and a distinct pattern so the sound itself tells you money arrived.
- **Large, plain buttons** with one clear action each, colour that is never the only signal, and text that can be scaled with the phone's settings.
- **Language:** English, French, Lingala, Swahili and more, with short sentences and no jargon.
- **QR codes and @tags** instead of long account numbers to type.
- **Voice-over and TalkBack** support in the apps; the website works with keyboard and screen readers and follows WCAG 2.1 AA.
- **Agents** who can help in person, on the customer's own phone, without ever taking control of the account.
- **Low data:** the apps work on 2G/3G connections and retry silently when the network drops.

## Tell us what is hard

If something in BitriPay is difficult for you to use, write to accessibility@bitripay.app or use Live chat. We fix accessibility problems as bugs, not as feature requests.`,
  },
  {
    slug: 'fees',
    title: 'Fees and charges',
    content: `## How fees work

Every fee is shown on the screen **before** you confirm a payment, in the currency you pay in, together with the exchange rate, the rate source and our margin where a conversion happens. What the recipient gets is shown next to it. Nothing is deducted that was not shown.

## Typical fees

| Service | Fee |
|---|---|
| Paying another BitriPay user, a merchant QR code or a payment link | Free for the payer; merchants pay a small percentage shown in their dashboard |
| Adding money by mobile money or bank transfer | Operator or bank charges only, shown before you confirm |
| Adding money by card | A percentage of the amount, set by the card processor for your country |
| Withdrawing to a bank account or mobile money | A fixed fee per withdrawal that varies by country |
| Cash-in and cash-out at an agent | The agent's commission, shown before you confirm |
| Sending money abroad | A transfer fee plus the exchange margin shown on the quote |
| Currency exchange between your own wallets | The margin shown on the quote |
| Virtual cards | Free to issue; some online merchants charge their own fees |
| Bills, airtime and gift cards | Free or as shown per biller |
| Account, statements, support | Free |

The exact amounts for your country are in the app under Fees and on every quote. Because they can change with operator and processor pricing, the app is always the authoritative source.

## Exchange rates

We show the reference rate, its source and time, and our margin. When a live rate is locked for the quote period the recipient amount is guaranteed; otherwise it is marked indicative.

## Limits

Unverified accounts have low daily and monthly limits. Verification raises them; the current limits are shown in the app under Limits.`,
  },
  {
    slug: 'security',
    title: 'Security',
    content: `## How BitriPay keeps money safe

- **Your approval on your device.** Every payment, new recipient, withdrawal and security change is approved with your fingerprint, face, passkey or PIN. We never see your biometrics; the phone only tells us yes or no.
- **Nothing settles on a screenshot.** A payment is confirmed only by the card processor's signed message, a signed confirmation from a registered payout device, or two administrators checking documentary evidence. A mobile-money confirmation SMS must match the amount, reference, recipient, SIM and time before money is marked as delivered.
- **Two people for every sensitive action.** Creating balance, releasing a held payout, changing a rate or a corridor: one person proposes, a different person approves, both with step-up authentication.
- **Immutable records.** Ledger entries, audit logs and events cannot be edited or deleted, and the event log is hash-chained so any tampering is visible.
- **Encryption.** Data is encrypted in transit and at rest; card details are tokenised with the processor and never stored on our servers; PINs and passwords are hashed.
- **Loud alerts.** You are told immediately when money moves, so an unexpected payment is noticed in seconds.
- **Freeze in one tap.** Lost phone? Sign in elsewhere and freeze your account, or contact support.

## Keeping yourself safe

BitriPay staff will never ask for your PIN, password or a code sent to your phone. Do not approve a payment you did not start. Only hand cash to an agent after the app shows the payout as settled.

## Reporting a vulnerability

security@bitripay.app. We acknowledge within two working days and thank researchers publicly when they wish.`,
  },
  {
    slug: 'regulatory',
    title: 'Regulatory information',
    content: `## Authorisation status

BitriPay offers electronic money and money-transfer services only where it is authorised to do so, either under its own licence or as the distributor or agent of a licensed issuer or payment institution. Until a corridor or currency is authorised, the app operates in **sandbox mode**, balances are labelled as having no real-world value, and no real customer funds are accepted.

The table below is maintained by the compliance team and mirrors the corridor and issuer records in our systems. Where a row says "sandbox", the service is not yet live for real money in that market.

| Country / currency | Legal issuer | Regulator | Authorisation reference | Safeguarding institution | Status |
|---|---|---|---|---|---|
| To be completed per market by the compliance team before go-live | | | | | sandbox |

## Registered entities

The BitriPay entity you contract with, its registration number, registered address and Money Laundering Reporting Officer are shown here for each market once authorised.

## Dispute resolution bodies

For each authorised market this page lists the ombudsman or alternative dispute-resolution scheme you can use free of charge if you are not satisfied with our final answer to a complaint.

## Important reminders

- Electronic money is not a bank deposit and is not covered by a deposit-guarantee scheme; it is protected by safeguarding (see Safeguarding of funds).
- Cross-border transfers are a regulated money-transfer service. We offer them only through authorised corridors with contracted collection and payout partners.
- Card payments are processed by licensed card processors; BitriPay never stores full card numbers.`,
  },
  {
    slug: 'agent-merchant-agreement',
    title: 'Agent and merchant agreement',
    content: `## Who this is for

Anyone who accepts payments through BitriPay as a business (a **merchant**) or who provides cash-in, cash-out or local payout services for customers (an **agent**). It adds to the Terms of service.

## Merchants

- You may accept BitriPay balance, cards, mobile money and bank transfers through QR codes, payment links, the point of sale and the checkout API, and you pay the fees shown in your dashboard.
- Settlement to your bank account or mobile-money wallet happens on the schedule you choose; you can see every settlement and its reference.
- You must describe what you sell honestly, deliver what was paid for, refund when you should and follow the Acceptable use policy. Prohibited business categories are listed in your dashboard.
- Chargebacks and disputes on card payments are passed on to you with the evidence; you can respond in the dashboard.

## Agents

- Your float is prefunded liquidity, reconciled daily. You may only complete a cash-in or cash-out that the customer has approved on their own phone, and only hand over cash once the app shows the transaction as settled.
- You may charge only the commission shown by the app. You must display your agent code, keep your SIM and payout device secure, and never share operator confirmation messages.
- Payouts you execute are confirmed by the operator's message and verified by the platform; a confirmation that does not match is reviewed before anything is settled.
- We train you, supervise your activity and may suspend or terminate the agreement for breaches. You must keep your identity documents and business registration up to date.

## Both

You are an independent business, not our employee or partner in law, and you may not describe yourself as BitriPay. You keep customers' data confidential and use it only to complete their transaction. We may change fees and rules with thirty days' notice.`,
  },
];
