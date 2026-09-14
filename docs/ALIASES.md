# Alias tables

The specification was written across several messages that name the same concepts differently. Each table below maps a
specification name to the built name so that both are accepted and traceable. Nothing was renamed: the built names stay,
the specification names are aliases.

## Route (money-movement) stages

Source: `backend/api/src/services/routeLifecycle.ts` (`STAGE_ALIASES`, `stageFromAlias`, `withStageAlias`). Every route
view carries `stage` (built) and `stageAlias` (specification).

| Specification name | Built stage |
| --- | --- |
| CREATED | CREATED |
| QUOTED | QUOTED |
| APPROVAL_REQUIRED | BIOMETRIC_APPROVAL_REQUIRED |
| APPROVED | BIOMETRICALLY_APPROVED |
| FUNDING_PENDING | FUNDING_PENDING |
| FUNDS_RECEIVED | FUNDED |
| FX_RESERVED | FX_RESERVED |
| AWAITING_CONFIRMATION | AWAITING_CONFIRMATION |
| INSTRUCTION_ISSUED | PAYOUT_ROUTED |
| PAYMENT_SENT | PAYOUT_SENT |
| EVIDENCE_RECEIVED | EVIDENCE_RECEIVED |
| VERIFYING | VERIFYING |
| CONFIRMED | VERIFIED |
| RELEASED | SETTLED |
| EXPIRED | EXPIRED |
| FAILED | FAILED |
| MISMATCHED | MISMATCHED |
| DUPLICATE | DUPLICATE |
| INSUFFICIENT_LIQUIDITY | INSUFFICIENT_LIQUIDITY |
| UNDER_REVIEW | MANUAL_REVIEW |
| DISPUTED | DISPUTED |
| REVERSED | REVERSED |
| REFUNDED | REFUNDED |

## Command-centre agents

Source: `backend/api/src/services/assist/registry.ts` (`OS_AGENT_ALIASES`, `agentForAlias`). The partner API accepts
either name on `POST /v1/ai/:agent`.

| Specification agent | Built agent key |
| --- | --- |
| RouteOptimiser | smart_route |
| FraudScorer | fraud_scorer |
| ComplianceMonitor | compliance |
| SavingsAdvisor | analyst |
| CreditReadiness | analyst |
| MerchantGrowth | onboarding |
| FinancialEducator | knowledge |
| SupportAgent | chief_of_staff |
| LiquidityForecaster | rebalancer |
| ContentEngine | seo_content |
| DisputeResolver | dispute_arbiter |
| RecipientValidator | koda_core |

## Webhook and domain events

Source: `backend/api/src/services/webhooks.ts` (`WEBHOOK_EVENT_TYPES`) and `backend/api/src/services/bus.ts`
(`DOMAIN_EVENT_TYPES`). Companion events are dispatched at the same moment as the built event they accompany.

| Specification event | Built event(s) |
| --- | --- |
| PaymentIntentCreated | payment_intent.created / bus `intent.created` |
| PaymentMethodSelected, RouteSelected | bus `route.selected` (Smart Route decision) |
| ProviderAttemptCreated | bus `attempt.created` |
| ProviderAuthorised | payment_intent.authorised |
| PaymentCaptured | payment_intent.succeeded / bus `payment.captured` |
| LedgerPosted | bus `transaction.created`, `transaction.settled` |
| SettlementObligationCreated | settlement.created / bus `settlement.closed` |
| MerchantNotified | webhook delivery record (`webhook_deliveries`) |
| SettlementInitiated | payout.processing |
| SettlementCompleted | settlement.completed / bus `settlement.paid` |
| verification.confirmed | companion of verification.completed with a positive result |
| dispute.opened | companion of payment_intent.disputed |
| payout.succeeded, payout.settled | companions of payout.completed |

## Offline payment states (§28)

Source: `backend/api/src/services/offline.ts` (`OFFLINE_STATES`, `offlineLifecycle`).

| Specification state | Stored `sync_state` | Where it is set |
| --- | --- | --- |
| OFFLINE_CREATED | – | merchant device shows the signed offline code |
| OFFLINE_ACCEPTED_LOCALLY | – | payer device signs the promise |
| SYNC_PENDING | PENDING_SYNC | promise queued on the device |
| ONLINE_VALIDATING | VALIDATING | batch handed to the platform |
| CONFIRMED | SETTLED | ledger posting done, signed receipt issued |
| REJECTED | REJECTED | platform refused the promise; local balance restored |

## Roles

| Specification role | Built role / permission |
| --- | --- |
| TREASURY_SUPER_ADMIN | administrator with the `treasury` permission |
| compliance_officer | administrator with the `compliance` permission |
| finance_admin | administrator with the `approvals` and `reconciliation` permissions |
| super_admin | administrator with every permission |
| corporate, ngo, government, developer | merchant-class accounts (see `isMerchantRole`) |
