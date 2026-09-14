# Go-live deployment: bitripay.com

One host (or one VM per environment) running Docker Compose with Caddy in front. Caddy obtains and renews the
TLS certificates; the API, the web app and the admin console are private containers on the compose network; the
SQLite database lives on the `api-data` volume with a nightly backup on `backups`.

| Host name | Serves | Container |
| --- | --- | --- |
| `bitripay.com` | customer / merchant / agent web app, hosted checkout, landing pages, BitriPay Lite, blog, legal pages, feeds | `web` (static) + `api` (server-rendered paths and `/api`, `/v1`) |
| `www.bitripay.com` | permanent redirect to `bitripay.com` | `caddy` |
| `admin.bitripay.com` | administration console | `admin` (static) + `api` |
| `api.bitripay.com` | partner API, webhooks, channels (USSD, SMS, WhatsApp), OpenAPI | `api` |

## 1. DNS

Create these records at the registrar (A/AAAA to the host's public address; CAA is optional but recommended):

```
bitripay.com.        A     <host IPv4>
bitripay.com.        AAAA  <host IPv6>          (if any)
www.bitripay.com.    CNAME bitripay.com.
admin.bitripay.com.  CNAME bitripay.com.
api.bitripay.com.    CNAME bitripay.com.
bitripay.com.        CAA   0 issue "letsencrypt.org"
```

Open ports 80 and 443 (TCP and UDP for HTTP/3) on the host firewall. Nothing else is exposed.

## 2. Environment

```bash
cp deploy/.env.production.example deploy/.env.production
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # run twice: JWT_SECRET, APP_SECRET
```

Fill `deploy/.env.production`: secrets, the administrator password, SMTP / SMS providers, the model key for the
assist agents and, only if you accept payment cards, the live keys of the card processor you contract with (health-checked
and enabled at start-up with `RAILS_AUTO_ENABLE=1`; a failing check never enables it). The file is git-ignored.

**Money movement needs no external API.** Transfers, QR payments, cross-payments and remittance run on the BitriPay
digital rail: the double-entry ledger, your own collection numbers at each mobile-money operator, bank-transfer
instructions, prefunded payout accounts, Android payout devices and agents. No bank, mobile-money operator or BTCPay
API is configured or required, and the go-live checklist blocks on the digital rail being on, never on such an API.
The connections are made digitally after the first sign-in: Mobile money → operator → collection number (your SIM at
that operator), Deposit / payment gateways → Bank transfer → account details, Corridors → Liquidity → payout accounts,
and the payout-device app enrols the phone that holds each SIM (signed receipts confirm every operator payment; the
maker-checker queue covers the rest). Operator-API adapters and BTCPay remain available as optional extras
(`backend/api/.env.optional-integrations.example`) for a deployment that contracts them.

## 3. Deploy

```bash
npm run deploy
```

The script builds the three images, starts the stack, waits for the API health check and runs the go-live command
inside the API container. The go-live command prints the digital-rail status, any optional external rail it provisioned, the checklist (blocking items marked ✗)
and the gate-to-scale metrics, and exits non-zero until every blocking item is green. Run it again at any time:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml exec api node backend/api/dist/goLive.js
```

## 4. Register the inbound webhooks

| Source | URL to register | Secret |
| --- | --- | --- |
| Stripe | `https://api.bitripay.com/api/webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` |
| Paystack | `https://api.bitripay.com/api/webhooks/paystack` | account secret key |
| Flutterwave | `https://api.bitripay.com/api/webhooks/flutterwave` | `FLUTTERWAVE_WEBHOOK_HASH` |
| Payout device / SMS forwarder (operator receipts, no operator API) | `https://api.bitripay.com/api/evidence/sms` | Ed25519 device key from enrolment in Admin → Mobile money & evidence |
| Direct mobile-money auto-confirm (any SMS-forwarder app on the collection phone) | `https://api.bitripay.com/api/webhooks/manual_momo` | `smsSecret` on the "Mobile money (direct)" gateway |
| WhatsApp Cloud API | `https://api.bitripay.com/api/whatsapp` (GET verification + POST messages) | verify token and app secret set in Admin → Channels → WhatsApp |
| USSD aggregator | `https://api.bitripay.com/api/ussd` | `X-Channel-Secret` from Admin → Channels |
| SMS aggregator | `https://api.bitripay.com/api/sms` | `X-Channel-Secret` from Admin → Channels |
| Open banking | per-link callbacks under `https://api.bitripay.com/api/open-banking/…` | provider keys in Admin → Banks |

Outbound merchant webhooks are signed with `BitriPay-Signature` and the platform Ed25519 key published at
`https://api.bitripay.com/v1/keys`.

## 5. First sign-in and hand-over

1. Open `https://admin.bitripay.com`, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, set the step-up PIN and enable
   two-factor authentication (production enforces it for administrators after the grace period; recovery codes are
   shown once).
2. Create a second administrator with the approver permissions: issuance, manual settlements and key revocation need
   maker-checker.
3. Gateway controls → run **Test connection** on every rail (the go-live command already did; the console shows the
   result and the webhook URL), set 3-D Secure, disable anything you do not contract for.
4. E-money → register the issuer programme, regulator reference and safeguarding account for every enabled currency.
5. Compliance → import the sanctions list source; Capability matrix → open the countries and methods you are licensed
   for (Bitcoin stays off until a country is flagged and a merchant opts in).
6. Run `npm run go-live` again: when it prints READY the compliance mode can be switched to live.

## 6. Operations

- Logs: `docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml logs -f api`
- Health: `https://api.bitripay.com/api/health`; admin **System** page for SLOs, rail health, SLA register.
- Backups: nightly copies under the `backups` volume (30-day retention). Restore: stop the stack, `sqlite3 bitripay.db ".restore <file>"` on the `api-data` volume, start again.
- Upgrades: `git pull && npm run deploy` (migrations run at start-up; default content is refreshed without touching administrator edits).
- Certificates: automatic; Caddy renews them and serves HTTP/3.

## What is not automated on purpose

The national switch connection stays in simulation until the official technical profile, certificates and homologation
are delivered (register in `docs/BCC-REGISTER.md`); the compliance mode switch to live and every corridor activation are
administrator decisions under step-up because they carry regulatory responsibility.

## Phone apps

`frontend/mobile/.env.production` and `frontend/payout-device/.env.production` point the Expo production builds at
`https://api.bitripay.com` (`eas build --profile production`); development builds keep the local servers from
`app.json`. Register the production package names with the push service before the first store submission.

## Deploying from GitHub

`.github/workflows/deploy.yml` deploys on a version tag (`git tag v1.0.0 && git push --tags`) or by hand from the
Actions tab. It re-runs the full verification, then connects to the production host over SSH, checks out the tag and
runs `npm run deploy`, and finally smokes `https://bitripay.com/`, `https://admin.bitripay.com/` and
`https://api.bitripay.com/api/health`. Add these repository secrets once (Settings → Secrets → Actions):

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | public address of the production host |
| `DEPLOY_USER` | deploy user allowed to run Docker |
| `DEPLOY_SSH_KEY` | private key of that user (the public key in its `~/.ssh/authorized_keys`) |
| `DEPLOY_PATH` | optional, default `/opt/bitripay` |
| `DEPLOY_PORT` | optional, default `22` |

`deploy/.env.production` stays on the host. For hosts without git, `npm run release` packs every compiled layer
(backend, web, admin, shared packages, deploy folder) into `release/bitripay-<version>-<sha>.tar.gz`.
