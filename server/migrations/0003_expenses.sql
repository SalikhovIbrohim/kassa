-- Expenses: money going out, with a category from a fixed list kept in the application.
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check CHECK (kind IN ('income', 'expense'));

ALTER TABLE operations ADD COLUMN category text;
ALTER TABLE operations ADD COLUMN recipient text;

-- Only incomes and client refunds name a client.
ALTER TABLE operations ALTER COLUMN client_code DROP NOT NULL;
ALTER TABLE operations ALTER COLUMN client_code_key DROP NOT NULL;

-- The shape of each kind, enforced by the database as a second line of defence:
-- an income names a client, a client refund names a client, no other expense does,
-- and the lower-cased search key is present exactly when the client code is.
ALTER TABLE operations ADD CONSTRAINT operations_shape_check CHECK (
  (kind = 'income'
     AND client_code IS NOT NULL AND client_code_key IS NOT NULL
     AND category IS NULL AND recipient IS NULL)
  OR
  (kind = 'expense'
     AND category IS NOT NULL
     AND (
       (category = 'client_refund' AND client_code IS NOT NULL AND client_code_key IS NOT NULL)
       OR
       (category <> 'client_refund' AND client_code IS NULL AND client_code_key IS NULL)
     ))
);
