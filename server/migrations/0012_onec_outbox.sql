-- The payments of clients that are to go to 1C as cash receipts (ПКО), one row for each, written with the operation and worked
-- through afterwards by a worker that tries again when 1C cannot be reached. `doc_ref` and `doc_number` say which
-- document in 1C the payment became; they are set as soon as 1C has made it, so a try that is cut off half way
-- goes on with the same document and never makes a second one.
CREATE TABLE onec_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES operations (id),
  created_at timestamptz NOT NULL,
  -- pending: to be done; blocked: waits for a person (no counterpart in 1C, no contract...), tried again every quarter of
  -- an hour; written: the document is in 1C, posted and checked; failed: given up, a person must look; skipped: not
  -- to be written any more (deleted, not a payment of a client any more, not on the list of clients); preview: what
  -- would have been written, in the rehearsal mode.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'blocked', 'written', 'failed', 'skipped', 'preview')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  doc_ref uuid,
  doc_number text,
  written_at timestamptz,
  -- Why it waits, failed or was skipped; for a rehearsal, what would have been written.
  detail text,
  -- The group was told that it waits or failed.
  alerted boolean NOT NULL DEFAULT false,
  CHECK ((status = 'written') = (written_at IS NOT NULL))
);
CREATE INDEX onec_outbox_due_idx ON onec_outbox (next_attempt_at) WHERE status IN ('pending', 'blocked');
