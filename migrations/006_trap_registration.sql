ALTER TABLE traps ADD COLUMN deployment_node text NOT NULL DEFAULT '' CHECK(octet_length(deployment_node)<=253);
CREATE TABLE registration_attempts (
 id uuid PRIMARY KEY,
 trap_id uuid NOT NULL REFERENCES traps(id),
 outcome text NOT NULL CHECK(outcome IN ('registered','rejected')),
 reason text NOT NULL CHECK(reason IN ('registered','invalid_token','expired_token','inactive_token','already_enrolled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_attempts_trap_time_idx ON registration_attempts(trap_id,created_at DESC,id DESC);
