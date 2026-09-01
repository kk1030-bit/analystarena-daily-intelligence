-- ETFs 热门话题：每小时 Reddit 评审、24 小时热度追踪、每日与每周统整。
-- 每小时的前五篇进入 24 小时追踪窗口（5 × 24 = 最多 120 篇活跃追踪）。

CREATE TABLE IF NOT EXISTS etf_topic_posts (
  id TEXT PRIMARY KEY,
  native_id TEXT NOT NULL,
  subreddit TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  title_zh TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  timestamp_kind TEXT NOT NULL CHECK (timestamp_kind IN ('published', 'collected')),
  first_tracked_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  tracking_until TIMESTAMPTZ NOT NULL,
  latest_engagement BIGINT NOT NULL DEFAULT 0,
  peak_engagement BIGINT NOT NULL DEFAULT 0,
  key_points_zh JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_generator TEXT NOT NULL DEFAULT 'deterministic',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS etf_topic_posts_tracking_idx
  ON etf_topic_posts (tracking_until DESC, peak_engagement DESC);
CREATE INDEX IF NOT EXISTS etf_topic_posts_first_tracked_idx
  ON etf_topic_posts (first_tracked_at DESC);

CREATE TABLE IF NOT EXISTS etf_topic_observations (
  post_id TEXT NOT NULL REFERENCES etf_topic_posts(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  score BIGINT NOT NULL DEFAULT 0,
  comments BIGINT NOT NULL DEFAULT 0,
  engagement BIGINT NOT NULL DEFAULT 0,
  rank INTEGER,
  PRIMARY KEY (post_id, observed_at)
);
CREATE INDEX IF NOT EXISTS etf_topic_observations_observed_idx
  ON etf_topic_observations (observed_at DESC);

CREATE TABLE IF NOT EXISTS etf_topic_selections (
  beijing_hour TEXT PRIMARY KEY,
  selected_at TIMESTAMPTZ NOT NULL,
  items JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS etf_topic_digests (
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  period_key TEXT NOT NULL,
  title_zh TEXT NOT NULL,
  content JSONB NOT NULL,
  generator TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, period_key)
);
