-- Audit 2026-10-08.
-- M9: post-job processing (coverage merge, notifications, GitHub check) is
-- recorded, so work lost to a crash between job finalization and the
-- in-memory hook is picked up by a periodic sweep.
ALTER TABLE jobs ADD COLUMN post_processed_at timestamptz;
UPDATE jobs SET post_processed_at = coalesce(finished_at, now()) WHERE state NOT IN ('QUEUED', 'RUNNING');
CREATE INDEX jobs_post_pending_idx ON jobs(finished_at) WHERE post_processed_at IS NULL AND finished_at IS NOT NULL;

-- Security H4 / L9: GitHub identities are matched by immutable numeric id.
ALTER TABLE github_installations ADD COLUMN sender_id bigint;
