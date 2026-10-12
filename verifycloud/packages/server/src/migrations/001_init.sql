-- VerifyCloud schema, migration 001.
-- Conventions: every tenant-owned row carries org_id (enforced in queries and
-- by foreign keys); ON DELETE behavior is explicit on every foreign key;
-- large data lives in object storage, rows hold references (artifacts).

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- plans
CREATE TABLE plans (
  name                    text PRIMARY KEY,
  max_concurrent_jobs     int    NOT NULL,
  max_concurrent_tasks    int    NOT NULL,   -- running build+test tasks per organization
  max_job_seconds         int    NOT NULL,
  artifact_quota_bytes    bigint NOT NULL,
  max_test_runs_per_job   int    NOT NULL,
  ai_tokens_per_month     bigint NOT NULL,
  max_retention_days      jsonb  NOT NULL     -- upper bounds for project retention settings
);
INSERT INTO plans VALUES
  ('free', 2, 4, 1800, 10737418240, 200, 200000, '{"logs":30,"waveforms":14,"coverage":90,"models":7,"sources":30}'),
  ('pro', 10, 32, 7200, 107374182400, 5000, 5000000, '{"logs":365,"waveforms":90,"coverage":730,"models":30,"sources":365}'),
  ('demo', 1, 2, 600, 1073741824, 20, 0, '{"logs":1,"waveforms":1,"coverage":1,"models":1,"sources":1}');

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id                uuid PRIMARY KEY,
  email             citext UNIQUE NOT NULL,
  name              text NOT NULL,
  password_hash     text,                      -- null for GitHub-only accounts
  email_verified_at timestamptz,
  github_user_id    bigint UNIQUE,
  github_login      text,
  platform_admin    boolean NOT NULL DEFAULT false,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea UNIQUE NOT NULL,          -- SHA-256 of the cookie value
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE email_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE oauth_states (
  state_hash bytea PRIMARY KEY,
  purpose    text NOT NULL,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,   -- set when linking an existing account
  expires_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------- tenancy
CREATE TABLE organizations (
  id         uuid PRIMARY KEY,
  slug       citext UNIQUE NOT NULL,
  name       text NOT NULL,
  plan       text NOT NULL REFERENCES plans(name) ON DELETE RESTRICT,
  is_demo    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'engineer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

-- Personal access tokens (act as the user, limited by scopes) and
-- organization API keys (act within one organization with a fixed role).
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('pat', 'org_key')),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,          -- pat owner / key creator
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- org_key only
  role         text CHECK (role IN ('admin', 'engineer', 'viewer')),  -- org_key only
  name         text NOT NULL,
  prefix       text NOT NULL,                                        -- shown to users to identify the token
  token_hash   bytea UNIQUE NOT NULL,
  scopes       text[] NOT NULL,
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'pat' AND user_id IS NOT NULL AND org_id IS NULL) OR (kind = 'org_key' AND org_id IS NOT NULL AND role IS NOT NULL))
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);
CREATE INDEX api_tokens_org_idx ON api_tokens(org_id);

-- ---------------------------------------------------------------- repositories
CREATE TABLE github_installations (
  installation_id bigint PRIMARY KEY,
  org_id          uuid REFERENCES organizations(id) ON DELETE SET NULL,
  account_login   text NOT NULL,
  sender_login    text,               -- GitHub user who installed the app (claim check)
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);

CREATE TABLE repositories (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('github')),
  full_name       text NOT NULL,                     -- owner/name
  installation_id bigint REFERENCES github_installations(installation_id) ON DELETE SET NULL,
  default_branch  text NOT NULL DEFAULT 'main',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, full_name)
);
CREATE INDEX repositories_name_idx ON repositories(provider, full_name);

CREATE TABLE branches (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name          text NOT NULL,
  head_sha      text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, name)
);

CREATE TABLE commits (
  id            uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha           text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  message       text,
  author        text,
  committed_at  timestamptz,
  UNIQUE (repository_id, sha)
);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug            citext NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  state           text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'archived')),
  repository_id   uuid REFERENCES repositories(id) ON DELETE SET NULL,
  branch          text,                                    -- branch verified on push (null = default branch)
  config_path     text NOT NULL DEFAULT 'verifycloud.yaml',
  max_concurrency int NOT NULL DEFAULT 4 CHECK (max_concurrency BETWEEN 1 AND 256),
  retention       jsonb NOT NULL DEFAULT '{"logs":30,"waveforms":14,"coverage":90,"models":7,"sources":30}',
  ai_settings     jsonb NOT NULL DEFAULT '{"provider":"heuristic","allowExternal":false}',
  pr_checks       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX projects_repo_idx ON projects(repository_id);

-- Secrets: values encrypted with AES-256-GCM (SECRET_ENCRYPTION_KEY); only
-- metadata is ever returned by the API.
CREATE TABLE project_secrets (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,63}$'),
  ciphertext bytea NOT NULL,
  nonce      bytea NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE regressions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  tests      text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

CREATE TABLE test_cases (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

-- ---------------------------------------------------------------- artifacts
CREATE TABLE artifacts (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,
  job_id       uuid,          -- FK added below (jobs defined later)
  task_id      uuid,
  kind         text NOT NULL CHECK (kind IN ('log', 'waveform', 'waveform_index', 'coverage', 'model', 'source', 'report', 'patch')),
  name         text NOT NULL,
  content_type text NOT NULL,
  encoding     text CHECK (encoding IN ('gzip')),
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  storage_key  text UNIQUE NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}',
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_org_idx ON artifacts(org_id, created_at DESC);
CREATE INDEX artifacts_project_idx ON artifacts(project_id, created_at DESC);
CREATE INDEX artifacts_task_idx ON artifacts(task_id);
CREATE INDEX artifacts_job_idx ON artifacts(job_id);
CREATE INDEX artifacts_expiry_idx ON artifacts(expires_at) WHERE expires_at IS NOT NULL;

-- Every deleted artifact row leaves its object key here; the retention
-- worker deletes the object and then the row. Cascading deletes therefore
-- never orphan stored objects.
CREATE TABLE storage_gc (
  storage_key text PRIMARY KEY,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text
);
CREATE FUNCTION artifacts_to_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO storage_gc(storage_key) VALUES (OLD.storage_key) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER artifacts_gc AFTER DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION artifacts_to_gc();

CREATE TABLE source_snapshots (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  sha256      text NOT NULL,
  file_count  int NOT NULL,
  config_text text,                       -- verifycloud.yaml found in the snapshot
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_snapshots_project_idx ON source_snapshots(project_id, created_at DESC);

-- Content-addressed build cache, scoped to one organization (never shared
-- across tenants: no cross-tenant cache poisoning or leaks).
CREATE TABLE build_cache (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cache_key    text NOT NULL CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  artifact_id  uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  toolchain    jsonb NOT NULL,
  hits         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, cache_key)
);

-- ---------------------------------------------------------------- workers
CREATE TABLE workers (
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  token_hash        bytea UNIQUE NOT NULL,
  version           text NOT NULL,
  sandbox           text NOT NULL,
  cpus              int NOT NULL,
  memory_mb         int NOT NULL,
  toolchain         jsonb NOT NULL DEFAULT '{}',
  state             text NOT NULL DEFAULT 'online' CHECK (state IN ('online', 'draining', 'offline')),
  registered_at     timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- jobs
CREATE TABLE jobs (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number           int NOT NULL,
  regression       text NOT NULL,
  state            text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'RESOURCE_EXCEEDED')),
  trigger          text NOT NULL CHECK (trigger IN ('manual', 'api', 'cli', 'push', 'pull_request', 'rerun', 'patch', 'demo')),
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_token  uuid REFERENCES api_tokens(id) ON DELETE SET NULL,
  idempotency_key  text,
  source           jsonb NOT NULL,     -- {type:'snapshot',snapshotId} | {type:'github',repository,sha}
  commit_sha       text,
  branch           text,
  pr_number        int,
  config           jsonb NOT NULL,     -- resolved configuration (immutable record)
  config_sha256    text NOT NULL,
  only_tests       text[],
  parent_job_id    uuid REFERENCES jobs(id) ON DELETE SET NULL,   -- re-run / patch verification of
  patch_id         uuid,
  toolchain        jsonb,              -- image digest, simulator version, harness hash (set by the build)
  cancel_requested boolean NOT NULL DEFAULT false,
  deadline_at      timestamptz NOT NULL,
  summary          jsonb NOT NULL DEFAULT '{}',
  coverage         jsonb,
  error            text,
  github_check     jsonb,              -- id/url of the GitHub status/check created for this job
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (project_id, number),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX jobs_project_idx ON jobs(project_id, created_at DESC);
CREATE INDEX jobs_org_state_idx ON jobs(org_id, state);
CREATE INDEX jobs_active_idx ON jobs(state, deadline_at) WHERE state IN ('QUEUED', 'RUNNING');
CREATE INDEX jobs_branch_idx ON jobs(project_id, branch, created_at DESC);
CREATE INDEX jobs_commit_idx ON jobs(project_id, commit_sha);

-- A task is one unit of execution: the build of a job, or one test run
-- (test x seed). Test runs are the "test_runs" of the domain model.
CREATE TABLE tasks (
  id               uuid PRIMARY KEY,
  job_id           uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('build', 'test')),
  ordinal          int NOT NULL,
  test_name        text,
  seed             bigint,
  plusargs         jsonb NOT NULL DEFAULT '{}',
  state            text NOT NULL CHECK (state IN ('BLOCKED', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'RESOURCE_EXCEEDED', 'SKIPPED')),
  depends_on       uuid REFERENCES tasks(id) ON DELETE CASCADE,
  cpu              int NOT NULL,
  memory_mb        int NOT NULL,
  timeout_seconds  int NOT NULL,
  attempt          int NOT NULL DEFAULT 0,       -- number of times claimed
  max_attempts     int NOT NULL DEFAULT 3,       -- infrastructure retries (lost worker, sandbox error)
  test_retries     int NOT NULL DEFAULT 0,       -- re-runs of a failing test (flakiness detection)
  test_attempts    jsonb NOT NULL DEFAULT '[]',  -- history of failed attempts before the final result
  lease_worker     uuid REFERENCES workers(id) ON DELETE SET NULL,
  lease_token      uuid,                         -- fencing token: changes on every claim
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  queued_at        timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  exit_code        int,
  duration_ms      int,
  result           jsonb,
  error            text,
  model_artifact_id uuid,                        -- build: compiled model; test: model used
  UNIQUE (job_id, ordinal)
);
CREATE INDEX tasks_queue_idx ON tasks(queued_at) WHERE state = 'QUEUED';
CREATE INDEX tasks_lease_idx ON tasks(lease_expires_at) WHERE state = 'RUNNING';
CREATE INDEX tasks_job_idx ON tasks(job_id, ordinal);
CREATE INDEX tasks_running_org_idx ON tasks(org_id) WHERE state = 'RUNNING';
CREATE INDEX tasks_history_idx ON tasks(project_id, test_name, finished_at DESC) WHERE kind = 'test';
CREATE INDEX tasks_depends_idx ON tasks(depends_on);

ALTER TABLE artifacts ADD CONSTRAINT artifacts_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD CONSTRAINT tasks_model_fk FOREIGN KEY (model_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL;

CREATE TABLE assertion_failures (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name       text NOT NULL,
  scope      text NOT NULL,
  severity   text NOT NULL,
  message    text NOT NULL,
  file       text NOT NULL,
  line       int NOT NULL,
  sim_time   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assertion_failures_job_idx ON assertion_failures(job_id);
CREATE INDEX assertion_failures_task_idx ON assertion_failures(task_id);

CREATE TABLE coverage_runs (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id           uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id          uuid REFERENCES tasks(id) ON DELETE CASCADE,  -- null = merged over the job
  branch           text,
  commit_sha       text,
  regression       text NOT NULL,
  test_name        text,
  line_covered     int, line_total     int,
  branch_covered   int, branch_total   int,
  toggle_covered   int, toggle_total   int,
  functional_covered int, functional_total int,
  detail_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coverage_runs_history_idx ON coverage_runs(project_id, branch, created_at DESC) WHERE task_id IS NULL;
CREATE INDEX coverage_runs_job_idx ON coverage_runs(job_id);

-- ---------------------------------------------------------------- events, audit, usage
CREATE TABLE job_events (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_org_idx ON job_events(org_id, id);
CREATE INDEX job_events_job_idx ON job_events(job_id, id);

CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_token_id uuid REFERENCES api_tokens(id) ON DELETE SET NULL,
  actor_label    text NOT NULL,             -- kept even if the actor is deleted
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  ip             text,
  request_id     text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_idx ON audit_events(org_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at DESC);

-- Usage ledger (billing-ready): append-only, one row per measured quantity.
-- The unique source key makes recording idempotent (a retried report does
-- not double-count).
CREATE TABLE usage_records (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  job_id     uuid REFERENCES jobs(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('cpu_seconds', 'simulation_seconds', 'worker_seconds', 'artifact_byte_days', 'artifact_bytes', 'ai_tokens_in', 'ai_tokens_out')),
  quantity   numeric NOT NULL,
  source_key text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_org_idx ON usage_records(org_id, created_at);

-- ---------------------------------------------------------------- AI
CREATE TABLE ai_analyses (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  model        text,
  external     boolean NOT NULL,           -- did data leave the VerifyCloud environment?
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  context_manifest jsonb NOT NULL DEFAULT '{}',  -- exactly what was sent (files, sizes, redactions)
  result       jsonb,
  tokens_in    int,
  tokens_out   int,
  latency_ms   int,
  error        text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_analyses_task_idx ON ai_analyses(task_id, created_at DESC);

CREATE TABLE patches (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id              uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,   -- the failing job the patch applies to
  analysis_id         uuid REFERENCES ai_analyses(id) ON DELETE SET NULL,
  origin              text NOT NULL CHECK (origin IN ('ai', 'user')),
  diff                text NOT NULL,
  files               text[] NOT NULL,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE jobs ADD CONSTRAINT jobs_patch_fk FOREIGN KEY (patch_id) REFERENCES patches(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- integrations
CREATE TABLE webhook_deliveries (
  provider     text NOT NULL,
  delivery_id  text NOT NULL,
  event        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (provider, delivery_id)
);

CREATE TABLE notification_channels (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('email', 'webhook')),
  target     text NOT NULL,
  events     text[] NOT NULL,
  secret_ciphertext bytea,
  secret_nonce      bytea,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox: notifications are written in the same transaction as the event
-- that causes them and delivered (with retries) by a background loop.
CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id  uuid REFERENCES notification_channels(id) ON DELETE CASCADE,
  kind        text NOT NULL,          -- email | webhook | github_status | github_comment
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX notifications_pending_idx ON notifications(next_attempt_at) WHERE status = 'pending';

CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL,
  PRIMARY KEY (key, window_start)
);
