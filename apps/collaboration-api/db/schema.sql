-- Current schema, applied once to a new database. No migration or compatibility paths.
CREATE TABLE studio_projects (
  id text PRIMARY KEY,
  gitlab_project_id bigint NOT NULL UNIQUE,
  data jsonb NOT NULL,
  CHECK (NOT data ? 'body')
);
CREATE TABLE studio_entities (
  project_id text NOT NULL REFERENCES studio_projects(id),
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (project_id, id),
  CHECK (NOT data ? 'body')
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
