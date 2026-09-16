import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import type { PublicUser } from '@bitripay/shared';

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
      {loading && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
      {children}
    </button>
  );
}
export function Field({ label, hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ''}`} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`input ${p.className ?? ''}`} />;
export const Alert = ({ kind = 'info', children }: { kind?: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) => <div className={`alert ${kind}`}>{children}</div>;
export function Chip({ children, kind, onClick, selected }: { children: ReactNode; kind?: 'success' | 'warning' | 'danger' | 'primary'; onClick?: () => void; selected?: boolean }) {
  return (
    <span className={`chip ${kind ?? ''} ${onClick ? 'clickable' : ''} ${selected ? 'selected' : ''}`} onClick={onClick}>
      {children}
    </span>
  );
}
const KIND: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = {
  completed: 'success',
  paid: 'success',
  succeeded: 'success',
  verified: 'success',
  active: 'success',
  open: 'primary',
  answered: 'primary',
  negotiating: 'primary',
  pending: 'warning',
  escrowed: 'warning',
  ready_for_pickup: 'warning',
  processing: 'warning',
  initiated: 'warning',
  new: 'warning',
  failed: 'danger',
  rejected: 'danger',
  declined: 'danger',
  reversed: 'danger',
  disputed: 'danger',
  suspended: 'danger',
  frozen: 'warning',
  replied: 'success',
};
export const StatusBadge = ({ status }: { status: string }) => <Chip kind={KIND[status]}>{String(status).replace(/_/g, ' ')}</Chip>;
export function Avatar({ user, size }: { user?: PublicUser | null; size?: 'sm' | 'lg' }) {
  const initials = (user?.businessName || user?.fullName || '?')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  if (user?.pictureUrl) return <img className={`avatar ${size ?? ''}`} src={user.pictureUrl} alt="" loading="lazy" />;
  return (
    <div className={`avatar ${size ?? ''}`} style={{ background: user?.avatarColor || '#64748b' }}>
      {initials}
    </div>
  );
}
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-title">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export const Empty = ({ icon = '🗂️', text = 'Nothing here yet' }: { icon?: string; text?: string }) => (
  <div className="empty">
    <div className="ico">{icon}</div>
    <div>{text}</div>
  </div>
);
export const Loading = () => (
  <div className="loading-page">
    <span className="spinner" />
  </div>
);
export function Tabs({ tabs, value, onChange, pills }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void; pills?: boolean }) {
  return (
    <div className={pills ? 'pill-tabs' : 'tabs'}>
      {tabs.map((t) => (
        <button key={t.id} type="button" className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
export const KV = ({ k, v }: { k: ReactNode; v: ReactNode }) => (
  <div className="kv">
    <span className="k">{k}</span>
    <span className="v">{v}</span>
  </div>
);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload: run, setData };
}
export function useDebounce<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
export function Table({ head, rows, empty }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length}>
                <Empty text={empty} />
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
export function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="row between mt">
      <span className="small muted">{total} total</span>
      <div className="row">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ←
        </Button>
        <span className="small">
          {page} / {pages}
        </span>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          →
        </Button>
      </div>
    </div>
  );
}
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—');
export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="row" style={{ cursor: 'pointer' }}>
      <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
      {label && <span>{label}</span>}
    </label>
  );
}
export function UserCell({ user }: { user?: PublicUser | null }) {
  if (!user) return <span className="muted">—</span>;
  return (
    <div className="row">
      <Avatar user={user} size="sm" />
      <div>
        <div className="bold small">{user.businessName || user.fullName}</div>
        <div className="tiny muted">@{user.tag}</div>
      </div>
    </div>
  );
}
export function ConfirmButton({
  onConfirm,
  children,
  prompt,
  variant,
  size,
}: {
  onConfirm: (reason?: string) => void;
  children: ReactNode;
  prompt?: string;
  variant?: 'danger' | 'secondary' | 'success' | 'ghost';
  size?: 'sm';
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Please confirm">
        {prompt ? (
          <Field label={prompt}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        ) : (
          <p>Are you sure?</p>
        )}
        <div className="row">
          <Button
            variant={variant === 'danger' ? 'danger' : undefined}
            disabled={!!prompt && reason.length < 2}
            onClick={() => {
              onConfirm(reason);
              setOpen(false);
              setReason('');
            }}
          >
            Confirm
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** Administrative approvals need a fresh step-up: the admin's PIN (a registered passkey token is attached automatically when present). */
export function StepUpButton({
  onConfirm,
  children,
  prompt,
  variant,
  size,
  title,
}: {
  onConfirm: (pin: string, reason?: string) => void;
  children: ReactNode;
  prompt?: string;
  variant?: 'danger' | 'secondary' | 'success' | 'ghost';
  size?: 'sm';
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title ?? 'Approve with step-up'}>
        {prompt && (
          <Field label={prompt}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        )}
        <Field label="Your transaction PIN" hint="Maker-checker: this decision is recorded under your identity. Set a PIN in My profile if you have none.">
          <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus={!prompt} />
        </Field>
        <div className="row">
          <Button
            variant={variant === 'danger' ? 'danger' : undefined}
            disabled={pin.length < 4 || (!!prompt && reason.length < 2)}
            onClick={() => {
              onConfirm(pin, reason);
              setOpen(false);
              setReason('');
              setPin('');
            }}
          >
            Confirm
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
    </>
  );
}
