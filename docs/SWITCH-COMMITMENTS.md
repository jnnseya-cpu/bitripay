# Interconnection commitment note (draft, internal validation)

What BitriPay commits to as an aggregator connected to the national interbank switch, and where each commitment is
enforced in code. The full reference to Instruction n°58 is inserted only after the authenticated text has been verified
(BCC-01); until then it is cited as "the national routing instruction".

| Commitment | Enforcement |
| --- | --- |
| BitriPay performs initiation, orchestration, normalisation, traceability and tracking only: no customer fund holding and no final settlement in the national flows | Switch payments post to the financial observation journal, never to a customer wallet (`services/switch/payments.ts`); wallets and e-money issuance are separate, licence-gated products (`services/emoney.ts`, `enableBlockers`) |
| National interoperable traffic is routed through the switch (direct connection or an expressly admitted participation mode) and never through a bilateral substitute route while the switch is unavailable, unless that flow is expressly authorised | `services/switch/policy.ts` computes the route server-side; a route injected in the merchant body is refused (acceptance test T31); when the switch link is down no bypass exists (T26) and the customer sees «Service temporairement indisponible. Réessayez plus tard.» |
| Technical specifications, security rules, homologation and operating rules are respected | Certification gate and certificate expiry stop emission (`emissionGate`, `certificateAlerts`; tests T05, T06); simulator output is labelled SIMULATION and attests nothing |
| References and proofs are kept for tracking, reconciliation with the switch and the institutions, supervision and audits | Evidence vault (`services/switch/vault.ts`), inbox / outbox with fingerprints, three-way reconciliation with MISSING_REPORT detection (`services/switch/reconciliation.ts`), append-only audit log with correlation ids |
| On interruption: controlled limitation of new initiations, preservation of uncertain states, duplicate prevention, communication, reconciliation before normal resumption | UNKNOWN state with inquiry chain and no blind re-emission (IDM-004; tests T07, T08, T32), idempotency tombstones never released by TTL (IDM-007), incident register (`openIncident`), guardian halts |
| Services needing additional authorisations (e-money issuance, wallets, cards, cross-border) stay disabled until the conditions are met; activating them never removes the national routing obligations | Product enablement is an administrator decision under step-up with the regulatory arrangement recorded (`services/corridors.ts`, go-live checklist `services/goLive.ts`) |

Residual risks recorded with their owners: switch creation vs connection confusion (direction); the "article 58"
reference is not yet certified (compliance); national availability date is an announcement, not a proof (partnerships);
protocol and profiles unknown until the official dossier (payments architecture); sponsored participation is a
conditional option (legal); external deduplication unknown, so no re-emission after doubt (technology / operations);
finality and settlement semantics to be proven (finance / partner).
