-- Legacy event content cannot support a semantic What Changed comparison, but
-- its immutable snapshot still provides the previous rank as historical
-- context. The v1 comparison intentionally keeps previous_rank while leaving
-- rank_delta uncomputed and rank_movement not_comparable. The original unnamed
-- constraint rejected that fail-closed legacy shape.

ALTER TABLE brief_snapshot_event_changes
  DROP CONSTRAINT IF EXISTS brief_snapshot_event_changes_check3;
ALTER TABLE brief_snapshot_event_changes
  DROP CONSTRAINT IF EXISTS brief_snapshot_event_changes_rank_shape_ck;

ALTER TABLE brief_snapshot_event_changes
  ADD CONSTRAINT brief_snapshot_event_changes_rank_shape_ck CHECK (
    (
      previous_rank IS NULL
      AND rank_delta IS NULL
      AND rank_movement = 'not_comparable'
    )
    OR (
      previous_rank IS NOT NULL
      AND (
        (
          rank_delta IS NOT NULL
          AND
          rank_delta = previous_rank - current_rank
          AND (
            (rank_delta > 0 AND rank_movement = 'up')
            OR (rank_delta < 0 AND rank_movement = 'down')
            OR (rank_delta = 0 AND rank_movement = 'unchanged')
          )
        )
        OR (
          status = 'legacy_unverified'
          AND presence = 'continued'
          AND baseline_snapshot_id IS NOT NULL
          AND baseline_event_id = event_id
          AND baseline_event_version_id IS NOT NULL
          AND rank_delta IS NULL
          AND rank_movement = 'not_comparable'
        )
      )
    )
  );
