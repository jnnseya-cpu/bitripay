/**
 * Phone number normalisation shared by every layer. Two forms are needed on a payments platform:
 *  - the E.164-style form (`+243812345678`) used to identify an account or a mobile money destination;
 *  - the national significant part (last nine digits) used to match evidence, statements and sanctions lists, where
 *    operators and banks drop the country code or the trunk prefix inconsistently.
 */

/** `+<digits>`; tolerates spaces, dashes, brackets and a `00` international prefix. Returns null when nothing is left. */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  digits = digits.replace(/(?!^)\+/g, '');
  if (!digits.replace('+', '')) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/** The national significant number (last nine digits) or null for anything shorter than eight digits. */
export function nationalSignificant(phone?: string | null): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-9) : null;
}

/** True when both numbers designate the same subscriber whatever prefix each side used. */
export function samePhone(a?: string | null, b?: string | null): boolean {
  const x = nationalSignificant(a);
  const y = nationalSignificant(b);
  return !!x && x === y;
}
