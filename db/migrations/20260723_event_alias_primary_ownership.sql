-- Historical builds registered every corroborating source as a permanent
-- event alias. Record whether an alias was ever a primary identity, protect
-- both legitimate and ambiguous historical ownership forever, and permit only
-- aliases proven to be corroborating-only pollution to move. Every move is
-- append-only audited and direct SQL is held to the same ownership rules.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE event_aliases
  ADD COLUMN IF NOT EXISTS primary_ever BOOLEAN;
ALTER TABLE event_aliases
  ADD COLUMN IF NOT EXISTS owner_event_version_id UUID;

-- Exact ownership used for all new writes. Only an explicitly declared
-- primary role can establish resolution authority. Historical payloads without
-- roles are deliberately ambiguous: their aliases remain protected by the
-- historical classifier below, but cannot resolve future observations until a
-- human establishes provenance. Collector-local legacy ids are intentionally
-- not accepted because they are not retained in event payloads.
CREATE OR REPLACE FUNCTION analystarena_event_version_owns_alias(
  target_event_id TEXT,
  target_version_id UUID,
  target_alias_type TEXT,
  target_alias_key TEXT,
  target_canonical_url TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  version_payload JSONB;
BEGIN
  SELECT version.payload
  INTO version_payload
  FROM event_versions AS version
  WHERE version.event_id = target_event_id
    AND version.id = target_version_id;

  IF NOT FOUND OR version_payload IS NULL OR target_alias_type = 'legacy' THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      COALESCE(version_payload->'headline'->'sources', '[]'::jsonb)
    ) AS source(value)
    WHERE source.value->>'role' = 'primary'
    AND (
      (
        target_alias_type = 'document'
        AND source.value->>'sourceDocumentId' = target_alias_key
      )
      OR (
        target_alias_type = 'url'
        AND target_canonical_url IS NOT NULL
        AND COALESCE(
          source.value->>'canonicalUrl',
          source.value->>'url'
        ) = target_canonical_url
      )
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Backfill is deliberately more conservative than new-write validation.
-- When an old version has no declared primary role, every matching source is
-- ambiguous and therefore protected. Only aliases that appear exclusively as
-- explicit non-primary sources can be classified as movable legacy pollution.
CREATE OR REPLACE FUNCTION analystarena_event_version_protects_historical_alias(
  target_event_id TEXT,
  target_version_id UUID,
  target_alias_type TEXT,
  target_alias_key TEXT,
  target_canonical_url TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  version_payload JSONB;
  has_declared_primary BOOLEAN;
BEGIN
  SELECT version.payload
  INTO version_payload
  FROM event_versions AS version
  WHERE version.event_id = target_event_id
    AND version.id = target_version_id;

  IF NOT FOUND OR version_payload IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Existing legacy aliases were previously immutable. Their exact inbound
  -- collector id is absent from the rewritten event payload, so preserve the
  -- historical mapping but prohibit all future inserts or changes below.
  IF target_alias_type = 'legacy' THEN
    RETURN TRUE;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      COALESCE(version_payload->'headline'->'sources', '[]'::jsonb)
    ) AS source(value)
    WHERE source.value->>'role' = 'primary'
  )
  INTO has_declared_primary;

  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      COALESCE(version_payload->'headline'->'sources', '[]'::jsonb)
    ) AS source(value)
    WHERE (
      NOT has_declared_primary
      OR COALESCE(source.value->>'role', '') NOT IN (
        'corroborating', 'context', 'contradicting', 'social_signal'
      )
    )
    AND (
      (
        target_alias_type = 'document'
        AND source.value->>'sourceDocumentId' = target_alias_key
      )
      OR (
        target_alias_type = 'url'
        AND target_canonical_url IS NOT NULL
        AND COALESCE(
          source.value->>'canonicalUrl',
          source.value->>'url'
        ) = target_canonical_url
      )
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION analystarena_event_version_mentions_alias(
  target_event_id TEXT,
  target_version_id UUID,
  target_alias_type TEXT,
  target_alias_key TEXT,
  target_canonical_url TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  version_payload JSONB;
BEGIN
  SELECT version.payload
  INTO version_payload
  FROM event_versions AS version
  WHERE version.event_id = target_event_id
    AND version.id = target_version_id;

  IF NOT FOUND OR version_payload IS NULL THEN
    RETURN FALSE;
  END IF;
  IF target_alias_type = 'legacy' THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      COALESCE(version_payload->'headline'->'sources', '[]'::jsonb)
    ) AS source(value)
    WHERE (
      (
        target_alias_type = 'document'
        AND source.value->>'sourceDocumentId' = target_alias_key
      )
      OR (
        target_alias_type = 'url'
        AND target_canonical_url IS NOT NULL
        AND COALESCE(
          source.value->>'canonicalUrl',
          source.value->>'url'
        ) = target_canonical_url
      )
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

WITH historical_protected AS (
  SELECT DISTINCT ON (alias.alias_type, alias.alias_key)
    alias.alias_type,
    alias.alias_key,
    version.id AS owner_event_version_id
  FROM event_aliases AS alias
  JOIN event_versions AS version
    ON version.event_id = alias.event_id
  WHERE analystarena_event_version_protects_historical_alias(
    alias.event_id,
    version.id,
    alias.alias_type,
    alias.alias_key,
    alias.canonical_url
  )
  ORDER BY
    alias.alias_type,
    alias.alias_key,
    analystarena_event_version_owns_alias(
      alias.event_id,
      version.id,
      alias.alias_type,
      alias.alias_key,
      alias.canonical_url
    ) DESC,
    version.version_number
)
UPDATE event_aliases AS alias
SET primary_ever = TRUE,
    owner_event_version_id = historical.owner_event_version_id
FROM historical_protected AS historical
WHERE historical.alias_type = alias.alias_type
  AND historical.alias_key = alias.alias_key;

-- "Movable" must be proven, not inferred from a failed lookup. Require at
-- least one exact historical source match and no primary/ambiguous match in
-- any version. Orphaned aliases and old canonical forms that cannot be
-- reconstructed remain protected below for manual investigation.
WITH historical_proven_pollution AS (
  SELECT alias.alias_type, alias.alias_key
  FROM event_aliases AS alias
  WHERE alias.alias_type <> 'legacy'
    AND EXISTS (
      SELECT 1
      FROM event_versions AS version
      WHERE version.event_id = alias.event_id
        AND analystarena_event_version_mentions_alias(
          alias.event_id,
          version.id,
          alias.alias_type,
          alias.alias_key,
          alias.canonical_url
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM event_versions AS version
      WHERE version.event_id = alias.event_id
        AND analystarena_event_version_protects_historical_alias(
          alias.event_id,
          version.id,
          alias.alias_type,
          alias.alias_key,
          alias.canonical_url
        )
    )
)
UPDATE event_aliases AS alias
SET primary_ever = FALSE,
    owner_event_version_id = NULL
FROM historical_proven_pollution AS pollution
WHERE pollution.alias_type = alias.alias_type
  AND pollution.alias_key = alias.alias_key;

-- Any remaining NULL row is unknown rather than proven pollution. Anchor it
-- to the earliest immutable version of its current event and fail the
-- migration if that event has no version, instead of silently making it
-- movable.
UPDATE event_aliases AS alias
SET primary_ever = TRUE,
    owner_event_version_id = (
      SELECT version.id
      FROM event_versions AS version
      WHERE version.event_id = alias.event_id
      ORDER BY version.version_number
      LIMIT 1
    )
WHERE alias.primary_ever IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM event_aliases
    WHERE primary_ever IS NULL
       OR (primary_ever AND owner_event_version_id IS NULL)
       OR (NOT primary_ever AND owner_event_version_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'event alias ownership backfill found an alias without an immutable event-version anchor'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE event_aliases
  ALTER COLUMN primary_ever SET DEFAULT FALSE;
ALTER TABLE event_aliases
  ALTER COLUMN primary_ever SET NOT NULL;

ALTER TABLE event_aliases
  DROP CONSTRAINT IF EXISTS event_aliases_owner_version_fk;
ALTER TABLE event_aliases
  ADD CONSTRAINT event_aliases_owner_version_fk
  FOREIGN KEY (event_id, owner_event_version_id)
  REFERENCES event_versions (event_id, id)
  ON DELETE RESTRICT;

ALTER TABLE event_aliases
  DROP CONSTRAINT IF EXISTS event_aliases_primary_owner_shape_ck;
ALTER TABLE event_aliases
  ADD CONSTRAINT event_aliases_primary_owner_shape_ck CHECK (
    (primary_ever AND owner_event_version_id IS NOT NULL)
    OR (NOT primary_ever AND owner_event_version_id IS NULL)
  );

-- URL identity is the SHA-256 digest of the exact canonical URL bytes. This
-- blocks a direct SQL write from pairing another URL's key with a target
-- event's otherwise valid source.
ALTER TABLE event_aliases
  DROP CONSTRAINT IF EXISTS event_aliases_url_key_ck;
ALTER TABLE event_aliases
  ADD CONSTRAINT event_aliases_url_key_ck CHECK (
    alias_type <> 'url'
    OR (
      canonical_url IS NOT NULL
      AND alias_key = encode(
        digest(convert_to(canonical_url, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  );

CREATE TABLE IF NOT EXISTS event_alias_assignment_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alias_type TEXT NOT NULL CHECK (alias_type IN ('document', 'url')),
  alias_key TEXT NOT NULL,
  canonical_url TEXT,
  from_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  to_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  from_owner_event_version_id UUID,
  to_owner_event_version_id UUID NOT NULL,
  previous_first_seen_at TIMESTAMPTZ NOT NULL,
  previous_last_seen_at TIMESTAMPTZ NOT NULL,
  reassigned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason_code TEXT NOT NULL CHECK (reason_code = 'legacy_corrob_alias_cleanup'),
  target_run_id UUID NOT NULL REFERENCES collection_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (from_event_id, from_owner_event_version_id)
    REFERENCES event_versions(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (to_event_id, to_owner_event_version_id)
    REFERENCES event_versions(event_id, id) ON DELETE RESTRICT,
  CHECK (from_event_id <> to_event_id)
);
CREATE INDEX IF NOT EXISTS event_alias_assignment_history_alias_idx
  ON event_alias_assignment_history(alias_type, alias_key, reassigned_at DESC);
CREATE INDEX IF NOT EXISTS event_alias_assignment_history_event_idx
  ON event_alias_assignment_history(from_event_id, to_event_id, reassigned_at DESC);

CREATE OR REPLACE FUNCTION analystarena_guard_alias_assignment()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event alias %:% cannot be deleted; provenance is immutable',
      OLD.alias_type, OLD.alias_key
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.alias_type IS DISTINCT FROM OLD.alias_type
    OR NEW.alias_key IS DISTINCT FROM OLD.alias_key
  ) THEN
    RAISE EXCEPTION 'event alias identity %:% is immutable', OLD.alias_type, OLD.alias_key
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.alias_type = 'legacy' THEN
      RAISE EXCEPTION 'new collector-local legacy aliases are not authoritative'
        USING ERRCODE = '23514';
    END IF;
    IF NOT NEW.primary_ever
       OR NEW.owner_event_version_id IS NULL
       OR NOT analystarena_event_version_owns_alias(
         NEW.event_id,
         NEW.owner_event_version_id,
         NEW.alias_type,
         NEW.alias_key,
         NEW.canonical_url
       ) THEN
      RAISE EXCEPTION 'new event alias %:% lacks exact primary ownership',
        NEW.alias_type, NEW.alias_key
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.alias_type = 'legacy' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'historical legacy alias % is immutable', OLD.alias_key
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Once an alias has been a primary (or was ambiguous before roles existed),
  -- its owner, provenance anchor, canonical identity and first-seen time are
  -- immutable. Only a monotonic last-seen refresh is allowed.
  IF OLD.primary_ever THEN
    IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
      RAISE EXCEPTION 'event alias %:% is a protected historical primary of event %',
        OLD.alias_type, OLD.alias_key, OLD.event_id
        USING ERRCODE = '23505';
    END IF;
    IF NEW.primary_ever IS DISTINCT FROM OLD.primary_ever
       OR NEW.owner_event_version_id IS DISTINCT FROM OLD.owner_event_version_id
       OR NEW.canonical_url IS DISTINCT FROM OLD.canonical_url
       OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.last_seen_at < OLD.last_seen_at THEN
      RAISE EXCEPTION 'protected event alias %:% provenance is immutable',
        OLD.alias_type, OLD.alias_key
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- A still-polluted row may only receive a monotonic sighting update unless
  -- this statement promotes it using an exact primary event version.
  IF NOT NEW.primary_ever THEN
    IF NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.owner_event_version_id IS NOT NULL
       OR NEW.canonical_url IS DISTINCT FROM OLD.canonical_url
       OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.last_seen_at < OLD.last_seen_at THEN
      RAISE EXCEPTION 'corroborating-only alias %:% cannot change without promotion',
        OLD.alias_type, OLD.alias_key
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.owner_event_version_id IS NULL
     OR NOT analystarena_event_version_owns_alias(
       NEW.event_id,
       NEW.owner_event_version_id,
       NEW.alias_type,
       NEW.alias_key,
       NEW.canonical_url
     ) THEN
    RAISE EXCEPTION 'event alias %:% cannot be promoted without exact target primary ownership',
      OLD.alias_type, OLD.alias_key
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_id IS NOT DISTINCT FROM OLD.event_id THEN
    IF NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.last_seen_at < OLD.last_seen_at THEN
      RAISE EXCEPTION 'same-event alias promotion cannot rewrite observation history'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.first_seen_at IS DISTINCT FROM NEW.last_seen_at THEN
    RAISE EXCEPTION 'reassigned alias must start a new owner observation interval'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION analystarena_audit_alias_reassignment()
RETURNS TRIGGER AS $$
DECLARE
  target_run UUID;
BEGIN
  IF NEW.event_id IS NOT DISTINCT FROM OLD.event_id THEN
    RETURN NEW;
  END IF;

  SELECT version.run_id
  INTO STRICT target_run
  FROM event_versions AS version
  WHERE version.event_id = NEW.event_id
    AND version.id = NEW.owner_event_version_id;

  INSERT INTO event_alias_assignment_history (
    alias_type,
    alias_key,
    canonical_url,
    from_event_id,
    to_event_id,
    from_owner_event_version_id,
    to_owner_event_version_id,
    previous_first_seen_at,
    previous_last_seen_at,
    reason_code,
    target_run_id
  ) VALUES (
    OLD.alias_type,
    OLD.alias_key,
    OLD.canonical_url,
    OLD.event_id,
    NEW.event_id,
    OLD.owner_event_version_id,
    NEW.owner_event_version_id,
    OLD.first_seen_at,
    OLD.last_seen_at,
    'legacy_corrob_alias_cleanup',
    target_run
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_aliases_no_reassignment ON event_aliases;
DROP TRIGGER IF EXISTS event_aliases_guard_assignment ON event_aliases;
CREATE TRIGGER event_aliases_guard_assignment
  BEFORE INSERT OR UPDATE OR DELETE ON event_aliases
  FOR EACH ROW EXECUTE FUNCTION analystarena_guard_alias_assignment();

DROP TRIGGER IF EXISTS event_aliases_no_truncate ON event_aliases;
CREATE TRIGGER event_aliases_no_truncate
  BEFORE TRUNCATE ON event_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_aliases_audit_reassignment ON event_aliases;
CREATE TRIGGER event_aliases_audit_reassignment
  AFTER UPDATE OF event_id ON event_aliases
  FOR EACH ROW
  WHEN (OLD.event_id IS DISTINCT FROM NEW.event_id)
  EXECUTE FUNCTION analystarena_audit_alias_reassignment();

DROP TRIGGER IF EXISTS event_alias_assignment_history_immutable
  ON event_alias_assignment_history;
CREATE TRIGGER event_alias_assignment_history_immutable
  BEFORE UPDATE OR DELETE ON event_alias_assignment_history
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_alias_assignment_history_no_truncate
  ON event_alias_assignment_history;
CREATE TRIGGER event_alias_assignment_history_no_truncate
  BEFORE TRUNCATE ON event_alias_assignment_history
  FOR EACH STATEMENT EXECUTE FUNCTION analystarena_reject_history_change();
