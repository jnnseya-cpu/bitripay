-- Session invalidation and account closure: tokens issued before `sessions_invalidated_at` are refused (password change,
-- sign-out everywhere, closure); a closed account keeps its ledger history under a pseudonym and nothing else.
ALTER TABLE users ADD COLUMN sessions_invalidated_at TEXT;
ALTER TABLE users ADD COLUMN closed_at TEXT;
