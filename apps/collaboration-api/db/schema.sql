-- Current schema, applied once to a new database. No migration or compatibility paths.
CREATE TABLE studio_users (
  id bigint PRIMARY KEY CHECK (id = 1),
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  admin boolean NOT NULL,
  password_salt text NOT NULL CHECK (password_salt ~ '^[a-f0-9]{32}$'),
  password_hash text NOT NULL CHECK (password_hash ~ '^[a-f0-9]{128}$'),
  gitlab_user_id bigint UNIQUE CHECK (gitlab_user_id > 0),
  gitlab_username text,
  gitlab_email text,
  CHECK ((gitlab_user_id IS NULL AND gitlab_username IS NULL) OR (gitlab_user_id IS NOT NULL AND gitlab_username IS NOT NULL))
);
CREATE TABLE studio_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id bigint NOT NULL REFERENCES studio_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX studio_sessions_expiry ON studio_sessions(expires_at);
CREATE TABLE studio_project_creations (
  actor_id bigint NOT NULL REFERENCES studio_users(id),
  key text NOT NULL,
  request_hash text NOT NULL,
  project_id text NOT NULL UNIQUE,
  namespace_id bigint NOT NULL,
  namespace_path text NOT NULL,
  path text NOT NULL,
  name text NOT NULL,
  marker text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('reserved','creating','created','assigned')),
  gitlab_project_id bigint UNIQUE,
  PRIMARY KEY(actor_id,key),
  UNIQUE(namespace_id,path)
);
CREATE TABLE studio_projects (
  id text PRIMARY KEY,
  gitlab_project_id bigint NOT NULL UNIQUE,
  data jsonb NOT NULL,
  CHECK (NOT (data ? 'body'))
);
CREATE TABLE studio_entities (
  project_id text NOT NULL REFERENCES studio_projects(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id, id),
  CHECK (NOT (data ? 'body'))
);
CREATE TABLE studio_occupations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  owner_id bigint NOT NULL,
  active boolean NOT NULL DEFAULT true,
  data jsonb NOT NULL,
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  UNIQUE(project_id, entity_id, generation)
);
CREATE UNIQUE INDEX studio_one_active_occupation ON studio_occupations(project_id, entity_id) WHERE active;
CREATE TABLE studio_confirmations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL,
  stage text NOT NULL CHECK(stage IN ('material','prototype')),
  data jsonb NOT NULL,
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  UNIQUE(project_id, entity_id, version, stage)
);
CREATE TABLE studio_eligibility (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL,
  enabled boolean NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY(project_id, entity_id, version),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id)
);
CREATE TABLE studio_integrations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  status text NOT NULL CHECK(status IN ('prepared', 'accepted', 'aborted')),
  data jsonb NOT NULL
);
CREATE UNIQUE INDEX studio_one_prepared_integration ON studio_integrations(project_id) WHERE status = 'prepared';
CREATE TABLE studio_baselines (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  data jsonb NOT NULL
);
CREATE TABLE studio_adoptions (
  id text PRIMARY KEY,
  source_project_id text NOT NULL REFERENCES studio_projects(id),
  target_project_id text NOT NULL REFERENCES studio_projects(id),
  data jsonb NOT NULL
);
CREATE TABLE studio_operations (
  project_id text NOT NULL REFERENCES studio_projects(id),
  key text NOT NULL,
  actor_id bigint NOT NULL,
  action text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(project_id, key)
);
CREATE TABLE studio_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  actor_id bigint NOT NULL,
  action text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE studio_handoff_receipts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  entity_id text NOT NULL,
  confirmation_id text NOT NULL REFERENCES studio_confirmations(id),
  actor_id bigint NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, entity_id, confirmation_id, actor_id)
);
