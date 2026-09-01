-- Distinguish immutable evidence-version creation time from the collection
-- observation time projected by a particular brief snapshot. Identical bytes,
-- quote and locator material deliberately reuse their evidence version; each
-- recapture remains independently auditable through source observations.
COMMENT ON COLUMN evidence_versions.captured_at IS
  'Collection time that first created this immutable evidence material version; it does not change when later observations reuse the version.';

COMMENT ON COLUMN source_collection_observations.collected_at IS
  'Capture time of this exact source observation; snapshot evidence projections use this value even when they reuse an earlier evidence version.';
