-- Shifts. A cashier opens one, and the operations that cashier enters while it is open belong to it.
-- Closing a shift with a count of the cash is a later step; the columns for it are here already.

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id uuid NOT NULL REFERENCES users (id),
  opened_at timestamptz NOT NULL,
  -- Null while the shift is open.
  closed_at timestamptz,
  CONSTRAINT shifts_closed_after_opened_check CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

-- The database itself allows one open shift in the whole cash desk: two cashiers opening at the same
-- moment cannot both succeed, whatever the application does.
CREATE UNIQUE INDEX shifts_one_open_key ON shifts ((true)) WHERE closed_at IS NULL;

CREATE INDEX shifts_closed_at_idx ON shifts (closed_at DESC) WHERE closed_at IS NOT NULL;

-- Per currency: what the shift started with and, once it is closed, what the books said, what was counted
-- and the difference. The next shift starts with what was counted.
CREATE TABLE shift_balances (
  shift_id uuid NOT NULL REFERENCES shifts (id),
  currency text NOT NULL CHECK (currency IN ('RUB', 'USD')),
  opening_minor bigint NOT NULL,
  calculated_minor bigint,
  actual_minor bigint,
  difference_minor bigint,
  PRIMARY KEY (shift_id, currency),
  CONSTRAINT shift_balances_count_check CHECK (
    (calculated_minor IS NULL AND actual_minor IS NULL AND difference_minor IS NULL)
    OR (calculated_minor IS NOT NULL AND actual_minor IS NOT NULL AND difference_minor = actual_minor - calculated_minor)
  )
);

-- The shift an operation was entered in; null for operations from before there were shifts, and for
-- those entered while the cashier had no shift of their own open.
ALTER TABLE operations ADD COLUMN shift_id uuid REFERENCES shifts (id);
CREATE INDEX operations_shift_idx ON operations (shift_id, created_at DESC) WHERE shift_id IS NOT NULL;

-- Which shift an operation belongs to is decided when it is written and never changes (the guard of
-- migration 0004, with this one more column that must stay as it is).
CREATE OR REPLACE FUNCTION kassa_guard_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  said_differently boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The id, type, author, shift and time of an operation never change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  said_differently :=
       NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.recipient IS DISTINCT FROM OLD.recipient
    OR NEW.client_code IS DISTINCT FROM OLD.client_code
    OR NEW.client_code_key IS DISTINCT FROM OLD.client_code_key
    OR NEW.comment IS DISTINCT FROM OLD.comment
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by;

  IF said_differently AND OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A deleted operation is final' USING ERRCODE = 'restrict_violation';
  END IF;
  IF said_differently AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'A change to an operation needs the next revision'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT said_differently AND NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'The revision of an operation moves only with a change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
