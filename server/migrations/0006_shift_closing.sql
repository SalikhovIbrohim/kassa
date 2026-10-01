-- Closing a shift with a count of the cash. The columns that hold the count (calculated, actual, difference
-- per currency) came with 0005; this adds who closed the shift.

ALTER TABLE shifts ADD COLUMN closed_by uuid REFERENCES users (id);

-- A shift is closed by someone, at some time, and a shift that is open has neither.
ALTER TABLE shifts ADD CONSTRAINT shifts_closed_by_check CHECK ((closed_at IS NULL) = (closed_by IS NULL));
