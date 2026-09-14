/**
 * Communication event catalogue: every notice BitriPay can send, in one place, with its category, severity, default
 * channels, placeholders and whether it is a mandatory notice (delivered even when the recipient opted the category or
 * channel out: security, money movement they must know about, legal and platform-integrity notices). Event ids that
 * existed before the catalogue (payout.paid, kyc.approved, remittance.*, …) keep their ids so administrator-edited
 * templates in Messaging → Templates still apply; the engine (./engine.ts) renders subject/body from those templates
 * first and from this catalogue otherwise.
 */
export const COMMS_CHANNELS = ['email', 'inapp', 'sms', 'push', 'whatsapp'] as const;
export type CommsChannel = (typeof COMMS_CHANNELS)[number];
export type CommsSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface CommsCategory {
  id: string;
  label: string;
  description: string;
}

export interface CommsEvent {
  id: string;
  category: string;
  label: string;
  /** Subject / title template ({{placeholders}}). */
  subject: string;
  /** Body template ({{placeholders}}); a `{{link}}` placeholder becomes the email call-to-action when supplied. */
  body: string;
  severity: CommsSeverity;
  channels: CommsChannel[];
  /** Mandatory notices bypass the recipient's opt-outs. */
  mandatory: boolean;
  /** Placeholders the event receives, with sample values for previews and test sends. */
  sample: Record<string, string>;
}

export const COMMS_CATEGORIES: CommsCategory[] = [
  { id: 'account', label: 'Identity & Account', description: 'Registration, verification, profile and account lifecycle' },
  { id: 'security', label: 'Login & Security', description: 'Sign-ins, devices, passwords, two-factor authentication, step-up' },
  { id: 'wallet', label: 'Wallet & Transfers', description: 'Money in, money out, transfers, requests, exchange, statements' },
  { id: 'payments', label: 'Payments & Checkout', description: 'Merchant payments, refunds, disputes and settlements' },
  { id: 'remittance', label: 'Remittance & Corridors', description: 'Cross-border sends, payout progress, corridor status' },
  { id: 'momo', label: 'Mobile money & Evidence', description: 'Direct operator payments, receipts, evidence matching' },
  { id: 'agents', label: 'Agents & Payout devices', description: 'Cash-in, cash-out, float, payout instructions, device enrolment' },
  { id: 'kyc', label: 'KYC & Compliance', description: 'Identity and business verification, screening, limits' },
  { id: 'cards', label: 'Cards', description: 'Virtual cards: issuance, charges, controls' },
  { id: 'merchant', label: 'Merchant, API & Webhooks', description: 'Keys, webhooks, integrations, organisation members' },
  { id: 'approvals', label: 'Approvals & Maker-checker', description: 'Verifications waiting for a second administrator' },
  { id: 'treasury', label: 'E-money, Treasury & Liquidity', description: 'Reserves, safeguarding, float, Guardian, reconciliation' },
  { id: 'support', label: 'Support & Success', description: 'Tickets, live chat, onboarding milestones' },
  { id: 'platform', label: 'Platform & System', description: 'Maintenance, incidents, service status, administration' },
  { id: 'legal', label: 'Legal & Privacy', description: 'Consent, terms, data requests, regulatory notices' },
];

type Opts = { severity?: CommsSeverity; channels?: CommsChannel[]; mandatory?: boolean; sample?: Record<string, string> };
const ev = (category: string, id: string, label: string, subject: string, body: string, o: Opts = {}): CommsEvent => ({
  id,
  category,
  label,
  subject,
  body,
  severity: o.severity ?? 'info',
  channels: o.channels ?? ['email', 'inapp'],
  mandatory: o.mandatory ?? false,
  sample: { appName: 'BitriPay', name: 'Amina', ...(o.sample ?? {}) },
});

export const COMMS_EVENTS: CommsEvent[] = [
  // ---------------------------------------------------------------- Identity & Account
  ev('account', 'welcome', 'Welcome', 'Welcome to {{appName}}!', 'Your wallet is ready. Add money to get started.', { severity: 'success', channels: ['email', 'inapp', 'push'] }),
  ev(
    'account',
    'account.registration.received',
    'Registration received',
    'We received your registration',
    'Thanks {{name}}, your {{appName}} account is being set up. Confirm your contact details to unlock everything.',
  ),
  ev('account', 'account.email_verification_required', 'Email verification required', 'Verify your email address', 'Confirm {{email}} to secure your {{appName}} account.', {
    severity: 'warning',
    sample: { email: 'amina@example.com' },
  }),
  ev('account', 'account.mobile_verification_required', 'Mobile verification required', 'Verify your mobile number', 'Confirm {{phone}} so you can receive codes and receipts.', {
    severity: 'warning',
    channels: ['email', 'inapp', 'sms'],
    sample: { phone: '+243 89 000 0000' },
  }),
  ev('account', 'account.verification.successful', 'Contact verified', 'Your {{channel}} is verified', 'Your {{channel}} was verified. Thank you.', {
    severity: 'success',
    sample: { channel: 'email' },
  }),
  ev('account', 'account.verification.expired', 'Verification code expired', 'Your verification code expired', 'Request a new code from the app to finish verifying your {{channel}}.', {
    severity: 'warning',
    sample: { channel: 'phone number' },
  }),
  ev(
    'account',
    'account.registration.abandoned',
    'Registration unfinished',
    'Finish setting up your {{appName}} account',
    'You are one step away: verify your contact details and add money to start.',
  ),
  ev('account', 'account.profile.updated', 'Profile updated', 'Your profile was updated', 'Your {{field}} was changed. If this was not you, contact {{supportEmail}} immediately.', {
    severity: 'info',
    sample: { field: 'display name', supportEmail: 'support@bitripay.com' },
  }),
  ev('account', 'account.tag.changed', 'Payment tag changed', 'Your @tag is now @{{tag}}', 'People can now pay you at @{{tag}}. Your old tag stops working.', { sample: { tag: 'amina' } }),
  ev('account', 'account.language.changed', 'Language changed', 'Language set to {{language}}', 'BitriPay now speaks {{language}} to you on every channel.', {
    channels: ['inapp'],
    sample: { language: 'Lingala' },
  }),
  ev('account', 'account.suspended', 'Account suspended', 'Your account has been suspended', 'Your {{appName}} account was suspended{{reason}}. Contact {{supportEmail}} to resolve this.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { reason: ' pending a compliance review', supportEmail: 'support@bitripay.com' },
  }),
  ev('account', 'account.reactivated', 'Account reactivated', 'Your account is active again', 'Welcome back. Your {{appName}} account was reactivated.', { severity: 'success' }),
  ev('account', 'account.closure.requested', 'Closure requested', 'Account closure requested', 'We received your request to close your account. Withdraw your remaining balance before {{date}}.', {
    severity: 'warning',
    mandatory: true,
    sample: { date: '30 September 2026' },
  }),
  ev('account', 'account.closed', 'Account closed', 'Your account has been closed', 'Your {{appName}} account is closed. Statements stay available for the retention period required by law.', {
    mandatory: true,
  }),
  ev('account', 'organisation.invited', 'Organisation invitation', '{{actor}} invited you to {{organisation}} on {{appName}}', 'Accept the invitation to join {{organisation}} as {{role}}.', {
    channels: ['email', 'inapp', 'push'],
    sample: { actor: 'Joseph', organisation: 'Kinshasa Market', role: 'cashier' },
  }),
  ev('account', 'organisation.invitation.accepted', 'Invitation accepted', '{{name}} joined {{organisation}}', '{{name}} accepted the invitation and is now {{role}} at {{organisation}}.', {
    severity: 'success',
    channels: ['inapp'],
    sample: { organisation: 'Kinshasa Market', role: 'cashier' },
  }),
  ev('account', 'organisation.member.removed', 'Removed from organisation', 'Your access to {{organisation}} was removed', 'You no longer have access to {{organisation}}.', {
    severity: 'warning',
    mandatory: true,
    sample: { organisation: 'Kinshasa Market' },
  }),
  ev('account', 'organisation.role.changed', 'Role changed', 'Your role at {{organisation}} is now {{role}}', 'Your permissions at {{organisation}} changed to {{role}}.', {
    channels: ['inapp', 'email'],
    sample: { organisation: 'Kinshasa Market', role: 'manager' },
  }),

  // ---------------------------------------------------------------- Login & Security
  ev('security', 'otp', 'One-time code', '{{appName}} verification code', 'Your {{appName}} verification code is {{code}}. It expires in {{minutes}} minutes.', {
    mandatory: true,
    channels: ['sms', 'email', 'whatsapp'],
    sample: { code: '482913', minutes: '10' },
  }),
  ev('security', 'auth.login.success', 'New sign-in', 'New sign-in to your {{appName}} account', 'Signed in from {{device}} ({{location}}) at {{time}}. Not you? Change your password now.', {
    channels: ['inapp'],
    sample: { device: 'Chrome on Windows', location: 'Kinshasa, CD', time: '14:03' },
  }),
  ev(
    'security',
    'auth.login.failed',
    'Failed sign-in',
    'Failed sign-in attempt',
    'A sign-in to your account failed from {{device}}. Your account is safe; if this keeps happening, change your password.',
    { severity: 'warning', channels: ['inapp'], sample: { device: 'unknown device' } },
  ),
  ev('security', 'auth.login.suspicious', 'Unusual sign-in', 'Unusual sign-in detected', 'A sign-in from {{location}} on {{device}} looked unusual. If it was not you, secure your account now.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { location: 'Lagos, NG', device: 'Android' },
  }),
  ev('security', 'auth.device.new', 'New device', 'New device signed in', '{{device}} signed in to your {{appName}} account for the first time.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { device: 'iPhone 15' },
  }),
  ev('security', 'passkey.registered', 'Passkey added', 'A passkey was added to your account', 'You can now sign in with biometrics on {{device}}.', {
    severity: 'success',
    mandatory: true,
    sample: { device: 'iPhone 15' },
  }),
  ev('security', 'passkey.removed', 'Passkey removed', 'A passkey was removed', 'The passkey "{{label}}" was removed from your account.', {
    severity: 'warning',
    mandatory: true,
    sample: { label: 'Work laptop' },
  }),
  ev('security', 'password.reset_link', 'Password reset', 'Reset your {{appName}} password', 'Use this link within {{minutes}} minutes to choose a new password: {{link}}', {
    mandatory: true,
    channels: ['email'],
    sample: { minutes: '15', link: 'https://bitripay.com/reset?token=…' },
  }),
  ev('security', 'password.changed', 'Password changed', 'Your password was changed', 'Your {{appName}} password was changed at {{time}}. If this was not you, contact {{supportEmail}} now.', {
    severity: 'success',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { time: '14:03', supportEmail: 'support@bitripay.com' },
  }),
  ev('security', 'pin.set', 'PIN set', 'Your transaction PIN was set', 'Your PIN protects every transfer, withdrawal and approval.', {
    severity: 'success',
    mandatory: true,
    channels: ['inapp', 'email'],
  }),
  ev('security', 'pin.changed', 'PIN changed', 'Your transaction PIN was changed', 'If you did not change it, contact {{supportEmail}} now.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { supportEmail: 'support@bitripay.com' },
  }),
  ev('security', 'mfa.enabled', 'Two-factor enabled', 'Two-factor authentication enabled', 'Your account now asks for an authenticator code at sign-in. Keep your recovery codes safe.', {
    severity: 'success',
    mandatory: true,
  }),
  ev('security', 'mfa.disabled', 'Two-factor disabled', 'Two-factor authentication disabled', 'Two-factor authentication was switched off. If this was not you, secure your account now.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
  }),
  ev('security', 'recovery_code.used', 'Recovery code used', 'Recovery code used', 'A recovery code was used to sign in to your account. {{remaining}} left{{hint}}.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { remaining: '7', hint: '' },
  }),
  ev('security', 'mfa.recovery_codes.regenerated', 'Recovery codes regenerated', 'New recovery codes generated', 'Your previous recovery codes no longer work.', { mandatory: true }),
  ev('security', 'session.revoked', 'Session signed out', 'A session was signed out', 'The session on {{device}} was signed out{{reason}}.', {
    severity: 'warning',
    mandatory: true,
    sample: { device: 'Chrome on Windows', reason: ' after a password change' },
  }),
  ev('security', 'account.locked', 'Account locked', 'Your account has been locked', 'Too many failed attempts. Your account is locked for {{minutes}} minutes.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { minutes: '30' },
  }),
  ev('security', 'account.unlocked', 'Account unlocked', 'Your account is unlocked', 'You can sign in again.', { severity: 'success' }),
  ev(
    'security',
    'destination.changed',
    'Payout destination changed',
    'Payout destination changed',
    '{{destination}} was added to your account. Large payouts to it start after {{hours}} hours. Not you? Revoke it now in Security.',
    { severity: 'warning', mandatory: true, channels: ['email', 'inapp', 'push', 'sms'], sample: { destination: 'bank account ••••8877', hours: '24' } },
  ),
  ev('security', 'destination.revoked', 'Payout destination revoked', 'A payout destination was revoked', '{{destination}} was removed and any pending payout to it was cancelled.', {
    severity: 'warning',
    mandatory: true,
    sample: { destination: 'bank account ••••8877' },
  }),
  ev('security', 'security.alert', 'Security alert', 'Security alert on your account', '{{detail}}', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms', 'push'],
    sample: { detail: 'Your API key was used from a new country.' },
  }),
  ev('security', 'security.step_up_required', 'Step-up required', 'Confirm it is you', 'Approve {{action}} with your PIN or biometrics in the app.', {
    severity: 'warning',
    channels: ['push', 'inapp'],
    sample: { action: 'a withdrawal of USD 500.00' },
  }),

  // ---------------------------------------------------------------- Wallet & Transfers
  ev(
    'wallet',
    'deposit.pending',
    'Deposit pending',
    'We are waiting for your {{method}} payment',
    'Send {{amount}} using reference {{reference}}. Your wallet is credited as soon as it is confirmed.',
    { channels: ['inapp', 'push'], sample: { method: 'bank transfer', amount: 'USD 100.00', reference: 'BT-7Y2K4A' } },
  ),
  ev('wallet', 'deposit.completed', 'Money added', 'Money added', '{{amount}} was added to your {{currency}} wallet.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email'],
    sample: { amount: '$100.00', currency: 'USD' },
  }),
  ev('wallet', 'deposit.failed', 'Deposit failed', 'Your deposit could not be completed', 'The {{method}} payment of {{amount}} was not confirmed{{reason}}. Nothing was taken from your wallet.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { method: 'mobile money', amount: 'CDF 50,000', reason: ': no matching receipt within 24 hours' },
  }),
  ev('wallet', 'transfer.sent', 'Transfer sent', 'You sent {{amount}} to {{recipient}}', '{{amount}} was sent to {{recipient}}{{note}}. Fee {{fee}}.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { amount: 'USD 25.00', recipient: '@joseph', note: ' for "lunch"', fee: 'USD 0.00' },
  }),
  ev('wallet', 'transfer.received', 'Money received', '{{sender}} sent you {{amount}}', '{{amount}} is now in your {{currency}} wallet{{note}}.', {
    severity: 'success',
    channels: ['inapp', 'push', 'sms', 'whatsapp'],
    sample: { sender: 'Amina K.', amount: 'USD 25.00', currency: 'USD', note: '' },
  }),
  ev('wallet', 'transfer.failed', 'Transfer failed', 'Your transfer did not go through', 'The transfer of {{amount}} to {{recipient}} failed{{reason}}. Your balance is unchanged.', {
    severity: 'warning',
    channels: ['inapp', 'push'],
    sample: { amount: 'USD 25.00', recipient: '@joseph', reason: ': daily limit reached' },
  }),
  ev('wallet', 'request.received', 'Payment request', '{{requester}} requests {{amount}}', '{{requester}} asked you for {{amount}}{{note}}. Pay or decline in the app.', {
    channels: ['inapp', 'push', 'sms'],
    sample: { requester: 'Joseph O.', amount: 'USD 40.00', note: ' for "rent share"' },
  }),
  ev('wallet', 'request.paid', 'Request paid', '{{payer}} paid your request', '{{payer}} paid {{amount}} for "{{note}}".', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { payer: 'Amina K.', amount: 'USD 40.00', note: 'rent share' },
  }),
  ev('wallet', 'request.declined', 'Request declined', '{{payer}} declined your request', 'The request for {{amount}} was declined.', {
    channels: ['inapp'],
    sample: { payer: 'Amina K.', amount: 'USD 40.00' },
  }),
  ev('wallet', 'request.expired', 'Request expired', 'Your payment request expired', 'The request for {{amount}} to {{payer}} expired without payment.', {
    channels: ['inapp'],
    sample: { amount: 'USD 40.00', payer: '@amina' },
  }),
  ev('wallet', 'withdrawal.requested', 'Withdrawal requested', 'Withdrawal of {{amount}} requested', 'Your withdrawal to {{destination}} is being reviewed. Funds are held until it is approved.', {
    channels: ['inapp', 'push'],
    sample: { amount: 'USD 200.00', destination: 'bank account ••••8877' },
  }),
  ev('wallet', 'withdrawal.approved', 'Withdrawal approved', 'Withdrawal approved', 'Your withdrawal of {{amount}} to {{destination}} was approved and is on its way. Reference {{reference}}.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email', 'sms'],
    sample: { amount: 'USD 200.00', destination: 'bank account ••••8877', reference: 'OPREF-12345' },
  }),
  ev('wallet', 'withdrawal.rejected', 'Withdrawal rejected', 'Withdrawal rejected', 'Your withdrawal of {{amount}} was rejected{{reason}}. The funds are back in your wallet.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'push', 'email'],
    sample: { amount: 'USD 200.00', reason: ': destination account name mismatch' },
  }),
  ev('wallet', 'withdrawal.paid', 'Withdrawal paid', 'Withdrawal paid out', '{{amount}} reached {{destination}}. Operator reference {{reference}}.', {
    severity: 'success',
    channels: ['inapp', 'push', 'sms'],
    sample: { amount: 'USD 200.00', destination: 'bank account ••••8877', reference: 'OPREF-12345' },
  }),
  ev('wallet', 'exchange.completed', 'Exchange completed', 'Exchanged {{fromAmount}} to {{toAmount}}', 'Rate {{rate}}. Both wallets are updated.', {
    severity: 'success',
    channels: ['inapp'],
    sample: { fromAmount: 'USD 100.00', toAmount: 'CDF 285,000', rate: '1 USD = 2,850 CDF' },
  }),
  ev('wallet', 'wallet.frozen', 'Wallet frozen', 'Your {{currency}} wallet is frozen', 'Your {{currency}} wallet was frozen{{reason}}. Contact {{supportEmail}}.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { currency: 'USD', reason: ' pending a compliance review', supportEmail: 'support@bitripay.com' },
  }),
  ev('wallet', 'wallet.unfrozen', 'Wallet unfrozen', 'Your {{currency}} wallet is active again', 'You can send and withdraw again.', { severity: 'success', sample: { currency: 'USD' } }),
  ev('wallet', 'limit.reached', 'Limit reached', 'You reached your {{period}} limit', 'Your {{period}} limit of {{limit}} is used up. Verify your identity to raise it.', {
    severity: 'warning',
    channels: ['inapp', 'push'],
    sample: { period: 'daily', limit: 'USD 1,000.00' },
  }),
  ev('wallet', 'statement.ready', 'Statement ready', 'Your {{period}} statement is ready', 'Download your {{period}} statement from the app or the link below. {{link}}', {
    channels: ['email', 'inapp'],
    sample: { period: 'August 2026', link: 'https://bitripay.com/statements' },
  }),
  ev('wallet', 'savings.goal.reached', 'Savings goal reached', 'You reached your goal: {{goal}}', 'Congratulations, {{amount}} saved.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { goal: 'School fees', amount: 'USD 500.00' },
  }),
  ev('wallet', 'referral.reward', 'Referral reward', 'You earned {{amount}}', '{{friend}} joined with your code. {{amount}} was added to your wallet.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { amount: 'USD 5.00', friend: 'Joseph' },
  }),

  // ---------------------------------------------------------------- Payments & Checkout
  ev('payments', 'payment.received', 'Payment received', 'Payment received: {{amount}}', '{{payerName}} paid {{amount}}{{description}}.', {
    severity: 'success',
    channels: ['inapp', 'push', 'sms', 'email'],
    sample: { payerName: 'Amina K.', amount: '$25.00', description: ' for "Order 1042"' },
  }),
  ev('payments', 'payment.rejected', 'Payment rejected', 'Payment rejected', '{{reason}}', { severity: 'warning', channels: ['inapp', 'push'], sample: { reason: 'Card declined by the issuer' } }),
  ev('payments', 'payment.expired', 'Payment expired', 'Payment {{reference}} expired', 'The payment of {{amount}} was not completed in time.', {
    channels: ['inapp'],
    sample: { reference: 'pi_7Y2K', amount: 'USD 25.00' },
  }),
  ev(
    'payments',
    'payment.pending_evidence',
    'Awaiting confirmation',
    'Waiting for the operator receipt',
    'We are matching the receipt for {{amount}} ({{reference}}). You will be told the moment it is confirmed.',
    { channels: ['inapp', 'push'], sample: { amount: 'CDF 50,000', reference: 'MM7Y2K4A' } },
  ),
  ev('payments', 'payment.manual_review', 'Payment under review', 'Your payment is being reviewed', 'The receipt for {{amount}} needs a human check. Usually done within {{hours}} hours.', {
    severity: 'warning',
    channels: ['inapp', 'push'],
    sample: { amount: 'CDF 50,000', hours: '2' },
  }),
  ev('payments', 'payment_link.paid', 'Payment link paid', '{{payerName}} paid your link "{{title}}"', '{{amount}} received through your payment link.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email'],
    sample: { payerName: 'Amina K.', title: 'Invoice 1042', amount: 'USD 120.00' },
  }),
  ev('payments', 'checkout.abandoned', 'Checkout abandoned', 'A customer left checkout', '{{customer}} left the checkout for {{amount}} at step {{step}}. Recovery options were offered.', {
    channels: ['inapp'],
    sample: { customer: 'a customer', amount: 'USD 25.00', step: 'mobile money' },
  }),
  ev('payments', 'refund.requested', 'Refund requested', 'Refund requested for {{reference}}', '{{customer}} asked for a refund of {{amount}}. Approve or decline in the merchant console.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { reference: 'pi_7Y2K', customer: 'Amina K.', amount: 'USD 25.00' },
  }),
  ev('payments', 'refund.processed', 'Refund processed', 'Refund of {{amount}} processed', 'Your refund for {{reference}} was sent back to the original method.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email'],
    sample: { amount: 'USD 25.00', reference: 'pi_7Y2K' },
  }),
  ev('payments', 'refund.failed', 'Refund failed', 'Refund could not be completed', 'The refund of {{amount}} failed{{reason}}. It is queued for manual handling.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'email'],
    sample: { amount: 'USD 25.00', reason: ': the rail has no refund API' },
  }),
  ev('payments', 'dispute.opened', 'Dispute opened', 'A dispute was opened on {{reference}}', '{{amount}} is on hold while the dispute is reviewed. Respond by {{deadline}}.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { reference: 'pi_7Y2K', amount: 'USD 25.00', deadline: '21 September 2026' },
  }),
  ev('payments', 'dispute.resolved', 'Dispute resolved', 'Dispute on {{reference}} resolved: {{outcome}}', '{{detail}}', {
    channels: ['email', 'inapp'],
    sample: { reference: 'pi_7Y2K', outcome: 'in your favour', detail: 'The held amount was released to your balance.' },
  }),
  ev('payments', 'settlement.paid', 'Settlement paid', 'Settlement of {{amount}} paid', '{{count}} payments were settled to {{destination}}. Reference {{reference}}.', {
    severity: 'success',
    channels: ['email', 'inapp'],
    sample: { amount: 'USD 1,240.00', count: '37', destination: 'bank account ••••8877', reference: 'ST-2026-09-14' },
  }),
  ev('payments', 'settlement.failed', 'Settlement failed', 'Settlement could not be paid', 'The settlement of {{amount}} failed{{reason}}. Your balance is untouched; we retry automatically.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { amount: 'USD 1,240.00', reason: ': destination account closed' },
  }),
  ev(
    'payments',
    'settlement.destination.changed',
    'Settlement destination changed',
    'Your settlement account was changed',
    'Settlements now go to {{destination}} after a {{hours}}-hour cooling-off. Not you? Revoke it in Security.',
    { severity: 'warning', mandatory: true, channels: ['email', 'inapp', 'sms'], sample: { destination: 'bank account ••••1234', hours: '24' } },
  ),
  ev('payments', 'subscription.charged', 'Subscription charged', '{{plan}}: {{amount}} charged', 'Your {{plan}} subscription renewed for {{period}}.', {
    channels: ['email', 'inapp'],
    sample: { plan: 'Command centre', amount: 'USD 29.00', period: 'September 2026' },
  }),
  ev('payments', 'subscription.failed', 'Subscription payment failed', 'We could not collect {{amount}}', 'Top up your wallet; we retry on {{retryDate}}. {{plan}} pauses if payment keeps failing.', {
    severity: 'warning',
    channels: ['email', 'inapp', 'push'],
    sample: { amount: 'USD 29.00', retryDate: '17 September 2026', plan: 'Command centre' },
  }),

  // ---------------------------------------------------------------- Remittance & Corridors
  ev('remittance', 'remittance.quote', 'Quote ready', 'Your quote: {{targetAmount}} for {{amount}}', 'Rate {{rate}}, fee {{fee}}, guaranteed until {{expires}}.', {
    channels: ['inapp'],
    sample: { targetAmount: 'CDF 285,000', amount: 'USD 100.00', rate: '2,850', fee: 'USD 2.00', expires: '14:33' },
  }),
  ev('remittance', 'remittance.sent', 'Remittance sent', 'Remittance sent', 'Your remittance of {{amount}} {{status}}{{pickupCode}}.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email'],
    sample: { amount: 'NGN 150,000.00', status: 'was delivered instantly', pickupCode: '' },
  }),
  ev('remittance', 'remittance.received', 'Remittance received', 'Remittance received', '{{senderName}} sent you {{amount}} from abroad.', {
    severity: 'success',
    channels: ['inapp', 'push', 'sms', 'whatsapp'],
    sample: { senderName: 'Amina K.', amount: 'NGN 150,000.00' },
  }),
  ev(
    'remittance',
    'remittance.in_progress',
    'Payout in progress',
    'Your money is on its way',
    'The payout of {{amount}} to {{recipient}} is being executed by our {{operator}} agent. Expected within {{minutes}} minutes.',
    { channels: ['inapp', 'push'], sample: { amount: 'CDF 285,000', recipient: 'Joseph O.', operator: 'Orange Money', minutes: '15' } },
  ),
  ev('remittance', 'remittance.delivered', 'Remittance delivered', 'Remittance delivered', 'Your remittance to {{recipientName}} has been paid out.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email', 'sms'],
    sample: { recipientName: 'Family' },
  }),
  ev(
    'remittance',
    'remittance.delayed',
    'Remittance delayed',
    'Your remittance is taking longer than usual',
    'The payout of {{amount}} to {{recipient}} is delayed{{reason}}. We keep trying and will confirm when it lands.',
    { severity: 'warning', mandatory: true, channels: ['inapp', 'push', 'email'], sample: { amount: 'CDF 285,000', recipient: 'Joseph O.', reason: ': the operator network is congested' } },
  ),
  ev('remittance', 'remittance.refunded', 'Remittance refunded', 'Remittance refunded', 'Your remittance was cancelled{{reason}}. Funds returned to your wallet.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'push', 'email'],
    sample: { reason: ': account closed' },
  }),
  ev('remittance', 'remittance.pickup', 'Cash picked up', 'Cash picked up', '{{recipientName}} collected {{amount}} at agent {{agentName}}.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { recipientName: 'Cousin', amount: '$50.00', agentName: 'Kinshasa Point' },
  }),
  ev('remittance', 'remittance.pickup_code', 'Pickup code', 'Your pickup code', '{{senderName}} sent you {{amount}}. Show code {{pickupCode}} and your ID at any BitriPay agent.', {
    mandatory: true,
    channels: ['sms', 'whatsapp'],
    sample: { senderName: 'Amina K.', amount: 'USD 50.00', pickupCode: 'PK-7Y2K' },
  }),
  ev(
    'remittance',
    'remittance.pickup_reminder',
    'Pickup reminder',
    'Your cash is waiting',
    '{{amount}} from {{senderName}} is still waiting at a BitriPay agent. Code {{pickupCode}}, valid until {{expires}}.',
    { channels: ['sms', 'whatsapp', 'push'], sample: { amount: 'USD 50.00', senderName: 'Amina K.', pickupCode: 'PK-7Y2K', expires: '21 September 2026' } },
  ),
  ev(
    'remittance',
    'remittance.currency_choice',
    'Choose payout currency',
    'Choose how to receive {{amount}}',
    '{{senderName}} sent you money. Receive it in {{options}}; reply in the app within {{hours}} hours.',
    { channels: ['push', 'sms', 'whatsapp', 'inapp'], sample: { amount: 'USD 100.00', senderName: 'Amina K.', options: 'USD or CDF', hours: '24' } },
  ),
  ev('remittance', 'corridor.live', 'Corridor live', '{{corridor}} is live', 'Customers can now send on {{corridor}}. Payout partner {{partner}}.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { corridor: 'GBP → CD CDF via Orange Money', partner: 'BitriPay SARL' },
  }),
  ev('remittance', 'corridor.suspended', 'Corridor suspended', '{{corridor}} was suspended', '{{reason}}. Sends on this corridor are refused until it is restored.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'push', 'sms'],
    sample: { corridor: 'GBP → CD CDF via Orange Money', reason: 'The licence on record expired' },
  }),
  ev('remittance', 'corridor.licence_expiring', 'Licence expiring', 'Licence for {{corridor}} expires in {{days}} days', 'Renew the licence and update the expiry date in Corridors before {{date}}.', {
    severity: 'warning',
    channels: ['email', 'inapp'],
    sample: { corridor: 'GBP → CD CDF', days: '30', date: '14 October 2026' },
  }),

  // ---------------------------------------------------------------- Mobile money & Evidence
  ev(
    'momo',
    'momo.instructions',
    'Mobile money instructions',
    'Pay {{amount}} to {{collectionNumber}}',
    'Open {{operator}}{{ussd}}, send exactly {{amount}} to {{collectionNumber}} ({{accountName}}) with reference {{reference}}.',
    {
      channels: ['inapp', 'push', 'sms'],
      sample: { amount: 'CDF 50,000', collectionNumber: '+243 89 000 0000', operator: 'Orange Money', ussd: ' (dial #144#)', accountName: 'BitriPay SARL', reference: 'MM7Y2K4A' },
    },
  ),
  ev('momo', 'evidence.received', 'Receipt received', 'We received the operator receipt', 'The receipt for {{amount}} ({{reference}}) arrived and is being matched.', {
    channels: ['inapp'],
    sample: { amount: 'CDF 50,000', reference: 'MM7Y2K4A' },
  }),
  ev('momo', 'evidence.matched', 'Payment confirmed', 'Payment confirmed: {{amount}}', 'The {{operator}} receipt matched your payment {{reference}}. Your wallet is credited.', {
    severity: 'success',
    channels: ['inapp', 'push', 'sms'],
    sample: { amount: 'CDF 50,000', operator: 'Orange Money', reference: 'MM7Y2K4A' },
  }),
  ev(
    'momo',
    'evidence.unmatched',
    'Receipt not matched',
    'A receipt could not be matched',
    'A {{operator}} receipt for {{amount}} from {{sender}} matches no pending payment. It is in the manual review queue.',
    { severity: 'warning', channels: ['inapp', 'email'], sample: { operator: 'Orange Money', amount: 'CDF 50,000', sender: '+243 81 000 0000' } },
  ),
  ev('momo', 'evidence.duplicate', 'Duplicate receipt', 'A receipt was received twice', 'The receipt {{reference}} was already applied; the duplicate was ignored.', {
    channels: ['inapp'],
    sample: { reference: 'MM7Y2K4A' },
  }),
  ev('momo', 'evidence.manual_review', 'Manual review needed', 'A payment needs your review', '{{count}} receipt(s) could not be settled automatically. Review them in the Verification console.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { count: '3' },
  }),
  ev('momo', 'device.enrolled', 'Device enrolled', '{{device}} was enrolled', 'The payout device {{device}} ({{sim}}) is active for {{account}}. Its signed receipts now settle payments.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { device: 'Kinshasa SIM 1', sim: '+243 89 000 0000', account: 'Orange Money Kinshasa' },
  }),
  ev('momo', 'device.revoked', 'Device revoked', '{{device}} was revoked', 'Receipts from {{device}} are no longer accepted.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'email'],
    sample: { device: 'Kinshasa SIM 1' },
  }),
  ev('momo', 'device.offline', 'Device silent', '{{device}} has not reported for {{hours}} hours', 'Payments on {{account}} fall back to manual review until the device is back.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { device: 'Kinshasa SIM 1', hours: '6', account: 'Orange Money Kinshasa' },
  }),
  ev('momo', 'collection_number.changed', 'Collection number changed', 'Collection number for {{operator}} changed', 'Customers now pay {{operator}} to {{collectionNumber}}. Changed by {{actor}}.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'email'],
    sample: { operator: 'Orange Money', collectionNumber: '+243 89 000 0001', actor: 'admin@bitripay.com' },
  }),
  ev('momo', 'operator.disabled', 'Operator disabled', '{{operator}} payments paused', '{{operator}} was disabled{{reason}}. Customers are offered the other operators.', {
    severity: 'warning',
    channels: ['inapp', 'email'],
    sample: { operator: 'Airtel Money', reason: ' by an administrator' },
  }),

  // ---------------------------------------------------------------- Agents & Payout devices
  ev('agents', 'agent.cash_in', 'Cash-in completed', 'Cash-in of {{amount}} completed', '{{customer}} was credited {{amount}} from your float. Commission {{commission}}.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { amount: 'CDF 100,000', customer: '@amina', commission: 'CDF 500' },
  }),
  ev('agents', 'agent.cash_out.requested', 'Cash-out request', '{{customer}} wants to cash out {{amount}}', 'Code {{code}}. Hand over the cash only after confirming the code in the app.', {
    channels: ['inapp', 'push', 'sms'],
    sample: { customer: 'Amina K.', amount: 'CDF 100,000', code: 'CO-7Y2K' },
  }),
  ev('agents', 'agent.cash_out.confirmed', 'Cash-out confirmed', 'Cash-out of {{amount}} confirmed', 'Your float increased by {{amount}} plus {{commission}} commission.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { amount: 'CDF 100,000', commission: 'CDF 500' },
  }),
  ev('agents', 'customer.cash_out.ready', 'Cash-out code', 'Your cash-out code', 'Show code {{code}} to {{agent}} to collect {{amount}}. Valid until {{expires}}.', {
    mandatory: true,
    channels: ['push', 'sms', 'inapp'],
    sample: { code: 'CO-7Y2K', agent: 'Kinshasa Point', amount: 'CDF 100,000', expires: '15:30' },
  }),
  ev('agents', 'agent.float.low', 'Float low', 'Your float is below {{threshold}}', 'Balance {{balance}}. Prefund now so payouts keep flowing.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'sms'],
    sample: { threshold: 'CDF 500,000', balance: 'CDF 320,000' },
  }),
  ev('agents', 'agent.float.prefunded', 'Float prefunded', 'Float prefunded with {{amount}}', 'Your payout account {{account}} now holds {{balance}}. {{requeued}} waiting payout(s) resumed.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { amount: 'CDF 1,000,000', account: 'Orange Money Kinshasa', balance: 'CDF 1,320,000', requeued: '2' },
  }),
  ev('agents', 'agent.float.request.approved', 'Float request approved', 'Your float request was approved', '{{amount}} was added to your float after maker-checker approval.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { amount: 'CDF 1,000,000' },
  }),
  ev(
    'agents',
    'payout.instruction.assigned',
    'Payout to execute',
    'New payout: {{amount}} to {{recipient}}',
    'Execute on {{operator}} from SIM {{sim}} and forward the receipt. Claim it in the payout device within {{minutes}} minutes.',
    { severity: 'warning', channels: ['push', 'inapp', 'sms'], sample: { amount: 'CDF 285,000', recipient: '+243 81 000 0000', operator: 'Orange Money', sim: '+243 89 000 0000', minutes: '15' } },
  ),
  ev('agents', 'payout.instruction.claimed', 'Payout claimed', '{{agent}} is executing the payout', 'Payout {{reference}} was claimed on device {{device}}.', {
    channels: ['inapp'],
    sample: { agent: 'Joseph O.', reference: 'PO-7Y2K', device: 'Kinshasa SIM 1' },
  }),
  ev('agents', 'payout.paid', 'Payout delivered', 'Payout delivered', '{{amount}} was delivered to {{recipient}} ({{rail}}). Operator reference {{reference}}.', {
    severity: 'success',
    channels: ['inapp', 'push', 'sms', 'whatsapp'],
    sample: { amount: 'KES 5,000.00', recipient: 'Joseph O.', rail: 'M-PESA', reference: 'BP-7Y2K', senderName: 'Amina K.' },
  }),
  ev('agents', 'payout.failed', 'Payout failed', 'Payout failed', '{{reason}}. The funds are back in your wallet.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'push', 'email'],
    sample: { reason: 'Operator unavailable' },
  }),
  ev('agents', 'payout.instruction.expired', 'Payout instruction expired', 'Payout {{reference}} was not executed in time', 'The instruction returned to the queue and was reassigned.', {
    severity: 'warning',
    channels: ['inapp', 'push'],
    sample: { reference: 'PO-7Y2K' },
  }),
  ev('agents', 'agent.commission.paid', 'Commission paid', 'Commission of {{amount}} paid', 'Your commission for {{period}} was paid to your wallet.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { amount: 'CDF 45,000', period: 'week 37' },
  }),
  ev('agents', 'agent.trust_score.changed', 'Trust score updated', 'Your trust score is now {{score}}', '{{detail}}', {
    channels: ['inapp'],
    sample: { score: '87', detail: 'On-time payouts over the last 30 days raised your score.' },
  }),
  ev('agents', 'agent.due_diligence.required', 'Due diligence required', 'Documents needed to keep operating', 'Upload {{documents}} before {{date}} to keep your agent account active.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { documents: 'a valid ID and proof of address', date: '30 September 2026' },
  }),

  // ---------------------------------------------------------------- KYC & Compliance
  ev('kyc', 'kyc.required', 'Verification required', 'Verify your identity to continue', '{{action}} needs a verified identity. It takes two minutes in the app.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { action: 'Withdrawing' },
  }),
  ev('kyc', 'kyc.submitted', 'Documents received', 'We received your documents', 'Your identity documents are being reviewed. Usually within {{hours}} hours.', {
    channels: ['inapp', 'email'],
    sample: { hours: '24' },
  }),
  ev('kyc', 'kyc.approved', 'Identity verified', 'Identity verified', 'Your KYC verification was approved. Higher limits are now active.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email'],
  }),
  ev('kyc', 'kyc.rejected', 'Verification rejected', 'Verification rejected', 'Your KYC submission was rejected{{reason}}. You can submit again.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { reason: ': document unreadable' },
  }),
  ev('kyc', 'kyc.tier.upgraded', 'Limits raised', 'You are now Tier {{tier}}', 'Your limits are now {{limits}}.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { tier: '2', limits: 'USD 5,000 per day' },
  }),
  ev('kyc', 'kyc.document.expiring', 'Document expiring', 'Your {{document}} expires on {{date}}', 'Upload a renewed document to keep your limits.', {
    severity: 'warning',
    channels: ['email', 'inapp'],
    sample: { document: 'passport', date: '30 October 2026' },
  }),
  ev('kyc', 'kyb.submitted', 'Business verification received', 'We received your business documents', '{{business}} is being verified. Usually within {{days}} business days.', {
    channels: ['email', 'inapp'],
    sample: { business: 'Kinshasa Market SARL', days: '3' },
  }),
  ev('kyc', 'kyb.approved', 'Business verified', '{{business}} is verified', 'Merchant limits and settlements are now active.', {
    severity: 'success',
    channels: ['email', 'inapp', 'push'],
    sample: { business: 'Kinshasa Market SARL' },
  }),
  ev('kyc', 'kyb.rejected', 'Business verification rejected', 'Business verification needs attention', '{{business}} could not be verified{{reason}}. Update the documents and resubmit.', {
    severity: 'warning',
    channels: ['email', 'inapp'],
    sample: { business: 'Kinshasa Market SARL', reason: ': registration certificate expired' },
  }),
  ev('kyc', 'compliance.review.opened', 'Compliance review', 'A compliance review was opened on your account', '{{detail}} Some actions are limited until it is closed.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { detail: 'A transaction pattern needs a routine check.' },
  }),
  ev('kyc', 'compliance.review.closed', 'Review closed', 'Your compliance review is closed', 'All limits are restored. Thank you for your patience.', { severity: 'success', mandatory: true }),
  ev('kyc', 'compliance.information.requested', 'Information requested', 'We need some information from you', '{{request}} Reply through the app by {{date}}.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { request: 'Please explain the source of funds for the transfer on 12 September.', date: '20 September 2026' },
  }),
  ev(
    'kyc',
    'sanctions.hit.blocked',
    'Transaction blocked',
    'A transaction was blocked',
    'The transaction of {{amount}} to {{counterparty}} was blocked by screening. Contact {{supportEmail}} if you believe this is a mistake.',
    { severity: 'critical', mandatory: true, channels: ['email', 'inapp'], sample: { amount: 'USD 500.00', counterparty: 'the named recipient', supportEmail: 'support@bitripay.com' } },
  ),

  // ---------------------------------------------------------------- Cards
  ev('cards', 'virtual_card.issued', 'Virtual card issued', 'Virtual card issued', 'Your new {{currency}} virtual card ending in {{last4}} is ready.', {
    severity: 'success',
    channels: ['inapp', 'push'],
    sample: { currency: 'USD', last4: '4821' },
  }),
  ev('cards', 'virtual_card.charged', 'Card payment', 'Card payment', '{{amount}} was charged to your virtual card •••• {{last4}} at {{merchantName}}.', {
    channels: ['inapp', 'push'],
    sample: { amount: '$25.00', last4: '4821', merchantName: 'Shop' },
  }),
  ev('cards', 'virtual_card.declined', 'Card declined', 'Card •••• {{last4}} declined', '{{amount}} at {{merchantName}} was declined{{reason}}.', {
    severity: 'warning',
    channels: ['inapp', 'push'],
    sample: { last4: '4821', amount: '$250.00', merchantName: 'Shop', reason: ': above the card limit' },
  }),
  ev('cards', 'virtual_card.frozen', 'Card frozen', 'Card •••• {{last4}} frozen', 'The card is frozen{{reason}}. Unfreeze it in the app when ready.', {
    severity: 'warning',
    mandatory: true,
    channels: ['inapp', 'push', 'email'],
    sample: { last4: '4821', reason: ' at your request' },
  }),
  ev('cards', 'virtual_card.unfrozen', 'Card unfrozen', 'Card •••• {{last4}} active', 'The card can be used again.', { severity: 'success', channels: ['inapp'], sample: { last4: '4821' } }),
  ev('cards', 'virtual_card.limit.changed', 'Card limit changed', 'Limit on •••• {{last4}} is now {{limit}}', 'Changed at {{time}}.', {
    mandatory: true,
    channels: ['inapp', 'push'],
    sample: { last4: '4821', limit: 'USD 500 per month', time: '14:03' },
  }),
  ev('cards', 'virtual_card.expiring', 'Card expiring', 'Card •••• {{last4}} expires {{date}}', 'Issue a new card in the app to keep paying online.', {
    channels: ['inapp', 'email'],
    sample: { last4: '4821', date: '10/2026' },
  }),
  ev('cards', 'virtual_card.closed', 'Card closed', 'Card •••• {{last4}} closed', 'The remaining balance {{balance}} was returned to your wallet.', {
    mandatory: true,
    channels: ['inapp', 'email'],
    sample: { last4: '4821', balance: 'USD 12.40' },
  }),

  // ---------------------------------------------------------------- Merchant, API & Webhooks
  ev('merchant', 'api_key.created', 'API key created', 'A new API key was created', 'Key {{label}} ({{mode}}) was created by {{actor}}. Rotate it immediately if this was not expected.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { label: 'Website', mode: 'live', actor: 'joseph@example.com' },
  }),
  ev('merchant', 'api_key.rotated', 'API key rotated', 'API key {{label}} was rotated', 'The old key stops working in {{hours}} hours.', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { label: 'Website', hours: '24' },
  }),
  ev('merchant', 'api_key.revoked', 'API key revoked', 'API key {{label}} was revoked', 'Requests with this key are refused from now on.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { label: 'Website' },
  }),
  ev('merchant', 'webhook.failing', 'Webhook failing', 'Your webhook {{url}} is failing', '{{failures}} deliveries failed in a row (last error {{error}}). We keep retrying for 24 hours.', {
    severity: 'warning',
    channels: ['email', 'inapp', 'push'],
    sample: { url: 'https://shop.example.com/hooks', failures: '5', error: 'HTTP 502' },
  }),
  ev('merchant', 'webhook.disabled', 'Webhook disabled', 'Webhook {{url}} was disabled', 'Deliveries failed for 24 hours. Fix the endpoint and re-enable it in the developer portal.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { url: 'https://shop.example.com/hooks' },
  }),
  ev('merchant', 'webhook.recovered', 'Webhook recovered', 'Webhook {{url}} is delivering again', 'Missed events were replayed.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { url: 'https://shop.example.com/hooks' },
  }),
  ev('merchant', 'integration.installed', 'Integration connected', '{{integration}} connected', 'Payments from {{integration}} now appear in your merchant console.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { integration: 'WooCommerce' },
  }),
  ev('merchant', 'merchant.live', 'Live mode enabled', 'Your merchant account is live', 'You can now accept real payments. Live keys are in the developer portal.', {
    severity: 'success',
    channels: ['email', 'inapp', 'push'],
  }),
  ev('merchant', 'merchant.acceptance_score', 'Acceptance score', 'Your acceptance score this week: {{score}}', '{{recommendation}}', {
    channels: ['inapp', 'email'],
    sample: { score: '92', recommendation: 'Enable mobile money recovery to lift it further.' },
  }),
  ev('merchant', 'merchant.daily_summary', 'Daily summary', 'Yesterday: {{count}} payments, {{amount}}', 'Refunds {{refunds}}, disputes {{disputes}}, settlement {{settlement}}.', {
    channels: ['email', 'inapp'],
    sample: { count: '37', amount: 'USD 1,240.00', refunds: '1', disputes: '0', settlement: 'paid' },
  }),
  ev('merchant', 'business_unit.created', 'Business unit created', '{{unit}} was created', '{{actor}} created the business unit {{unit}} in {{organisation}}.', {
    channels: ['inapp'],
    sample: { unit: 'Gombe branch', actor: 'Joseph O.', organisation: 'Kinshasa Market' },
  }),

  // ---------------------------------------------------------------- Approvals & Maker-checker
  ev('approvals', 'approval.requested', 'Approval needed', 'Approval needed: {{item}}', '{{proposer}} proposed {{item}} ({{amount}}). Approve or decline with your PIN.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { item: 'a withdrawal', proposer: 'Amina K.', amount: 'USD 5,000.00' },
  }),
  ev('approvals', 'approval.reminder', 'Approval pending', 'Reminder: {{item}} is waiting for approval', 'Proposed {{age}} ago by {{proposer}}.', {
    severity: 'warning',
    channels: ['inapp', 'push'],
    sample: { item: 'a withdrawal', age: '2 hours', proposer: 'Amina K.' },
  }),
  ev('approvals', 'approval.approved', 'Approved', '{{item}} was approved', '{{approver}} approved {{item}}. It is now executing.', {
    severity: 'success',
    channels: ['inapp', 'push', 'email'],
    sample: { item: 'the withdrawal of USD 5,000.00', approver: 'Joseph O.' },
  }),
  ev('approvals', 'approval.declined', 'Declined', '{{item}} was declined', '{{approver}} declined {{item}}{{reason}}.', {
    severity: 'warning',
    channels: ['inapp', 'push', 'email'],
    sample: { item: 'the withdrawal of USD 5,000.00', approver: 'Joseph O.', reason: ': destination not verified' },
  }),
  ev('approvals', 'approval.expired', 'Approval expired', '{{item}} expired unapproved', 'No second administrator approved it within {{hours}} hours. Propose it again if still needed.', {
    severity: 'warning',
    channels: ['inapp', 'email'],
    sample: { item: 'the withdrawal of USD 5,000.00', hours: '48' },
  }),
  ev('approvals', 'approval.sla_breach', 'Approval overdue', 'SLA breach: {{item}} approval overdue', 'Waiting {{age}}. Escalated to every approver.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms', 'push'],
    sample: { item: 'a withdrawal of USD 5,000.00', age: '26 hours' },
  }),
  ev('approvals', 'approval.self_approval_blocked', 'Self-approval blocked', 'You cannot approve your own proposal', 'Maker-checker requires a different administrator to approve {{item}}.', {
    channels: ['inapp'],
    sample: { item: 'the reserve funding' },
  }),
  ev('approvals', 'approval.step_up_failed', 'Step-up failed', 'A PIN attempt failed on an approval', '{{actor}} entered a wrong PIN while approving {{item}}.', {
    severity: 'warning',
    channels: ['inapp'],
    sample: { actor: 'Joseph O.', item: 'a withdrawal' },
  }),
  ev(
    'approvals',
    'issuance.proposed',
    'Issuance proposed',
    'E-money issuance of {{amount}} proposed',
    '{{proposer}} proposed issuing {{amount}} {{currency}} against reserves. A second administrator with the issuance permission must approve.',
    { severity: 'warning', channels: ['inapp', 'push', 'email'], sample: { amount: '10,000.00', currency: 'USD', proposer: 'Amina K.' } },
  ),

  // ---------------------------------------------------------------- E-money, Treasury & Liquidity
  ev(
    'treasury',
    'reserve.funding.proposed',
    'Reserve funding proposed',
    'Reserve funding of {{amount}} recorded',
    '{{proposer}} recorded a safeguarding transfer ({{reference}}). Clear it with your PIN once the bank line is confirmed.',
    { severity: 'warning', channels: ['inapp', 'push', 'email'], sample: { amount: 'USD 50,000.00', proposer: 'Amina K.', reference: 'SAFE-2026-09-14' } },
  ),
  ev('treasury', 'reserve.funding.cleared', 'Reserve funding cleared', 'Reserves for {{currency}} increased by {{amount}}', 'Cleared by {{approver}}. Cover ratio {{ratio}}.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { currency: 'USD', amount: 'USD 50,000.00', approver: 'Joseph O.', ratio: '104 %' },
  }),
  ev(
    'treasury',
    'reserve.breach',
    'Reserve breach',
    'Reserve breach on {{currency}}',
    'Outstanding e-money {{outstanding}} exceeds cleared reserves {{reserves}}. Issuance is suspended until reserves are restored.',
    { severity: 'critical', mandatory: true, channels: ['email', 'inapp', 'sms', 'push'], sample: { currency: 'USD', outstanding: 'USD 52,000.00', reserves: 'USD 50,000.00' } },
  ),
  ev('treasury', 'reserve.headroom.low', 'Reserve headroom low', 'Reserve headroom on {{currency}} is {{headroom}}', 'Issuance stops when it reaches zero. Plan a safeguarding transfer.', {
    severity: 'warning',
    channels: ['email', 'inapp'],
    sample: { currency: 'USD', headroom: 'USD 1,200.00' },
  }),
  ev('treasury', 'programme.live', 'Programme live', 'E-money programme {{currency}}/{{jurisdiction}} is live', 'Issuer {{issuer}}, regulator {{regulator}}.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { currency: 'USD', jurisdiction: 'CD', issuer: 'Licensed issuer', regulator: 'Banque Centrale du Congo' },
  }),
  ev('treasury', 'programme.suspended', 'Programme suspended', 'E-money programme {{currency}}/{{jurisdiction}} suspended', '{{reason}}. Issuance is stopped; balances stay redeemable.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { currency: 'USD', jurisdiction: 'CD', reason: 'Safeguarding reconciliation found a breach' },
  }),
  ev('treasury', 'reconciliation.completed', 'Reconciliation completed', 'Reconciliation for {{date}}: {{matched}} matched, {{exceptions}} exception(s)', 'Auto-match rate {{rate}}.', {
    channels: ['inapp', 'email'],
    sample: { date: '13 September 2026', matched: '412', exceptions: '3', rate: '99.3 %' },
  }),
  ev('treasury', 'reconciliation.exception', 'Reconciliation exception', 'Exception on {{reference}}', '{{detail}} Resolve it in Finance operations.', {
    severity: 'warning',
    channels: ['inapp', 'email'],
    sample: { reference: 'MM7Y2K4A', detail: 'Operator statement shows CDF 50,000; ledger shows CDF 45,000.' },
  }),
  ev('treasury', 'guardian.halt', 'Guardian halt', 'Guardian halted posting on {{stream}}', 'Invariant {{invariant}} failed. Nothing posts on this stream until an administrator clears it.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms', 'push'],
    sample: { stream: 'ledger', invariant: 'balanced double entry' },
  }),
  ev('treasury', 'guardian.cleared', 'Guardian cleared', 'Guardian halt on {{stream}} cleared', 'Cleared by {{actor}}. Posting resumed.', {
    severity: 'success',
    channels: ['inapp', 'email'],
    sample: { stream: 'ledger', actor: 'Joseph O.' },
  }),
  ev(
    'treasury',
    'rates.stale',
    'Exchange rates stale',
    'Exchange rates are stale',
    'Rate refresh from {{provider}} keeps failing: {{error}}. Guaranteed quotes are disabled until rates are fresher than {{hours}} h.',
    { severity: 'warning', mandatory: true, channels: ['email', 'inapp', 'push'], sample: { provider: 'open.er-api.com', error: 'HTTP 403', hours: '6' } },
  ),
  ev('treasury', 'float.rebalance.suggested', 'Float rebalance', 'Move {{amount}} from {{from}} to {{to}}', 'The Rebalancer forecasts {{to}} runs dry in {{hours}} hours.', {
    channels: ['inapp', 'email'],
    sample: { amount: 'CDF 2,000,000', from: 'Airtel Money Lubumbashi', to: 'Orange Money Kinshasa', hours: '18' },
  }),
  ev('treasury', 'liquidity.corridor.short', 'Corridor liquidity short', '{{corridor}} cannot pay out', 'Payout accounts on {{corridor}} hold {{balance}} against {{queued}} queued. Prefund now.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms', 'push'],
    sample: { corridor: 'GBP → CD CDF', balance: 'CDF 120,000', queued: 'CDF 2,850,000' },
  }),

  // ---------------------------------------------------------------- Support & Success
  ev('support', 'support.ticket.created', 'Ticket created', 'Ticket {{number}} created: {{subject}}', 'We received your message and will reply within {{hours}} hours.', {
    channels: ['email', 'inapp'],
    sample: { number: 'T-1042', subject: 'Deposit not credited', hours: '24' },
  }),
  ev('support', 'support.ticket.replied', 'Support replied', 'Reply on ticket {{number}}', '{{agent}} replied: "{{preview}}"', {
    channels: ['email', 'inapp', 'push'],
    sample: { number: 'T-1042', agent: 'BitriPay support', preview: 'We found the receipt and credited your wallet.' },
  }),
  ev('support', 'support.ticket.resolved', 'Ticket resolved', 'Ticket {{number}} resolved', 'Tell us how we did: {{link}}', {
    severity: 'success',
    channels: ['email', 'inapp'],
    sample: { number: 'T-1042', link: 'https://bitripay.com/support' },
  }),
  ev('support', 'support.ticket.closed', 'Ticket closed', 'Ticket {{number}} closed', 'Reopen it any time by replying.', { channels: ['inapp'], sample: { number: 'T-1042' } }),
  ev('support', 'chat.message', 'New chat message', '{{agent}}: {{preview}}', '{{preview}}', {
    channels: ['push', 'inapp'],
    sample: { agent: 'BitriPay support', preview: 'Can you share the operator reference?' },
  }),
  ev('support', 'onboarding.started', 'Welcome aboard', 'Let us get you set up', 'Three steps: verify your identity, add money, send your first payment.', { channels: ['email', 'inapp'] }),
  ev('support', 'onboarding.completed', 'You are all set', 'You are all set up', 'Everything is verified and funded. Enjoy {{appName}}.', {
    severity: 'success',
    channels: ['email', 'inapp', 'push'],
  }),
  ev('support', 'merchant.onboarding.step', 'Next merchant step', 'Next: {{step}}', '{{detail}}', {
    channels: ['inapp', 'email'],
    sample: { step: 'Add your settlement account', detail: 'Settlements need a verified bank account or mobile money number.' },
  }),
  ev('support', 'nps.survey', 'Quick question', 'How likely are you to recommend {{appName}}?', 'One tap, thirty seconds: {{link}}', {
    channels: ['email', 'inapp'],
    sample: { link: 'https://bitripay.com/survey' },
  }),

  // ---------------------------------------------------------------- Platform & System
  ev(
    'platform',
    'system.maintenance.scheduled',
    'Scheduled maintenance',
    'Scheduled maintenance on {{date}}',
    '{{appName}} will pause for {{duration}} from {{time}}. Payments queue and resume automatically.',
    { channels: ['email', 'inapp'], sample: { date: '21 September 2026', duration: '30 minutes', time: '02:00 UTC' } },
  ),
  ev('platform', 'system.maintenance.emergency', 'Emergency maintenance', 'Emergency maintenance in progress', '{{detail}} We will confirm when service is back.', {
    severity: 'warning',
    mandatory: true,
    channels: ['email', 'inapp', 'sms', 'push'],
    sample: { detail: 'A database fail-over is in progress.' },
  }),
  ev('platform', 'system.outage', 'Service disruption', 'Service disruption', '{{detail}} Your balances are safe; no money is lost.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms', 'push'],
    sample: { detail: 'Mobile money confirmations are delayed.' },
  }),
  ev('platform', 'system.service_restored', 'Service restored', 'Service restored', 'Everything is running normally again. Queued operations completed.', {
    severity: 'success',
    channels: ['email', 'inapp', 'push'],
  }),
  ev('platform', 'system.slo_breach', 'SLO breach', 'SLO breach: {{slo}}', '{{detail}}', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'push'],
    sample: { slo: 'payment confirmation p95 < 60 s', detail: 'p95 is 140 s over the last 15 minutes.' },
  }),
  ev(
    'platform',
    'admin.created',
    'Administrator created',
    'You are an administrator on {{appName}}',
    '{{actor}} gave you administrator access with {{permissions}}. Sign in, set up two-factor authentication and save a PIN.',
    { mandatory: true, channels: ['email', 'inapp'], sample: { actor: 'admin@bitripay.com', permissions: 'approvals, issuance, treasury' } },
  ),
  ev('platform', 'admin.permissions.changed', 'Permissions changed', 'Your administrator permissions changed', 'Now: {{permissions}}. Changed by {{actor}}.', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { permissions: 'approvals, kyc', actor: 'admin@bitripay.com' },
  }),
  ev('platform', 'go_live.ready', 'Ready for live', 'Every go-live item is green', 'Switch compliance mode to live under Gateway controls & risk when you are ready.', {
    severity: 'success',
    channels: ['email', 'inapp', 'push'],
  }),
  ev(
    'platform',
    'go_live.switched',
    'Platform is live',
    '{{appName}} switched to live mode',
    '{{actor}} switched compliance mode to live at {{time}}. Live customer funds are now accepted on authorised corridors.',
    { severity: 'success', mandatory: true, channels: ['email', 'inapp', 'sms'], sample: { actor: 'admin@bitripay.com', time: '14:03 UTC' } },
  ),
  ev('platform', 'audit.policy_violation', 'Policy violation', 'Policy violation detected', '{{detail}}', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp', 'sms'],
    sample: { detail: 'An administrator attempted to approve their own proposal.' },
  }),
  ev('platform', 'backup.failed', 'Backup failed', 'The nightly backup failed', '{{error}}. Check the backup container.', {
    severity: 'critical',
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { error: 'No space left on device' },
  }),
  ev('platform', 'notice.generic', 'Notice', '{{title}}', '{{body}}', { channels: ['inapp', 'push'], sample: { title: 'Notice', body: 'A plain in-app notice.' } }),

  // ---------------------------------------------------------------- Legal & Privacy
  ev('legal', 'privacy.consent_request', 'Consent request', 'We need your consent', '{{detail}} Review it in Settings → Privacy.', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { detail: 'We updated how we use your transaction data for fraud prevention.' },
  }),
  ev('legal', 'privacy.consent_updated', 'Consent updated', 'Your consent preferences were updated', 'Changed at {{time}}.', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { time: '14:03' },
  }),
  ev('legal', 'terms.updated', 'Terms updated', 'Our terms are changing on {{date}}', 'Read what changes: {{link}}. Continuing to use {{appName}} after {{date}} means you accept them.', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { date: '1 October 2026', link: 'https://bitripay.com/legal/terms' },
  }),
  ev('legal', 'privacy.data_export_ready', 'Data export ready', 'Your data export is ready', 'Download it within {{days}} days: {{link}}', {
    severity: 'success',
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { days: '7', link: 'https://bitripay.com/settings' },
  }),
  ev(
    'legal',
    'privacy.deletion_requested',
    'Deletion requested',
    'Account deletion requested',
    'We received your request. Statements are kept for {{years}} years as the law requires; everything else is erased on {{date}}.',
    { severity: 'warning', mandatory: true, channels: ['email', 'inapp'], sample: { years: '5', date: '14 October 2026' } },
  ),
  ev('legal', 'privacy.deletion_completed', 'Deletion completed', 'Your data has been deleted', 'Your {{appName}} account and personal data were erased as requested.', {
    mandatory: true,
    channels: ['email'],
  }),
  ev('legal', 'regulatory.notice', 'Regulatory notice', 'Regulatory notice: {{title}}', '{{detail}}', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { title: 'Transaction limits updated', detail: "Following the regulator's instruction, unverified accounts are limited to USD 500 per month." },
  }),
  ev('legal', 'fees.changed', 'Fees changing', 'Fee changes from {{date}}', '{{detail}}', {
    mandatory: true,
    channels: ['email', 'inapp'],
    sample: { date: '1 October 2026', detail: 'Bank withdrawal fee changes from USD 1.00 to USD 0.80.' },
  }),
];

export const COMMS_EVENT_BY_ID: Map<string, CommsEvent> = new Map(COMMS_EVENTS.map((e) => [e.id, e]));
export const getCommsEvent = (id: string): CommsEvent | undefined => COMMS_EVENT_BY_ID.get(id);
