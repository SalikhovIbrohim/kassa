-- The exchange rate of a ruble operation: how many rubles one dollar was worth when it was made,
-- times 10 000 (79,5 is 795000). It turns rubles into dollars: the owner counts everything in
-- dollars. Only a ruble operation has one (the application insists on it for an income); an
-- expense without one is counted at the average rate of its shift once the shift is closed.
ALTER TABLE operations ADD COLUMN rate_e4 bigint;
ALTER TABLE operations ADD CONSTRAINT operations_rate_check
  CHECK (rate_e4 IS NULL OR (currency = 'RUB' AND rate_e4 BETWEEN 10000 AND 10000000));

-- The average rate of the ruble incomes of a shift, fixed when the shift is closed.
ALTER TABLE shifts ADD COLUMN average_rate_e4 bigint;
ALTER TABLE shifts ADD CONSTRAINT shifts_average_rate_check
  CHECK (average_rate_e4 IS NULL OR (closed_at IS NOT NULL AND average_rate_e4 BETWEEN 10000 AND 10000000));

-- The rate is part of what an operation says: it moves only with a new revision, and the history
-- keeps what it was (the guard of migration 0005 and the history check of 0004, with one more field).
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
    OR NEW.rate_e4 IS DISTINCT FROM OLD.rate_e4
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

CREATE OR REPLACE FUNCTION kassa_require_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  line public.operation_changes%ROWTYPE;
BEGIN
  SELECT * INTO line FROM public.operation_changes
   WHERE operation_id = NEW.id AND revision = NEW.revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revision % of operation % has no line in its history', NEW.revision, NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF line.state_before IS DISTINCT FROM jsonb_build_object(
       'amountMinor', OLD.amount_minor, 'currency', OLD.currency, 'rateE4', OLD.rate_e4, 'category', OLD.category,
       'recipient', OLD.recipient, 'clientCode', OLD.client_code, 'comment', OLD.comment)
     OR (line.action = 'delete') <> (NEW.deleted_at IS NOT NULL)
     OR (NEW.deleted_at IS NOT NULL
         AND (line.changed_at <> NEW.deleted_at OR line.changed_by <> NEW.deleted_by)) THEN
    RAISE EXCEPTION 'Revision % of operation % has a line in its history that does not describe the change made',
      NEW.revision, NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;
