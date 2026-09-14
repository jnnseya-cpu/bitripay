/**
 * BitriPay embedded checkout for the browser. Zero dependencies, no build-time framework: `BitriPay.checkout(...)`
 * either redirects the shopper to the hosted checkout or mounts it in an iframe and reports the outcome through the
 * `bitripay:checkout` postMessage contract. The pure helpers (`buildCheckoutUrl`, `parseCheckoutMessage`) have no DOM
 * dependency so they can be unit-tested and reused server-side.
 *
 * postMessage contract (sent by the hosted checkout page to `window.parent` when opened with `?embed=1&origin=…`):
 *   { type: 'bitripay:checkout', status: 'succeeded' | 'failed' | 'closed', sessionId: string | null, paymentIntentId: string | null }
 * The page posts it with `targetOrigin` = the `origin` query parameter, and the SDK only accepts events whose
 * `event.origin` is the checkout origin it opened (derived from the checkout URL).
 */

export type CheckoutStatus = 'succeeded' | 'failed' | 'closed';
export type CheckoutMode = 'redirect' | 'embed';

export interface CheckoutMessage {
  type: 'bitripay:checkout';
  status: CheckoutStatus;
  sessionId: string | null;
  paymentIntentId: string | null;
}

export interface CheckoutUrlOptions {
  /** The hosted checkout URL returned by the API (`checkout.session.url`, a payment link or a `/pay/<code>` URL). */
  url?: string;
  /** A checkout session id (`cs_…`) resolved on the hosted checkout as `<apiBase>/checkout/<sessionId>`. */
  sessionId?: string;
  /** Origin of the hosted checkout (the BitriPay web app), e.g. `https://pay.example.com`. Required with `sessionId`. */
  apiBase?: string;
  /** Add `embed=1` and `origin=<origin>` so the page posts the outcome to the embedding window. */
  embed?: boolean;
  /** The embedding page's origin (`window.location.origin`); the checkout page posts messages only to it. */
  origin?: string;
  /** Optional UI language passed to the checkout page. */
  locale?: string;
}

export interface CheckoutOptions extends CheckoutUrlOptions {
  /** `redirect` (default) navigates the current window; `embed` mounts an iframe in `container`. */
  mode?: CheckoutMode;
  /** Element or CSS selector to mount the iframe in (embed mode). Defaults to `document.body`. */
  container?: string | Element | null;
  /** Iframe height in CSS units (default `640px`). Width is always 100%. */
  height?: string;
  onSuccess?: (result: CheckoutMessage) => void;
  onFailure?: (result: CheckoutMessage) => void;
  onClose?: (result: CheckoutMessage) => void;
  /** Called for every accepted message, before the specific callback. */
  onMessage?: (result: CheckoutMessage) => void;
}

export interface CheckoutHandle {
  mode: CheckoutMode;
  url: string;
  /** The iframe (embed mode only). */
  frame: HTMLIFrameElement | null;
  /** Remove the iframe and stop listening. Safe to call twice. */
  close: () => void;
}

export const CHECKOUT_MESSAGE_TYPE = 'bitripay:checkout';
const STATUSES: CheckoutStatus[] = ['succeeded', 'failed', 'closed'];

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Origin (`scheme://host[:port]`) of an absolute URL, or null when it is not one. */
export function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Build the hosted checkout URL. Pure: works from a session id + apiBase or from a full URL, keeps existing query
 * parameters, and adds `embed=1&origin=…` (plus `locale`) when asked. Throws on missing or non-absolute input.
 */
export function buildCheckoutUrl(opts: CheckoutUrlOptions): string {
  let base: string;
  if (opts.url) base = opts.url.trim();
  else if (opts.sessionId) {
    if (!opts.apiBase) throw new Error('apiBase is required with sessionId');
    if (!/^cs_[a-z0-9]+$/i.test(opts.sessionId)) throw new Error('sessionId must be a checkout session id (cs_…)');
    base = `${trimSlash(opts.apiBase.trim())}/checkout/${opts.sessionId}`;
  } else throw new Error('url or sessionId is required');
  if (!originOf(base)) throw new Error('checkout url must be an absolute http(s) URL');
  const params: string[] = [];
  if (opts.embed) {
    params.push('embed=1');
    if (opts.origin) params.push(`origin=${encodeURIComponent(opts.origin)}`);
  }
  if (opts.locale) params.push(`locale=${encodeURIComponent(opts.locale)}`);
  if (!params.length) return base;
  const hashAt = base.indexOf('#');
  const hash = hashAt >= 0 ? base.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? base.slice(0, hashAt) : base;
  return `${noHash}${noHash.includes('?') ? '&' : '?'}${params.join('&')}${hash}`;
}

/**
 * Validate a `message` event from the checkout iframe: the origin must equal `expectedOrigin` (the checkout origin)
 * and the data must be a well-formed `bitripay:checkout` message (a JSON string is accepted too). Returns null for
 * anything else so unrelated messages on the page are ignored.
 */
export function parseCheckoutMessage(event: { origin?: string; data?: unknown }, expectedOrigin: string): CheckoutMessage | null {
  if (!event || typeof event.origin !== 'string' || event.origin.toLowerCase() !== expectedOrigin.toLowerCase()) return null;
  let data: unknown = event.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== CHECKOUT_MESSAGE_TYPE || typeof d.status !== 'string' || STATUSES.indexOf(d.status as CheckoutStatus) < 0) return null;
  return {
    type: CHECKOUT_MESSAGE_TYPE,
    status: d.status as CheckoutStatus,
    sessionId: typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : null,
    paymentIntentId: typeof d.paymentIntentId === 'string' && d.paymentIntentId ? d.paymentIntentId : null,
  };
}

function resolveContainer(container: CheckoutOptions['container']): Element {
  if (!container) return document.body;
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error(`container ${container} not found`);
    return el;
  }
  return container;
}

/** Open the hosted checkout: navigate (`redirect`) or mount an iframe and listen for the outcome (`embed`). */
export function checkout(opts: CheckoutOptions): CheckoutHandle {
  const mode: CheckoutMode = opts.mode ?? 'redirect';
  const win: Window | undefined = typeof window !== 'undefined' ? window : undefined;
  if (!win) throw new Error('BitriPay.checkout needs a browser window');
  const origin = opts.origin ?? win.location.origin;
  const url = buildCheckoutUrl({ ...opts, embed: mode === 'embed', origin });
  if (mode === 'redirect') {
    win.location.assign(url);
    return { mode, url, frame: null, close: () => undefined };
  }
  const checkoutOrigin = originOf(url)!;
  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'BitriPay checkout';
  frame.setAttribute('allow', 'payment *; clipboard-write');
  frame.setAttribute('loading', 'eager');
  frame.style.border = '0';
  frame.style.width = '100%';
  frame.style.height = opts.height ?? '640px';
  frame.dataset.bitripayCheckout = '1';
  let open = true;
  const listener = (event: MessageEvent) => {
    if (event.source && frame.contentWindow && event.source !== frame.contentWindow) return;
    const msg = parseCheckoutMessage(event, checkoutOrigin);
    if (!msg) return;
    opts.onMessage?.(msg);
    if (msg.status === 'succeeded') opts.onSuccess?.(msg);
    else if (msg.status === 'failed') opts.onFailure?.(msg);
    else {
      close();
      opts.onClose?.(msg);
    }
  };
  const close = () => {
    if (!open) return;
    open = false;
    win.removeEventListener('message', listener);
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  };
  win.addEventListener('message', listener);
  resolveContainer(opts.container).appendChild(frame);
  return { mode, url, frame, close };
}

export interface PayButtonOptions extends CheckoutOptions {
  /** Button label (default "Pay with BitriPay"). */
  label?: string;
  /** Extra class names for the button. */
  className?: string;
}

/**
 * Turn any element into a pay button: clicking it opens the checkout with the given options. When `el` is not a
 * button, one is created inside it. Returns the button and an `unmount` that removes the click handler.
 */
export function mountPayButton(el: string | Element, options: PayButtonOptions): { button: HTMLElement; unmount: () => void } {
  const host = typeof el === 'string' ? document.querySelector(el) : el;
  if (!host) throw new Error(`element ${String(el)} not found`);
  let button: HTMLElement;
  if (host instanceof HTMLButtonElement || host instanceof HTMLAnchorElement) button = host;
  else {
    const created = document.createElement('button');
    created.type = 'button';
    created.textContent = options.label ?? 'Pay with BitriPay';
    host.appendChild(created);
    button = created;
  }
  if (options.className) button.className = `${button.className} ${options.className}`.trim();
  button.setAttribute('data-bitripay-pay', '1');
  const onClick = (e: Event) => {
    e.preventDefault();
    checkout(options);
  };
  button.addEventListener('click', onClick);
  return { button, unmount: () => button.removeEventListener('click', onClick) };
}

/** Namespace object for `<script>` users: `BitriPay.checkout({...})`, `BitriPay.mountPayButton(...)`. */
export const BitriPay = { checkout, mountPayButton, buildCheckoutUrl, parseCheckoutMessage, originOf, CHECKOUT_MESSAGE_TYPE };
export default BitriPay;

declare global {
  interface Window {
    BitriPay?: typeof BitriPay;
  }
}
if (typeof window !== 'undefined' && !window.BitriPay) window.BitriPay = BitriPay;
