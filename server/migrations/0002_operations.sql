CREATE TABLE operations (
  -- Created by the client, so sending the same operation twice cannot double it.
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('income')),
  -- Whole minor units (kopecks, cents): money is never a floating-point number.
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency IN ('RUB', 'USD')),
  client_code text NOT NULL,
  -- client_code lower-cased by the application, for case-insensitive prefix search that
  -- works for any alphabet whatever locale the database was created with.
  client_code_key text NOT NULL,
  comment text,
  author_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL
);

CREATE INDEX operations_created_at_idx ON operations (created_at);
CREATE INDEX operations_client_code_key_idx ON operations (client_code_key text_pattern_ops);
CREATE INDEX operations_author_created_idx ON operations (author_id, created_at DESC);

CREATE TABLE opening_balances (
  currency text PRIMARY KEY CHECK (currency IN ('RUB', 'USD')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  set_at timestamptz NOT NULL DEFAULT now()
);
