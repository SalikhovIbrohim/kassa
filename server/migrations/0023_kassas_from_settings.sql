-- The cash desks of a business are named in the settings of its installation (KASSAS), not in the database: another
-- company has other desks (Tashkent, say) and keeps other money in them. So the lists of names that migrations 0017
-- and 0020 wrote into the tables go, and so does the rule that Andijan keeps dollars only: which money a desk keeps is
-- the settings' to say, and the server checks it on every entry, every correction and every count. What stays in the
-- database is the shape of an id. Nothing stored changes: the entries, the counts, the opening balances and the cities
-- of people and of categories are as they were, and an installation that sets nothing has the two desks it had.
DO $$
DECLARE
  found record;
BEGIN
  -- Found by what they say, not by their names: a database restored from a copy keeps whatever names it was given.
  FOR found IN
    SELECT c.conrelid::regclass AS in_table, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid IN ('operations'::regclass, 'reconciliations'::regclass, 'opening_balances'::regclass,
                          'categories'::regclass, 'users'::regclass)
       AND pg_get_constraintdef(c.oid) LIKE '%''andijan''%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', found.in_table, found.conname);
  END LOOP;
END
$$;

ALTER TABLE operations ADD CONSTRAINT operations_kassa_check CHECK (kassa ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_kassa_check CHECK (kassa ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE opening_balances ADD CONSTRAINT opening_balances_kassa_check CHECK (kassa ~ '^[a-z][a-z0-9_]{0,31}$');
-- A city is the id of a cash desk, or nothing for everywhere.
ALTER TABLE categories ADD CONSTRAINT categories_city_check CHECK (city ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE users ADD CONSTRAINT users_city_check CHECK (city ~ '^[a-z][a-z0-9_]{0,31}$');
