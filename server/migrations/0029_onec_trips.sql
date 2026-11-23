-- A trip that has arrived goes to 1C too, as the services rendered to its clients («Оказание услуг»): one document to
-- a trip. It waits in the same queue as the entries of the cash desk; a row is of an entry or of a trip, never both.
ALTER TABLE onec_outbox ALTER COLUMN operation_id DROP NOT NULL;
ALTER TABLE onec_outbox ADD COLUMN trip_id bigint UNIQUE REFERENCES trips (id);
ALTER TABLE onec_outbox ADD CONSTRAINT onec_outbox_of_one_thing CHECK ((operation_id IS NULL) <> (trip_id IS NULL));
