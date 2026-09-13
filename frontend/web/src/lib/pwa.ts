/**
 * Progressive web app wiring: register the service worker, expose the online / offline state and the "last synced"
 * marker, and flush the offline promise queue as soon as the network returns.
 */
import { offlineQueue } from './offline';

export const pwaState = { online: typeof navigator === 'undefined' ? true : navigator.onLine, lastSync: null as string | null, listeners: new Set<() => void>() };
function notify() {
  for (const l of pwaState.listeners) l();
}
export function onPwaChange(fn: () => void): () => void {
  pwaState.listeners.add(fn);
  return () => pwaState.listeners.delete(fn);
}
async function flush() {
  try {
    if ((await offlineQueue.count()) > 0) await offlineQueue.sync();
    pwaState.lastSync = await offlineQueue.lastSync();
  } catch {
    /* the queue stays; the next reconnect retries */
  }
  notify();
}
export function registerPwa() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => {
    pwaState.online = true;
    notify();
    void flush();
  });
  window.addEventListener('offline', () => {
    pwaState.online = false;
    notify();
  });
  void offlineQueue
    .lastSync()
    .then((v) => {
      pwaState.lastSync = v;
      notify();
    })
    .catch(() => undefined);
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'sync-offline-promises') void flush();
    });
  }
}
