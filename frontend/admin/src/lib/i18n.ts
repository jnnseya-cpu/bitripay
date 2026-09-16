import { useSyncExternalStore } from 'react';
import { subscribeTr, trVersion } from './tr';
import { useStore } from './store';

export { tr } from './tr';

/** The language + overrides version, for keying a subtree so `tr()` output refreshes when either changes. */
export function useTrKey(): string {
  const { lang } = useStore();
  const v = useSyncExternalStore(subscribeTr, trVersion);
  return `${lang}:${v}`;
}
