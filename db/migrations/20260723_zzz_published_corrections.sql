-- 7/23: publication corrections without rewriting a frozen report.
--
-- A date may have one editable draft and one current publication. Replacing a
-- publication is a state transition, not an UPDATE of its payload/PDF/audit:
--
--   old published --(atomic publish)--> old superseded -> new published
--
-- Historical rows remain addressable to administrators and continue to point
-- at their original snapshot and publication audit.

DROP TRIGGER IF EXISTS daily_briefs_preserve_publication_authority
  ON daily_briefs;

ALTER TABLE daily_briefs
  DROP CONSTRAINT IF EXISTS daily_briefs_brief_date_key,
  DROP CONSTRAINT IF EXISTS daily_briefs_status_check,
  DROP CONSTRAINT IF EXISTS daily_briefs_superseded_pointer_ck,
  DROP CONSTRAINT IF EXISTS daily_briefs_correction_not_self_ck,
  DROP CONSTRAINT IF EXISTS daily_briefs_replacement_not_self_ck,
  DROP CONSTRAINT IF EXISTS daily_briefs_supersedes_fk,
  DROP CONSTRAINT IF EXISTS daily_briefs_superseded_by_fk;

ALTER TABLE daily_briefs
  ADD COLUMN IF NOT EXISTS supersedes_id UUID,
  ADD COLUMN IF NOT EXISTS superseded_by_id UUID;

ALTER TABLE daily_briefs
  ADD CONSTRAINT daily_briefs_status_check
    CHECK (status IN ('draft', 'published', 'superseded')),
  ADD CONSTRAINT daily_briefs_superseded_pointer_ck CHECK (
    (status = 'superseded') = (superseded_by_id IS NOT NULL)
  ),
  ADD CONSTRAINT daily_briefs_correction_not_self_ck CHECK (
    supersedes_id IS NULL OR supersedes_id <> id
  ),
  ADD CONSTRAINT daily_briefs_replacement_not_self_ck CHECK (
    superseded_by_id IS NULL OR superseded_by_id <> id
  ),
  ADD CONSTRAINT daily_briefs_supersedes_fk
    FOREIGN KEY (supersedes_id) REFERENCES daily_briefs(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT daily_briefs_superseded_by_fk
    FOREIGN KEY (superseded_by_id) REFERENCES daily_briefs(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX IF NOT EXISTS daily_briefs_one_draft_per_date_uq
  ON daily_briefs (brief_date)
  WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS daily_briefs_one_current_publication_per_date_uq
  ON daily_briefs (brief_date)
  WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS daily_briefs_one_successor_uq
  ON daily_briefs (supersedes_id)
  WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS daily_briefs_one_predecessor_uq
  ON daily_briefs (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS daily_briefs_publication_history_idx
  ON daily_briefs (brief_date DESC, published_at DESC)
  WHERE status IN ('published', 'superseded');

-- Validate both sides of the replacement chain at transaction end. This lets
-- publication free the old partial-unique slot before promoting the new row,
-- while never exposing a committed half-transition.
CREATE OR REPLACE FUNCTION analystarena_validate_daily_brief_correction_chain()
RETURNS TRIGGER AS $$
DECLARE
  predecessor_date DATE;
  predecessor_status TEXT;
  predecessor_published_at TIMESTAMPTZ;
  predecessor_superseded_by UUID;
  successor_date DATE;
  successor_status TEXT;
  successor_published_at TIMESTAMPTZ;
  successor_supersedes UUID;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT brief_date, status, published_at, superseded_by_id
      INTO predecessor_date, predecessor_status, predecessor_published_at,
        predecessor_superseded_by
    FROM daily_briefs
    WHERE id = NEW.supersedes_id;

    IF predecessor_date IS NULL
       OR predecessor_date IS DISTINCT FROM NEW.brief_date
       OR predecessor_published_at IS NULL THEN
      RAISE EXCEPTION 'correction % must reference a published predecessor on the same brief date',
        NEW.id
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'draft' THEN
      IF predecessor_status IS DISTINCT FROM 'published'
         OR predecessor_superseded_by IS NOT NULL
         OR NEW.published_at IS NOT NULL THEN
        RAISE EXCEPTION 'draft correction % must target the current same-date publication',
          NEW.id
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF predecessor_status IS DISTINCT FROM 'superseded'
         OR predecessor_superseded_by IS DISTINCT FROM NEW.id
         OR NEW.published_at IS NULL
         OR NEW.published_at <= predecessor_published_at THEN
        RAISE EXCEPTION 'published correction % must atomically supersede its predecessor',
          NEW.id
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.superseded_by_id IS NOT NULL THEN
    SELECT brief_date, status, published_at, supersedes_id
      INTO successor_date, successor_status, successor_published_at,
        successor_supersedes
    FROM daily_briefs
    WHERE id = NEW.superseded_by_id;

    IF successor_date IS NULL
       OR successor_date IS DISTINCT FROM NEW.brief_date
       OR successor_status NOT IN ('published', 'superseded')
       OR successor_supersedes IS DISTINCT FROM NEW.id
       OR NEW.published_at IS NULL
       OR successor_published_at IS NULL
       OR successor_published_at <= NEW.published_at THEN
      RAISE EXCEPTION 'superseded brief % must point to its exact newer publication',
        NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS daily_briefs_validate_correction_chain
  ON daily_briefs;
DROP TRIGGER IF EXISTS daily_briefs_validate_correction_chain_insert
  ON daily_briefs;
DROP TRIGGER IF EXISTS daily_briefs_validate_correction_chain_update
  ON daily_briefs;
CREATE CONSTRAINT TRIGGER daily_briefs_validate_correction_chain_insert
  AFTER INSERT ON daily_briefs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION analystarena_validate_daily_brief_correction_chain();
CREATE CONSTRAINT TRIGGER daily_briefs_validate_correction_chain_update
  AFTER UPDATE ON daily_briefs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.brief_date IS DISTINCT FROM NEW.brief_date
    OR OLD.published_at IS DISTINCT FROM NEW.published_at
    OR OLD.supersedes_id IS DISTINCT FROM NEW.supersedes_id
    OR OLD.superseded_by_id IS DISTINCT FROM NEW.superseded_by_id
  )
  EXECUTE FUNCTION analystarena_validate_daily_brief_correction_chain();

-- Published and superseded rows share the same immutable publication
-- authority. The sole permitted lifecycle mutation is published -> superseded
-- plus one forward pointer; snapshot, payload, PDF, publication time and
-- predecessor pointer remain frozen.
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
BEGIN
  IF OLD.status NOT IN ('published', 'superseded') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT snapshot_id, snapshot_payload_hash, pdf_sha256, published_at
    INTO audit_snapshot_id, audit_snapshot_payload_hash, audit_pdf_sha256,
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
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR (
       OLD.status = 'published'
       AND NOT (
         (NEW.status = 'published'
          AND NEW.superseded_by_id IS NOT DISTINCT FROM OLD.superseded_by_id)
         OR
         (NEW.status = 'superseded'
          AND OLD.superseded_by_id IS NULL
          AND NEW.superseded_by_id IS NOT NULL)
       )
     )
     OR (
       OLD.status = 'superseded'
       AND (
         NEW.status IS DISTINCT FROM 'superseded'
         OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
       )
     ) THEN
    RAISE EXCEPTION 'published brief % cannot diverge from its immutable publication audit',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_briefs_preserve_publication_authority
  BEFORE UPDATE OR DELETE ON daily_briefs
  FOR EACH ROW EXECUTE FUNCTION analystarena_preserve_publication_authority();
