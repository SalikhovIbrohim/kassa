-- Groupage («Сборные грузы»): a trip is one truck that goes from warehouse to warehouse, and at each of them the cargo
-- of many clients is put on it. Every line of cargo names the client that owes for it. When the truck has arrived, what
-- its lines come to is owed by those clients, from the day of the arrival; what a client paid is the entries of the
-- cash desk that name them. So the debt of a client is not stored anywhere: it is worked out from the trips and from
-- the cash book, which are in this one database.
--
-- Whether a business has this section at all is its settings' to say (WAREHOUSES); these tables are there either way.

-- The person who keeps a warehouse (завсклад): writes the cargo of their warehouse onto the trips. Nothing of the cash.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('cashier', 'head_cashier', 'admin', 'viewer', 'warehouse'));

-- What a client pays for a kilogram unless a line says otherwise: thousandths of a dollar (1,55 $ is 1550).
ALTER TABLE clients ADD COLUMN price_milli integer CHECK (price_milli BETWEEN 0 AND 1000000);
-- What a client owed on the day the business started to keep its trips here, in cents; less than nothing is money
-- paid ahead. Set once by the admin, like the opening balance of a cash desk.
ALTER TABLE clients ADD COLUMN opening_debt_minor bigint NOT NULL DEFAULT 0
  CHECK (opening_debt_minor BETWEEN -10000000000 AND 10000000000);

CREATE TABLE trips (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The number the business knows the trip by (190, 191, ...): an expense of the cash desk names its trip by it.
  number integer NOT NULL CHECK (number BETWEEN 1 AND 999999999),
  driver_name text CHECK (driver_name IS NULL OR length(driver_name) BETWEEN 1 AND 100),
  driver_phone text CHECK (driver_phone IS NULL OR length(driver_phone) BETWEEN 1 AND 100),
  truck_plates text CHECK (truck_plates IS NULL OR length(truck_plates) BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  departure_day date,
  -- The day the truck arrived: the day its cargo is owed from.
  arrival_day date,
  status text NOT NULL DEFAULT 'loading' CHECK (status IN ('loading', 'in_transit', 'arrived')),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  -- A trip made by mistake is taken away by the admin while it has no cargo; the row stays.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users (id),
  CONSTRAINT trips_arrived_has_a_day CHECK (status <> 'arrived' OR arrival_day IS NOT NULL),
  CONSTRAINT trips_deleted_by_somebody CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
-- One trip to a number, among those that are not taken away.
CREATE UNIQUE INDEX trips_number_key ON trips (number) WHERE deleted_at IS NULL;

-- A line of the waybill of a trip: one kind of goods of one client, put on the truck at one warehouse.
CREATE TABLE trip_cargo (
  -- Made by the screen, so that a line sent twice is stored once.
  id uuid PRIMARY KEY,
  -- The order the lines were written in, which is the order the waybill lists them in.
  position bigint GENERATED ALWAYS AS IDENTITY,
  trip_id bigint NOT NULL REFERENCES trips (id),
  -- The warehouse it was loaded at: an id of the settings (WAREHOUSES), like the cash desk of an entry.
  warehouse text NOT NULL CHECK (warehouse ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- The client who owes for it.
  client_code text NOT NULL REFERENCES clients (code),
  -- Who sent it («От кого») and the phone of who receives it: for the people, not for the money.
  sender text CHECK (sender IS NULL OR length(sender) BETWEEN 1 AND 100),
  receiver_phone text CHECK (receiver_phone IS NULL OR length(receiver_phone) BETWEEN 1 AND 100),
  item text CHECK (item IS NULL OR length(item) BETWEEN 1 AND 200),
  brand text CHECK (brand IS NULL OR length(brand) BETWEEN 1 AND 100),
  size text CHECK (size IS NULL OR length(size) BETWEEN 1 AND 50),
  bags integer CHECK (bags BETWEEN 0 AND 1000000),
  per_bag integer CHECK (per_bag BETWEEN 0 AND 1000000),
  pieces integer CHECK (pieces BETWEEN 0 AND 1000000000),
  -- The weight in grams and the price of a kilogram in thousandths of a dollar: whole numbers, and their product is
  -- what the line comes to in millionths of a dollar, exactly.
  weight_g bigint NOT NULL CHECK (weight_g BETWEEN 0 AND 1000000000),
  price_milli integer NOT NULL CHECK (price_milli BETWEEN 0 AND 1000000),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  -- A line taken off the waybill stays in the table, hidden.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users (id),
  CONSTRAINT trip_cargo_deleted_by_somebody CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX trip_cargo_trip_idx ON trip_cargo (trip_id) WHERE deleted_at IS NULL;
CREATE INDEX trip_cargo_client_idx ON trip_cargo (client_code) WHERE deleted_at IS NULL;

-- What was done to a trip and to its lines, by whom and when, with what it said before and after: written in the
-- same transaction as the change itself. Lines of this table are never changed or deleted.
CREATE TABLE trip_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id bigint NOT NULL REFERENCES trips (id),
  -- The line of cargo the change is about; none for a change of the trip itself.
  cargo_id uuid REFERENCES trip_cargo (id),
  action text NOT NULL CHECK (action IN ('create', 'edit', 'status', 'delete', 'add_cargo', 'edit_cargo', 'delete_cargo')),
  changed_at timestamptz NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id),
  state_before jsonb,
  state_after jsonb
);
CREATE INDEX trip_changes_trip_idx ON trip_changes (trip_id, id);

CREATE FUNCTION kassa_trip_changes_are_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The history of a trip is never changed or deleted' USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER trip_changes_are_final BEFORE UPDATE OR DELETE ON trip_changes
  FOR EACH ROW EXECUTE FUNCTION kassa_trip_changes_are_final();
CREATE TRIGGER trip_changes_no_truncate BEFORE TRUNCATE ON trip_changes
  FOR EACH STATEMENT EXECUTE FUNCTION kassa_trip_changes_are_final();
