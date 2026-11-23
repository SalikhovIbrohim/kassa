-- The waybill of a trip, column for column as the business keeps it in its spreadsheets, and the history of before the
-- trips were kept here: what the clients owed, trip by trip, and what they paid, day by day.

-- The header of a trip: the day it was loaded (it leaves a day or two later), and where it goes.
ALTER TABLE trips ADD COLUMN loading_day date;
ALTER TABLE trips ADD COLUMN direction text CHECK (direction IS NULL OR length(direction) BETWEEN 1 AND 100);
-- A trip of the history: there is no waybill of it here, only what each client owed for it (see trip_sums).
ALTER TABLE trips ADD COLUMN from_card_file boolean NOT NULL DEFAULT false;

-- A line of the waybill. Where on the truck the cargo lies: the head (the front part) or the trailer (the back one);
-- its number there is its turn among the lines of that part, as the spreadsheet numbers them («ГОЛОВА 3»).
ALTER TABLE trip_cargo ADD COLUMN truck_part text CHECK (truck_part IN ('head', 'trailer'));
-- The day the warehouse took the cargo in.
ALTER TABLE trip_cargo ADD COLUMN accepted_day date;
-- Who receives it, by name: most often the client, sometimes somebody else under the client's code.
ALTER TABLE trip_cargo ADD COLUMN receiver text CHECK (receiver IS NULL OR length(receiver) BETWEEN 1 AND 100);
-- What it is packed in (a bag, a box, a roll).
ALTER TABLE trip_cargo ADD COLUMN packaging text CHECK (packaging IS NULL OR length(packaging) BETWEEN 1 AND 50);

-- What a client owed for a trip of the history, in millionths of a dollar (the card file keeps the product of a weight
-- and a price as it is, a third decimal and all): one sum to a client and a trip, where a trip kept here has lines.
CREATE TABLE trip_sums (
  trip_id bigint NOT NULL REFERENCES trips (id),
  client_code text NOT NULL REFERENCES clients (code),
  amount_micro bigint NOT NULL CHECK (amount_micro BETWEEN 1 AND 1000000000000000),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  PRIMARY KEY (trip_id, client_code)
);
CREATE INDEX trip_sums_client_idx ON trip_sums (client_code);

-- What the clients paid before the cash book was kept here, day by day, with the cash desk that took it where the card
-- file says. These are no entries of the cash book: they are in no balance of a cash desk and in no journal. They are
-- only counted in what a client has paid.
CREATE TABLE past_payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_code text NOT NULL REFERENCES clients (code),
  paid_day date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 10000000000),
  kassa text CHECK (kassa ~ '^[a-z][a-z0-9_]{0,31}$'),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500)
);
CREATE INDEX past_payments_client_idx ON past_payments (client_code, paid_day);
