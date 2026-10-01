-- Corrections and deletions. An operation is never lost and never changed in silence:
-- every correction and every deletion leaves a row in operation_changes, a table that
-- only grows, and the database itself refuses anything that would break that.

-- How many times the operation was changed (corrected or deleted); 0 means as first written.
ALTER TABLE operations ADD COLUMN revision integer NOT NULL DEFAULT 0;
ALTER TABLE operations ADD CONSTRAINT operations_revision_check CHECK (revision >= 0);

-- Deletion is logical: the row stays, marked. Cashiers no longer see it and it no longer
-- counts towards any balance; the viewer can still see it and who deleted it, and when.
ALTER TABLE operations ADD COLUMN deleted_at timestamptz;
ALTER TABLE operations ADD COLUMN deleted_by uuid REFERENCES users (id);
ALTER TABLE operations ADD CONSTRAINT operations_deleted_check
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

CREATE TABLE operation_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations (id),
  -- The revision of the operation this change produced: 1 for the first change, then 2, 3...
  revision integer NOT NULL CHECK (revision >= 1),
  action text NOT NULL CHECK (action IN ('edit', 'delete')),
  changed_at timestamptz NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id),
  -- Why, in the person's own words. Optional.
  reason text,
  -- The editable fields of the operation as they were just before this change.
  state_before jsonb NOT NULL CHECK (jsonb_typeof(state_before) = 'object'),
  UNIQUE (operation_id, revision)
);

-- ---- What the database refuses, whatever the application does ----

CREATE FUNCTION kassa_forbid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: operations are never deleted and their history only grows',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

-- Nothing is physically deleted, neither an operation nor a line of its history.
CREATE TRIGGER operations_never_deleted BEFORE DELETE ON operations
  FOR EACH ROW EXECUTE FUNCTION kassa_forbid();
CREATE TRIGGER operations_never_truncated BEFORE TRUNCATE ON operations
  FOR EACH STATEMENT EXECUTE FUNCTION kassa_forbid();
CREATE TRIGGER operation_changes_only_grow BEFORE UPDATE OR DELETE ON operation_changes
  FOR EACH ROW EXECUTE FUNCTION kassa_forbid();
CREATE TRIGGER operation_changes_never_truncated BEFORE TRUNCATE ON operation_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kassa_forbid();

-- An operation's identity never changes; what it says changes only together with a new
-- revision, one step at a time; a deleted operation is final.
CREATE FUNCTION kassa_guard_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  said_differently boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The id, type, author and time of an operation never change'
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

CREATE TRIGGER operations_guard_update BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION kassa_guard_operation_update();

-- Checked when the transaction ends, so the two writes may come in either order: a new
-- revision of an operation needs its line in the history, and a line of history needs an
-- operation that has reached that revision.
CREATE FUNCTION kassa_require_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operation_changes WHERE operation_id = NEW.id AND revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'Revision % of operation % has no line in its history', NEW.revision, NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER operations_change_recorded
  AFTER UPDATE ON operations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.revision IS DISTINCT FROM OLD.revision)
  EXECUTE FUNCTION kassa_require_history();

CREATE FUNCTION kassa_require_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operations WHERE id = NEW.operation_id AND revision >= NEW.revision
  ) THEN
    RAISE EXCEPTION 'A line of history for operation % claims revision %, which it never reached',
      NEW.operation_id, NEW.revision USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER operation_changes_have_a_revision
  AFTER INSERT ON operation_changes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION kassa_require_revision();
