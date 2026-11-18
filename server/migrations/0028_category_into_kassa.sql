-- A category whose money goes into one cash desk, whoever enters it. The owner takes a payment of a client in Tashkent
-- and rings Moscow to have it written down: the cashier of Moscow enters it under such a category, and it is an income
-- of the desk of Tashkent, in the balance of Tashkent, not of Moscow. None, which is what every category had: the money
-- goes into the desk the person works in.
ALTER TABLE categories ADD COLUMN into_kassa text CHECK (into_kassa ~ '^[a-z][a-z0-9_]{0,31}$');
