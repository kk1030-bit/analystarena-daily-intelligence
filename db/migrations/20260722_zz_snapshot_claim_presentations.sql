-- A claim's evidence-bearing assertion belongs to an event version, while its
-- translated display sentence belongs to one immutable brief snapshot.  Keep
-- those authorities separate so a pure translation can reuse an event version
-- without allowing a client to forge the text rendered in a reviewed brief.
CREATE TABLE IF NOT EXISTS brief_snapshot_claim_presentations (
  snapshot_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  event_version_id UUID NOT NULL,
  claim_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  statement TEXT NOT NULL CHECK (btrim(statement) <> ''),
  language TEXT NOT NULL CHECK (btrim(language) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (snapshot_id, event_id, claim_key),
  UNIQUE (snapshot_id, event_id, ordinal),
  CONSTRAINT brief_snapshot_claim_presentations_snapshot_event_fk
  FOREIGN KEY (snapshot_id, event_id, event_version_id)
    REFERENCES brief_snapshot_events (snapshot_id, event_id, event_version_id)
    ON DELETE RESTRICT,
  CONSTRAINT brief_snapshot_claim_presentations_event_claim_fk
  FOREIGN KEY (event_id, event_version_id, claim_key)
    REFERENCES event_claims (event_id, event_version_id, claim_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS brief_snapshot_claim_presentations_event_idx
  ON brief_snapshot_claim_presentations (event_id, event_version_id, ordinal);

-- Backfill only claims which are already bound to the exact snapshot event and
-- normalized event-version claim.  The snapshot payload is immutable and is
-- therefore the authority for the display statement/language; no assertion,
-- evidence link, or verification status is inferred here.
WITH snapshot_headlines AS (
  SELECT snapshot.id AS snapshot_id, headline.value AS headline
  FROM brief_snapshots AS snapshot
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(snapshot.payload->'headlines') = 'array'
        THEN snapshot.payload->'headlines'
      ELSE '[]'::jsonb
    END
  ) AS headline(value)
), snapshot_claims AS (
  SELECT
    snapshot_headlines.snapshot_id,
    snapshot_headlines.headline->>'id' AS event_id,
    claim.value AS claim
  FROM snapshot_headlines
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(snapshot_headlines.headline->'claims') = 'array'
        THEN snapshot_headlines.headline->'claims'
      ELSE '[]'::jsonb
    END
  ) AS claim(value)
)
INSERT INTO brief_snapshot_claim_presentations (
  snapshot_id, event_id, event_version_id, claim_key,
  ordinal, statement, language
)
SELECT
  snapshot_claims.snapshot_id,
  snapshot_claims.event_id,
  snapshot_event.event_version_id,
  snapshot_claims.claim->>'claimKey',
  (snapshot_claims.claim->>'ordinal')::integer,
  snapshot_claims.claim->>'statement',
  snapshot_claims.claim->>'language'
FROM snapshot_claims
JOIN brief_snapshot_events AS snapshot_event
  ON snapshot_event.snapshot_id = snapshot_claims.snapshot_id
 AND snapshot_event.event_id = snapshot_claims.event_id
JOIN event_claims AS event_claim
  ON event_claim.event_id = snapshot_event.event_id
 AND event_claim.event_version_id = snapshot_event.event_version_id
 AND event_claim.claim_key = snapshot_claims.claim->>'claimKey'
WHERE snapshot_claims.event_id IS NOT NULL
  AND NULLIF(snapshot_claims.claim->>'claimKey', '') IS NOT NULL
  AND (snapshot_claims.claim->>'ordinal') ~ '^\d+$'
  AND NULLIF(snapshot_claims.claim->>'statement', '') IS NOT NULL
  AND NULLIF(snapshot_claims.claim->>'language', '') IS NOT NULL
ON CONFLICT (snapshot_id, event_id, claim_key) DO NOTHING;

DROP TRIGGER IF EXISTS brief_snapshot_claim_presentations_immutable
  ON brief_snapshot_claim_presentations;
CREATE TRIGGER brief_snapshot_claim_presentations_immutable
  BEFORE UPDATE OR DELETE ON brief_snapshot_claim_presentations
  FOR EACH ROW EXECUTE FUNCTION analystarena_reject_history_change();

COMMENT ON TABLE brief_snapshot_claim_presentations IS
  'Immutable display statement and language for an exact event-version claim in one brief snapshot.';
COMMENT ON COLUMN brief_snapshot_claim_presentations.statement IS
  'Reviewed snapshot display text; the evidence-bearing original assertion remains in event_claims.';
