-- The code of a client is the letter А and digits (А707) in one business and digits alone (707) in another: which it
-- is, the settings of the installation say (CLIENT_CODES), and the server writes every code that way. The table only
-- keeps the shape both have. Nothing stored changes.
ALTER TABLE clients DROP CONSTRAINT clients_code_check;
ALTER TABLE clients ADD CONSTRAINT clients_code_check CHECK (code ~ '^А?[0-9]{1,9}(-[0-9]{1,3})?$');
