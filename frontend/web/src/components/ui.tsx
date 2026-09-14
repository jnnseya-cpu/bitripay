import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import QRCode from 'qrcode';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import type { PublicUser, Transaction } from '@bitripay/shared';
import { TRANSACTION_TYPE_LABELS } from '@bitripay/shared';
import { Link } from 'react-router-dom';
import { biometricStepUp, passkeysSupported } from '../lib/passkeys';

export function Button({
  children,
  loading,
  variant,
  size,
  block,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: 'secondary' | 'ghost' | 'danger' | 'success'; size?: 'sm' | 'lg'; block?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || loading} className={`btn ${variant ?? ''} ${size ?? ''} ${block ? 'block' : ''} ${rest.className ?? ''}`}>
      {loading ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2, borderTopColor: '#fff' }} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, error }: { label?: string; hint?: string; children: ReactNode; error?: string | null }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error ? (
        <span className="hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${props.className ?? ''}`} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input ${props.className ?? ''}`} />;
}

export function Alert({ kind = 'info', children }: { kind?: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function Chip({ children, kind, onClick, selected }: { children: ReactNode; kind?: 'success' | 'warning' | 'danger' | 'primary'; onClick?: () => void; selected?: boolean }) {
  return (
    <span className={`chip ${kind ?? ''} ${onClick ? 'clickable' : ''} ${selected ? 'selected' : ''}`} onClick={onClick}>
      {children}
    </span>
  );
}

const STATUS_KIND: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = {
  completed: 'success',
  paid: 'success',
  succeeded: 'success',
  verified: 'success',
  active: 'success',
  open: 'primary',
  pending: 'warning',
  escrowed: 'warning',
  negotiating: 'primary',
  ready_for_pickup: 'warning',
  processing: 'warning',
  initiated: 'warning',
  answered: 'primary',
  failed: 'danger',
  rejected: 'danger',
  cancelled: undefined,
  expired: undefined,
  declined: 'danger',
  reversed: 'danger',
  disputed: 'danger',
  suspended: 'danger',
  frozen: 'warning',
  closed: undefined,
  refunded: undefined,
};
export function StatusBadge({ status }: { status: string }) {
  return <Chip kind={STATUS_KIND[status]}>{status.replace(/_/g, ' ')}</Chip>;
}

export function Avatar({ user, size }: { user?: PublicUser | null; size?: 'sm' | 'lg' }) {
  const initials = (user?.businessName || user?.fullName || '?')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className={`avatar ${size ?? ''}`} style={{ background: user?.avatarColor || '#64748b' }}>
      {initials}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-title">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Asks for the transaction PIN before running an action. */
export function PinModal({
  open,
  onClose,
  onSubmit,
  title,
  summary,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (pin: string) => void;
  title?: string;
  summary?: ReactNode;
  loading?: boolean;
}) {
  const t = useT();
  const [pin, setPin] = useState('');
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);
  const { user, hasPasskeys } = useStore();
  useEffect(() => {
    if (open) {
      setPin('');
      setBioError(null);
    }
  }, [open]);
  const useBiometrics = async () => {
    setBioBusy(true);
    setBioError(null);
    try {
      await biometricStepUp();
      onSubmit(''); // the API client attaches the step-up token; the PIN is not needed
    } catch (err) {
      setBioError((err as Error).message || 'Biometric confirmation cancelled');
    } finally {
      setBioBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title ?? t('common.confirm')}>
      {summary}
      {hasPasskeys && passkeysSupported() && (
        <div className="mb">
          <Button block variant="secondary" loading={bioBusy} onClick={useBiometrics} type="button">
            🔐 Confirm with biometrics
          </Button>
          {bioError && (
            <div className="hint mt-sm" style={{ color: 'var(--danger)' }}>
              {bioError}
            </div>
          )}
          <div className="center tiny muted mt-sm">or enter your PIN</div>
        </div>
      )}
      {!user?.hasPin && !hasPasskeys ? (
        <Alert kind="warning">
          Set a transaction PIN first in <Link to="/settings?tab=security">Security settings</Link>.
        </Alert>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(pin);
          }}
        >
          <Field label={t('common.pin')}>
            <Input className="pin-input" type="password" inputMode="numeric" autoFocus maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
          </Field>
          <Button block loading={loading} disabled={pin.length < 4}>
            {t('common.confirm')}
          </Button>
        </form>
      )}
    </Modal>
  );
}

export function QrImage({ value, size = 240 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } })
      .then(setSrc)
      .catch(() => setSrc(''));
  }, [value, size]);
  return <div className="qr-box">{src ? <img src={src} alt="QR code" style={{ width: size, height: size }} /> : <div style={{ width: size, height: size }} />}</div>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </Button>
  );
}

export function Empty({ icon = '🗂️', text }: { icon?: string; text?: string }) {
  const t = useT();
  return (
    <div className="empty">
      <div className="ico">{icon}</div>
      <div>{text ?? t('common.none')}</div>
    </div>
  );
}

export function Loading() {
  return (
    <div className="loading-page">
      <span className="spinner" />
    </div>
  );
}

export function Tabs({ tabs, value, onChange, pills }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void; pills?: boolean }) {
  return (
    <div className={pills ? 'pill-tabs' : 'tabs'}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" className={`tab ${value === tab.id ? 'active' : ''}`} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/** Amount + currency picker bound to the user's wallets (or all enabled currencies). */
export function AmountInput({
  amount,
  currency,
  onAmount,
  onCurrency,
  currencies,
  big,
  disabled,
}: {
  amount: string;
  currency: string;
  onAmount: (v: string) => void;
  onCurrency: (c: string) => void;
  currencies?: string[];
  big?: boolean;
  disabled?: boolean;
}) {
  const { config, wallets } = useStore();
  const codes = currencies ?? (wallets.length ? wallets.map((w) => w.currency) : (config?.currencies ?? []).map((c) => c.code));
  return (
    <div className="input-group">
      <input
        className={`input ${big ? 'amount-input' : ''}`}
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        disabled={disabled}
        onChange={(e) => onAmount(e.target.value.replace(/[^\d.]/g, ''))}
      />
      <select className="input" value={currency} onChange={(e) => onCurrency(e.target.value)} disabled={disabled}>
        {codes.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}

export function useDebounce<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const TX_ICONS: Record<string, string> = {
  transfer: '↔️',
  qr_payment: '📷',
  merchant_payment: '🏪',
  money_request: '🙋',
  card_deposit: '💳',
  bank_deposit: '🏦',
  mobile_money_deposit: '📱',
  agent_cash_in: '💵',
  agent_cash_out: '🏧',
  withdrawal: '🏦',
  remittance: '🌍',
  exchange: '💱',
  virtual_card_funding: '💳',
  gift_card: '🎁',
  bill_payment: '🧾',
  mobile_topup: '📶',
  referral_reward: '🎉',
  admin_adjustment: '🛠️',
  refund: '↩️',
};

export function TxRow({ tx, onClick }: { tx: Transaction; onClick?: () => void }) {
  const { money } = useStore();
  const who = tx.counterparty ? tx.counterparty.businessName || tx.counterparty.fullName : TRANSACTION_TYPE_LABELS[tx.type];
  const isIn = tx.direction === 'in';
  const shown = isIn ? (tx.receiveAmount ?? tx.amount) : tx.amount + (tx.direction === 'out' && (tx.metadata as any)?.feeFrom !== 'receiver' ? tx.fee : 0);
  const cur = isIn ? (tx.receiveCurrency ?? tx.currency) : tx.currency;
  return (
    <div className={`list-item ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="avatar sm" style={{ background: 'var(--bg-soft)', color: 'var(--text)' }}>
        {TX_ICONS[tx.type] ?? '•'}
      </div>
      <div className="flex1">
        <div className="main-text truncate">{who}</div>
        <div className="sub-text truncate">
          {TRANSACTION_TYPE_LABELS[tx.type]} · {new Date(tx.createdAt).toLocaleString()} {tx.note ? `· ${tx.note}` : ''}
        </div>
      </div>
      <div className="right">
        <div className={`amount ${isIn ? 'in' : 'out'}`}>
          {isIn ? '+' : tx.direction === 'out' ? '-' : ''}
          {money(shown, cur)}
        </div>
        <StatusBadge status={tx.status} />
      </div>
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(fn);
  ref.current = fn;
  const run = () => {
    setLoading(true);
    return ref
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass their own dependency list
  }, deps);
  return { data, error, loading, reload: run, setData };
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

/** Lifecycle of an external payment: makes the difference between initiated, confirmed and settled explicit. */
export const STAGE_STEPS: { id: string; label: string; stages: string[] }[] = [
  { id: 'initiated', label: 'Initiated', stages: ['CREATED', 'AUTHENTICATION_REQUIRED', 'INSTRUCTION_ISSUED'] },
  { id: 'sent', label: 'Sent', stages: ['PAYMENT_SENT'] },
  { id: 'verifying', label: 'Verifying', stages: ['EVIDENCE_RECEIVED', 'VERIFYING', 'MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'DISPUTED'] },
  { id: 'confirmed', label: 'Confirmed', stages: ['CONFIRMED'] },
  { id: 'settled', label: 'Settled', stages: ['SETTLED'] },
];
export function StageTimeline({ stage, stageLabel, stageDescription }: { stage?: string; stageLabel?: string; stageDescription?: string }) {
  const t = useT();
  if (!stage) return null;
  const terminalBad = ['EXPIRED', 'REJECTED', 'REVERSED'].includes(stage);
  const exception = ['MANUAL_REVIEW', 'MISMATCHED', 'DUPLICATE', 'DISPUTED'].includes(stage);
  const idx = STAGE_STEPS.findIndex((s) => s.stages.includes(stage));
  return (
    <div className="stage-timeline">
      <div className="row" style={{ gap: 0, alignItems: 'stretch' }}>
        {STAGE_STEPS.map((s, i) => {
          const state = terminalBad ? (i === 0 ? 'failed' : 'off') : i < idx ? 'done' : i === idx ? (exception ? 'warn' : 'active') : 'off';
          return (
            <div key={s.id} style={{ flex: 1, textAlign: 'center' }}>
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  margin: '0 2px',
                  background: state === 'done' || state === 'active' ? 'var(--success)' : state === 'warn' ? 'var(--warning, #f59e0b)' : state === 'failed' ? 'var(--danger)' : 'var(--border)',
                }}
              />
              <div className="tiny mt-sm" style={{ color: state === 'off' ? 'var(--muted)' : 'inherit', fontWeight: state === 'active' || state === 'warn' ? 700 : 400 }}>
                {s.label}
              </div>
            </div>
          );
        })}
      </div>
      <div className="small mt-sm">
        <b>{stageLabel ?? stage}</b>
        {stageDescription ? <span className="muted"> – {stageDescription}</span> : null}
      </div>
      {stage !== 'SETTLED' && (
        <div className="tiny muted mt-sm" data-testid="lifecycle-trust">
          {t('trust.notProofShort')}
        </div>
      )}
    </div>
  );
}

/** How a leg is initiated, confirmed and settled, and how long it takes – shown before the payer authorises. */
export function RouteDisclosure({ declaration, fx }: { declaration?: any; fx?: any }) {
  if (!declaration && !fx) return null;
  const leg = (title: string, l: any) =>
    l ? (
      <div className="mb-sm">
        <div className="small bold">
          {title} · <span className={`chip ${l.processing === 'automatic' ? 'success' : l.processing === 'assisted' ? 'warning' : ''}`}>{l.processing}</span>
        </div>
        <div className="tiny">
          <b>Initiation:</b> {l.initiation}
        </div>
        <div className="tiny">
          <b>Confirmation:</b> {l.confirmation}
        </div>
        <div className="tiny">
          <b>Settlement:</b> {l.settlement}
        </div>
        <div className="tiny">
          <b>Expected:</b> {l.expectedCompletion} · <b>Refund:</b> {l.refundMethod}
        </div>
      </div>
    ) : null;
  return (
    <details className="card soft compact mb">
      <summary className="small bold" style={{ cursor: 'pointer' }}>
        How this payment works{declaration ? ` · ${declaration.processing ?? declaration.funding?.processing ?? ''} · ${declaration.expectedCompletion ?? ''}` : ''}
      </summary>
      <div className="mt-sm">
        {declaration?.funding ? leg('Money in', declaration.funding) : declaration?.initiation ? leg('Payment', declaration) : null}
        {declaration?.payout && leg('Money out', declaration.payout)}
        {declaration?.disclosure && <div className="tiny muted">{declaration.disclosure}</div>}
        {fx && fx.sourceCurrency !== fx.targetCurrency && (
          <div className="mt-sm">
            <div className="small bold">Exchange rate</div>
            <div className="tiny">
              Reference rate 1 {fx.sourceCurrency} = {Number(fx.midRate).toFixed(6)} {fx.targetCurrency} · {fx.providerLabel}
              {fx.rateTimestamp ? ` · ${new Date(fx.rateTimestamp).toLocaleString()}` : ''}
            </div>
            <div className="tiny">
              Markup {(fx.markupBps / 100).toFixed(2)}% · your rate 1 {fx.sourceCurrency} = {Number(fx.rate).toFixed(6)} {fx.targetCurrency}
            </div>
            <div className="tiny">
              {fx.guaranteed ? (
                <span className="chip success">Rate guaranteed until {new Date(fx.expiresAt).toLocaleTimeString()}</span>
              ) : (
                <span className="chip warning">Indicative rate – not guaranteed{fx.stale ? ' (administrator-approved / stale)' : ''}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

/** Lifecycle of a cross-rail transfer: initiated → funded → paying out → settled. */
export const ROUTE_STEPS: { id: string; label: string; stages: string[] }[] = [
  { id: 'initiated', label: 'Approved', stages: ['CREATED', 'QUOTED', 'BIOMETRIC_APPROVAL_REQUIRED', 'BIOMETRICALLY_APPROVED', 'FUNDING_PENDING'] },
  { id: 'funded', label: 'Funded · FX reserved', stages: ['FUNDED', 'FX_RESERVED', 'AWAITING_CONFIRMATION', 'MANUAL_REVIEW', 'INSUFFICIENT_LIQUIDITY'] },
  { id: 'paying', label: 'Paying out', stages: ['PAYOUT_ROUTED', 'PAYOUT_SENT', 'EVIDENCE_RECEIVED', 'VERIFYING', 'VERIFIED', 'MISMATCHED', 'DUPLICATE'] },
  { id: 'settled', label: 'Settled', stages: ['SETTLED'] },
];
export function RouteTimeline({ stage, stageLabel, stageDescription }: { stage?: string; stageLabel?: string; stageDescription?: string }) {
  if (!stage) return null;
  const bad = ['EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED', 'DISPUTED'].includes(stage);
  const warn = ['MANUAL_REVIEW', 'INSUFFICIENT_LIQUIDITY', 'MISMATCHED', 'DUPLICATE'].includes(stage);
  const idx = ROUTE_STEPS.findIndex((s) => s.stages.includes(stage));
  return (
    <div className="stage-timeline">
      <div className="row" style={{ gap: 0, alignItems: 'stretch' }}>
        {ROUTE_STEPS.map((s, i) => {
          const state = bad ? (i === 0 ? 'failed' : 'off') : i < idx ? 'done' : i === idx ? (warn ? 'warn' : 'active') : 'off';
          return (
            <div key={s.id} style={{ flex: 1, textAlign: 'center' }}>
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  margin: '0 2px',
                  background: state === 'done' || state === 'active' ? 'var(--success)' : state === 'warn' ? 'var(--warning, #f59e0b)' : state === 'failed' ? 'var(--danger)' : 'var(--border)',
                }}
              />
              <div className="tiny mt-sm" style={{ color: state === 'off' ? 'var(--muted)' : 'inherit', fontWeight: state === 'active' || state === 'warn' ? 700 : 400 }}>
                {s.label}
              </div>
            </div>
          );
        })}
      </div>
      <div className="small mt-sm">
        <b>{stageLabel ?? stage}</b>
        {stageDescription ? <span className="muted"> – {stageDescription}</span> : null}
      </div>
    </div>
  );
}
