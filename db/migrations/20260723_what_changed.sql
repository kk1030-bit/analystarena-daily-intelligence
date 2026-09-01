-- 7/23: immutable, evidence-backed What Changed comparisons.
--
-- Event-version changes and snapshot/rank changes deliberately live in
-- separate tables. A ranking refresh must never create or mutate an event
-- content version.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM event_versions AS current_version
    LEFT JOIN event_versions AS previous_version
      ON previous_version.event_id = current_version.event_id
     AND previous_version.id = current_version.previous_version_id
    WHERE (current_version.version_number = 1 AND current_version.previous_version_id IS NOT NULL)
       OR (current_version.version_number > 1 AND (
         current_version.previous_version_id IS NULL
         OR previous_version.id IS NULL
         OR previous_version.version_number <> current_version.version_number - 1
       ))
       OR (
         current_version.previous_version_id IS NOT NULL
         AND previous_version.id IS NOT NULL
         AND current_version.observed_at < previous_version.observed_at
       )
  ) THEN
    RAISE EXCEPTION 'event_versions contains a non-adjacent, incomplete, or time-reversing version chain'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM brief_snapshots AS current_snapshot
    LEFT JOIN brief_snapshots AS previous_snapshot
      ON previous_snapshot.id = current_snapshot.previous_snapshot_id
    WHERE (current_snapshot.sequence_number = 1 AND current_snapshot.previous_snapshot_id IS NOT NULL)
       OR (current_snapshot.sequence_number > 1 AND (
         current_snapshot.previous_snapshot_id IS NULL
         OR previous_snapshot.id IS NULL
         OR previous_snapshot.brief_date <> current_snapshot.brief_date
         OR previous_snapshot.sequence_number <> current_snapshot.sequence_number - 1
       ))
       OR (
         current_snapshot.previous_snapshot_id IS NOT NULL
         AND previous_snapshot.id IS NOT NULL
         AND current_snapshot.generated_at < previous_snapshot.generated_at
       )
  ) THEN
    RAISE EXCEPTION 'brief_snapshots contains a non-adjacent, cross-date, or time-reversing snapshot chain'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE event_versions
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS actor_id_hash TEXT,
  ADD COLUMN IF NOT EXISTS change_reason TEXT,
  ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE event_versions
  ALTER COLUMN actor_type SET DEFAULT 'system';

ALTER TABLE brief_snapshots
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS actor_id_hash TEXT,
  ADD COLUMN IF NOT EXISTS action_reason TEXT,
  ADD COLUMN IF NOT EXISTS action_request_id TEXT;
ALTER TABLE brief_snapshots
  ALTER COLUMN actor_type SET DEFAULT 'system';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_versions_chain_shape_ck'
      AND conrelid = 'event_versions'::regclass
  ) THEN
    ALTER TABLE event_versions
      ADD CONSTRAINT event_versions_chain_shape_ck CHECK (
        (version_number = 1 AND previous_version_id IS NULL)
        OR (version_number > 1 AND previous_version_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_versions_actor_type_ck'
      AND conrelid = 'event_versions'::regclass
  ) THEN
    ALTER TABLE event_versions
      ADD CONSTRAINT event_versions_actor_type_ck
      CHECK (actor_type IN ('system', 'admin', 'legacy'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_versions_actor_hash_ck'
      AND conrelid = 'event_versions'::regclass
  ) THEN
    ALTER TABLE event_versions
      ADD CONSTRAINT event_versions_actor_hash_ck CHECK (
        actor_id_hash IS NULL OR actor_id_hash ~ '^[0-9a-f]{64}$'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_versions_admin_actor_ck'
      AND conrelid = 'event_versions'::regclass
  ) THEN
    ALTER TABLE event_versions
      ADD CONSTRAINT event_versions_admin_actor_ck CHECK (
        actor_type <> 'admin'
        OR (
          actor_id_hash IS NOT NULL
          AND COALESCE(btrim(change_reason), '') <> ''
          AND COALESCE(btrim(request_id), '') <> ''
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_snapshots_actor_type_ck'
      AND conrelid = 'brief_snapshots'::regclass
  ) THEN
    ALTER TABLE brief_snapshots
      ADD CONSTRAINT brief_snapshots_actor_type_ck
      CHECK (actor_type IN ('system', 'admin', 'legacy'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_snapshots_actor_audit_ck'
      AND conrelid = 'brief_snapshots'::regclass
  ) THEN
    ALTER TABLE brief_snapshots
      ADD CONSTRAINT brief_snapshots_actor_audit_ck CHECK (
        actor_id_hash IS NULL OR actor_id_hash ~ '^[0-9a-f]{64}$'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_snapshots_admin_actor_ck'
      AND conrelid = 'brief_snapshots'::regclass
  ) THEN
    ALTER TABLE brief_snapshots
      ADD CONSTRAINT brief_snapshots_admin_actor_ck CHECK (
        actor_type <> 'admin'
        OR (
          actor_id_hash IS NOT NULL
          AND COALESCE(btrim(action_reason), '') <> ''
          AND COALESCE(btrim(action_request_id), '') <> ''
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION analystarena_validate_event_version_chain()
RETURNS TRIGGER AS $$
DECLARE
  predecessor_number INTEGER;
  predecessor_observed_at TIMESTAMPTZ;
BEGIN
  IF NEW.version_number = 1 THEN
    IF NEW.previous_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'event version 1 cannot have a predecessor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT version_number, observed_at
    INTO predecessor_number, predecessor_observed_at
  FROM event_versions
  WHERE event_id = NEW.event_id AND id = NEW.previous_version_id;

  IF predecessor_number IS NULL
     OR predecessor_number <> NEW.version_number - 1
     OR NEW.observed_at < predecessor_observed_at THEN
    RAISE EXCEPTION 'event version % must point to adjacent version % for event %',
      NEW.version_number, NEW.version_number - 1, NEW.event_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_versions_validate_chain ON event_versions;
CREATE TRIGGER event_versions_validate_chain
  BEFORE INSERT ON event_versions
  FOR EACH ROW EXECUTE FUNCTION analystarena_validate_event_version_chain();

CREATE OR REPLACE FUNCTION analystarena_validate_snapshot_chain()
RETURNS TRIGGER AS $$
DECLARE
  predecessor_date DATE;
  predecessor_sequence INTEGER;
  predecessor_generated_at TIMESTAMPTZ;
BEGIN
  IF NEW.sequence_number = 1 THEN
    IF NEW.previous_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION 'snapshot sequence 1 cannot have a predecessor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT brief_date, sequence_number, generated_at
    INTO predecessor_date, predecessor_sequence, predecessor_generated_at
  FROM brief_snapshots
  WHERE id = NEW.previous_snapshot_id;

  IF predecessor_date IS NULL
     OR predecessor_date <> NEW.brief_date
     OR predecessor_sequence <> NEW.sequence_number - 1
     OR NEW.generated_at < predecessor_generated_at THEN
    RAISE EXCEPTION 'snapshot sequence % must point to the adjacent snapshot for %',
      NEW.sequence_number, NEW.brief_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brief_snapshots_validate_chain ON brief_snapshots;
CREATE TRIGGER brief_snapshots_validate_chain
  BEFORE INSERT ON brief_snapshots
  FOR EACH ROW EXECUTE FUNCTION analystarena_validate_snapshot_chain();

CREATE OR REPLACE FUNCTION analystarena_stamp_snapshot_created_at()
RETURNS TRIGGER AS $$
DECLARE
  latest_snapshot_timestamp TIMESTAMPTZ;
BEGIN
  -- Snapshot visibility must be linear with publication. Holding this lock
  -- until COMMIT prevents an uncommitted older snapshot from appearing only
  -- after a report has frozen its historical comparison boundary.
  PERFORM pg_advisory_xact_lock(
    hashtext('analystarena_snapshot_visibility')
  );
  SELECT MAX(snapshot.created_at)
    INTO latest_snapshot_timestamp
  FROM brief_snapshots AS snapshot;
  NEW.created_at := GREATEST(
    clock_timestamp(),
    COALESCE(
      latest_snapshot_timestamp + INTERVAL '1 microsecond',
      '-infinity'::timestamptz
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brief_snapshots_stamp_created_at ON brief_snapshots;
CREATE TRIGGER brief_snapshots_stamp_created_at
  BEFORE INSERT ON brief_snapshots
  FOR EACH ROW EXECUTE FUNCTION analystarena_stamp_snapshot_created_at();

ALTER TABLE brief_snapshots
  DROP CONSTRAINT IF EXISTS brief_snapshots_previous_snapshot_id_fkey;
ALTER TABLE brief_snapshots
  DROP CONSTRAINT IF EXISTS brief_snapshots_previous_snapshot_fk;
ALTER TABLE brief_snapshots
  ADD CONSTRAINT brief_snapshots_previous_snapshot_fk
  FOREIGN KEY (previous_snapshot_id) REFERENCES brief_snapshots(id) ON DELETE RESTRICT;
ALTER TABLE brief_snapshots
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS brief_snapshots_created_at_idx
  ON brief_snapshots (created_at DESC);

-- A convergent rerun may need to repair a stale legacy pointer before the
-- publication triggers are recreated below. Drop only these two guards inside
-- the migration transaction so no deferred trigger events can block later DDL.
DROP TRIGGER IF EXISTS daily_briefs_require_publication_audit
  ON daily_briefs;
DROP TRIGGER IF EXISTS daily_briefs_preserve_publication_authority
  ON daily_briefs;

ALTER TABLE daily_briefs
  ADD COLUMN IF NOT EXISTS current_snapshot_id UUID;

UPDATE daily_briefs AS brief
SET current_snapshot_id = snapshot.id
FROM brief_snapshots AS snapshot
WHERE brief.payload->'snapshot'->>'id' = snapshot.id::text
  AND brief.current_snapshot_id IS DISTINCT FROM snapshot.id;

UPDATE daily_briefs AS brief
SET current_snapshot_id = snapshot.id
FROM brief_snapshots AS snapshot
WHERE brief.current_snapshot_id IS NULL
  AND snapshot.id = brief.id
  AND snapshot.stream = 'legacy'
  AND snapshot.batch_key = 'daily-brief:' || brief.id::text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM daily_briefs WHERE current_snapshot_id IS NULL
  ) THEN
    RAISE EXCEPTION 'daily_briefs contains a row without an immutable current snapshot'
      USING ERRCODE = '23514';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'daily_briefs_current_snapshot_fk'
      AND conrelid = 'daily_briefs'::regclass
  ) THEN
    ALTER TABLE daily_briefs
      ADD CONSTRAINT daily_briefs_current_snapshot_fk
      FOREIGN KEY (current_snapshot_id) REFERENCES brief_snapshots(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS daily_briefs_published_snapshot_idx
  ON daily_briefs (brief_date DESC, current_snapshot_id)
  WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS daily_briefs_current_snapshot_authority_uq
  ON daily_briefs (id, current_snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS brief_snapshots_payload_authority_uq
  ON brief_snapshots (id, payload_hash);

CREATE TABLE IF NOT EXISTS brief_publication_audits (
  brief_id UUID PRIMARY KEY,
  snapshot_id UUID NOT NULL UNIQUE,
  snapshot_payload_hash TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id_hash TEXT,
  action_reason TEXT,
  request_id TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brief_publication_audits_brief_fk
    FOREIGN KEY (brief_id) REFERENCES daily_briefs(id) ON DELETE RESTRICT,
  CONSTRAINT brief_publication_audits_snapshot_fk
    FOREIGN KEY (snapshot_id) REFERENCES brief_snapshots(id) ON DELETE RESTRICT,
  CONSTRAINT brief_publication_audits_current_snapshot_fk
    FOREIGN KEY (brief_id, snapshot_id)
    REFERENCES daily_briefs (id, current_snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT brief_publication_audits_snapshot_payload_fk
    FOREIGN KEY (snapshot_id, snapshot_payload_hash)
    REFERENCES brief_snapshots (id, payload_hash) ON DELETE RESTRICT,
  CONSTRAINT brief_publication_audits_snapshot_hash_ck
    CHECK (snapshot_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT brief_publication_audits_pdf_hash_ck
    CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT brief_publication_audits_actor_type_ck
    CHECK (actor_type IN ('system', 'admin')),
  CONSTRAINT brief_publication_audits_actor_hash_ck
    CHECK (actor_id_hash IS NULL OR actor_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT brief_publication_audits_admin_actor_ck CHECK (
    actor_type <> 'admin'
    OR (
      actor_id_hash IS NOT NULL
      AND COALESCE(btrim(action_reason), '') <> ''
      AND COALESCE(btrim(request_id), '') <> ''
    )
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS brief_publication_audits_published_at_uq
  ON brief_publication_audits (published_at);

-- CREATE TABLE IF NOT EXISTS does not retrofit constraints after an interrupted
-- or earlier draft migration. Add every publication-audit rule by stable name
-- so reruns converge on the same authority model.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_brief_fk'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_brief_fk
      FOREIGN KEY (brief_id) REFERENCES daily_briefs(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_snapshot_fk'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_snapshot_fk
      FOREIGN KEY (snapshot_id) REFERENCES brief_snapshots(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_current_snapshot_fk'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_current_snapshot_fk
      FOREIGN KEY (brief_id, snapshot_id)
      REFERENCES daily_briefs (id, current_snapshot_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_snapshot_payload_fk'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_snapshot_payload_fk
      FOREIGN KEY (snapshot_id, snapshot_payload_hash)
      REFERENCES brief_snapshots (id, payload_hash) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_snapshot_hash_ck'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_snapshot_hash_ck
      CHECK (snapshot_payload_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_pdf_hash_ck'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_pdf_hash_ck
      CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_actor_type_ck'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_actor_type_ck
      CHECK (actor_type IN ('system', 'admin'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_actor_hash_ck'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_actor_hash_ck
      CHECK (actor_id_hash IS NULL OR actor_id_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_publication_audits_admin_actor_ck'
      AND conrelid = 'brief_publication_audits'::regclass
  ) THEN
    ALTER TABLE brief_publication_audits
      ADD CONSTRAINT brief_publication_audits_admin_actor_ck CHECK (
        actor_type <> 'admin'
        OR (
          actor_id_hash IS NOT NULL
          AND COALESCE(btrim(action_reason), '') <> ''
          AND COALESCE(btrim(request_id), '') <> ''
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION analystarena_validate_publication_audit()
RETURNS TRIGGER AS $$
DECLARE
  authority_status TEXT;
  authority_snapshot_id UUID;
  authority_snapshot_payload_hash TEXT;
  authority_snapshot_payload JSONB;
  authority_brief_payload JSONB;
  authority_brief_date DATE;
  authority_snapshot_date DATE;
  authority_pdf_sha256 TEXT;
  authority_published_at TIMESTAMPTZ;
  latest_publication_timestamp TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('analystarena_snapshot_visibility')
  );
  PERFORM pg_advisory_xact_lock(
    hashtext('analystarena_brief_publication')
  );

  SELECT MAX(authority.published_at)
    INTO latest_publication_timestamp
  FROM (
    SELECT audit.published_at
    FROM brief_publication_audits AS audit
    UNION ALL
    SELECT brief.published_at
    FROM daily_briefs AS brief
    WHERE brief.status = 'published'
      AND brief.id <> NEW.brief_id
      AND brief.published_at IS NOT NULL
  ) AS authority;

  IF latest_publication_timestamp IS NOT NULL
     AND NEW.published_at <= latest_publication_timestamp THEN
    RAISE EXCEPTION 'publication timestamp % must be strictly later than existing authority %',
      NEW.published_at, latest_publication_timestamp
      USING ERRCODE = '23514';
  END IF;

  SELECT
    brief.status,
    brief.current_snapshot_id,
    snapshot.payload_hash,
    snapshot.payload,
    brief.payload,
    brief.brief_date,
    snapshot.brief_date,
    encode(sha256(brief.pdf_data), 'hex'),
    brief.published_at
    INTO
      authority_status,
      authority_snapshot_id,
      authority_snapshot_payload_hash,
      authority_snapshot_payload,
      authority_brief_payload,
      authority_brief_date,
      authority_snapshot_date,
      authority_pdf_sha256,
      authority_published_at
  FROM daily_briefs AS brief
  LEFT JOIN brief_snapshots AS snapshot
    ON snapshot.id = brief.current_snapshot_id
  WHERE brief.id = NEW.brief_id;

  IF authority_status IS DISTINCT FROM 'published'
     OR authority_snapshot_id IS DISTINCT FROM NEW.snapshot_id
     OR authority_snapshot_payload_hash IS DISTINCT FROM NEW.snapshot_payload_hash
     OR (
       authority_brief_payload
         - 'id' - 'status' - 'publishedAt' - 'storageMode'
     ) IS DISTINCT FROM (
       authority_snapshot_payload
         - 'id' - 'status' - 'publishedAt' - 'storageMode'
     )
     OR authority_snapshot_date IS DISTINCT FROM authority_brief_date
     OR authority_pdf_sha256 IS DISTINCT FROM NEW.pdf_sha256
     OR authority_published_at IS DISTINCT FROM NEW.published_at THEN
    RAISE EXCEPTION 'publication audit must match the exact published brief snapshot, payload, PDF, and time'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION analystarena_serialize_daily_brief_publication()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('analystarena_snapshot_visibility')
  );
  PERFORM pg_advisory_xact_lock(
    hashtext('analystarena_brief_publication')
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS daily_briefs_serialize_publication_update
  ON daily_briefs;
CREATE TRIGGER daily_briefs_serialize_publication_update
  BEFORE UPDATE OF status ON daily_briefs
  FOR EACH STATEMENT
  EXECUTE FUNCTION analystarena_serialize_daily_brief_publication();

-- A trigger only validates new audit rows. Refuse to install the authority
-- function over an earlier partial migration whose immutable audit already
-- disagrees with the published brief, snapshot payload, or stored PDF bytes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM brief_publication_audits AS audit
    LEFT JOIN daily_briefs AS brief
      ON brief.id = audit.brief_id
    LEFT JOIN brief_snapshots AS snapshot
      ON snapshot.id = brief.current_snapshot_id
    WHERE brief.id IS NULL
       OR brief.status NOT IN ('published', 'superseded')
       OR brief.current_snapshot_id IS DISTINCT FROM audit.snapshot_id
       OR snapshot.payload_hash IS DISTINCT FROM audit.snapshot_payload_hash
       OR (
         brief.payload - 'id' - 'status' - 'publishedAt' - 'storageMode'
       ) IS DISTINCT FROM (
         snapshot.payload - 'id' - 'status' - 'publishedAt' - 'storageMode'
       )
       OR snapshot.brief_date IS DISTINCT FROM brief.brief_date
       OR encode(sha256(brief.pdf_data), 'hex') IS DISTINCT FROM audit.pdf_sha256
       OR brief.published_at IS DISTINCT FROM audit.published_at
  ) THEN
    RAISE EXCEPTION 'brief_publication_audits contains a row that disagrees with published authority'
      USING ERRCODE = '23514';
  END IF;
END $$;

DROP TRIGGER IF EXISTS brief_publication_audits_validate
  ON brief_publication_audits;
CREATE TRIGGER brief_publication_audits_validate
  BEFORE INSERT ON brief_publication_audits
  FOR EACH ROW EXECUTE FUNCTION analystarena_validate_publication_audit();

CREATE OR REPLACE FUNCTION analystarena_require_publication_audit()
RETURNS TRIGGER AS $$
DECLARE
  authority_snapshot_payload_hash TEXT;
  authority_snapshot_date DATE;
  authority_snapshot_payload JSONB;
  authority_pdf_sha256 TEXT;
BEGIN
  IF NEW.status <> 'published'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'published') THEN
    RETURN NULL;
  END IF;

  SELECT
    snapshot.payload_hash,
    snapshot.brief_date,
    snapshot.payload,
    encode(sha256(NEW.pdf_data), 'hex')
    INTO
      authority_snapshot_payload_hash,
      authority_snapshot_date,
      authority_snapshot_payload,
      authority_pdf_sha256
  FROM brief_snapshots AS snapshot
  WHERE snapshot.id = NEW.current_snapshot_id;

  IF authority_snapshot_date IS DISTINCT FROM NEW.brief_date
     OR (
       NEW.payload - 'id' - 'status' - 'publishedAt' - 'storageMode'
     ) IS DISTINCT FROM (
       authority_snapshot_payload
         - 'id' - 'status' - 'publishedAt' - 'storageMode'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM brief_publication_audits AS audit
       WHERE audit.brief_id = NEW.id
         AND audit.snapshot_id = NEW.current_snapshot_id
         AND audit.snapshot_payload_hash = authority_snapshot_payload_hash
         AND audit.pdf_sha256 = authority_pdf_sha256
         AND audit.published_at = NEW.published_at
     ) THEN
    RAISE EXCEPTION 'draft-to-published transition requires one exact publication audit in the same transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS daily_briefs_require_publication_audit
  ON daily_briefs;
CREATE CONSTRAINT TRIGGER daily_briefs_require_publication_audit
  AFTER INSERT OR UPDATE ON daily_briefs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION analystarena_require_publication_audit();

CREATE OR REPLACE FUNCTION analystarena_preserve_publication_authority()
RETURNS TRIGGER AS $$
DECLARE
  audit_snapshot_id UUID;
  audit_snapshot_payload_hash TEXT;
  audit_pdf_sha256 TEXT;
  audit_published_at TIMESTAMPTZ;
  authority_snapshot_payload_hash TEXT;
  authority_snapshot_payload JSONB;
  authority_snapshot_date DATE;
  old_supersedes_id UUID;
  new_supersedes_id UUID;
  old_superseded_by_id UUID;
  new_superseded_by_id UUID;
BEGIN
  -- `to_jsonb` keeps this migration independently rerunnable both before and
  -- after the later correction migration adds the lifecycle columns. A direct
  -- rerun must never downgrade the newer publication-authority trigger.
  old_supersedes_id := NULLIF(to_jsonb(OLD)->>'supersedes_id', '')::uuid;
  new_supersedes_id := NULLIF(to_jsonb(NEW)->>'supersedes_id', '')::uuid;
  old_superseded_by_id :=
    NULLIF(to_jsonb(OLD)->>'superseded_by_id', '')::uuid;
  new_superseded_by_id :=
    NULLIF(to_jsonb(NEW)->>'superseded_by_id', '')::uuid;

  IF OLD.status NOT IN ('published', 'superseded') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    snapshot_id,
    snapshot_payload_hash,
    pdf_sha256,
    published_at
    INTO
      audit_snapshot_id,
      audit_snapshot_payload_hash,
      audit_pdf_sha256,
      audit_published_at
  FROM brief_publication_audits
  WHERE brief_id = OLD.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy published brief % has no publication audit and is immutable',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published brief % cannot be deleted from publication authority',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  SELECT payload_hash, payload, brief_date
    INTO authority_snapshot_payload_hash, authority_snapshot_payload,
      authority_snapshot_date
  FROM brief_snapshots
  WHERE id = NEW.current_snapshot_id;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.brief_date IS DISTINCT FROM OLD.brief_date
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.current_snapshot_id IS DISTINCT FROM audit_snapshot_id
     OR authority_snapshot_payload_hash
       IS DISTINCT FROM audit_snapshot_payload_hash
     OR (
       NEW.payload - 'id' - 'status' - 'publishedAt' - 'storageMode'
     ) IS DISTINCT FROM (
       authority_snapshot_payload
         - 'id' - 'status' - 'publishedAt' - 'storageMode'
     )
     OR authority_snapshot_date IS DISTINCT FROM NEW.brief_date
     OR encode(sha256(NEW.pdf_data), 'hex') IS DISTINCT FROM audit_pdf_sha256
     OR NEW.published_at IS DISTINCT FROM audit_published_at
     OR new_supersedes_id IS DISTINCT FROM old_supersedes_id
     OR (
       OLD.status = 'published'
       AND NOT (
         (NEW.status = 'published'
          AND new_superseded_by_id IS NOT DISTINCT FROM old_superseded_by_id)
         OR
         (NEW.status = 'superseded'
          AND old_superseded_by_id IS NULL
          AND new_superseded_by_id IS NOT NULL)
       )
     )
     OR (
       OLD.status = 'superseded'
       AND (
         NEW.status IS DISTINCT FROM 'superseded'
         OR new_superseded_by_id IS DISTINCT FROM old_superseded_by_id
       )
     ) THEN
    RAISE EXCEPTION 'published brief % cannot diverge from its immutable publication audit',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS daily_briefs_preserve_publication_authority
  ON daily_briefs;
CREATE TRIGGER daily_briefs_preserve_publication_authority
  BEFORE UPDATE OR DELETE ON daily_briefs
  FOR EACH ROW EXECUTE FUNCTION analystarena_preserve_publication_authority();

CREATE TABLE IF NOT EXISTS comparison_algorithms (
  version TEXT PRIMARY KEY,
  implementation_hash TEXT NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (btrim(version) <> ''),
  CHECK (implementation_hash ~ '^[0-9a-f]{64}$')
);

INSERT INTO comparison_algorithms (version, implementation_hash, config)
VALUES (
  'what-changed/v1',
  'f510adc0e7a9f8987d9ea5bba2e0a886e764745a0b7eed9ea2f20ad7bbe2c01c',
  '{
    "schema":"what-changed/v1",
    "evidence":"exact-event-and-claim-relation-bindings",
    "numbers":"original-claim-explicit-unit-v1",
    "direction":"explicit-market-direction",
    "rankDelta":"previous-current",
    "baselines":["previous_observation","previous_published"]
  }'::jsonb
)
ON CONFLICT (version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM comparison_algorithms
    WHERE version = 'what-changed/v1'
      AND implementation_hash =
        'f510adc0e7a9f8987d9ea5bba2e0a886e764745a0b7eed9ea2f20ad7bbe2c01c'
      AND config = '{
        "schema":"what-changed/v1",
        "evidence":"exact-event-and-claim-relation-bindings",
        "numbers":"original-claim-explicit-unit-v1",
        "direction":"explicit-market-direction",
        "rankDelta":"previous-current",
        "baselines":["previous_observation","previous_published"]
      }'::jsonb
  ) THEN
    RAISE EXCEPTION 'what-changed/v1 registry does not match the deployed implementation'
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_version_comparisons (
  event_id TEXT NOT NULL,
  current_version_id UUID NOT NULL,
  previous_version_id UUID,
  status TEXT NOT NULL CHECK (status IN (
    'first_seen', 'changed', 'legacy_unverified', 'comparison_unavailable'
  )),
  algorithm_version TEXT NOT NULL REFERENCES comparison_algorithms(version) ON DELETE RESTRICT,
  input_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  compared_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, current_version_id, algorithm_version),
  FOREIGN KEY (event_id, current_version_id)
    REFERENCES event_versions(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, previous_version_id)
    REFERENCES event_versions(event_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'first_seen' AND previous_version_id IS NULL)
    OR status <> 'first_seen'
  ),
  CHECK (btrim(input_hash) <> ''),
  CHECK (btrim(result_hash) <> ''),
  CHECK (btrim(summary) <> '')
);
CREATE INDEX IF NOT EXISTS event_version_comparisons_previous_idx
  ON event_version_comparisons (event_id, previous_version_id);

CREATE TABLE IF NOT EXISTS event_version_change_items (
  event_id TEXT NOT NULL,
  current_version_id UUID NOT NULL,
  algorithm_version TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'first_seen', 'evidence_added', 'evidence_removed', 'evidence_revised',
    'claim_support_added', 'claim_support_removed', 'claim_support_changed',
    'claim_relation_added', 'claim_relation_removed', 'claim_relation_changed',
    'numeric_changed', 'direction_established', 'direction_changed',
    'claim_changed', 'state_changed'
  )),
  subject_key TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  evidence_version_ids UUID[] NOT NULL DEFAULT '{}',
  change_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, current_version_id, algorithm_version, item_id),
  UNIQUE (event_id, current_version_id, algorithm_version, ordinal),
  FOREIGN KEY (event_id, current_version_id, algorithm_version)
    REFERENCES event_version_comparisons (
      event_id, current_version_id, algorithm_version
    ) ON DELETE RESTRICT,
  CHECK (btrim(subject_key) <> ''),
  CHECK (btrim(reason_code) <> ''),
  CHECK (btrim(summary) <> ''),
  CHECK (change_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_version_change_items_removal_evidence_ck CHECK (
    kind NOT IN (
      'evidence_removed', 'claim_support_removed', 'claim_relation_removed'
    )
    OR (
      cardinality(evidence_version_ids) > 0
      AND array_position(evidence_version_ids, NULL) IS NULL
    )
  )
);

ALTER TABLE event_version_change_items
  DROP CONSTRAINT IF EXISTS event_version_change_items_kind_check;
ALTER TABLE event_version_change_items
  ADD CONSTRAINT event_version_change_items_kind_check CHECK (kind IN (
    'first_seen', 'evidence_added', 'evidence_removed', 'evidence_revised',
    'claim_support_added', 'claim_support_removed', 'claim_support_changed',
    'claim_relation_added', 'claim_relation_removed', 'claim_relation_changed',
    'numeric_changed', 'direction_established', 'direction_changed',
    'claim_changed', 'state_changed'
  ));
ALTER TABLE event_version_change_items
  DROP CONSTRAINT IF EXISTS event_version_change_items_removal_evidence_ck;
ALTER TABLE event_version_change_items
  ADD CONSTRAINT event_version_change_items_removal_evidence_ck CHECK (
    kind NOT IN (
      'evidence_removed', 'claim_support_removed', 'claim_relation_removed'
    )
    OR (
      cardinality(evidence_version_ids) > 0
      AND array_position(evidence_version_ids, NULL) IS NULL
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_version_change_items_removal_evidence_ck'
      AND conrelid = 'event_version_change_items'::regclass
  ) THEN
    ALTER TABLE event_version_change_items
      ADD CONSTRAINT event_version_change_items_removal_evidence_ck CHECK (
        kind NOT IN (
          'evidence_removed', 'claim_support_removed', 'claim_relation_removed'
        )
        OR (
          cardinality(evidence_version_ids) > 0
          AND array_position(evidence_version_ids, NULL) IS NULL
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS event_version_numeric_facts (
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  fact_key TEXT NOT NULL,
  claim_key TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  period_key TEXT NOT NULL,
  value_numeric NUMERIC NOT NULL,
  value_canonical TEXT NOT NULL,
  unit TEXT NOT NULL,
  currency TEXT,
  scale TEXT NOT NULL,
  raw_token TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  original_text TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  comparison_status TEXT NOT NULL CHECK (comparison_status IN ('comparable', 'uncomparable')),
  comparison_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, event_version_id, fact_key),
  FOREIGN KEY (event_id, event_version_id, claim_key)
    REFERENCES event_claims (event_id, event_version_id, claim_key) ON DELETE RESTRICT,
  CHECK (btrim(fact_key) <> ''),
  CHECK (btrim(metric_key) <> ''),
  CHECK (btrim(subject_key) <> ''),
  CHECK (btrim(period_key) <> ''),
  CHECK (btrim(value_canonical) <> ''),
  CHECK (btrim(unit) <> ''),
  CHECK (btrim(raw_token) <> ''),
  CHECK (btrim(original_text) <> ''),
  CHECK (btrim(parser_version) <> ''),
  CHECK (btrim(comparison_reason) <> '')
);

CREATE TABLE IF NOT EXISTS event_version_numeric_fact_evidence (
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  fact_key TEXT NOT NULL,
  claim_id UUID NOT NULL,
  claim_key TEXT NOT NULL,
  evidence_item_id TEXT NOT NULL,
  evidence_version_id UUID NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports' CHECK (relation = 'supports'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, event_version_id, fact_key, evidence_version_id),
  FOREIGN KEY (event_id, event_version_id, fact_key)
    REFERENCES event_version_numeric_facts (
      event_id, event_version_id, fact_key
    ) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, event_version_id, claim_id, claim_key)
    REFERENCES event_claims (
      event_id, event_version_id, id, claim_key
    ) ON DELETE RESTRICT,
  FOREIGN KEY (claim_id, evidence_version_id, relation)
    REFERENCES claim_evidence_links (
      claim_id, evidence_version_id, relation
    ) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS event_version_numeric_facts_claim_idx
  ON event_version_numeric_facts (event_id, event_version_id, claim_key);

-- These exact identity indexes support composite foreign keys below. They
-- prevent a request from naming a real evidence UUID or predecessor UUID while
-- pairing it with the wrong item or transition.
CREATE UNIQUE INDEX IF NOT EXISTS event_versions_exact_transition_uq
  ON event_versions (event_id, id, previous_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS event_version_evidence_exact_item_uq
  ON event_version_evidence (
    event_id, event_version_id, evidence_item_id, evidence_version_id
  );

CREATE TABLE IF NOT EXISTS evidence_retraction_requests (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  event_id TEXT NOT NULL,
  from_event_version_id UUID NOT NULL,
  to_event_version_id UUID NOT NULL,
  evidence_item_id TEXT NOT NULL,
  evidence_version_id UUID NOT NULL,
  claim_id UUID,
  claim_key TEXT,
  citation_relation TEXT CHECK (
    citation_relation IN ('supports', 'contradicts', 'context')
  ),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'source_retracted', 'invalid_locator', 'duplicate',
    'review_rejected', 'superseded'
  )),
  reason_note TEXT NOT NULL,
  replacement_evidence_version_id UUID,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'admin')),
  actor_id_hash TEXT NOT NULL,
  applied_run_id UUID NOT NULL REFERENCES collection_runs(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT evidence_retraction_requests_source_evidence_fk
  FOREIGN KEY (
    event_id, from_event_version_id, evidence_item_id, evidence_version_id
  )
    REFERENCES event_version_evidence (
      event_id, event_version_id, evidence_item_id, evidence_version_id
    ) ON DELETE RESTRICT,
  CONSTRAINT evidence_retraction_requests_target_version_fk
  FOREIGN KEY (event_id, to_event_version_id)
    REFERENCES event_versions (event_id, id) ON DELETE RESTRICT,
  CONSTRAINT evidence_retraction_requests_transition_fk
  FOREIGN KEY (event_id, to_event_version_id, from_event_version_id)
    REFERENCES event_versions (event_id, id, previous_version_id) ON DELETE RESTRICT,
  CONSTRAINT evidence_retraction_requests_replacement_evidence_fk
  FOREIGN KEY (
    event_id, to_event_version_id, replacement_evidence_version_id
  )
    REFERENCES event_version_evidence (
      event_id, event_version_id, evidence_version_id
    ) ON DELETE RESTRICT,
  CONSTRAINT evidence_retraction_requests_claim_fk
  FOREIGN KEY (event_id, from_event_version_id, claim_id, claim_key)
    REFERENCES event_claims (
      event_id, event_version_id, id, claim_key
    ) ON DELETE RESTRICT,
  CONSTRAINT evidence_retraction_requests_claim_relation_fk
  FOREIGN KEY (claim_id, evidence_version_id, citation_relation)
    REFERENCES claim_evidence_links (
      claim_id, evidence_version_id, relation
    ) ON DELETE RESTRICT,
  CONSTRAINT evidence_retraction_requests_distinct_versions_ck
    CHECK (from_event_version_id <> to_event_version_id),
  CHECK (
    (claim_id IS NULL AND claim_key IS NULL AND citation_relation IS NULL)
    OR (
      claim_id IS NOT NULL
      AND claim_key IS NOT NULL
      AND citation_relation IS NOT NULL
    )
  ),
  CHECK (btrim(request_id) <> ''),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CHECK (btrim(evidence_item_id) <> ''),
  CHECK (btrim(reason_note) <> ''),
  CHECK (actor_id_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_retraction_requests_exact_target_uq
  ON evidence_retraction_requests (
    request_id, event_id, to_event_version_id, evidence_version_id
  );
CREATE INDEX IF NOT EXISTS evidence_retraction_requests_event_idx
  ON evidence_retraction_requests (
    event_id, from_event_version_id, evidence_version_id
  );
CREATE INDEX IF NOT EXISTS claim_evidence_links_replacement_authority_idx
  ON claim_evidence_links (
    event_id, event_version_id, claim_key, evidence_version_id, relation
  );

ALTER TABLE evidence_retraction_requests
  ADD COLUMN IF NOT EXISTS citation_relation TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM evidence_retraction_requests AS request
    WHERE request.claim_key IS NOT NULL
      AND request.citation_relation IS NULL
      AND (
        SELECT COUNT(DISTINCT link.relation)
        FROM claim_evidence_links AS link
        WHERE link.claim_id = request.claim_id
          AND link.evidence_version_id = request.evidence_version_id
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'claim-scoped legacy retraction has no unique citation relation'
      USING ERRCODE = '23514';
  END IF;
END $$;

UPDATE evidence_retraction_requests AS request
SET citation_relation = (
  SELECT MIN(link.relation)
  FROM claim_evidence_links AS link
  WHERE link.claim_id = request.claim_id
    AND link.evidence_version_id = request.evidence_version_id
)
WHERE request.claim_key IS NOT NULL
  AND request.citation_relation IS NULL;

ALTER TABLE evidence_retraction_requests
  DROP CONSTRAINT IF EXISTS evidence_retraction_requests_claim_relation_shape_ck;
ALTER TABLE evidence_retraction_requests
  ADD CONSTRAINT evidence_retraction_requests_claim_relation_shape_ck CHECK (
    (
      claim_id IS NULL
      AND claim_key IS NULL
      AND citation_relation IS NULL
    )
    OR (
      claim_id IS NOT NULL
      AND claim_key IS NOT NULL
      AND citation_relation IN ('supports', 'contradicts', 'context')
    )
  );

-- Converge databases that saw an earlier draft of this migration. Stable
-- names make this block safe on every rerun while retaining strict validation
-- of any already-present rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_source_evidence_fk'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_source_evidence_fk
      FOREIGN KEY (
        event_id, from_event_version_id, evidence_item_id, evidence_version_id
      ) REFERENCES event_version_evidence (
        event_id, event_version_id, evidence_item_id, evidence_version_id
      ) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_claim_relation_fk'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_claim_relation_fk
      FOREIGN KEY (claim_id, evidence_version_id, citation_relation)
      REFERENCES claim_evidence_links (
        claim_id, evidence_version_id, relation
      ) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_target_version_fk'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_target_version_fk
      FOREIGN KEY (event_id, to_event_version_id)
      REFERENCES event_versions (event_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_transition_fk'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_transition_fk
      FOREIGN KEY (event_id, to_event_version_id, from_event_version_id)
      REFERENCES event_versions (event_id, id, previous_version_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_replacement_evidence_fk'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_replacement_evidence_fk
      FOREIGN KEY (
        event_id, to_event_version_id, replacement_evidence_version_id
      ) REFERENCES event_version_evidence (
        event_id, event_version_id, evidence_version_id
      ) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_claim_fk'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_claim_fk
      FOREIGN KEY (event_id, from_event_version_id, claim_id, claim_key)
      REFERENCES event_claims (event_id, event_version_id, id, claim_key)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_retraction_requests_distinct_versions_ck'
      AND conrelid = 'evidence_retraction_requests'::regclass
  ) THEN
    ALTER TABLE evidence_retraction_requests
      ADD CONSTRAINT evidence_retraction_requests_distinct_versions_ck
      CHECK (from_event_version_id <> to_event_version_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS brief_snapshot_event_changes (
  current_snapshot_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  current_event_version_id UUID NOT NULL,
  baseline_kind TEXT NOT NULL CHECK (baseline_kind IN (
    'previous_observation', 'previous_published'
  )),
  baseline_snapshot_id UUID REFERENCES brief_snapshots(id) ON DELETE RESTRICT,
  baseline_event_id TEXT,
  baseline_event_version_id UUID,
  historical_observation_snapshot_id UUID REFERENCES brief_snapshots(id) ON DELETE RESTRICT,
  historical_observation_event_id TEXT,
  historical_observation_event_version_id UUID,
  presence TEXT NOT NULL CHECK (presence IN (
    'first_seen', 'continued', 'entered', 'reentered', 'no_baseline'
  )),
  previous_rank INTEGER CHECK (previous_rank > 0),
  current_rank INTEGER NOT NULL CHECK (current_rank > 0),
  rank_delta INTEGER,
  rank_movement TEXT NOT NULL CHECK (rank_movement IN (
    'up', 'down', 'unchanged', 'not_comparable'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'first_seen', 'changed', 'unchanged', 'legacy_unverified',
    'comparison_unavailable'
  )),
  algorithm_version TEXT NOT NULL REFERENCES comparison_algorithms(version) ON DELETE RESTRICT,
  input_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  compared_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (current_snapshot_id, event_id, baseline_kind, algorithm_version),
  FOREIGN KEY (current_snapshot_id, event_id, current_event_version_id)
    REFERENCES brief_snapshot_events (
      snapshot_id, event_id, event_version_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (baseline_snapshot_id, baseline_event_id, baseline_event_version_id)
    REFERENCES brief_snapshot_events (
      snapshot_id, event_id, event_version_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    historical_observation_snapshot_id,
    historical_observation_event_id,
    historical_observation_event_version_id
  ) REFERENCES brief_snapshot_events (
    snapshot_id, event_id, event_version_id
  ) MATCH FULL ON DELETE RESTRICT,
  CHECK (
    baseline_event_id IS NULL OR baseline_event_id = event_id
  ),
  CHECK (
    (baseline_event_id IS NULL AND baseline_event_version_id IS NULL)
    OR (baseline_event_id IS NOT NULL AND baseline_event_version_id IS NOT NULL)
  ),
  CHECK (
    historical_observation_event_id IS NULL
    OR historical_observation_event_id = event_id
  ),
  CHECK (
    (previous_rank IS NULL AND rank_delta IS NULL AND rank_movement = 'not_comparable')
    OR (
      previous_rank IS NOT NULL
      AND rank_delta = previous_rank - current_rank
      AND (
        (rank_delta > 0 AND rank_movement = 'up')
        OR (rank_delta < 0 AND rank_movement = 'down')
        OR (rank_delta = 0 AND rank_movement = 'unchanged')
      )
    )
  ),
  CHECK (
    (presence = 'continued' AND baseline_event_id = event_id)
    OR (presence <> 'continued')
  ),
  CHECK (btrim(input_hash) <> ''),
  CHECK (btrim(result_hash) <> ''),
  CHECK (btrim(summary) <> '')
);
CREATE INDEX IF NOT EXISTS brief_snapshot_event_changes_event_idx
  ON brief_snapshot_event_changes (
    event_id, baseline_kind, current_snapshot_id
  );

CREATE TABLE IF NOT EXISTS brief_snapshot_event_change_items (
  current_snapshot_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  baseline_kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'first_seen', 'evidence_added', 'evidence_removed', 'evidence_revised',
    'claim_support_added', 'claim_support_removed', 'claim_support_changed',
    'claim_relation_added', 'claim_relation_removed', 'claim_relation_changed',
    'numeric_changed', 'direction_established', 'direction_changed',
    'claim_changed', 'state_changed', 'rank_up', 'rank_down',
    'entered', 'reentered'
  )),
  subject_key TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  evidence_version_ids UUID[] NOT NULL DEFAULT '{}',
  change_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    current_snapshot_id, event_id, baseline_kind, algorithm_version, item_id
  ),
  UNIQUE (
    current_snapshot_id, event_id, baseline_kind, algorithm_version, ordinal
  ),
  FOREIGN KEY (
    current_snapshot_id, event_id, baseline_kind, algorithm_version
  ) REFERENCES brief_snapshot_event_changes (
    current_snapshot_id, event_id, baseline_kind, algorithm_version
  ) ON DELETE RESTRICT,
  CHECK (btrim(subject_key) <> ''),
  CHECK (btrim(reason_code) <> ''),
  CHECK (btrim(summary) <> ''),
  CHECK (change_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE brief_snapshot_event_change_items
  DROP CONSTRAINT IF EXISTS brief_snapshot_event_change_items_kind_check;
ALTER TABLE brief_snapshot_event_change_items
  ADD CONSTRAINT brief_snapshot_event_change_items_kind_check CHECK (kind IN (
    'first_seen', 'evidence_added', 'evidence_removed', 'evidence_revised',
    'claim_support_added', 'claim_support_removed', 'claim_support_changed',
    'claim_relation_added', 'claim_relation_removed', 'claim_relation_changed',
    'numeric_changed', 'direction_established', 'direction_changed',
    'claim_changed', 'state_changed', 'rank_up', 'rank_down',
    'entered', 'reentered'
  ));

CREATE TABLE IF NOT EXISTS event_version_change_item_retractions (
  event_id TEXT NOT NULL,
  current_version_id UUID NOT NULL,
  algorithm_version TEXT NOT NULL,
  item_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  evidence_version_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    event_id, current_version_id, algorithm_version, item_id, request_id
  ),
  CONSTRAINT event_version_change_item_retractions_item_fk
  FOREIGN KEY (
    event_id, current_version_id, algorithm_version, item_id
  ) REFERENCES event_version_change_items (
    event_id, current_version_id, algorithm_version, item_id
  ) ON DELETE RESTRICT,
  CONSTRAINT event_version_change_item_retractions_request_fk
  FOREIGN KEY (
    request_id, event_id, current_version_id, evidence_version_id
  ) REFERENCES evidence_retraction_requests (
    request_id, event_id, to_event_version_id, evidence_version_id
  ) ON DELETE RESTRICT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_version_change_item_retractions_item_fk'
      AND conrelid = 'event_version_change_item_retractions'::regclass
  ) THEN
    ALTER TABLE event_version_change_item_retractions
      ADD CONSTRAINT event_version_change_item_retractions_item_fk
      FOREIGN KEY (
        event_id, current_version_id, algorithm_version, item_id
      ) REFERENCES event_version_change_items (
        event_id, current_version_id, algorithm_version, item_id
      ) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_version_change_item_retractions_request_fk'
      AND conrelid = 'event_version_change_item_retractions'::regclass
  ) THEN
    ALTER TABLE event_version_change_item_retractions
      ADD CONSTRAINT event_version_change_item_retractions_request_fk
      FOREIGN KEY (
        request_id, event_id, current_version_id, evidence_version_id
      ) REFERENCES evidence_retraction_requests (
        request_id, event_id, to_event_version_id, evidence_version_id
      ) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION analystarena_require_change_item_retraction()
RETURNS TRIGGER AS $$
DECLARE
  missing_evidence UUID;
BEGIN
  IF NEW.kind NOT IN (
    'evidence_removed', 'claim_support_removed', 'claim_relation_removed'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT removed.evidence_version_id INTO missing_evidence
  FROM unnest(NEW.evidence_version_ids) AS removed(evidence_version_id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM event_version_change_item_retractions AS binding
    WHERE binding.event_id = NEW.event_id
      AND binding.current_version_id = NEW.current_version_id
      AND binding.algorithm_version = NEW.algorithm_version
      AND binding.item_id = NEW.item_id
      AND binding.evidence_version_id = removed.evidence_version_id
  )
  LIMIT 1;

  IF missing_evidence IS NOT NULL THEN
    RAISE EXCEPTION 'change item % removes evidence % without an exact retraction request',
      NEW.item_id, missing_evidence
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION analystarena_validate_change_item_retraction()
RETURNS TRIGGER AS $$
DECLARE
  target_kind TEXT;
  target_before_value JSONB;
  target_after_value JSONB;
  target_evidence_version_ids UUID[];
  authority_request_id TEXT;
  request_claim_key TEXT;
  request_citation_relation TEXT;
BEGIN
  SELECT
    item.kind,
    item.before_value,
    item.after_value,
    item.evidence_version_ids,
    request.request_id,
    request.claim_key,
    request.citation_relation
    INTO
      target_kind,
      target_before_value,
      target_after_value,
      target_evidence_version_ids,
      authority_request_id,
      request_claim_key,
      request_citation_relation
  FROM event_version_change_items AS item
  JOIN evidence_retraction_requests AS request
    ON request.request_id = NEW.request_id
   AND request.event_id = NEW.event_id
   AND request.to_event_version_id = NEW.current_version_id
   AND request.evidence_version_id = NEW.evidence_version_id
  WHERE item.event_id = NEW.event_id
    AND item.current_version_id = NEW.current_version_id
    AND item.algorithm_version = NEW.algorithm_version
    AND item.item_id = NEW.item_id;

  IF authority_request_id IS NULL
     OR target_kind IS NULL
     OR NOT (NEW.evidence_version_id = ANY(target_evidence_version_ids)) THEN
    RAISE EXCEPTION 'retraction binding % does not exactly match removal item % and evidence %',
      NEW.request_id, NEW.item_id, NEW.evidence_version_id
      USING ERRCODE = '23514';
  END IF;

  IF request_claim_key IS NULL THEN
    IF target_kind NOT IN (
      'evidence_removed', 'claim_support_removed',
      'evidence_revised', 'claim_support_changed',
      'claim_relation_removed', 'claim_relation_changed'
    ) THEN
      RAISE EXCEPTION 'global retraction % cannot bind change item kind %',
        NEW.request_id, target_kind
        USING ERRCODE = '23514';
    END IF;
  ELSIF target_kind NOT IN (
       'claim_support_removed', 'claim_support_changed',
       'claim_relation_removed', 'claim_relation_changed'
     )
     OR COALESCE(
       target_before_value->>'claimKey',
       target_after_value->>'claimKey'
     ) IS DISTINCT FROM request_claim_key
     OR (
       target_before_value->>'claimKey' IS NOT NULL
       AND target_before_value->>'claimKey' IS DISTINCT FROM request_claim_key
     )
     OR (
       target_after_value->>'claimKey' IS NOT NULL
       AND target_after_value->>'claimKey' IS DISTINCT FROM request_claim_key
     )
     OR COALESCE(
       target_before_value->>'relation',
       CASE
         WHEN target_kind IN ('claim_support_removed', 'claim_support_changed')
         THEN 'supports'
         ELSE NULL
       END
     ) IS DISTINCT FROM request_citation_relation
  THEN
    RAISE EXCEPTION 'claim-scoped retraction % cannot bind item % outside claim %',
      NEW.request_id, NEW.item_id, request_claim_key
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION analystarena_validate_retraction_request_authority()
RETURNS TRIGGER AS $$
DECLARE
  has_compliant_binding BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM event_version_change_item_retractions AS binding
    JOIN event_version_change_items AS item
      ON item.event_id = binding.event_id
     AND item.current_version_id = binding.current_version_id
     AND item.algorithm_version = binding.algorithm_version
     AND item.item_id = binding.item_id
    WHERE binding.request_id = NEW.request_id
      AND binding.event_id = NEW.event_id
      AND binding.current_version_id = NEW.to_event_version_id
      AND binding.evidence_version_id = NEW.evidence_version_id
      AND NEW.evidence_version_id = ANY(item.evidence_version_ids)
      AND (
        (
          NEW.claim_key IS NULL
          AND item.kind IN (
            'evidence_removed', 'claim_support_removed',
            'evidence_revised', 'claim_support_changed',
            'claim_relation_removed', 'claim_relation_changed'
          )
        )
        OR (
          NEW.claim_key IS NOT NULL
          AND item.kind IN (
            'claim_support_removed', 'claim_support_changed',
            'claim_relation_removed', 'claim_relation_changed'
          )
          AND COALESCE(
            item.before_value->>'claimKey',
            item.after_value->>'claimKey'
          ) = NEW.claim_key
          AND (
            item.before_value->>'claimKey' IS NULL
            OR item.before_value->>'claimKey' = NEW.claim_key
          )
          AND (
            item.after_value->>'claimKey' IS NULL
            OR item.after_value->>'claimKey' = NEW.claim_key
          )
          AND COALESCE(
            item.before_value->>'relation',
            CASE
              WHEN item.kind IN ('claim_support_removed', 'claim_support_changed')
              THEN 'supports'
              ELSE NULL
            END
          ) = NEW.citation_relation
        )
      )
  ) INTO has_compliant_binding;

  IF NOT has_compliant_binding THEN
    RAISE EXCEPTION 'retraction request % has no compliant change-item binding',
      NEW.request_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.claim_key IS NOT NULL
     AND NEW.replacement_evidence_version_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM claim_evidence_links AS replacement
       WHERE replacement.event_id = NEW.event_id
         AND replacement.event_version_id = NEW.to_event_version_id
         AND replacement.claim_key = NEW.claim_key
         AND replacement.evidence_version_id =
           NEW.replacement_evidence_version_id
         AND replacement.relation = 'supports'
     ) THEN
    RAISE EXCEPTION 'replacement evidence % does not support claim % in event version %',
      NEW.replacement_evidence_version_id,
      NEW.claim_key,
      NEW.to_event_version_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_version_change_items_require_retraction
  ON event_version_change_items;
CREATE CONSTRAINT TRIGGER event_version_change_items_require_retraction
  AFTER INSERT ON event_version_change_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION analystarena_require_change_item_retraction();

DROP TRIGGER IF EXISTS event_version_change_item_retractions_validate
  ON event_version_change_item_retractions;
CREATE CONSTRAINT TRIGGER event_version_change_item_retractions_validate
  AFTER INSERT ON event_version_change_item_retractions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION analystarena_validate_change_item_retraction();

DROP TRIGGER IF EXISTS evidence_retraction_requests_validate_authority
  ON evidence_retraction_requests;
CREATE CONSTRAINT TRIGGER evidence_retraction_requests_validate_authority
  AFTER INSERT ON evidence_retraction_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION analystarena_validate_retraction_request_authority();

-- Constraint triggers only see new rows. Refuse to bless an earlier partial
-- migration whose historical removal items or bindings are not exact.
DO $$
DECLARE
  invalid_item RECORD;
  invalid_binding RECORD;
  invalid_request RECORD;
  invalid_replacement RECORD;
BEGIN
  SELECT
    item.event_id,
    item.current_version_id,
    item.algorithm_version,
    item.item_id,
    removed.evidence_version_id
  INTO invalid_item
  FROM event_version_change_items AS item
  CROSS JOIN LATERAL unnest(item.evidence_version_ids)
    AS removed(evidence_version_id)
  WHERE item.kind IN (
    'evidence_removed', 'claim_support_removed', 'claim_relation_removed'
  )
    AND NOT EXISTS (
      SELECT 1
      FROM event_version_change_item_retractions AS binding
      WHERE binding.event_id = item.event_id
        AND binding.current_version_id = item.current_version_id
        AND binding.algorithm_version = item.algorithm_version
        AND binding.item_id = item.item_id
        AND binding.evidence_version_id = removed.evidence_version_id
    )
  LIMIT 1;

  IF invalid_item.item_id IS NOT NULL THEN
    RAISE EXCEPTION 'existing change item % removes evidence % without an exact retraction request',
      invalid_item.item_id, invalid_item.evidence_version_id
      USING ERRCODE = '23514';
  END IF;

  SELECT binding.*
  INTO invalid_binding
  FROM event_version_change_item_retractions AS binding
  JOIN event_version_change_items AS item
    ON item.event_id = binding.event_id
   AND item.current_version_id = binding.current_version_id
   AND item.algorithm_version = binding.algorithm_version
   AND item.item_id = binding.item_id
  JOIN evidence_retraction_requests AS request
    ON request.request_id = binding.request_id
   AND request.event_id = binding.event_id
   AND request.to_event_version_id = binding.current_version_id
   AND request.evidence_version_id = binding.evidence_version_id
  WHERE NOT (binding.evidence_version_id = ANY(item.evidence_version_ids))
     OR (
       request.claim_key IS NULL
       AND item.kind NOT IN (
         'evidence_removed', 'claim_support_removed',
         'evidence_revised', 'claim_support_changed',
         'claim_relation_removed', 'claim_relation_changed'
       )
     )
     OR (
       request.claim_key IS NOT NULL
       AND (
         item.kind NOT IN (
           'claim_support_removed', 'claim_support_changed',
           'claim_relation_removed', 'claim_relation_changed'
         )
         OR COALESCE(
           item.before_value->>'claimKey',
           item.after_value->>'claimKey'
         ) IS DISTINCT FROM request.claim_key
         OR (
           item.before_value->>'claimKey' IS NOT NULL
           AND item.before_value->>'claimKey' IS DISTINCT FROM request.claim_key
         )
         OR (
           item.after_value->>'claimKey' IS NOT NULL
           AND item.after_value->>'claimKey' IS DISTINCT FROM request.claim_key
         )
         OR COALESCE(
           item.before_value->>'relation',
           CASE
             WHEN item.kind IN ('claim_support_removed', 'claim_support_changed')
             THEN 'supports'
             ELSE NULL
           END
         ) IS DISTINCT FROM request.citation_relation
       )
     )
  LIMIT 1;

  IF invalid_binding.request_id IS NOT NULL THEN
    RAISE EXCEPTION 'existing retraction binding % does not match its request scope and removal item',
      invalid_binding.request_id
      USING ERRCODE = '23514';
  END IF;

  SELECT request.*
  INTO invalid_request
  FROM evidence_retraction_requests AS request
  WHERE NOT EXISTS (
    SELECT 1
    FROM event_version_change_item_retractions AS binding
    JOIN event_version_change_items AS item
      ON item.event_id = binding.event_id
     AND item.current_version_id = binding.current_version_id
     AND item.algorithm_version = binding.algorithm_version
     AND item.item_id = binding.item_id
    WHERE binding.request_id = request.request_id
      AND binding.event_id = request.event_id
      AND binding.current_version_id = request.to_event_version_id
      AND binding.evidence_version_id = request.evidence_version_id
      AND request.evidence_version_id = ANY(item.evidence_version_ids)
      AND (
        (
          request.claim_key IS NULL
          AND item.kind IN (
            'evidence_removed', 'claim_support_removed',
            'evidence_revised', 'claim_support_changed',
            'claim_relation_removed', 'claim_relation_changed'
          )
        )
        OR (
          request.claim_key IS NOT NULL
          AND item.kind IN (
            'claim_support_removed', 'claim_support_changed',
            'claim_relation_removed', 'claim_relation_changed'
          )
          AND COALESCE(
            item.before_value->>'claimKey',
            item.after_value->>'claimKey'
          ) = request.claim_key
          AND (
            item.before_value->>'claimKey' IS NULL
            OR item.before_value->>'claimKey' = request.claim_key
          )
          AND (
            item.after_value->>'claimKey' IS NULL
            OR item.after_value->>'claimKey' = request.claim_key
          )
          AND COALESCE(
            item.before_value->>'relation',
            CASE
              WHEN item.kind IN ('claim_support_removed', 'claim_support_changed')
              THEN 'supports'
              ELSE NULL
            END
          ) = request.citation_relation
        )
      )
  )
  LIMIT 1;

  IF invalid_request.request_id IS NOT NULL THEN
    RAISE EXCEPTION 'existing retraction request % has no compliant change-item binding',
      invalid_request.request_id
      USING ERRCODE = '23514';
  END IF;

  SELECT request.*
  INTO invalid_replacement
  FROM evidence_retraction_requests AS request
  WHERE request.claim_key IS NOT NULL
    AND request.replacement_evidence_version_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM claim_evidence_links AS replacement
      WHERE replacement.event_id = request.event_id
        AND replacement.event_version_id = request.to_event_version_id
        AND replacement.claim_key = request.claim_key
        AND replacement.evidence_version_id =
          request.replacement_evidence_version_id
        AND replacement.relation = 'supports'
    )
  LIMIT 1;

  IF invalid_replacement.request_id IS NOT NULL THEN
    RAISE EXCEPTION 'existing retraction request % names replacement evidence outside claim %',
      invalid_replacement.request_id,
      invalid_replacement.claim_key
      USING ERRCODE = '23514';
  END IF;
END $$;

-- Existing rows predate this comparator. Preserve them honestly without
-- manufacturing evidence, number, direction, or ranking deltas.
INSERT INTO event_version_comparisons (
  event_id, current_version_id, previous_version_id, status,
  algorithm_version, input_hash, result_hash, summary, compared_at
)
SELECT
  version.event_id,
  version.id,
  version.previous_version_id,
  'legacy_unverified',
  'what-changed/v1',
  'legacy-unverified',
  'legacy-unverified',
  '迁移前事件版本未运行差异算法，不生成推测性变化。',
  version.observed_at
FROM event_versions AS version
ON CONFLICT (event_id, current_version_id, algorithm_version) DO NOTHING;

INSERT INTO brief_snapshot_event_changes (
  current_snapshot_id, event_id, current_event_version_id,
  baseline_kind, presence, current_rank, rank_movement, status,
  algorithm_version, input_hash, result_hash, summary, compared_at
)
SELECT
  snapshot_event.snapshot_id,
  snapshot_event.event_id,
  snapshot_event.event_version_id,
  baseline.kind,
  'no_baseline',
  snapshot_event.rank,
  'not_comparable',
  'legacy_unverified',
  'what-changed/v1',
  'legacy-unverified',
  'legacy-unverified',
  '迁移前快照未运行差异算法，不生成推测性排名或内容变化。',
  snapshot.generated_at
FROM brief_snapshot_events AS snapshot_event
JOIN brief_snapshots AS snapshot ON snapshot.id = snapshot_event.snapshot_id
CROSS JOIN (VALUES ('previous_observation'), ('previous_published')) AS baseline(kind)
ON CONFLICT (
  current_snapshot_id, event_id, baseline_kind, algorithm_version
) DO NOTHING;

DROP TRIGGER IF EXISTS comparison_algorithms_immutable ON comparison_algorithms;
CREATE TRIGGER comparison_algorithms_immutable
  BEFORE UPDATE OR DELETE ON comparison_algorithms
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_comparisons_immutable ON event_version_comparisons;
CREATE TRIGGER event_version_comparisons_immutable
  BEFORE UPDATE OR DELETE ON event_version_comparisons
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_change_items_immutable ON event_version_change_items;
CREATE TRIGGER event_version_change_items_immutable
  BEFORE UPDATE OR DELETE ON event_version_change_items
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_numeric_facts_immutable ON event_version_numeric_facts;
CREATE TRIGGER event_version_numeric_facts_immutable
  BEFORE UPDATE OR DELETE ON event_version_numeric_facts
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_numeric_fact_evidence_immutable
  ON event_version_numeric_fact_evidence;
CREATE TRIGGER event_version_numeric_fact_evidence_immutable
  BEFORE UPDATE OR DELETE ON event_version_numeric_fact_evidence
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS evidence_retraction_requests_immutable
  ON evidence_retraction_requests;
CREATE TRIGGER evidence_retraction_requests_immutable
  BEFORE UPDATE OR DELETE ON evidence_retraction_requests
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_change_item_retractions_immutable
  ON event_version_change_item_retractions;
CREATE TRIGGER event_version_change_item_retractions_immutable
  BEFORE UPDATE OR DELETE ON event_version_change_item_retractions
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS brief_publication_audits_immutable
  ON brief_publication_audits;
CREATE TRIGGER brief_publication_audits_immutable
  BEFORE UPDATE OR DELETE ON brief_publication_audits
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS brief_snapshot_event_changes_immutable
  ON brief_snapshot_event_changes;
CREATE TRIGGER brief_snapshot_event_changes_immutable
  BEFORE UPDATE OR DELETE ON brief_snapshot_event_changes
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS brief_snapshot_event_change_items_immutable
  ON brief_snapshot_event_change_items;
CREATE TRIGGER brief_snapshot_event_change_items_immutable
  BEFORE UPDATE OR DELETE ON brief_snapshot_event_change_items
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();
