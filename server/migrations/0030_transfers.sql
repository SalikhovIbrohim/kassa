-- Money moved from one cash desk of the business to another. A category of expenses that moves money says so
-- (`transfer`); an expense of it names the desk the money went to, and the same money is written at once as an income
-- of that desk, of the category of incomes that says the same. The income points at its expense: the two are
-- corrected and deleted together, through the expense.
ALTER TABLE categories ADD COLUMN transfer boolean NOT NULL DEFAULT false;
UPDATE categories SET transfer = true WHERE lower(btrim(label)) = 'внутреннее перемещение денежных средств';

ALTER TABLE operations ADD COLUMN to_kassa text CHECK (to_kassa ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE operations ADD COLUMN transfer_of uuid UNIQUE REFERENCES operations (id);
ALTER TABLE operations ADD CONSTRAINT operations_transfer_sides CHECK (
  (to_kassa IS NULL OR (kind = 'expense' AND to_kassa <> kassa)) AND (transfer_of IS NULL OR kind = 'income')
);
