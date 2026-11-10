-- Indexes for the daily trend-intelligence collection, which reads the platform's own signals by date window.
--
-- Without these, the collector's two aggregate queries scan whole tables to find the last few weeks:
-- `domain_events` only had an index on (type, occurred_at), so a range on `occurred_at` alone could not seek and
-- SQLite read every event the platform has ever emitted — the highest-volume table here — once a day. Tickets had
-- no index at all.
--
-- Both are declared with the grouping column second so the index covers the query outright: the planner seeks the
-- window and never touches the table. They are ordinary date indexes and help any other listing by recency too.
CREATE INDEX IF NOT EXISTS idx_domain_events_occurred ON domain_events (occurred_at, type);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets (created_at, category);

-- The retention sweep deletes by window alone; without this it scans every observation to find the old ones.
CREATE INDEX IF NOT EXISTS ti_observations_retention ON ti_observations (window_end);
