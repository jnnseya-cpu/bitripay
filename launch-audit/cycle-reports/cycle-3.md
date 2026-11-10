# Cycle 3 — embedding trend intelligence, and taking it off the shop window

**Build:** `8ad85cc` on `claude/magical-franklin-pa55pn`.
**Scope:** two instructions — the module must be part of the whole existing platform rather than a separate one,
and a customer must never see it. Everything verified in cycles 1 and 2 stands; nothing was removed.

**Verdict for this build is unchanged: NO-GO.** Production is still unreachable from this session, so the deployed
build is not the tested build, and H-10 (the module is not calibrated) is unchanged. The module remains off.

## Invisible, and proved against the running build

`internal` on a catalogue entry keeps it out of every public surface while leaving the module-coverage invariant
able to trace the flag to enforced code. Probed against the compiled build on a fresh database:

| Surface | Result |
| --- | --- |
| `/features` hub, English and French | 0 mentions |
| `/features/trend-intelligence` | 404, as an unknown slug |
| `sitemap.xml` | 0 entries |
| `/blog/<article>` both languages | 404 |
| Hub JSON-LD `ItemList` | 41 features |
| Control: `/features/qr-code-payments` | 200 |

A sweep in `features.test.ts` enforces all of it for anything marked internal, including the related links of every
public feature and of every published article — so invisibility is a property of the build.

**A process from before the change served the first three probe runs**, because `ss` cannot see listeners in this
container and the kill-by-port had silently done nothing for half an hour. Every "it is still visible" reading was
stale code. Worth recording: a probe that reports the wrong answer confidently is worse than no probe, and the tell
was that the compiled artefact disagreed with the live response.

## Embedded

Nothing is registered, typed or scored by hand. The collector reads `seo_pageviews`, `support_tickets` (counts per
category only) and `domain_events` (counts per type); topics are the catalogue's own features; fit and readiness
come from `featureAvailability()`; claims are the features' own published proof lines. The loop runs on the
existing daily scheduler, and the claim boundary lives in `siteContext()` so every agent that writes public copy
inherits it rather than one call site passing it.

Proved end to end against the compiled build on a throwaway database: 488 observations over 8 days with nothing
registered, 41 topics synced, QR payments scored into the brief band on all three families (opportunity 90.8,
confidence 88.0), one draft proposed by the platform, steering flipped from backlog to brief on a second
administrator's approval. The trend tables contained none of the fixture's ticket subject, card number or user id.

## Defects found and fixed in this cycle

| # | Defect | How it was found | Severity |
| --- | --- | --- | --- |
| LA-008 | The collector invented a baseline of zero for periods the platform was not counting | a test that expected the scorer to stay silent | P2 |
| LA-009 | The scheduled pass resurrected a claim an administrator had retired | writing the test for LA-010, which refused to fail | P2 |
| LA-010 | Briefs were declined without a reason | reading the catch block against the module's own stated principle | P3 |
| LA-011 | The daily collector scanned `domain_events` and `support_tickets` | `EXPLAIN QUERY PLAN`, not a symptom | P3 |

LA-009 is the one worth remembering. The automatic loop was quietly overruling a person on the single thing in
this module that is supposed to be a person's to decide — what the platform may claim — and it was invisible
because the brief it produced looked perfectly ordinary.

## The upgrade path, tested rather than assumed

This cycle adds a migration, and the VPS has a populated database rather than a fresh one — which is the case none
of the test suites exercise, because every suite starts from `:memory:`.

Built a database at the previous release (45 migrations), populated the two tables the new indexes touch (5,000
domain events, 300 tickets), then applied only what a deploy would apply:

- `046_trend_signal_indexes.sql` was the single pending migration, applied in **2 ms**
- re-applying it is a no-op, so a re-run deploy is safe
- row counts unchanged, `PRAGMA integrity_check` returns `ok`
- both query plans use the new covering indexes afterwards

**The gap that revealed:** this repository has 46 migrations and no standing test that the upgrade path works on a
populated database. Every suite builds from nothing, so a migration that breaks only on existing data — a `NOT
NULL` column with no default, a unique index that existing rows violate — would pass CI and fail on the VPS. This
one was checked by hand; the class is not covered. Recorded here rather than fixed, because a migration-upgrade
harness is its own piece of work.

## Judgements, not measurements

- A fixture that looked like a surge produced `watch` and no brief, **correctly**: support and event volumes sat
  below the specification's gate of twenty, so only one family qualified and the single-family cap held confidence
  at 59. That case is now asserted deliberately.
- An incremental cursor was designed and then not built: the cycle measures 282 ms cold and 126 ms warm against a
  year of synthetic data, so re-reading the window is cheaper than the state a cursor would need.
- The twenty support-category and event-type mappings are checked for referential integrity but remain judgements
  about this platform's ticket mix. They should be read against real tickets before the module is switched on.
