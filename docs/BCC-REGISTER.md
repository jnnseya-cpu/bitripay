# BCC / national switch information requests (BCC-01 … BCC-16)

Register of the questions BitriPay must have answered by the Banque Centrale du Congo and the national switch operator
before any national routing goes live. Status of every line: **prepared, not yet transmitted**. Each answer feeds a
specific module; until it arrives the module runs on its simulator and the corresponding product stays disabled in
production (see `backend/api/src/services/switch/connections.ts` `enableBlockers` and `emissionGate`).

| Id | Request | Why it is needed | Consumed by | Status |
| --- | --- | --- | --- | --- |
| BCC-01 | Authenticated text of Instruction n°58, annexes, amendments and the applicable article | The routing obligation is only cited as verified once the authenticated text is on file | compliance register, `docs/SWITCH-COMMITMENTS.md` | prepared, not yet transmitted |
| BCC-02 | Operating entity, participation rules and the criteria applicable to aggregators | Decides direct participation vs sponsored access | participants registry (`services/switch/participants.ts`) | prepared, not yet transmitted |
| BCC-03 | Services really open today and the opening calendar per participant | Capability matrix must reflect what is live, not announced | capability matrix, `serviceAvailability` | prepared, not yet transmitted |
| BCC-04 | Integration guide: protocols, versions, encoding, error catalogue | The certified adapter codec is written from the official profile only | `services/switch/adapter.ts` (abstract adapter) | prepared, not yet transmitted |
| BCC-05 | Participant identifiers, accounts, merchant identifiers, official directory | Directory of institutions must come from the approved registry | participants registry | prepared, not yet transmitted |
| BCC-06 | Networks, addresses, sessions, certificates, MAC/HSM, key rotation | Channel security and key custody are contractual, never assumed | `services/switch/vault.ts`, certificate alerts | prepared, not yet transmitted |
| BCC-07 | Idempotency, unique identifiers, timeouts, inquiry, NOT_FOUND semantics | Decides when re-emission is ever allowed (IDM-004/005) | orchestrator (`services/switch/payments.ts`) | prepared, not yet transmitted |
| BCC-08 | Distinction authorisation / credit / clearing / settlement and the proof of finality | The five status dimensions must map to proofs | payment status dimensions, reconciliation | prepared, not yet transmitted |
| BCC-09 | Currencies, limits, fees, taxes, ceilings, FX rules | Product ceilings and tariff versioning | fee schedules, route policy | prepared, not yet transmitted |
| BCC-10 | Reports: frequencies, cycles, time zone / business date, totals, corrections | Three-way reconciliation needs the official cycle definition | `services/switch/reconciliation.ts` | prepared, not yet transmitted |
| BCC-11 | Reversal, refund and dispute rules and windows | Refund reservations and dispute deadlines come from national rules | refunds, disputes | prepared, not yet transmitted |
| BCC-12 | QR / card / POS / ATM profiles, identifiers, certification bodies | The national QR profile is distinct from the proprietary BitriQR profile | `shared/bitriqr` national profile (to obtain) | prepared, not yet transmitted |
| BCC-13 | Sandbox, test data, scripts, homologation procedure | Official vectors replace the simulator before production | simulator adapter, acceptance tests T01–T32 | prepared, not yet transmitted |
| BCC-14 | Hosting, audit, data, retention and reporting requirements | Retention of tombstones and journals; audit exports | audit log, evidence vault | prepared, not yet transmitted |
| BCC-15 | SLA, joint continuity / recovery plans, maintenance windows, incident contacts | Operations register and incident escalation | SLA register (`services/sla.ts`), incidents | prepared, not yet transmitted |
| BCC-16 | Conditions and proofs for any routing exception (explicit, never implicit) | Bilateral routing while the switch is unavailable is forbidden without express authorisation | route policy engine (`services/switch/policy.ts`) | prepared, not yet transmitted |

Rule: an answer that is missing blocks only the product that depends on it, unless it is a common dependency
(BCC-01, BCC-04, BCC-06, BCC-07 block every national flow).
