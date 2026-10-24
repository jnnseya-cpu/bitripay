# Defects — cycle 1

## LA-001 · Module switch "KYC verification" was enforced in the interface only

- **Severity** P2 (high) · **Blocker** No · **Area** authorisation / regulatory control surface · **Status** FIXED, retested
- **Preconditions** Administrator switches *KYC verification* off in Console → Modules.
- **Steps** `GET /api/kyc` and `POST /api/kyc` with any authenticated user token.
- **Expected** `422 module_disabled` — the route family is off.
- **Actual (before)** `200` / submission accepted. The flag was read in exactly one place,
  `frontend/web/src/pages/Settings.tsx:21`, which hid a settings tab. Lite, the phone app and any direct API
  caller were unaffected.
- **Root cause** `app.use('/api/kyc', kycRouter)` was the only mount in that block without `requireModule(...)`.
  Every sibling line (`transfers`, `qrPayments`, `savings`, `creditScore`, `openBanking`, `restrictedWallets`)
  has one, so this was an omission, not a design decision.
- **Impact** A control in a regulated console reported a state it did not enforce. An administrator switching KYC
  off — because a provider is down, or a programme is not live — would believe submissions had stopped while they
  continued. Not an exploitable bypass: tier limits still applied, so no user gained anything. The harm is a false
  belief about control state.
- **Fix** `app.use('/api/kyc', requireModule('kyc'), kycRouter)`.
- **Regression test** `module_switches.test.ts` — "refuses the KYC route family when KYC verification is switched off".
- **Residual risk** None known.

## LA-002 · Module switch "Referral system" was enforced nowhere

- **Severity** P3 (medium) · **Blocker** No · **Area** treasury / growth controls · **Status** FIXED, retested
- **Steps** Switch *Referral system* off; register a user carrying a referral code; complete a first deposit.
- **Expected** No attribution, no reward paid.
- **Actual (before)** Rewards paid from the treasury as normal. `modules.referrals` was read in **no** file.
- **Root cause** The flag was added to `ModuleFlags`, `DEFAULT_MODULES` and the console's switch list without a
  reader. Attribution happens inside registration and payout inside deposit completion, so there was no referral
  endpoint for route middleware to guard and the gap was invisible to a route-level audit.
- **Impact** Money left the treasury on a programme an administrator believed was stopped.
- **Fix** `referralsOn()` guard in `services/referrals.ts` at all three entry points (`payRewards`,
  `onUserRegistered`, `onDepositCompleted`), plus `enabled` on `referralStats` so no interface keeps offering a
  share link that would attribute nobody. Past earnings stay readable — they were earned.
- **Regression test** `module_switches.test.ts` — "stops attributing and paying referral rewards…".
- **Residual risk** None known.

## LA-003 · Pattern sweep made permanent

Not a defect — the control that stops LA-001 and LA-002 recurring. `module_switches.test.ts` walks the whole
server source and fails if any flag in `DEFAULT_MODULES` has no reader. Adding a switch to the console without
enforcing it is now a failing test.
