import { detectCardBrand, formatCardNumber, luhnCheck } from '@bitripay/shared';
import { Field, Input } from './ui';

export interface CardValues { number: string; expMonth: string; expYear: string; cvc: string; holderName: string }

export function CardForm({ value, onChange }: { value: CardValues; onChange: (v: CardValues) => void }) {
  const brand = detectCardBrand(value.number);
  const valid = value.number.replace(/\s/g, '').length >= 12 && luhnCheck(value.number);
  return (
    <div>
      <Field label="Card number" error={value.number.replace(/\s/g, '').length >= 12 && !valid ? 'Invalid card number' : null}>
        <div className="input-group">
          <input className="input mono" inputMode="numeric" autoComplete="cc-number" placeholder="4242 4242 4242 4242" value={value.number} onChange={(e) => onChange({ ...value, number: formatCardNumber(e.target.value).slice(0, 23) })} />
          <span className="addon input" style={{ display: 'grid', placeItems: 'center' }}>{brand === 'unknown' ? '💳' : brand.toUpperCase()}</span>
        </div>
      </Field>
      <div className="grid cols-3">
        <Field label="Month">
          <Input inputMode="numeric" placeholder="MM" maxLength={2} autoComplete="cc-exp-month" value={value.expMonth} onChange={(e) => onChange({ ...value, expMonth: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="Year">
          <Input inputMode="numeric" placeholder="YY" maxLength={4} autoComplete="cc-exp-year" value={value.expYear} onChange={(e) => onChange({ ...value, expYear: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="CVC">
          <Input inputMode="numeric" placeholder="123" maxLength={4} autoComplete="cc-csc" value={value.cvc} onChange={(e) => onChange({ ...value, cvc: e.target.value.replace(/\D/g, '') })} />
        </Field>
      </div>
      <Field label="Name on card">
        <Input autoComplete="cc-name" value={value.holderName} onChange={(e) => onChange({ ...value, holderName: e.target.value })} />
      </Field>
    </div>
  );
}
