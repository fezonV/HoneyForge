ALTER TABLE commands ADD COLUMN delivered_at timestamptz;
ALTER TABLE commands ADD COLUMN result_error text NOT NULL DEFAULT '';
