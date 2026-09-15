# Go-live deployment: bitripay.com

One host (or one VM per environment) running Docker Compose with Caddy in front. Caddy obtains and renews the
TLS certificates; the API, the web app and the admin console are private containers on the compose network; the
SQLite database lives on the `api-data` volume with a nightly backup on `backups`.

| Host name | Serves | Container |
| --- | --- | --- |
| `www.bitripay.com` | customer / merchant / agent web app, hosted checkout, landing pages, BitriPay Lite, blog, legal pages, feeds (canonical host) | `web` (static) + `api` (server-rendered paths and `/api`, `/v1`) |
| `bitripay.com` | permanent redirect to `www.bitripay.com` | `caddy` |
| `admin.bitripay.com` | administration console | `admin` (static) + `api` |
| `api.bitripay.com` | partner API, webhooks, channels (USSD, SMS, WhatsApp), OpenAPI | `api` |


## 0. Where each layer runs

BitriPay is one repository with three deployable layers and one library layer. The backend keeps its ledger in
SQLite on a persistent disk and runs background jobs, so it needs a real server: a **Hostinger VPS** (KVM plan,
Ubuntu with the Docker template). The two web front-ends are static builds and can sit either on the same VPS
(default, one command, one bill) or on **Vercel**. **Firebase Hosting** cannot proxy the API paths the marketing
pages, blog, legal pages and sitemap are served from, so it is not used. No other vendor is needed.

| Layer | Folder | Recommended home | Alternative |
| --- | --- | --- | --- |
| Backend (API, ledger, jobs, SSR site pages, webhooks, channels) | `backend/api` | Hostinger VPS, container `api` behind Caddy | none: it needs a persistent disk and long-running jobs |
| Customer web app (www.bitripay.com) | `frontend/web` | Hostinger VPS, container `web` | Vercel project with root `frontend/web` (`vercel.json` is included) |
| Administration console (admin.bitripay.com) | `frontend/admin` | Hostinger VPS, container `admin` | Vercel project with root `frontend/admin` (`vercel.json` is included) |
| Shared packages (`@bitripay/shared`, BitriQR, SDKs) | `shared/*` | not deployed: built into the three layers at image / build time | same |
| Phone apps and payout device | `frontend/mobile`, `frontend/payout-device` | built with EAS against `https://api.bitripay.com` | same |

### A VPS that already serves other websites (shared host)

Nothing here takes ports 80 or 443 from the web server that already runs your other sites. In shared-host mode the
three containers listen on localhost only (web 127.0.0.1:8080, admin 127.0.0.1:8081, API 127.0.0.1:4000; change
`BITRIPAY_*_PORT` in `deploy/.env.production` if a port is taken), and the existing web server proxies the three host
names to them. Containers, images and volumes are all prefixed `bitripay_`; no other project on the host is touched,
and `npm run deploy` in dedicated mode refuses to start while something else listens on 80/443.

```bash
git clone https://github.com/jnnseya-cpu/bitripay.git /opt/bitripay && cd /opt/bitripay
cp deploy/.env.production.example deploy/.env.production
nano deploy/.env.production                 # ADMIN_EMAIL, SMTP, SMS; secrets may stay empty
npm run deploy -- --shared-host             # builds, starts on localhost ports, runs the go-live command
ss -ltnp | grep -E ':(80|443) '             # which web server owns 80/443: nginx, apache2 or caddy
```

Then hand the three host names to that web server (DNS records as in section 1, pointing at this VPS):

| Existing web server | Do this |
| --- | --- |
| Nginx | `cp deploy/shared-host/nginx-bitripay.conf /etc/nginx/sites-available/bitripay.conf && ln -s /etc/nginx/sites-available/bitripay.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`, then `certbot --nginx -d bitripay.com -d www.bitripay.com -d admin.bitripay.com -d api.bitripay.com` |
| Apache | `cp deploy/shared-host/apache-bitripay.conf /etc/apache2/sites-available/bitripay.conf && a2enmod proxy proxy_http proxy_wstunnel headers && a2ensite bitripay && apachectl configtest && systemctl reload apache2`, then `certbot --apache -d bitripay.com -d www.bitripay.com -d admin.bitripay.com -d api.bitripay.com` |
| Caddy on the host | append `deploy/shared-host/Caddyfile.snippet` to the host Caddyfile and `systemctl reload caddy` (certificates are automatic) |
| A proxy that is itself a container (Caddy, Traefik, Nginx Proxy Manager) | set `BITRIPAY_EDGE_NETWORK` in the env file to the network that container is attached to (`docker inspect <proxy> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`); the deploy then joins the BitriPay containers to it. **Caddy container: configured automatically** — every deployment runs `deploy/shared-host/apply-edge.sh`, which finds the Caddy container on that network, backs up the Caddyfile it mounts, replaces any earlier `bitripay.com` blocks with `deploy/shared-host/Caddyfile.container.snippet` (apex → www redirect, www, admin, api), validates, reloads and checks the four host names; run it by hand any time. Traefik: add router labels for `bitripay-web:80`, `bitripay-admin:80`, `bitripay-api:4000`; Nginx Proxy Manager: add three proxy hosts to those names |
| hPanel / a hosting panel | add the three domains as proxied sites pointing at the localhost ports above, with SSL enabled by the panel |

Install certbot once if it is missing: `apt-get install -y certbot python3-certbot-nginx` (or `python3-certbot-apache`).
The web and admin containers route `/api`, `/v1` and the site pages to the API themselves, so the proxy only needs
one location per host name.

### Hostinger VPS dedicated to BitriPay, step by step

1. hPanel → VPS → order a KVM 2 (2 vCPU, 8 GB) or larger → operating system **Ubuntu 22.04 with Docker** →
   set the root password and add your SSH key.
2. hPanel → Domains → bitripay.com → DNS zone: create the records in section 1 below with the VPS IPv4.
3. SSH in as root, then:

```bash
apt-get update && apt-get install -y git nodejs npm
git clone https://github.com/jnnseya-cpu/bitripay.git /opt/bitripay && cd /opt/bitripay
cp deploy/.env.production.example deploy/.env.production
nano deploy/.env.production        # ACME_EMAIL, ADMIN_EMAIL, SMTP and SMS providers; secrets may stay empty
npm run deploy
```

`npm run deploy` generates any secret left empty (JWT_SECRET, APP_SECRET and, printed once, ADMIN_PASSWORD), builds
the three images, starts them behind Caddy and runs the go-live command. Hostinger's firewall (hPanel → VPS →
Firewall) must allow 22, 80 and 443.

### Front-ends on Vercel (optional)

Create two Vercel projects from the same repository, root directory `frontend/web` and `frontend/admin`, framework
Vite, build command `npm run build`, output `dist`; set the environment variable `VITE_API_URL=https://api.bitripay.com`
on both. The included `vercel.json` files proxy `/api`, `/v1` and the site pages to the API and serve the SPA
fallback. Point `www.bitripay.com` (and the `bitripay.com` redirect) and `admin.bitripay.com` at Vercel (its A / CNAME targets) and keep
`api.bitripay.com` on the VPS. Set `WEB_URL` / `ADMIN_URL` in `deploy/.env.production` to the same hosts; the API
already allows those origins.

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

The script generates any secret left empty in the env file, builds the three images, starts the stack, waits for the
API health check and runs the go-live command inside the API container. In production these checklist items are green
from the first start without console work: production secrets (generated), sandbox gateway off, live exchange rates
(open.er-api.com, refreshed every 6 hours), KYC required before withdrawals, and the sanctions lists (the official
US OFAC, UK OFSI, UN and EU consolidated lists are registered and loaded at start-up, then refreshed daily). What
remains needs your documents and accounts: the e-money issuer programme and reserves, the corridor's regulatory
arrangements, payout accounts and devices, collection numbers, and a second administrator with a PIN and 2FA. The go-live command prints the digital-rail status, any optional external rail it provisioned, the checklist (blocking items marked ✗)
and the gate-to-scale metrics, and exits non-zero until every blocking item is green. Run it again at any time:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml exec api node backend/api/dist/goLive.js
```

## 3b. Go-live profile: the launch records from one file

Everything the checklist needs beyond the automatic items is data you hold: bank details, collection numbers,
e-money programmes, payout accounts, corridor arrangements, a second administrator, SMTP. Write it once as JSON and
it is applied digitally, idempotently (records are matched on their natural key and updated, never duplicated):

```bash
cp deploy/go-live.profile.example.json deploy/go-live.profile.json   # git-ignored; replace every value with yours
npm run deploy -- --shared-host       # applies the profile before the checklist (or: npm run go-live -- deploy/go-live.profile.json)
```

The report lists what was created or updated and, under "Still yours", the steps that stay with people: each
administrator's PIN and 2FA, clearing the reserve funding under maker-checker, pressing Go live on the corridor with a
PIN, prefunding the float and enrolling the payout phone. The same document can be pasted in the console under
Gateway controls & risk → Go-live checklist → Apply a go-live profile (step-up PIN required). A placeholder left in the
file is a wrong record in production: the example values are shapes, not defaults.

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

## 5b. Test accounts for a demonstration

`npm run demo-accounts` creates a customer, a merchant and an agent on the running platform (inside the API
container on a deployed host) with verified KYC, a transaction PIN, the merchant's organisation, the agent's team and
sandbox balances in USD and CDF; it prints the sign-in details once. Give it the phone number or email of each person
who will use the account during the test; nothing is invented:

```bash
npm run demo-accounts -- --customer +243810000000 --merchant +243820000000 --agent +243890000000
# optional: --<role>-email owner@example.com, --merchant-business "Pharmacie …", --agent-business "…", --password …, --pin 1234
```

Sandbox compliance mode only (the balances are an administrator issuance approved by the same administrator, which
the four-eyes rule forbids once real money is in play). Running it again reports the existing accounts and adds
nothing.

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

## Deploying from GitHub (automatic)

Two ways to keep the live site on the latest green commit. Use one; both call `npm run deploy` on the host and
keep `deploy/.env.production` there, never in GitHub.

### A. Push-based: GitHub Actions deploys over SSH

`.github/workflows/deploy.yml` runs on **every push to the repository's default branch**, on a version tag
(`git tag v1.0.0 && git push --tags`) and by hand from the Actions tab. It re-runs the full verification and only
then connects to the host, checks out that exact commit, runs `npm run deploy` in the mode of the `DEPLOY_MODE`
variable (default `shared-host`), and smokes `https://www.bitripay.com/`, `https://admin.bitripay.com/`,
`https://api.bitripay.com/api/health` and the apex → www redirect. Until the secrets exist the job stops with a
"Deployment not configured" warning and nothing is deployed.

Add these once under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | public address of the production host |
| `DEPLOY_USER` | deploy user allowed to run Docker (`usermod -aG docker <user>`) |
| `DEPLOY_SSH_KEY` | private key of that user; put the public key in its `~/.ssh/authorized_keys` on the host (`ssh-keygen -t ed25519 -f bitripay-deploy -N ''`) |
| `DEPLOY_PATH` | optional, default `/opt/bitripay` |
| `DEPLOY_PORT` | optional, default `22` |

and the variable `DEPLOY_MODE` = `shared-host` or `dedicated` (Variables tab; default `shared-host`).

### B. Pull-based: a timer on the host (no secrets in GitHub)

On the host, from the checkout, as root:

```bash
bash deploy/install-auto-deploy.sh      # systemd timer: every 5 minutes runs deploy/auto-deploy.sh
bash deploy/auto-deploy.sh --force      # deploy the current remote head right now
tail -f /var/log/bitripay-auto-deploy.log
```

`deploy/auto-deploy.sh` fetches the followed branch (`AUTO_DEPLOY_BRANCH` in the env file, else the branch checked
out), and deploys a new commit only when GitHub's `verify` workflow has completed successfully for it. A private
repository needs `GITHUB_TOKEN` in the env file (fine-grained, "Actions: read") so the timer can read that status;
without it nothing is deployed automatically and the log says why. A commit whose CI failed is skipped once and
never retried; `--force` overrides the gate for an emergency.

For hosts without git, `npm run release` packs every compiled layer (backend, web, admin, shared packages, deploy
folder) into `release/bitripay-<version>-<sha>.tar.gz`.
