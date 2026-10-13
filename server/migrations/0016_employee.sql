-- One more thing a category may ask of an entry: the employee (сотрудник) the money went to or came from, as text.
-- The owner ticks it on the category; an entry of such a category is not taken without it.
ALTER TABLE categories ADD COLUMN requires_employee boolean NOT NULL DEFAULT false;

ALTER TABLE operations ADD COLUMN employee text;
ALTER TABLE operations ADD CONSTRAINT operations_employee_check CHECK (employee IS NULL OR length(employee) BETWEEN 1 AND 100);

-- It is part of what an operation says: the guard and the history check of migration 0014, with one more field.
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
       'recipient', OLD.recipient, 'clientCode', OLD.client_code, 'tripNumber', OLD.trip_number,
       'counterparty', OLD.counterparty, 'employee', OLD.employee, 'comment', OLD.comment)
     OR (line.action = 'delete') <> (NEW.deleted_at IS NOT NULL)
     OR (NEW.deleted_at IS NOT NULL
         AND (line.changed_at <> NEW.deleted_at OR line.changed_by <> NEW.deleted_by)) THEN
    RAISE EXCEPTION 'Revision % of operation % has a line in its history that does not describe the change made',
      NEW.revision, NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;
