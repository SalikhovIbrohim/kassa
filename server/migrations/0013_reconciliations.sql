-- The cash desk has no shifts any more: the day turns over by itself at 03:00 Moscow time, and everybody who works
-- in the cash desk enters into the one book. What the shifts were for, counting the cash against the book, becomes a
-- reconciliation that one person (the role "admin") makes whenever they like.

-- "admin" is a cashier who may also reconcile the cash desk.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('cashier', 'admin', 'viewer'));

-- A count of the cash, with what the book said at that moment, for each currency. Made by the client's own id, so that
-- the same count sent twice is stored once. The difference moves the balance (a shortage lowers it): from then on the
-- book says what was counted.
CREATE TABLE reconciliations (
  id uuid PRIMARY KEY,
  made_by uuid NOT NULL REFERENCES users (id),
  made_at timestamptz NOT NULL
);
CREATE INDEX reconciliations_made_at_idx ON reconciliations (made_at DESC);

CREATE TABLE reconciliation_balances (
  reconciliation_id uuid NOT NULL REFERENCES reconciliations (id),
  currency text NOT NULL CHECK (currency IN ('RUB', 'USD')),
  calculated_minor bigint NOT NULL,
  actual_minor bigint NOT NULL,
  difference_minor bigint NOT NULL,
  PRIMARY KEY (reconciliation_id, currency),
  CONSTRAINT reconciliation_balances_difference_check CHECK (difference_minor = actual_minor - calculated_minor)
);

-- The counts of the shifts that were closed are kept as reconciliations (with the id of the shift), so that the
-- balances and the totals of the past stay as they were: from now on they are read from here only.
INSERT INTO reconciliations (id, made_by, made_at)
SELECT s.id, s.closed_by, s.closed_at
  FROM shifts s
 WHERE s.closed_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM shift_balances sb WHERE sb.shift_id = s.id AND sb.actual_minor IS NOT NULL);

INSERT INTO reconciliation_balances (reconciliation_id, currency, calculated_minor, actual_minor, difference_minor)
SELECT sb.shift_id, sb.currency, sb.calculated_minor, sb.actual_minor, sb.difference_minor
  FROM shift_balances sb
 WHERE sb.actual_minor IS NOT NULL;

-- A count is final: it is never changed or taken back, as the balance rests on it.
CREATE FUNCTION kassa_forbid_reconciliation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: a reconciliation is final', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER reconciliations_final BEFORE UPDATE OR DELETE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION kassa_forbid_reconciliation_change();
CREATE TRIGGER reconciliations_never_truncated BEFORE TRUNCATE ON reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION kassa_forbid_reconciliation_change();
CREATE TRIGGER reconciliation_balances_final BEFORE UPDATE OR DELETE ON reconciliation_balances
  FOR EACH ROW EXECUTE FUNCTION kassa_forbid_reconciliation_change();
CREATE TRIGGER reconciliation_balances_never_truncated BEFORE TRUNCATE ON reconciliation_balances
  FOR EACH STATEMENT EXECUTE FUNCTION kassa_forbid_reconciliation_change();
