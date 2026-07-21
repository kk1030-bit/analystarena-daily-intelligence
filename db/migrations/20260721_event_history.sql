CREATE TABLE IF NOT EXISTS collection_runs (
  id UUID PRIMARY KEY,
  stream TEXT NOT NULL CHECK (stream IN (
    'shared', 'manual', 'privileged', 'cron', 'generate',
    'review', 'publish', 'legacy', 'unspecified'
  )),
  batch_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  brief_date DATE NOT NULL,
  input_hash TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stream, batch_key)
);
CREATE INDEX IF NOT EXISTS collection_runs_date_started_idx
  ON collection_runs (brief_date DESC, started_at DESC);
CREATE INDEX IF NOT EXISTS collection_runs_status_started_idx
  ON collection_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  native_id TEXT,
  canonical_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('Official', 'News', 'Reddit', 'X')),
  published_at TIMESTAMPTZ NOT NULL,
  timestamp_kind TEXT NOT NULL CHECK (timestamp_kind IN ('published', 'collected')),
  first_collected_at TIMESTAMPTZ NOT NULL,
  last_collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (last_collected_at >= first_collected_at)
);
CREATE INDEX IF NOT EXISTS source_documents_last_collected_idx
  ON source_documents (last_collected_at DESC);
CREATE INDEX IF NOT EXISTS source_documents_type_published_idx
  ON source_documents (source_type, published_at DESC);

CREATE TABLE IF NOT EXISTS source_document_versions (
  id UUID PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  previous_version_id UUID,
  content_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_document_id, version_number),
  UNIQUE (source_document_id, id)
);
CREATE INDEX IF NOT EXISTS source_document_versions_document_created_idx
  ON source_document_versions (source_document_id, version_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS source_document_versions_transition_idx
  ON source_document_versions (
    source_document_id,
    COALESCE(previous_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    content_hash
  );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_document_versions_previous_same_document_fk'
      AND conrelid = 'source_document_versions'::regclass
  ) THEN
    ALTER TABLE source_document_versions
      ADD CONSTRAINT source_document_versions_previous_same_document_fk
      FOREIGN KEY (source_document_id, previous_version_id)
      REFERENCES source_document_versions (source_document_id, id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  canonical_title TEXT NOT NULL,
  category TEXT NOT NULL,
  ticker TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  identity_quality TEXT NOT NULL CHECK (identity_quality IN (
    'source_alias', 'semantic_high', 'new', 'legacy_unmatched'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS events_last_seen_idx ON events (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS events_ticker_last_seen_idx ON events (ticker, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS event_aliases (
  alias_type TEXT NOT NULL CHECK (alias_type IN ('document', 'url', 'legacy')),
  alias_key TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  canonical_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alias_type, alias_key),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS event_aliases_event_idx ON event_aliases (event_id);

CREATE TABLE IF NOT EXISTS event_versions (
  id UUID PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  previous_version_id UUID,
  content_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  presentation_hash TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  run_id UUID NOT NULL REFERENCES collection_runs(id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, version_number),
  UNIQUE (event_id, id)
);
CREATE INDEX IF NOT EXISTS event_versions_event_created_idx
  ON event_versions (event_id, version_number DESC);
CREATE INDEX IF NOT EXISTS event_versions_observed_idx
  ON event_versions (observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS event_versions_transition_idx
  ON event_versions (
    event_id,
    COALESCE(previous_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    content_hash
  );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_versions_previous_same_event_fk'
      AND conrelid = 'event_versions'::regclass
  ) THEN
    ALTER TABLE event_versions
      ADD CONSTRAINT event_versions_previous_same_event_fk
      FOREIGN KEY (event_id, previous_version_id)
      REFERENCES event_versions (event_id, id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS brief_snapshots (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES collection_runs(id) ON DELETE RESTRICT,
  stream TEXT NOT NULL,
  batch_key TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  brief_date DATE NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  previous_snapshot_id UUID REFERENCES brief_snapshots(id) ON DELETE SET NULL,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stream, batch_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS brief_snapshots_date_sequence_idx
  ON brief_snapshots (brief_date, sequence_number);
CREATE INDEX IF NOT EXISTS brief_snapshots_date_created_idx
  ON brief_snapshots (brief_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS brief_snapshots_previous_idx
  ON brief_snapshots (previous_snapshot_id);

CREATE TABLE IF NOT EXISTS brief_snapshot_events (
  snapshot_id UUID NOT NULL REFERENCES brief_snapshots(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  event_version_id UUID NOT NULL,
  rank INTEGER NOT NULL CHECK (rank > 0),
  ranking_score NUMERIC,
  freshness_score NUMERIC,
  impact INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  mentions INTEGER NOT NULL,
  cross_source_count INTEGER,
  match_method TEXT NOT NULL CHECK (match_method IN (
    'existing_id', 'source_alias', 'semantic_high', 'new', 'legacy'
  )),
  match_confidence NUMERIC NOT NULL CHECK (match_confidence >= 0 AND match_confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (snapshot_id, event_id),
  FOREIGN KEY (event_id, event_version_id)
    REFERENCES event_versions (event_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS brief_snapshot_events_event_idx
  ON brief_snapshot_events (event_id, snapshot_id);

-- Backfill each existing daily brief as a frozen legacy snapshot. Existing
-- published payloads and PDF bytes remain untouched.
INSERT INTO collection_runs (
  id, stream, batch_key, status, brief_date, input_hash, started_at, completed_at
)
SELECT id, 'legacy', 'daily-brief:' || id::text, 'success', brief_date,
       'legacy-md5:' || md5(payload::text), created_at, updated_at
FROM daily_briefs
ON CONFLICT (stream, batch_key) DO NOTHING;

INSERT INTO events (
  id, stable_key, canonical_title, category, ticker,
  first_seen_at, last_seen_at, identity_quality
)
SELECT
  'evt_legacy_' || md5(brief.id::text || ':' || item.ordinality::text),
  'legacy:' || md5(brief.id::text || ':' || item.ordinality::text),
  COALESCE(NULLIF(item.headline->>'title', ''), 'Legacy event'),
  COALESCE(NULLIF(item.headline->>'category', ''), 'Other'),
  COALESCE(NULLIF(item.headline->>'ticker', ''), 'UNKNOWN'),
  brief.created_at,
  brief.updated_at,
  'legacy_unmatched'
FROM daily_briefs AS brief
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(brief.payload->'headlines', '[]'::jsonb))
  WITH ORDINALITY AS item(headline, ordinality)
ON CONFLICT (stable_key) DO NOTHING;

INSERT INTO event_versions (
  id, event_id, version_number, previous_version_id,
  content_hash, evidence_hash, state_hash, presentation_hash,
  observed_at, run_id, payload
)
SELECT
  (
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 1, 8) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 9, 4) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 13, 4) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 17, 4) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 21, 12)
  )::uuid,
  'evt_legacy_' || md5(brief.id::text || ':' || item.ordinality::text),
  1,
  NULL,
  'legacy-md5:' || md5(item.headline::text),
  'legacy-md5:' || md5(COALESCE((item.headline->'sources')::text, '[]')),
  'legacy-md5:' || md5(jsonb_build_object(
    'ticker', item.headline->'ticker',
    'category', item.headline->'category',
    'marketDirection', item.headline->'marketDirection',
    'equityImpacts', item.headline->'equityImpacts'
  )::text),
  'legacy-md5:' || md5(jsonb_build_object(
    'title', item.headline->'title',
    'summary', item.headline->'summary',
    'keyPoints', item.headline->'keyPoints'
  )::text),
  brief.updated_at,
  brief.id,
  jsonb_build_object(
    'headline', jsonb_set(
      item.headline,
      '{id}',
      to_jsonb('evt_legacy_' || md5(brief.id::text || ':' || item.ordinality::text))
    )
  )
FROM daily_briefs AS brief
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(brief.payload->'headlines', '[]'::jsonb))
  WITH ORDINALITY AS item(headline, ordinality)
ON CONFLICT (event_id, version_number) DO NOTHING;

INSERT INTO brief_snapshots (
  id, run_id, stream, batch_key, sequence_number, brief_date, generated_at,
  previous_snapshot_id, payload_hash, payload, created_at
)
SELECT
  brief.id,
  brief.id,
  'legacy',
  'daily-brief:' || brief.id::text,
  1,
  brief.brief_date,
  brief.updated_at,
  NULL,
  'legacy-md5:' || md5(brief.payload::text),
  jsonb_set(
    brief.payload,
    '{headlines}',
    COALESCE((
      SELECT jsonb_agg(
        jsonb_set(
          item.headline,
          '{id}',
          to_jsonb('evt_legacy_' || md5(brief.id::text || ':' || item.ordinality::text))
        ) ORDER BY item.ordinality
      )
      FROM jsonb_array_elements(COALESCE(brief.payload->'headlines', '[]'::jsonb))
        WITH ORDINALITY AS item(headline, ordinality)
    ), '[]'::jsonb)
  ),
  brief.updated_at
FROM daily_briefs AS brief
ON CONFLICT (stream, batch_key) DO NOTHING;

INSERT INTO brief_snapshot_events (
  snapshot_id, event_id, event_version_id, rank, ranking_score,
  freshness_score, impact, confidence, mentions, cross_source_count,
  match_method, match_confidence
)
SELECT
  brief.id,
  'evt_legacy_' || md5(brief.id::text || ':' || item.ordinality::text),
  (
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 1, 8) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 9, 4) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 13, 4) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 17, 4) || '-' ||
    substr(md5('legacy-version:' || brief.id::text || ':' || item.ordinality::text), 21, 12)
  )::uuid,
  COALESCE((item.headline->>'rank')::integer, item.ordinality::integer),
  NULLIF(item.headline->>'rankingScore', '')::numeric,
  NULLIF(item.headline->>'freshnessScore', '')::numeric,
  COALESCE((item.headline->>'impact')::integer, 1),
  COALESCE((item.headline->>'confidence')::integer, 1),
  COALESCE((item.headline->>'mentions')::integer, 0),
  NULLIF(item.headline->>'crossSourceCount', '')::integer,
  'legacy',
  1
FROM daily_briefs AS brief
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(brief.payload->'headlines', '[]'::jsonb))
  WITH ORDINALITY AS item(headline, ordinality)
ON CONFLICT (snapshot_id, event_id) DO NOTHING;

CREATE OR REPLACE FUNCTION analystarena_reject_history_change()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; create a new version or snapshot instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_document_versions_immutable ON source_document_versions;
CREATE TRIGGER source_document_versions_immutable
  BEFORE UPDATE OR DELETE ON source_document_versions
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_versions_immutable ON event_versions;
CREATE TRIGGER event_versions_immutable
  BEFORE UPDATE OR DELETE ON event_versions
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS brief_snapshots_immutable ON brief_snapshots;
CREATE TRIGGER brief_snapshots_immutable
  BEFORE UPDATE OR DELETE ON brief_snapshots
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS brief_snapshot_events_immutable ON brief_snapshot_events;
CREATE TRIGGER brief_snapshot_events_immutable
  BEFORE UPDATE OR DELETE ON brief_snapshot_events
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

CREATE OR REPLACE FUNCTION analystarena_prevent_alias_reassignment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'event alias %:% is already assigned to event %', OLD.alias_type, OLD.alias_key, OLD.event_id
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_aliases_no_reassignment ON event_aliases;
CREATE TRIGGER event_aliases_no_reassignment
  BEFORE UPDATE ON event_aliases
  FOR EACH ROW EXECUTE FUNCTION analystarena_prevent_alias_reassignment();
