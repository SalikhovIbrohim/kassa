-- Messages for the Telegram group, written in the same transaction as the operation they are about and sent
-- afterwards, by a worker that tries again when Telegram cannot be reached: a message is neither lost with the
-- connection nor sent twice. `sent` and `failed` rows stay as the record of what was said (and what was not).
CREATE TABLE telegram_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL,
  -- The operation the message is about; null for a message that is not about one.
  operation_id uuid REFERENCES operations (id),
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  sent_at timestamptz,
  last_error text,
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX telegram_outbox_pending_idx ON telegram_outbox (id) WHERE status = 'pending';
