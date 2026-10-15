-- The business has two cash desks: Moscow (rubles and dollars) and Andijan (dollars only). Every entry, every count of
-- the cash and every opening balance belongs to one of them; everything there was before is Moscow's.
ALTER TABLE operations ADD COLUMN kassa text NOT NULL DEFAULT 'moscow' CHECK (kassa IN ('moscow', 'andijan'));
ALTER TABLE operations ADD CONSTRAINT operations_andijan_dollars CHECK (kassa <> 'andijan' OR currency = 'USD');
CREATE INDEX operations_kassa_created_idx ON operations (kassa, created_at);

ALTER TABLE reconciliations ADD COLUMN kassa text NOT NULL DEFAULT 'moscow' CHECK (kassa IN ('moscow', 'andijan'));

ALTER TABLE opening_balances ADD COLUMN kassa text NOT NULL DEFAULT 'moscow' CHECK (kassa IN ('moscow', 'andijan'));
ALTER TABLE opening_balances DROP CONSTRAINT opening_balances_pkey;
ALTER TABLE opening_balances ADD PRIMARY KEY (kassa, currency);

-- The cash desk of an entry never changes, like its author and its time: the guard of migration 0016, with one more field.
CREATE OR REPLACE FUNCTION kassa_guard_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  said_differently boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.kassa IS DISTINCT FROM OLD.kassa
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The id, type, author, shift, cash desk and time of an operation never change'
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
    OR NEW.trip_number IS DISTINCT FROM OLD.trip_number
    OR NEW.counterparty IS DISTINCT FROM OLD.counterparty
    OR NEW.employee IS DISTINCT FROM OLD.employee
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
