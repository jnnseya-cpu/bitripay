/** Pure helpers shared by the app and its Node tests (no React Native imports). */

/** Sender-id filter: case-insensitive, matches sender ids ("OrangeMoney") and numbers (a filter of "+243" matches the prefix). */
export function matchesFilters(from: string, filters: string[]): boolean {
  if (!filters.length) return true;
  const f = from.trim().toLowerCase();
  return filters.some((x) => {
    const y = x.trim().toLowerCase();
    return !!y && (f === y || f.replace(/\s+/g, '') === y.replace(/\s+/g, '') || f.startsWith(y));
  });
}
