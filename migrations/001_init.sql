CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('operator','viewer')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operator_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), token_hash bytea NOT NULL UNIQUE,
 csrf_hash bytea NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_sessions_user_idx ON operator_sessions(user_id, expires_at);
CREATE TABLE profiles (
 id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', current_revision integer NOT NULL CHECK(current_revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX profiles_active_name_idx ON profiles(lower(name),id) WHERE deleted_at IS NULL;
CREATE TABLE profile_revisions (
 profile_id uuid NOT NULL REFERENCES profiles(id), revision integer NOT NULL CHECK(revision>0), config jsonb NOT NULL,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,revision)
);
ALTER TABLE profiles ADD CONSTRAINT profiles_current_revision_fk FOREIGN KEY(id,current_revision) REFERENCES profile_revisions(profile_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE traps (
 id uuid PRIMARY KEY, name text NOT NULL, desired_profile_id uuid, desired_revision integer,
 applied_profile_id uuid, applied_revision integer, agent_status text NOT NULL DEFAULT 'offline' CHECK(agent_status IN ('online','offline')),
 service_status text NOT NULL DEFAULT 'unknown' CHECK(service_status IN ('unknown','running','stopped','degraded','error')),
 last_seen timestamptz, deployment_bindings jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CHECK((desired_profile_id IS NULL)=(desired_revision IS NULL)), CHECK((applied_profile_id IS NULL)=(applied_revision IS NULL)),
 FOREIGN KEY(desired_profile_id,desired_revision) REFERENCES profile_revisions(profile_id,revision),
 FOREIGN KEY(applied_profile_id,applied_revision) REFERENCES profile_revisions(profile_id,revision)
);
CREATE INDEX traps_active_name_idx ON traps(lower(name),id) WHERE deleted_at IS NULL;
CREATE INDEX traps_desired_idx ON traps(desired_profile_id,desired_revision);
CREATE TABLE agents (
 id uuid PRIMARY KEY, trap_id uuid NOT NULL UNIQUE REFERENCES traps(id), token_hash bytea NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz, revoked_at timestamptz
);
CREATE TABLE enrollment_tokens (
 id uuid PRIMARY KEY, trap_id uuid NOT NULL REFERENCES traps(id), token_hash bytea NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enrollment_active_idx ON enrollment_tokens(trap_id,expires_at) WHERE consumed_at IS NULL;
CREATE TABLE commands (
 id uuid PRIMARY KEY, trap_id uuid NOT NULL REFERENCES traps(id), command_type text NOT NULL CHECK(command_type IN ('start','stop','apply_profile')),
 expected_profile_id uuid, expected_revision integer, target_profile_id uuid, target_revision integer, status text NOT NULL CHECK(status IN ('queued','delivered','applied','failed','expired')),
 expires_at timestamptz NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((target_profile_id IS NULL)=(target_revision IS NULL)),
 FOREIGN KEY(expected_profile_id,expected_revision) REFERENCES profile_revisions(profile_id,revision),
 FOREIGN KEY(target_profile_id,target_revision) REFERENCES profile_revisions(profile_id,revision)
);
CREATE INDEX commands_trap_idx ON commands(trap_id,created_at DESC,id);
CREATE TABLE visitor_sessions (
 id uuid PRIMARY KEY, trap_id uuid NOT NULL REFERENCES traps(id), started_at timestamptz NOT NULL, ended_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX visitor_sessions_trap_idx ON visitor_sessions(trap_id,started_at DESC);
CREATE TABLE events (
 id uuid NOT NULL, schema_version text NOT NULL DEFAULT '1.0', trap_id uuid NOT NULL REFERENCES traps(id), agent_id uuid NOT NULL REFERENCES agents(id), service_id text NOT NULL,
 session_id uuid REFERENCES visitor_sessions(id), profile_id uuid, applied_revision integer, event_type text NOT NULL,
 occurred_at timestamptz NOT NULL, source_ip inet, source_port integer, destination_port integer, protocol text NOT NULL DEFAULT 'http',
 payload jsonb NOT NULL DEFAULT '{}'::jsonb, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(agent_id,id),
 FOREIGN KEY(profile_id,applied_revision) REFERENCES profile_revisions(profile_id,revision)
);
CREATE INDEX events_trap_time_idx ON events(trap_id,occurred_at DESC,id);
CREATE INDEX events_session_idx ON events(session_id,occurred_at,id) WHERE session_id IS NOT NULL;
CREATE TABLE audit_log (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, entity_type text NOT NULL,
 entity_id text NOT NULL DEFAULT '', details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time_idx ON audit_log(created_at DESC,id);
