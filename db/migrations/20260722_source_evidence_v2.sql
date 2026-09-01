-- 2026-07-22 v2: source provenance, exact evidence and claim-to-evidence links.
-- The v2 filename is intentional: a database that recorded an earlier draft
-- as `20260722_source_evidence.sql` must still execute this finalized schema.
--
-- This migration deliberately does not infer quotations or locators for legacy
-- data. Historical source versions receive an honest provenance envelope and
-- historical event text becomes legacy_unverified claims only.

ALTER TABLE source_documents
  ADD COLUMN IF NOT EXISTS original_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at_raw TEXT,
  ADD COLUMN IF NOT EXISTS published_at_field TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_documents_published_raw_nonblank_ck'
      AND conrelid = 'source_documents'::regclass
  ) THEN
    ALTER TABLE source_documents
      ADD CONSTRAINT source_documents_published_raw_nonblank_ck
      CHECK (published_at_raw IS NULL OR btrim(published_at_raw) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_documents_published_field_nonblank_ck'
      AND conrelid = 'source_documents'::regclass
  ) THEN
    ALTER TABLE source_documents
      ADD CONSTRAINT source_documents_published_field_nonblank_ck
      CHECK (published_at_field IS NULL OR btrim(published_at_field) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_documents_time_consistency_ck'
      AND conrelid = 'source_documents'::regclass
  ) THEN
    ALTER TABLE source_documents
      ADD CONSTRAINT source_documents_time_consistency_ck CHECK (
        (
          timestamp_kind = 'published'
          AND original_published_at IS NOT NULL
          AND published_at = original_published_at
        )
        OR (
          timestamp_kind = 'collected'
          AND original_published_at IS NULL
          AND published_at = last_collected_at
        )
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_document_versions_exact_content_uk'
      AND conrelid = 'source_document_versions'::regclass
  ) THEN
    ALTER TABLE source_document_versions
      ADD CONSTRAINT source_document_versions_exact_content_uk
      UNIQUE (source_document_id, id, content_hash);
  END IF;
END $$;

-- Freeze the legacy population once. A manual rerun at a later date must not
-- relabel newly-created, citation-aware rows as legacy data.
CREATE TABLE IF NOT EXISTS source_evidence_backfill_boundaries (
  migration_id TEXT PRIMARY KEY,
  cutoff_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (btrim(migration_id) <> '')
);
INSERT INTO source_evidence_backfill_boundaries (migration_id, cutoff_at)
VALUES ('20260722_source_evidence', clock_timestamp())
ON CONFLICT (migration_id) DO NOTHING;

-- One immutable provenance record per exact source-document version. The
-- mutable source_documents row is a registry; this table is the audit record.
CREATE TABLE IF NOT EXISTS source_version_provenance (
  source_document_version_id UUID PRIMARY KEY,
  source_document_id TEXT NOT NULL,
  native_id TEXT,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('Official', 'News', 'Reddit', 'X')),
  timestamp_kind TEXT NOT NULL CHECK (timestamp_kind IN ('published', 'collected')),
  canonical_url TEXT NOT NULL,
  raw_url TEXT,
  final_url TEXT,
  feed_url TEXT,
  mime_type TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  original_published_at TIMESTAMPTZ,
  published_at_raw TEXT,
  published_at_field TEXT,
  source_updated_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL,
  capture_scope TEXT NOT NULL CHECK (capture_scope IN (
    'rss_entry', 'atom_entry', 'detail_page', 'reddit_post',
    'x_post', 'pdf', 'legacy_metadata'
  )),
  captured_content_hash TEXT NOT NULL,
  captured_artifact TEXT,
  captured_artifact_encoding TEXT CHECK (
    captured_artifact_encoding IS NULL OR captured_artifact_encoding = 'utf8'
  ),
  captured_artifact_size_bytes INTEGER CHECK (
    captured_artifact_size_bytes IS NULL OR captured_artifact_size_bytes >= 0
  ),
  captured_text_hash TEXT,
  extraction_method TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  backfill_quality TEXT NOT NULL CHECK (backfill_quality IN (
    'native', 'exact_legacy_metadata', 'unverified_legacy'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT source_version_provenance_exact_version_uk
    UNIQUE (source_document_id, source_document_version_id),
  CONSTRAINT source_version_provenance_source_version_fk
  FOREIGN KEY (source_document_id, source_document_version_id)
    REFERENCES source_document_versions (source_document_id, id) ON DELETE RESTRICT,
  CONSTRAINT source_version_provenance_content_hash_fk
  FOREIGN KEY (source_document_id, source_document_version_id, captured_content_hash)
    REFERENCES source_document_versions (source_document_id, id, content_hash)
    ON DELETE RESTRICT,
  CHECK (btrim(source_name) <> ''),
  CHECK (btrim(canonical_url) <> ''),
  CHECK (final_url IS NULL OR btrim(final_url) <> ''),
  CHECK (raw_url IS NULL OR btrim(raw_url) <> ''),
  CHECK (feed_url IS NULL OR btrim(feed_url) <> ''),
  CHECK (mime_type IS NULL OR btrim(mime_type) <> ''),
  CHECK (published_at_raw IS NULL OR btrim(published_at_raw) <> ''),
  CHECK (published_at_field IS NULL OR btrim(published_at_field) <> ''),
  CHECK (btrim(captured_content_hash) <> ''),
  CONSTRAINT source_version_provenance_artifact_shape_ck CHECK (
    (captured_artifact IS NULL AND captured_artifact_encoding IS NULL AND captured_artifact_size_bytes IS NULL)
    OR (
      captured_artifact IS NOT NULL
      AND captured_artifact_encoding = 'utf8'
      AND captured_artifact_size_bytes = octet_length(captured_artifact)
    )
  ),
  CONSTRAINT source_version_provenance_native_artifact_ck
    CHECK (backfill_quality <> 'native' OR captured_artifact IS NOT NULL),
  CONSTRAINT source_version_provenance_native_time_consistency_ck CHECK (
    backfill_quality <> 'native'
    OR (
      timestamp_kind = 'published'
      AND original_published_at IS NOT NULL
    )
    OR (
      timestamp_kind = 'collected'
      AND original_published_at IS NULL
    )
  ),
  CHECK (captured_text_hash IS NULL OR btrim(captured_text_hash) <> ''),
  CHECK (btrim(extraction_method) <> ''),
  CHECK (btrim(extractor_version) <> '')
);

-- Upgrade compatibility for databases that recorded an earlier 7/22 draft
-- under the non-v2 migration filename. CREATE TABLE IF NOT EXISTS does not add
-- columns to that draft, so add every finalized raw-artifact field explicitly.
ALTER TABLE source_version_provenance
  ADD COLUMN IF NOT EXISTS captured_artifact TEXT,
  ADD COLUMN IF NOT EXISTS captured_artifact_encoding TEXT,
  ADD COLUMN IF NOT EXISTS captured_artifact_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS captured_text_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_version_provenance_exact_version_uk'
      AND conrelid = 'source_version_provenance'::regclass
  ) THEN
    ALTER TABLE source_version_provenance
      ADD CONSTRAINT source_version_provenance_exact_version_uk
      UNIQUE (source_document_id, source_document_version_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_version_provenance_source_version_fk'
      AND conrelid = 'source_version_provenance'::regclass
  ) THEN
    ALTER TABLE source_version_provenance
      ADD CONSTRAINT source_version_provenance_source_version_fk
      FOREIGN KEY (source_document_id, source_document_version_id)
      REFERENCES source_document_versions (source_document_id, id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_version_provenance_content_hash_fk'
      AND conrelid = 'source_version_provenance'::regclass
  ) THEN
    ALTER TABLE source_version_provenance
      ADD CONSTRAINT source_version_provenance_content_hash_fk
      FOREIGN KEY (source_document_id, source_document_version_id, captured_content_hash)
      REFERENCES source_document_versions (source_document_id, id, content_hash)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_version_provenance_artifact_shape_ck'
      AND conrelid = 'source_version_provenance'::regclass
  ) THEN
    ALTER TABLE source_version_provenance
      ADD CONSTRAINT source_version_provenance_artifact_shape_ck CHECK (
        (
          captured_artifact IS NULL
          AND captured_artifact_encoding IS NULL
          AND captured_artifact_size_bytes IS NULL
        )
        OR (
          captured_artifact IS NOT NULL
          AND captured_artifact_encoding = 'utf8'
          AND captured_artifact_size_bytes = octet_length(captured_artifact)
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_version_provenance_native_artifact_ck'
      AND conrelid = 'source_version_provenance'::regclass
  ) THEN
    ALTER TABLE source_version_provenance
      ADD CONSTRAINT source_version_provenance_native_artifact_ck
      CHECK (backfill_quality <> 'native' OR captured_artifact IS NOT NULL)
      NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS source_version_provenance_published_idx
  ON source_version_provenance (original_published_at DESC)
  WHERE original_published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_version_provenance_collected_idx
  ON source_version_provenance (collected_at DESC);
CREATE INDEX IF NOT EXISTS source_version_provenance_final_url_idx
  ON source_version_provenance (final_url)
  WHERE final_url IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_version_provenance_native_time_consistency_ck'
      AND conrelid = 'source_version_provenance'::regclass
  ) THEN
    ALTER TABLE source_version_provenance
      ADD CONSTRAINT source_version_provenance_native_time_consistency_ck CHECK (
        backfill_quality <> 'native'
        OR (
          timestamp_kind = 'published'
          AND original_published_at IS NOT NULL
        )
        OR (
          timestamp_kind = 'collected'
          AND original_published_at IS NULL
        )
      ) NOT VALID;
  END IF;
END $$;

-- Every collection is an immutable observation even when the captured content
-- reuses an existing source version. This keeps collection time and channel
-- metadata auditable without manufacturing a new content revision.
CREATE TABLE IF NOT EXISTS source_collection_observations (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL,
  source_document_version_id UUID NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('Official', 'News', 'Reddit', 'X')),
  collected_at TIMESTAMPTZ NOT NULL,
  raw_url TEXT NOT NULL,
  final_url TEXT,
  feed_url TEXT,
  mime_type TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  capture_scope TEXT NOT NULL CHECK (capture_scope IN (
    'rss_entry', 'atom_entry', 'detail_page', 'reddit_post',
    'x_post', 'pdf', 'legacy_metadata'
  )),
  captured_content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_document_id, source_document_version_id, id),
  FOREIGN KEY (source_document_id, source_document_version_id)
    REFERENCES source_version_provenance (source_document_id, source_document_version_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, source_document_version_id, captured_content_hash)
    REFERENCES source_document_versions (source_document_id, id, content_hash)
    ON DELETE RESTRICT,
  CHECK (btrim(id) <> ''),
  CHECK (btrim(source_name) <> ''),
  CHECK (btrim(raw_url) <> ''),
  CHECK (final_url IS NULL OR btrim(final_url) <> ''),
  CHECK (feed_url IS NULL OR btrim(feed_url) <> ''),
  CHECK (mime_type IS NULL OR btrim(mime_type) <> '')
);
CREATE INDEX IF NOT EXISTS source_collection_observations_document_idx
  ON source_collection_observations (source_document_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS source_collection_observations_collected_idx
  ON source_collection_observations (collected_at DESC);

-- A stable evidence item identifies one durable source anchor. Changes to the
-- captured quote, locator or source version create evidence_versions below.
CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE RESTRICT,
  anchor_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_document_id, id),
  UNIQUE (source_document_id, anchor_key),
  CHECK (btrim(id) <> ''),
  CHECK (btrim(anchor_key) <> '')
);
CREATE INDEX IF NOT EXISTS evidence_items_document_idx
  ON evidence_items (source_document_id, created_at);

-- material_hash is the application SHA-256 over the exact
-- source_document_version_id, quote_original_hash, locator_hash,
-- availability_status, directness, capture_scope, extraction_method and
-- extractor_version. quote_zh_cn is intentionally excluded: presentation
-- translation must not create or fork evidence identity.
CREATE TABLE IF NOT EXISTS evidence_versions (
  id UUID PRIMARY KEY,
  evidence_item_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_document_version_id UUID NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  previous_version_id UUID,
  material_hash TEXT NOT NULL,
  quote_original TEXT,
  quote_original_hash TEXT,
  quote_language TEXT,
  quote_zh_cn TEXT,
  locator JSONB NOT NULL,
  locator_hash TEXT NOT NULL,
  locator_kind TEXT NOT NULL CHECK (locator_kind IN (
    'feed_field', 'html_text_quote', 'reddit_post_field',
    'x_post_field', 'pdf_text', 'unavailable'
  )),
  locator_status TEXT NOT NULL CHECK (locator_status IN ('exact', 'derived', 'unavailable')),
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'unavailable')),
  directness TEXT NOT NULL CHECK (directness IN ('direct', 'indirect', 'derived', 'unavailable')),
  capture_scope TEXT NOT NULL CHECK (capture_scope IN (
    'rss_entry', 'atom_entry', 'detail_page', 'reddit_post',
    'x_post', 'pdf', 'legacy_metadata'
  )),
  extraction_method TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  extraction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  unavailable_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (evidence_item_id, version_number),
  UNIQUE (evidence_item_id, id),
  UNIQUE (source_document_id, evidence_item_id, id),
  UNIQUE (source_document_id, source_document_version_id, evidence_item_id, id),
  UNIQUE (source_document_id, source_document_version_id, evidence_item_id, id, directness),
  FOREIGN KEY (source_document_id, evidence_item_id)
    REFERENCES evidence_items (source_document_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, source_document_version_id)
    REFERENCES source_document_versions (source_document_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, source_document_version_id)
    REFERENCES source_version_provenance (source_document_id, source_document_version_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, evidence_item_id, previous_version_id)
    REFERENCES evidence_versions (source_document_id, evidence_item_id, id)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT evidence_versions_chain_shape_ck CHECK (
    (version_number = 1 AND previous_version_id IS NULL)
    OR (version_number > 1 AND previous_version_id IS NOT NULL)
  ),
  CONSTRAINT evidence_versions_material_hash_ck CHECK (material_hash ~ '^[0-9a-f]{64}$'),
  CHECK (quote_original IS NULL OR btrim(quote_original) <> ''),
  CONSTRAINT evidence_versions_quote_hash_ck CHECK (
    quote_original_hash IS NULL OR quote_original_hash ~ '^[0-9a-f]{64}$'
  ),
  CHECK (quote_language IS NULL OR btrim(quote_language) <> ''),
  CHECK (quote_zh_cn IS NULL OR btrim(quote_zh_cn) <> ''),
  CONSTRAINT evidence_versions_locator_object_ck CHECK (jsonb_typeof(locator) = 'object'),
  CONSTRAINT evidence_versions_locator_kind_ck CHECK (
    locator ? 'kind' AND locator->>'kind' = locator_kind
  ),
  CONSTRAINT evidence_versions_locator_payload_ck CHECK (
    CASE locator_kind
      WHEN 'feed_field' THEN
        jsonb_typeof(locator->'feedUrl') = 'string'
        AND btrim(locator->>'feedUrl') <> ''
        AND locator->>'feedUrl' ~* '^https?://'
        AND (
          NOT (locator ? 'entryId')
          OR (jsonb_typeof(locator->'entryId') = 'string' AND btrim(locator->>'entryId') <> '')
        )
        AND locator->>'field' IN ('title', 'description', 'summary', 'content')
        AND jsonb_typeof(locator->'fieldPath') = 'string'
        AND btrim(locator->>'fieldPath') <> ''
      WHEN 'html_text_quote' THEN
        jsonb_typeof(locator->'pageUrl') = 'string'
        AND btrim(locator->>'pageUrl') <> ''
        AND locator->>'pageUrl' ~* '^https?://'
        AND jsonb_typeof(locator->'textQuote') = 'object'
        AND jsonb_typeof(locator#>'{textQuote,exact}') = 'string'
        AND btrim(locator#>>'{textQuote,exact}') <> ''
        AND locator#>>'{textQuote,exact}' = quote_original
        AND (
          (NOT (locator ? 'blockIndex') AND NOT (locator ? 'blockIndexBasis'))
          OR (
            jsonb_typeof(locator->'blockIndex') = 'number'
            AND locator->>'blockIndex' ~ '^[0-9]+$'
            AND locator->>'blockIndexBasis' = 'normalized_content_blocks'
          )
        )
      WHEN 'reddit_post_field' THEN
        jsonb_typeof(locator->'postId') = 'string'
        AND btrim(locator->>'postId') <> ''
        AND locator->>'field' IN ('title', 'body')
      WHEN 'x_post_field' THEN
        jsonb_typeof(locator->'statusId') = 'string'
        AND locator->>'statusId' ~ '^[0-9]+$'
        AND locator->>'field' = 'text'
      WHEN 'pdf_text' THEN
        jsonb_typeof(locator->'pdfUrl') = 'string'
        AND btrim(locator->>'pdfUrl') <> ''
        AND locator->>'pdfUrl' ~* '^https?://'
        AND jsonb_typeof(locator->'pageNumber') = 'number'
        AND locator->>'pageNumber' ~ '^[1-9][0-9]*$'
        AND (
          NOT (locator ? 'startOffset')
          OR (
            jsonb_typeof(locator->'startOffset') = 'number'
            AND locator->>'startOffset' ~ '^[0-9]+$'
          )
        )
        AND (
          NOT (locator ? 'endOffset')
          OR (
            locator ? 'startOffset'
            AND jsonb_typeof(locator->'endOffset') = 'number'
            AND locator->>'endOffset' ~ '^[0-9]+$'
            AND (locator->>'endOffset')::numeric >= (locator->>'startOffset')::numeric
          )
        )
      WHEN 'unavailable' THEN
        locator->>'reasonCode' IN (
          'body_not_collected', 'source_not_resolved', 'content_not_extracted',
          'legacy_metadata_only', 'unsupported_content_type', 'collection_failed'
        )
      ELSE FALSE
    END
  ),
  CONSTRAINT evidence_versions_locator_scope_ck CHECK (
    availability_status = 'unavailable'
    OR (locator_kind = 'feed_field' AND capture_scope IN ('rss_entry', 'atom_entry'))
    OR (locator_kind = 'html_text_quote' AND capture_scope = 'detail_page')
    OR (locator_kind = 'reddit_post_field' AND capture_scope = 'reddit_post')
    OR (locator_kind = 'x_post_field' AND capture_scope = 'x_post')
    OR (locator_kind = 'pdf_text' AND capture_scope = 'pdf')
  ),
  CONSTRAINT evidence_versions_locator_hash_ck CHECK (locator_hash ~ '^[0-9a-f]{64}$'),
  CHECK (btrim(extraction_method) <> ''),
  CHECK (btrim(extractor_version) <> ''),
  CONSTRAINT evidence_versions_extraction_metadata_ck CHECK (
    jsonb_typeof(extraction_metadata) = 'object'
  ),
  CONSTRAINT evidence_versions_availability_ck CHECK (
    (
      availability_status = 'available'
      AND quote_original IS NOT NULL
      AND quote_original_hash IS NOT NULL
      AND locator_kind <> 'unavailable'
      AND locator_status <> 'unavailable'
      AND directness <> 'unavailable'
      AND unavailable_reason IS NULL
    )
    OR
    (
      availability_status = 'unavailable'
      AND quote_original IS NULL
      AND quote_original_hash IS NULL
      AND quote_language IS NULL
      AND quote_zh_cn IS NULL
      AND locator_kind = 'unavailable'
      AND locator_status = 'unavailable'
      AND directness = 'unavailable'
      AND unavailable_reason IS NOT NULL
      AND btrim(unavailable_reason) <> ''
      AND locator ? 'reasonCode'
      AND (
        unavailable_reason = locator->>'reasonCode'
        OR unavailable_reason LIKE (locator->>'reasonCode') || ': %'
      )
    )
  )
);
CREATE INDEX IF NOT EXISTS evidence_versions_item_version_idx
  ON evidence_versions (evidence_item_id, version_number DESC);
CREATE INDEX IF NOT EXISTS evidence_versions_source_version_idx
  ON evidence_versions (source_document_id, source_document_version_id);
CREATE INDEX IF NOT EXISTS evidence_versions_captured_idx
  ON evidence_versions (captured_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_versions_transition_idx
  ON evidence_versions (
    evidence_item_id,
    COALESCE(previous_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source_document_version_id,
    material_hash
  );

-- Exact source revisions used by an event revision. A source-document registry
-- row alone is not sufficient for an auditable claim.
CREATE TABLE IF NOT EXISTS event_version_sources (
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  source_document_id TEXT NOT NULL,
  source_document_version_id UUID NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN (
    'primary', 'corroborating', 'context', 'contradicting', 'social_signal'
  )),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_version_id, source_document_version_id),
  UNIQUE (event_version_id, ordinal),
  UNIQUE (event_id, event_version_id, source_document_id, source_document_version_id),
  FOREIGN KEY (event_id, event_version_id)
    REFERENCES event_versions (event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, source_document_version_id)
    REFERENCES source_document_versions (source_document_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, source_document_version_id)
    REFERENCES source_version_provenance (source_document_id, source_document_version_id)
    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS event_version_sources_document_idx
  ON event_version_sources (source_document_id, source_document_version_id);
CREATE INDEX IF NOT EXISTS event_version_sources_event_idx
  ON event_version_sources (event_id, event_version_id, ordinal);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_version_sources_exact_row_uk'
      AND conrelid = 'event_version_sources'::regclass
  ) THEN
    ALTER TABLE event_version_sources
      ADD CONSTRAINT event_version_sources_exact_row_uk UNIQUE (
        event_id, event_version_id, source_document_id, source_document_version_id,
        source_role, ordinal
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_snapshot_events_exact_version_uk'
      AND conrelid = 'brief_snapshot_events'::regclass
  ) THEN
    ALTER TABLE brief_snapshot_events
      ADD CONSTRAINT brief_snapshot_events_exact_version_uk
      UNIQUE (snapshot_id, event_id, event_version_id);
  END IF;
END $$;

-- Records every evidence version projected by an event version, including
-- unavailable evidence which may not be cited by a publishable claim. Without
-- this relation a JSON projection could silently omit evidence and still pass
-- a citation-only authority check.
CREATE TABLE IF NOT EXISTS event_version_evidence (
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  source_document_id TEXT NOT NULL,
  source_document_version_id UUID NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN (
    'primary', 'corroborating', 'context', 'contradicting', 'social_signal'
  )),
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal > 0),
  evidence_item_id TEXT NOT NULL,
  evidence_version_id UUID NOT NULL,
  directness TEXT NOT NULL CHECK (directness IN ('direct', 'indirect', 'derived', 'unavailable')),
  evidence_ordinal INTEGER NOT NULL CHECK (evidence_ordinal > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, event_version_id, evidence_version_id),
  UNIQUE (event_id, event_version_id, source_ordinal, evidence_ordinal),
  UNIQUE (
    event_id, event_version_id, source_document_id, source_document_version_id,
    evidence_item_id, evidence_version_id, directness
  ),
  CONSTRAINT event_version_evidence_event_source_fk
  FOREIGN KEY (
    event_id, event_version_id, source_document_id, source_document_version_id,
    source_role, source_ordinal
  ) REFERENCES event_version_sources (
    event_id, event_version_id, source_document_id, source_document_version_id,
    source_role, ordinal
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_document_id, source_document_version_id, evidence_item_id,
    evidence_version_id, directness
  ) REFERENCES evidence_versions (
    source_document_id, source_document_version_id, evidence_item_id, id, directness
  ) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS event_version_evidence_event_idx
  ON event_version_evidence (event_id, event_version_id, source_ordinal, evidence_ordinal);
CREATE INDEX IF NOT EXISTS event_version_evidence_source_idx
  ON event_version_evidence (
    source_document_id, source_document_version_id, evidence_item_id, evidence_version_id
  );

-- A snapshot records which collection observation supplied each displayed
-- source. Event versions remain content-based and therefore do not fork merely
-- because identical content was seen again ten minutes later.
CREATE TABLE IF NOT EXISTS brief_snapshot_source_observations (
  snapshot_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  source_document_id TEXT NOT NULL,
  source_document_version_id UUID NOT NULL,
  source_observation_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN (
    'primary', 'corroborating', 'context', 'contradicting', 'social_signal'
  )),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (snapshot_id, event_id, source_observation_id),
  UNIQUE (snapshot_id, event_id, ordinal),
  CONSTRAINT brief_snapshot_source_observations_snapshot_version_fk
  FOREIGN KEY (snapshot_id, event_id, event_version_id)
    REFERENCES brief_snapshot_events (snapshot_id, event_id, event_version_id)
    ON DELETE RESTRICT,
  CONSTRAINT brief_snapshot_source_observations_event_source_fk
  FOREIGN KEY (
    event_id, event_version_id, source_document_id, source_document_version_id,
    source_role, ordinal
  ) REFERENCES event_version_sources (
    event_id, event_version_id, source_document_id, source_document_version_id,
    source_role, ordinal
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_document_id, source_document_version_id, source_observation_id
  ) REFERENCES source_collection_observations (
    source_document_id, source_document_version_id, id
  ) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS brief_snapshot_source_observations_source_idx
  ON brief_snapshot_source_observations (
    source_document_id, source_document_version_id, source_observation_id
  );

-- Compatibility for a database where an earlier draft of this migration was
-- already applied. Derive, rather than guess, the exact event revision and
-- source role/ordinal before enabling the composite foreign keys.
DROP TRIGGER IF EXISTS brief_snapshot_source_observations_immutable
  ON brief_snapshot_source_observations;
ALTER TABLE brief_snapshot_source_observations
  ADD COLUMN IF NOT EXISTS event_version_id UUID;
UPDATE brief_snapshot_source_observations AS observation
SET event_version_id = snapshot_event.event_version_id,
    source_role = event_source.source_role,
    ordinal = event_source.ordinal
FROM brief_snapshot_events AS snapshot_event
JOIN event_version_sources AS event_source
  ON event_source.event_id = snapshot_event.event_id
 AND event_source.event_version_id = snapshot_event.event_version_id
WHERE snapshot_event.snapshot_id = observation.snapshot_id
  AND snapshot_event.event_id = observation.event_id
  AND event_source.source_document_id = observation.source_document_id
  AND event_source.source_document_version_id = observation.source_document_version_id
  AND observation.event_version_id IS NULL;
ALTER TABLE brief_snapshot_source_observations
  ALTER COLUMN event_version_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_snapshot_source_observations_snapshot_version_fk'
      AND conrelid = 'brief_snapshot_source_observations'::regclass
  ) THEN
    ALTER TABLE brief_snapshot_source_observations
      ADD CONSTRAINT brief_snapshot_source_observations_snapshot_version_fk
      FOREIGN KEY (snapshot_id, event_id, event_version_id)
      REFERENCES brief_snapshot_events (snapshot_id, event_id, event_version_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brief_snapshot_source_observations_event_source_fk'
      AND conrelid = 'brief_snapshot_source_observations'::regclass
  ) THEN
    ALTER TABLE brief_snapshot_source_observations
      ADD CONSTRAINT brief_snapshot_source_observations_event_source_fk
      FOREIGN KEY (
        event_id, event_version_id, source_document_id, source_document_version_id,
        source_role, ordinal
      ) REFERENCES event_version_sources (
        event_id, event_version_id, source_document_id, source_document_version_id,
        source_role, ordinal
      ) ON DELETE RESTRICT;
  END IF;
END $$;

-- Claims are immutable assertions made by one exact event version. claim_key is
-- stable across event versions; id identifies this version-specific assertion.
CREATE TABLE IF NOT EXISTS event_claims (
  id UUID PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  claim_key TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN (
    'title', 'summary', 'important_information', 'market_impact',
    'direction_rationale', 'equity_impact'
  )),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  statement TEXT NOT NULL,
  original_statement TEXT,
  statement_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN (
    'supported', 'partially_supported', 'pending_confirmation', 'legacy_unverified'
  )),
  generator TEXT NOT NULL CHECK (generator IN (
    'collector', 'deterministic', 'ai', 'review', 'legacy'
  )),
  generator_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, event_version_id, claim_key),
  UNIQUE (event_id, event_version_id, id),
  UNIQUE (event_id, event_version_id, id, claim_key),
  UNIQUE (event_version_id, ordinal),
  FOREIGN KEY (event_id, event_version_id)
    REFERENCES event_versions (event_id, id) ON DELETE RESTRICT,
  CHECK (btrim(claim_key) <> ''),
  CHECK (btrim(statement) <> ''),
  CHECK (original_statement IS NULL OR btrim(original_statement) <> ''),
  CONSTRAINT event_claims_statement_hash_ck CHECK (
    statement_hash ~ '^[0-9a-f]{64}$'
    OR statement_hash ~ '^legacy-md5:[0-9a-f]{32}$'
  ),
  CHECK (btrim(language) <> ''),
  CHECK (btrim(generator_version) <> ''),
  CONSTRAINT event_claims_ai_pending_ck CHECK (
    generator <> 'ai' OR verification_status = 'pending_confirmation'
  ),
  CONSTRAINT event_claims_review_confirmation_ck CHECK (
    generator <> 'review'
    OR verification_status NOT IN ('supported', 'partially_supported')
    OR generator_version = 'review-console/manual-semantic-confirmation/v1'
  )
);

-- Rerunning the migration against a database that created event_claims from an
-- earlier draft must still enforce the verifier semantics for every new row.
-- NOT VALID deliberately avoids rewriting immutable historical rows; the
-- application publication gate rejects any legacy AI row that was overstated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_claims_ai_pending_ck'
      AND conrelid = 'event_claims'::regclass
  ) THEN
    ALTER TABLE event_claims
      ADD CONSTRAINT event_claims_ai_pending_ck
      CHECK (generator <> 'ai' OR verification_status = 'pending_confirmation') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_claims_review_confirmation_ck'
      AND conrelid = 'event_claims'::regclass
  ) THEN
    ALTER TABLE event_claims
      ADD CONSTRAINT event_claims_review_confirmation_ck
      CHECK (
        generator <> 'review'
        OR verification_status NOT IN ('supported', 'partially_supported')
        OR generator_version = 'review-console/manual-semantic-confirmation/v1'
      ) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS event_claims_event_version_idx
  ON event_claims (event_id, event_version_id, ordinal);
CREATE INDEX IF NOT EXISTS event_claims_claim_key_idx
  ON event_claims (event_id, claim_key, event_version_id);
CREATE INDEX IF NOT EXISTS event_claims_status_idx
  ON event_claims (verification_status, created_at DESC);

-- This relation repeats all identity dimensions on purpose. Composite foreign
-- keys make it impossible to link a claim to evidence from a different event,
-- unregistered source revision, source document, or evidence item.
CREATE TABLE IF NOT EXISTS claim_evidence_links (
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  claim_key TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_document_version_id UUID NOT NULL,
  evidence_item_id TEXT NOT NULL,
  evidence_version_id UUID NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'context')),
  directness TEXT NOT NULL CHECK (directness IN ('direct', 'indirect', 'derived', 'unavailable')),
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (claim_id, evidence_version_id, relation),
  UNIQUE (claim_id, ordinal),
  FOREIGN KEY (event_id, event_version_id, claim_id, claim_key)
    REFERENCES event_claims (event_id, event_version_id, id, claim_key) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, event_version_id, source_document_id, source_document_version_id)
    REFERENCES event_version_sources (
      event_id, event_version_id, source_document_id, source_document_version_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_document_id, source_document_version_id, evidence_item_id, evidence_version_id,
    directness
  ) REFERENCES evidence_versions (
    source_document_id, source_document_version_id, evidence_item_id, id, directness
  ) ON DELETE RESTRICT,
  CONSTRAINT claim_evidence_links_event_evidence_fk
  FOREIGN KEY (
    event_id, event_version_id, source_document_id, source_document_version_id,
    evidence_item_id, evidence_version_id, directness
  ) REFERENCES event_version_evidence (
    event_id, event_version_id, source_document_id, source_document_version_id,
    evidence_item_id, evidence_version_id, directness
  ) ON DELETE RESTRICT,
  CHECK (btrim(claim_key) <> '')
);
CREATE INDEX IF NOT EXISTS claim_evidence_links_claim_idx
  ON claim_evidence_links (event_id, event_version_id, claim_id, ordinal);
CREATE INDEX IF NOT EXISTS claim_evidence_links_evidence_idx
  ON claim_evidence_links (
    source_document_id, source_document_version_id, evidence_item_id, evidence_version_id
  );

-- If an earlier draft stored claim links before event_version_evidence existed,
-- backfill only the evidence versions those immutable links prove. This does
-- not invent uncited evidence or quotes.
WITH distinct_links AS (
  SELECT DISTINCT
    link.event_id, link.event_version_id,
    link.source_document_id, link.source_document_version_id,
    link.evidence_item_id, link.evidence_version_id, link.directness
  FROM claim_evidence_links AS link
), ranked_links AS (
  SELECT
    link.*,
    source.source_role,
    source.ordinal AS source_ordinal,
    row_number() OVER (
      PARTITION BY link.event_id, link.event_version_id,
                   link.source_document_id, link.source_document_version_id
      ORDER BY link.evidence_item_id, link.evidence_version_id
    )::integer AS evidence_ordinal
  FROM distinct_links AS link
  JOIN event_version_sources AS source
    ON source.event_id = link.event_id
   AND source.event_version_id = link.event_version_id
   AND source.source_document_id = link.source_document_id
   AND source.source_document_version_id = link.source_document_version_id
)
INSERT INTO event_version_evidence (
  event_id, event_version_id, source_document_id, source_document_version_id,
  source_role, source_ordinal, evidence_item_id, evidence_version_id,
  directness, evidence_ordinal
)
SELECT
  event_id, event_version_id, source_document_id, source_document_version_id,
  source_role, source_ordinal, evidence_item_id, evidence_version_id,
  directness, evidence_ordinal
FROM ranked_links
ON CONFLICT (event_id, event_version_id, evidence_version_id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'claim_evidence_links_event_evidence_fk'
      AND conrelid = 'claim_evidence_links'::regclass
  ) THEN
    ALTER TABLE claim_evidence_links
      ADD CONSTRAINT claim_evidence_links_event_evidence_fk
      FOREIGN KEY (
        event_id, event_version_id, source_document_id, source_document_version_id,
        evidence_item_id, evidence_version_id, directness
      ) REFERENCES event_version_evidence (
        event_id, event_version_id, source_document_id, source_document_version_id,
        evidence_item_id, evidence_version_id, directness
      ) ON DELETE RESTRICT;
  END IF;
END $$;

-- A claim cannot call itself supported merely by linking contradictory,
-- contextual, or explicitly unavailable evidence. This check is deferred so
-- the claim row can be inserted before its links within one transaction.
CREATE OR REPLACE FUNCTION analystarena_require_available_claim_support()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.verification_status IN ('supported', 'partially_supported')
    AND NOT EXISTS (
      SELECT 1
      FROM claim_evidence_links AS link
      JOIN evidence_versions AS evidence ON evidence.id = link.evidence_version_id
      WHERE link.claim_id = NEW.id
        AND link.relation = 'supports'
        AND link.confidence > 0
        AND link.directness <> 'unavailable'
        AND evidence.locator_status <> 'unavailable'
    )
  THEN
    RAISE EXCEPTION 'claim % is % but has no available supporting evidence',
      NEW.id, NEW.verification_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_claims_require_available_support ON event_claims;
CREATE CONSTRAINT TRIGGER event_claims_require_available_support
  AFTER INSERT ON event_claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION analystarena_require_available_claim_support();

-- Validate a strict v1 -> v2 -> ... chain, not merely a same-item pointer.
CREATE OR REPLACE FUNCTION analystarena_validate_evidence_version_chain()
RETURNS TRIGGER AS $$
DECLARE
  prior_version_number INTEGER;
BEGIN
  IF NEW.version_number = 1 THEN
    IF NEW.previous_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'evidence version 1 cannot have previous version %', NEW.previous_version_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT version_number INTO prior_version_number
  FROM evidence_versions
  WHERE source_document_id = NEW.source_document_id
    AND evidence_item_id = NEW.evidence_item_id
    AND id = NEW.previous_version_id;

  IF prior_version_number IS NULL THEN
    RAISE EXCEPTION 'previous evidence version % does not exist for evidence item %',
      NEW.previous_version_id, NEW.evidence_item_id
      USING ERRCODE = '23503';
  END IF;

  IF prior_version_number <> NEW.version_number - 1 THEN
    RAISE EXCEPTION 'evidence version % must follow version %, got previous version %',
      NEW.version_number, NEW.version_number - 1, prior_version_number
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_versions_validate_chain ON evidence_versions;
CREATE TRIGGER evidence_versions_validate_chain
  BEFORE INSERT ON evidence_versions
  FOR EACH ROW EXECUTE FUNCTION analystarena_validate_evidence_version_chain();

-- Honest legacy source provenance: retain exact stored URL/hash/collection time,
-- mark unknown capture details as unknown, and never turn metadata into a quote.
INSERT INTO source_version_provenance (
  source_document_version_id, source_document_id, native_id,
  source_name, source_type, timestamp_kind, canonical_url,
  raw_url, final_url, feed_url, mime_type, http_status,
  original_published_at, published_at_raw, published_at_field, source_updated_at,
  collected_at, capture_scope, captured_content_hash,
  captured_artifact, captured_artifact_encoding, captured_artifact_size_bytes,
  captured_text_hash, extraction_method, extractor_version, backfill_quality
)
SELECT
  version.id,
  document.id,
  document.native_id,
  document.source_name,
  document.source_type,
  document.timestamp_kind,
  document.canonical_url,
  COALESCE(
    NULLIF(version.payload#>>'{capture,rawUrl}', ''),
    NULLIF(version.payload->>'url', '')
  ),
  NULLIF(version.payload#>>'{capture,finalUrl}', ''),
  NULLIF(version.payload#>>'{capture,feedUrl}', ''),
  NULLIF(version.payload#>>'{capture,mimeType}', ''),
  CASE
    WHEN version.payload#>>'{capture,httpStatus}' ~ '^[1-5][0-9][0-9]$'
      THEN (version.payload#>>'{capture,httpStatus}')::integer
    ELSE NULL
  END,
  -- The pre-7/22 Atom collector stored `updated` in published_at and labelled
  -- it as published. Because the old payload did not preserve the native field
  -- name, no legacy timestamp can be proven to be an original publication
  -- time. Keep it NULL instead of manufacturing precision.
  NULL,
  document.published_at_raw,
  document.published_at_field,
  document.source_updated_at,
  version.collected_at,
  'legacy_metadata',
  version.content_hash,
  NULL,
  NULL,
  NULL,
  NULL,
  'legacy_backfill',
  'migration-20260722',
  'unverified_legacy'
FROM source_document_versions AS version
JOIN source_documents AS document ON document.id = version.source_document_id
CROSS JOIN source_evidence_backfill_boundaries AS boundary
WHERE boundary.migration_id = '20260722_source_evidence'
  AND version.created_at <= boundary.cutoff_at
ON CONFLICT (source_document_version_id) DO NOTHING;

INSERT INTO source_collection_observations (
  id, source_document_id, source_document_version_id, source_name, source_type,
  collected_at, raw_url, final_url, feed_url, mime_type, http_status,
  capture_scope, captured_content_hash
)
SELECT
  'obs_legacy_' || md5('legacy-observation:' || provenance.source_document_version_id::text),
  provenance.source_document_id,
  provenance.source_document_version_id,
  provenance.source_name,
  provenance.source_type,
  provenance.collected_at,
  COALESCE(provenance.raw_url, provenance.canonical_url),
  provenance.final_url,
  provenance.feed_url,
  provenance.mime_type,
  provenance.http_status,
  provenance.capture_scope,
  provenance.captured_content_hash
FROM source_version_provenance AS provenance
CROSS JOIN source_evidence_backfill_boundaries AS boundary
WHERE boundary.migration_id = '20260722_source_evidence'
  AND provenance.created_at <= boundary.cutoff_at
ON CONFLICT (id) DO NOTHING;

-- Existing event text is useful historical context, but it was not captured
-- with exact citations. Preserve only text that is actually present and label
-- every generated row legacy_unverified. No evidence rows or links are made.
WITH legacy_event_versions AS (
  SELECT version.*
  FROM event_versions AS version
  CROSS JOIN source_evidence_backfill_boundaries AS boundary
  WHERE boundary.migration_id = '20260722_source_evidence'
    AND version.created_at <= boundary.cutoff_at
), raw_claims AS (
  SELECT
    version.id AS event_version_id,
    version.event_id,
    'legacy:title'::text AS claim_key,
    'title'::text AS claim_type,
    10::bigint AS sort_key,
    NULLIF(btrim(version.payload#>>'{headline,title}'), '') AS statement
  FROM legacy_event_versions AS version

  UNION ALL

  SELECT
    version.id,
    version.event_id,
    'legacy:summary',
    'summary',
    20,
    NULLIF(btrim(version.payload#>>'{headline,summary}'), '')
  FROM legacy_event_versions AS version

  UNION ALL

  SELECT
    version.id,
    version.event_id,
    'legacy:important-information:' || point.ordinality::text,
    'important_information',
    100 + point.ordinality,
    NULLIF(btrim(point.value #>> '{}'), '')
  FROM legacy_event_versions AS version
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(version.payload#>'{headline,keyPoints}') = 'array'
        THEN version.payload#>'{headline,keyPoints}'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS point(value, ordinality)

  UNION ALL

  SELECT
    version.id,
    version.event_id,
    'legacy:market-impact',
    'market_impact',
    10000,
    NULLIF(btrim(version.payload#>>'{headline,marketImpact}'), '')
  FROM legacy_event_versions AS version

  UNION ALL

  SELECT
    version.id,
    version.event_id,
    'legacy:direction-rationale',
    'direction_rationale',
    10010,
    NULLIF(btrim(version.payload#>>'{headline,directionRationale}'), '')
  FROM legacy_event_versions AS version

  UNION ALL

  SELECT
    version.id,
    version.event_id,
    'legacy:equity-impact:' || impact.ordinality::text,
    'equity_impact',
    20000 + impact.ordinality,
    NULLIF(btrim(COALESCE(
      impact.value->>'mechanism',
      impact.value->>'companyName',
      impact.value->>'symbol'
    )), '')
  FROM legacy_event_versions AS version
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(version.payload#>'{headline,equityImpacts}') = 'array'
        THEN version.payload#>'{headline,equityImpacts}'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS impact(value, ordinality)
), ordered_claims AS (
  SELECT
    event_version_id,
    event_id,
    claim_key,
    claim_type,
    statement,
    row_number() OVER (
      PARTITION BY event_version_id
      ORDER BY sort_key, claim_key
    )::integer AS ordinal
  FROM raw_claims
  WHERE statement IS NOT NULL
), identified_claims AS (
  SELECT
    (
      substr(md5('legacy-claim:' || event_version_id::text || ':' || claim_key), 1, 8) || '-' ||
      substr(md5('legacy-claim:' || event_version_id::text || ':' || claim_key), 9, 4) || '-' ||
      substr(md5('legacy-claim:' || event_version_id::text || ':' || claim_key), 13, 4) || '-' ||
      substr(md5('legacy-claim:' || event_version_id::text || ':' || claim_key), 17, 4) || '-' ||
      substr(md5('legacy-claim:' || event_version_id::text || ':' || claim_key), 21, 12)
    )::uuid AS id,
    event_id,
    event_version_id,
    claim_key,
    claim_type,
    ordinal,
    statement
  FROM ordered_claims
)
INSERT INTO event_claims (
  id, event_id, event_version_id, claim_key, claim_type, ordinal,
  statement, original_statement, statement_hash, language,
  verification_status, generator, generator_version
)
SELECT
  id,
  event_id,
  event_version_id,
  claim_key,
  claim_type,
  ordinal,
  statement,
  NULL,
  'legacy-md5:' || md5(statement),
  'und',
  'legacy_unverified',
  'legacy',
  'migration-20260722'
FROM identified_claims
ON CONFLICT (event_id, event_version_id, claim_key) DO NOTHING;

CREATE OR REPLACE FUNCTION analystarena_reject_history_change()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; create a new version or snapshot instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_evidence_backfill_boundaries_immutable
  ON source_evidence_backfill_boundaries;
CREATE TRIGGER source_evidence_backfill_boundaries_immutable
  BEFORE UPDATE OR DELETE ON source_evidence_backfill_boundaries
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS source_version_provenance_immutable ON source_version_provenance;
CREATE TRIGGER source_version_provenance_immutable
  BEFORE UPDATE OR DELETE ON source_version_provenance
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS source_collection_observations_immutable ON source_collection_observations;
CREATE TRIGGER source_collection_observations_immutable
  BEFORE UPDATE OR DELETE ON source_collection_observations
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS evidence_items_immutable ON evidence_items;
CREATE TRIGGER evidence_items_immutable
  BEFORE UPDATE OR DELETE ON evidence_items
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS evidence_versions_immutable ON evidence_versions;
CREATE TRIGGER evidence_versions_immutable
  BEFORE UPDATE OR DELETE ON evidence_versions
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_sources_immutable ON event_version_sources;
CREATE TRIGGER event_version_sources_immutable
  BEFORE UPDATE OR DELETE ON event_version_sources
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_version_evidence_immutable ON event_version_evidence;
CREATE TRIGGER event_version_evidence_immutable
  BEFORE UPDATE OR DELETE ON event_version_evidence
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS brief_snapshot_source_observations_immutable
  ON brief_snapshot_source_observations;
CREATE TRIGGER brief_snapshot_source_observations_immutable
  BEFORE UPDATE OR DELETE ON brief_snapshot_source_observations
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS event_claims_immutable ON event_claims;
CREATE TRIGGER event_claims_immutable
  BEFORE UPDATE OR DELETE ON event_claims
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

DROP TRIGGER IF EXISTS claim_evidence_links_immutable ON claim_evidence_links;
CREATE TRIGGER claim_evidence_links_immutable
  BEFORE UPDATE OR DELETE ON claim_evidence_links
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

COMMENT ON COLUMN evidence_versions.material_hash IS
  'Hash of exact source version, original quote hash, locator hash, availability/directness/scope and extractor; excludes quote_zh_cn.';
COMMENT ON COLUMN evidence_versions.quote_zh_cn IS
  'Optional Simplified Chinese presentation translation; deliberately excluded from evidence material identity.';
COMMENT ON TABLE claim_evidence_links IS
  'Exact immutable relation between one event-version claim, one registered source revision and one evidence revision.';
