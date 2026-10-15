-- The journal is copied to a Google spreadsheet, one row per entry. What waits to be written there, and which row of
-- the sheet each entry has, so that a correction or a deletion rewrites its row instead of adding another.
CREATE TABLE sheet_outbox (
  id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations (id),
  created_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text
);
CREATE INDEX sheet_outbox_operation_idx ON sheet_outbox (operation_id);

CREATE TABLE sheet_rows (
  operation_id uuid PRIMARY KEY REFERENCES operations (id),
  row_number integer NOT NULL CHECK (row_number >= 2)
);
