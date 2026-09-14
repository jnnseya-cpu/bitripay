# @bitripay/checkout-js

Embedded checkout for the browser. Zero dependencies. Redirect the shopper to the BitriPay hosted
checkout, or mount it in an iframe and get the outcome back through `postMessage`.

```bash
npm install @bitripay/checkout-js
```

```ts
import { BitriPay } from '@bitripay/checkout-js';

// 1. Your server creates a checkout session (POST /v1/checkout_sessions with a secret key) and
//    hands the browser its `url` (or its `id`).
// 2. The browser opens it.
BitriPay.checkout({
  url: session.url, // or: sessionId: session.id, apiBase: 'https://pay.yourbrand.com'
  mode: 'embed', // 'redirect' (default) navigates the current window
  container: '#checkout', // element or selector; defaults to document.body
  height: '720px',
  onSuccess: ({ sessionId, paymentIntentId }) => markOrderPaid(sessionId, paymentIntentId),
  onFailure: () => showRetry(),
  onClose: () => hideModal(),
});
```

`BitriPay.checkout` returns `{ mode, url, frame, close }`; `close()` removes the iframe and stops
listening. `mountPayButton(el, options)` wires a click on any element (or a button it creates inside
it) to `checkout(options)`.

The build also assigns `window.BitriPay` so the compiled file can be dropped into a page with a
`<script>` tag.

## Options

| Option                                | Meaning                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `url`                                 | Hosted checkout URL from the API (`checkout.session.url`, a payment link, `/pay/<code>`).        |
| `sessionId` + `apiBase`               | Alternative to `url`: opens `<apiBase>/checkout/<sessionId>` (`apiBase` is the checkout origin). |
| `mode`                                | `'redirect'` (default) or `'embed'`.                                                            |
| `container`, `height`                 | Embed only: where the iframe goes and how tall it is (width is 100%).                           |
| `origin`                              | Embedding origin; defaults to `window.location.origin`.                                          |
| `locale`                              | Optional UI language for the checkout page.                                                     |
| `onSuccess`, `onFailure`, `onClose`   | Called with the parsed message (below). `onMessage` sees every accepted message.                |

## postMessage contract

When opened with `?embed=1&origin=<embedding origin>`, the hosted checkout page posts to
`window.parent` (with `targetOrigin` set to that origin) whenever the outcome is known:

```json
{ "type": "bitripay:checkout", "status": "succeeded" | "failed" | "closed", "sessionId": "cs_…" | null, "paymentIntentId": "pi_…" | null }
```

- `succeeded`: the payment intent was captured (the session is `complete`).
- `failed`: the payment failed, was cancelled or the session expired.
- `closed`: the shopper dismissed the checkout; the SDK removes the iframe and calls `onClose`.

The SDK only accepts events whose `event.origin` equals the checkout origin derived from the URL it
opened, and whose `data` matches the shape above (a JSON string is accepted as well). Everything
else on the page's `message` channel is ignored. Never trust the message alone to fulfil an order:
confirm from your server with `GET /v1/checkout_sessions/:id` or the `checkout.session.completed`
webhook.

`buildCheckoutUrl(options)` and `parseCheckoutMessage(event, expectedOrigin)` are exported as pure
functions (no DOM) and unit-tested with `node:test`.

## Development

```bash
npm run build   # dist/ (CommonJS + .d.ts, ES2019 + DOM)
npm test        # node --test on src/*.test.ts
```
