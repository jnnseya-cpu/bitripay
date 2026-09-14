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

Fill `deploy/.env.production`: secrets, the administrator password, the credentials of the processors and mobile-money
APIs you contract with, your prefunded operator SIMs in `MOMO_DIRECT_RAILS`, BTCPay if you offer the Bitcoin rail,
SMTP / SMS providers, and the model key for the assist agents. Every rail whose credentials are present is
connectivity-checked at start-up and enabled when the check passes (`RAILS_AUTO_ENABLE=1`); a rail without credentials
stays off; a failing check never enables a rail. The file is git-ignored.

## 3. Deploy

```bash
npm run deploy
```

The script builds the three images, starts the stack, waits for the API health check and runs the go-live command
inside the API container. The go-live command prints the rails it provisioned, the checklist (blocking items marked ✗)
and the gate-to-scale metrics, and exits non-zero until every blocking item is green. Run it again at any time:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml exec api node backend/api/dist/goLive.js
```

## 4. Register the inbound webhooks

| Provider | URL to register | Secret |
| --- | --- | --- |
| Stripe | `https://api.bitripay.com/api/webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` |
| Paystack | `https://api.bitripay.com/api/webhooks/paystack` | account secret key |
| Flutterwave | `https://api.bitripay.com/api/webhooks/flutterwave` | `FLUTTERWAVE_WEBHOOK_HASH` |
| MTN MoMo | `https://api.bitripay.com/api/webhooks/mtn_momo` | API user / key |
| M-Pesa (Daraja) | `https://api.bitripay.com/api/webhooks/mpesa` | consumer key / secret |
| BTCPay Server | `https://api.bitripay.com/api/webhooks/bitcoin` | `BTCPAY_WEBHOOK_SECRET` (BTCPay-Sig) |
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
