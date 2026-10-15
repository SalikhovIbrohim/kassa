-- The clients of the business, by their code (А707, А34-2): the code is what the cash books, 1C and the people know
-- them by, so there is one client to a code. The names may repeat. A client is never deleted, only switched off: the
-- entries that name them keep saying who.
CREATE TABLE clients (
  code text PRIMARY KEY CHECK (code ~ '^А[0-9]{1,5}(-[0-9]{1,3})?$'),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  phone text CHECK (phone IS NULL OR length(phone) BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Search by the code as typed in any case, and by the name.
CREATE INDEX clients_lower_code_idx ON clients (lower(code) text_pattern_ops);
