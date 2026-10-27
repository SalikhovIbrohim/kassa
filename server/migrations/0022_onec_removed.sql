-- What is done to a payment in the cash desk is done to its document in 1C: a correction changes the document and posts it
-- again, a deletion unposts it and marks it for deletion (never deleted outright: the accountant empties what is marked).
-- removed: the document of a payment that was deleted (or is no longer a payment of a client) is unposted and marked.
ALTER TABLE onec_outbox DROP CONSTRAINT onec_outbox_status_check;
ALTER TABLE onec_outbox ADD CONSTRAINT onec_outbox_status_check
  CHECK (status IN ('pending', 'blocked', 'written', 'failed', 'skipped', 'preview', 'removed'));
-- The mark for deletion was put by the cash desk: if the payment comes back (its category made a payment of a client
-- again), the cash desk takes its own mark off and uses the document again. A mark a person put is left alone.
ALTER TABLE onec_outbox ADD COLUMN removed_by_kassa boolean NOT NULL DEFAULT false;
