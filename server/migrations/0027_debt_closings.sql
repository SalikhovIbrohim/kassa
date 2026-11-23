-- The report on the debts of the clients, day by day (see debt-report.ts). A day of the cash desk closes by itself at
-- three in the morning, and what the clients owed when it closed is kept here: a picture of that moment, never changed
-- afterwards. The debts themselves are still stored nowhere and worked out every time; the picture is only there to
-- tell, the next time, what was written into the days already closed (a payment entered late for a day before, a sum
-- moved from one client to another, a trip marked as arrived after the fact).

CREATE TABLE debt_closings (
  -- The day of the cash desk that closed.
  day date PRIMARY KEY,
  -- When the picture was taken: as soon as the day was over, or later when the server was not running then.
  taken_at timestamptz NOT NULL,
  -- What all the clients owed together, in cents.
  total_minor bigint NOT NULL,
  -- What each client owed, by code, in cents: {"707": 125000}. A client who owed nothing is not in it.
  debts jsonb NOT NULL,
  -- The codes of the thirty who owed most, biggest first, and of those who had not paid for long, as the report listed them.
  top jsonb NOT NULL,
  overdue jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION kassa_debt_closings_are_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The closing of a day is kept as it was taken' USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER debt_closings_are_final BEFORE UPDATE ON debt_closings FOR EACH ROW EXECUTE FUNCTION kassa_debt_closings_are_final();
