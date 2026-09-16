# BitriPay Payout Device (Android)

The phone that holds a merchant / agent SIM and executes local mobile-money payouts **without any operator API**.
It is an Expo (React Native 0.79) app with one small native module, `modules/sms-receiver`, that captures the
operator's confirmation SMS the moment it arrives.

One phone + one SIM = one **payout device**, bound to exactly one prefunded payout account. The same app can also
run as a **SMS collector** (kind `collection`) on a merchant SIM that receives customer payments.

## What it does

| Step | Device | Server (`backend/api`) |
| --- | --- | --- |
| Enrol | Agent signs in once, picks the payout account they operate, the app generates an Ed25519 key in the keystore-backed secure store and registers the public key + SIM identity (`POST /api/evidence/devices`, kind `payout`). The agent token is discarded. | Agents may only enrol devices on accounts they operate (`payout_not_yours`); a payout device must declare its SIM (`sim_identity_required`). |
| Queue | Polls `GET /api/payouts/device/queue` every 10 s with device-signed headers. | Returns `QUEUED` / `IN_PROGRESS` instructions for that payout account only. |
| Claim | `POST /api/payouts/device/:id/claim` → full recipient number + USSD steps; the app dials the operator menu (`tel:` intent). | Claim expires after `compliance.payoutClaimMinutes`; expired claims go back to the queue. |
| Confirm | The operator SMS is captured by the broadcast receiver, signed (`deviceId\nnonce\nreceivedAt\nfrom\noperatorId\ntext`), hashed and posted to `POST /api/payouts/device/:id/evidence` with `simIdentity`, `deviceTimestamp`, `clientHash`. | Parses the SMS with the operator template, checks reference, amount, currency, recipient, SIM, timing, replay and duplicates. Only a full match settles the payout and debits the float. Anything else → `MISMATCHED` / `DUPLICATE` / `MANUAL_REVIEW`. |
| Offline | Signed evidence that cannot be delivered is queued in app storage and retried; each payload carries a single-use nonce so it is never double-counted. | Replays are refused (`evidence_replay`). |
| Collector | Every operator SMS is signed and forwarded to `POST /api/evidence/sms`. | Matches inbound receipts to pending payment intents; raw evidence is preserved whatever the outcome. |
| Bills and airtime | The same queue carries bill payments (rail `bill`: biller, account number, receipt in the steps) and airtime purchases (rail `airtime`: operator and recipient number); the agent pays them from the operator menu and the confirmation SMS settles them like any payout. | `processing` → `completed` on the confirmation, `failed` with the money back to the customer if the payout fails. No biller or operator API. |
| SMS sender | With *Send BitriPay SMS from this SIM* switched on (device tab), the app drains `GET /api/payouts/device/sms-outbox` every poll, sends each message from its own SIM (`SmsManager`) and reports `POST /api/payouts/device/sms-outbox/:id` with `ok` / `error`. | The server queues every code, receipt and notice in `sms_outbox` when the SMS provider is `device`; a refused send goes back to the queue up to three times, then shows as failed in Admin → Messaging. No SMS API key. |

The app **never** decides that money has moved. It cannot mark a payout settled, cannot type a confirmation into the
signed channel on a production build (the manual "paste SMS" panel only exists when the native receiver is absent,
i.e. Expo Go / iOS development), and the private key cannot be exported.

## Protocol

`src/protocol.ts` is pure TypeScript (no React Native imports) and is verified in Node against the same
`crypto.verify` the API uses:

```bash
npm install
npm test          # test/protocol.test.ts + test/forwarder.test.ts
npm run typecheck
```

- **Keys**: Ed25519, 32-byte private seed from `expo-crypto`, public key exported as SPKI PEM.
- **Request auth**: headers `X-Device-Id`, `X-Device-Timestamp` (ISO, ±5 min), `X-Device-Signature` = sign(`deviceId\ntimestamp\nMETHOD\npath`) where `path` is the full route path, e.g. `/api/payouts/device/queue`.
- **Evidence**: `signature` = sign(`deviceId\nnonce\nreceivedAt\nfrom\noperatorId\ntext`), `clientHash` = sha256(text), `simIdentity` = MSISDN or ICCID of the registered SIM, `deviceTimestamp` = time of submission.
- Signatures are standard base64 (URL-safe accepted by the server).

## Building the Android app

The native module has not been compiled in this repository's CI container (no Android SDK); build it on a machine
with Android Studio / SDK 34+ and JDK 17, or with EAS:

```bash
cd frontend/payout-device
npm install
npx expo prebuild --platform android      # applies modules/sms-receiver/app.plugin.js
npx expo run:android                       # or: eas build -p android --profile production
```

Point the app at your API with `expo.extra.apiUrl` in `app.json` (default `http://10.0.2.2:4000`, the emulator's host
loopback). The URL can also be changed on the enrolment screen.

### Permissions

`RECEIVE_SMS` (capture confirmations), `SEND_SMS` (send BitriPay codes and receipts from the SIM, only while the
switch on the device tab is on), `READ_PHONE_STATE` / `READ_PHONE_NUMBERS` (SIM identity for enrolment),
`CALL_PHONE` (dial the USSD menu), `RECEIVE_BOOT_COMPLETED` (keep capturing after a reboot), `USE_BIOMETRIC`
(unlock the app). The inbox is never read: only messages received after installation reach the app, and only senders
matching the configured filters are forwarded.

Google Play restricts `RECEIVE_SMS` to approved use cases; distribute payout devices through **managed / enterprise
distribution** (or an internal track) rather than the public store.

### Native module layout

```
modules/sms-receiver/
  app.plugin.js                 config plugin: permissions + static SMS_RECEIVED / BOOT_COMPLETED receivers
  expo-module.config.json
  android/build.gradle
  android/src/main/java/com/bitripay/smsreceiver/
    SmsBroadcastReceiver.kt     reassembles multipart SMS, stores durably, emits `onSms`
    SmsStore.kt                 SharedPreferences queue until JS acknowledges
    SmsReceiverModule.kt        Expo module: hasPermissions, drainPending, acknowledge, getSimInfo
  src/index.ts                  JS bridge; degrades to "manual" mode when the native module is missing
```

## Operating notes

- A new payout instruction on this SIM rings a loud alarm (bundled `assets/loud_alert.wav`) with a long
  vibration pattern, even in silent mode, so the operator never misses one.

- Enrol a device only on the phone that physically holds the payout SIM; the server rejects confirmations whose
  `simIdentity` differs from the registration (`unregistered_sim`).
- If a phone or SIM is lost, revoke the device in the admin console (Evidence → Devices). Its signatures are refused
  from that moment.
- Keep the confirmation SMS on the device; administrators can request the raw message during a dispute.
- The device app is one input to the maker-checker and manual-review queues, never a bypass of them.
