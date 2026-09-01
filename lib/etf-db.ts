import { runEtfQuery, storageMode } from "./db";
import {
  ETF_MAX_TRACKED,
  type EtfDigestContent,
  type EtfSelectionItem,
  type EtfValidatedPost,
} from "./etf-topics";

export interface EtfTrackedPost {
  id: string;
  nativeId: string;
  subreddit: string;
  author: string;
  title: string;
  titleZh: string;
  url: string;
  publishedAt: string;
  timestampKind: "published" | "collected";
  firstTrackedAt: string;
  lastObservedAt: string;
  trackingUntil: string;
  latestEngagement: number;
  peakEngagement: number;
  keyPointsZh: string[];
  summaryGenerator: string;
}

export interface EtfObservation {
  postId: string;
  observedAt: string;
  score: number;
  comments: number;
  engagement: number;
  rank: number | null;
}

export interface EtfSelectionRecord {
  beijingHour: string;
  selectedAt: string;
  items: EtfSelectionItem[];
}

export interface EtfDigestRecord {
  kind: "daily" | "weekly";
  periodKey: string;
  titleZh: string;
  content: EtfDigestContent;
  generator: "ai" | "deterministic";
  createdAt: string;
}

export interface EtfNewTrackedInput {
  post: EtfValidatedPost;
  titleZh: string;
  keyPointsZh: string[];
  generator: "ai" | "deterministic";
}

export interface EtfIngestInput {
  observedAt: string;
  beijingHour: string;
  selection: EtfSelectionItem[];
  newTracked: EtfNewTrackedInput[];
  observations: EtfObservation[];
}

export interface EtfTopicsView {
  updatedAt: string | null;
  storageMode: "postgres" | "memory";
  latestSelection: EtfSelectionRecord | null;
  tracked: Array<EtfTrackedPost & { active: boolean; observations: EtfObservation[] }>;
  topAuthors: Array<{ author: string; posts: number; peakEngagement: number }>;
  dailyDigests: EtfDigestRecord[];
  weeklyDigest: EtfDigestRecord | null;
}

interface EtfMemoryPost extends EtfTrackedPost {
  body: string;
}

declare global {
  var __analystArenaEtfPosts: Map<string, EtfMemoryPost> | undefined;
  var __analystArenaEtfObservations: Map<string, EtfObservation[]> | undefined;
  var __analystArenaEtfSelections: Map<string, EtfSelectionRecord> | undefined;
  var __analystArenaEtfDigests: Map<string, EtfDigestRecord> | undefined;
}

const postMemory = globalThis.__analystArenaEtfPosts ?? new Map<string, EtfMemoryPost>();
globalThis.__analystArenaEtfPosts = postMemory;
const observationMemory = globalThis.__analystArenaEtfObservations ?? new Map<string, EtfObservation[]>();
globalThis.__analystArenaEtfObservations = observationMemory;
const selectionMemory = globalThis.__analystArenaEtfSelections ?? new Map<string, EtfSelectionRecord>();
globalThis.__analystArenaEtfSelections = selectionMemory;
const digestMemory = globalThis.__analystArenaEtfDigests ?? new Map<string, EtfDigestRecord>();
globalThis.__analystArenaEtfDigests = digestMemory;

/** Test hook: clears the in-memory ETF stores. No effect on PostgreSQL. */
export function resetEtfMemoryStores(): void {
  postMemory.clear();
  observationMemory.clear();
  selectionMemory.clear();
  digestMemory.clear();
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.valueOf()) ? new Date(0).toISOString() : parsed.toISOString();
}

function count(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
}

export async function getActiveEtfTracked(nowIso: string): Promise<EtfTrackedPost[]> {
  if (storageMode() === "memory") {
    return [...postMemory.values()]
      .filter((post) => post.trackingUntil > nowIso)
      .sort((left, right) => right.peakEngagement - left.peakEngagement || left.id.localeCompare(right.id))
      .map(memoryPostToTracked);
  }
  const result = await runEtfQuery(`
    SELECT id, native_id, subreddit, author, title, title_zh, url, published_at, timestamp_kind,
           first_tracked_at, last_observed_at, tracking_until, latest_engagement, peak_engagement,
           key_points_zh, summary_generator
    FROM etf_topic_posts
    WHERE tracking_until > $1
    ORDER BY peak_engagement DESC, id ASC
    LIMIT $2
  `, [nowIso, ETF_MAX_TRACKED]);
  return result.rows.map(rowToPost);
}

function memoryPostToTracked(post: EtfMemoryPost): EtfTrackedPost {
  return {
    id: post.id,
    nativeId: post.nativeId,
    subreddit: post.subreddit,
    author: post.author,
    title: post.title,
    titleZh: post.titleZh,
    url: post.url,
    publishedAt: post.publishedAt,
    timestampKind: post.timestampKind,
    firstTrackedAt: post.firstTrackedAt,
    lastObservedAt: post.lastObservedAt,
    trackingUntil: post.trackingUntil,
    latestEngagement: post.latestEngagement,
    peakEngagement: post.peakEngagement,
    keyPointsZh: post.keyPointsZh,
    summaryGenerator: post.summaryGenerator,
  };
}

function rowToPost(row: Record<string, unknown>): EtfTrackedPost {
  return {
    id: String(row.id),
    nativeId: String(row.native_id),
    subreddit: String(row.subreddit),
    author: String(row.author ?? ""),
    title: String(row.title),
    titleZh: String(row.title_zh ?? ""),
    url: String(row.url),
    publishedAt: iso(row.published_at),
    timestampKind: row.timestamp_kind === "published" ? "published" : "collected",
    firstTrackedAt: iso(row.first_tracked_at),
    lastObservedAt: iso(row.last_observed_at),
    trackingUntil: iso(row.tracking_until),
    latestEngagement: count(row.latest_engagement),
    peakEngagement: count(row.peak_engagement),
    keyPointsZh: stringArray(row.key_points_zh),
    summaryGenerator: String(row.summary_generator ?? "deterministic"),
  };
}

/**
 * Persists one hourly review: newly selected posts enter the 24-hour tracking
 * window (re-selection extends an expired window), every observed tracked post
 * gets an engagement observation, and the hour's top-5 snapshot is upserted.
 */
export async function saveEtfIngest(input: EtfIngestInput): Promise<{ activeTracked: number }> {
  const trackingUntil = new Date(new Date(input.observedAt).getTime() + 24 * 3_600_000).toISOString();
  const active = await getActiveEtfTracked(input.observedAt);
  const activeIds = new Set(active.map((post) => post.id));
  const slots = Math.max(0, ETF_MAX_TRACKED - activeIds.size);
  const admitted = input.newTracked.filter((item) => !activeIds.has(item.post.id)).slice(0, slots);

  if (storageMode() === "memory") {
    for (const { post, titleZh, keyPointsZh, generator } of admitted) {
      const existing = postMemory.get(post.id);
      postMemory.set(post.id, {
        id: post.id,
        nativeId: post.nativeId,
        subreddit: post.subreddit,
        author: post.author,
        title: post.title,
        titleZh: titleZh || existing?.titleZh || "",
        body: post.body,
        url: post.url,
        publishedAt: post.publishedAt,
        timestampKind: post.timestampKind,
        firstTrackedAt: existing?.firstTrackedAt ?? input.observedAt,
        lastObservedAt: input.observedAt,
        trackingUntil,
        latestEngagement: post.engagement,
        peakEngagement: Math.max(existing?.peakEngagement ?? 0, post.engagement),
        keyPointsZh: keyPointsZh.length ? keyPointsZh : existing?.keyPointsZh ?? [],
        summaryGenerator: generator,
      });
    }
    for (const observation of input.observations) {
      const post = postMemory.get(observation.postId);
      if (!post) continue;
      const series = observationMemory.get(observation.postId) ?? [];
      if (!series.some((item) => item.observedAt === observation.observedAt)) {
        series.push(observation);
        series.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
        observationMemory.set(observation.postId, series.slice(-48));
      }
      if (observation.observedAt >= post.lastObservedAt) {
        post.lastObservedAt = observation.observedAt;
        post.latestEngagement = observation.engagement;
      }
      post.peakEngagement = Math.max(post.peakEngagement, observation.engagement);
    }
    selectionMemory.set(input.beijingHour, {
      beijingHour: input.beijingHour,
      selectedAt: input.observedAt,
      items: input.selection,
    });
    return { activeTracked: [...postMemory.values()].filter((post) => post.trackingUntil > input.observedAt).length };
  }

  if (admitted.length) {
    await runEtfQuery(`
      INSERT INTO etf_topic_posts (
        id, native_id, subreddit, author, title, title_zh, body, url, published_at, timestamp_kind,
        first_tracked_at, last_observed_at, tracking_until, latest_engagement, peak_engagement,
        key_points_zh, summary_generator
      )
      SELECT item.id, item.native_id, item.subreddit, item.author, item.title, item.title_zh, item.body,
             item.url, item.published_at, item.timestamp_kind, item.first_tracked_at, item.last_observed_at,
             item.tracking_until, item.latest_engagement, item.peak_engagement, item.key_points_zh,
             item.summary_generator
      FROM jsonb_to_recordset($1::jsonb) AS item(
        id TEXT, native_id TEXT, subreddit TEXT, author TEXT, title TEXT, title_zh TEXT, body TEXT,
        url TEXT, published_at TIMESTAMPTZ, timestamp_kind TEXT, first_tracked_at TIMESTAMPTZ,
        last_observed_at TIMESTAMPTZ, tracking_until TIMESTAMPTZ, latest_engagement BIGINT,
        peak_engagement BIGINT, key_points_zh JSONB, summary_generator TEXT
      )
      ON CONFLICT (id) DO UPDATE SET
        tracking_until = GREATEST(etf_topic_posts.tracking_until, EXCLUDED.tracking_until),
        title_zh = CASE WHEN etf_topic_posts.title_zh = '' THEN EXCLUDED.title_zh ELSE etf_topic_posts.title_zh END,
        key_points_zh = CASE
          WHEN jsonb_array_length(etf_topic_posts.key_points_zh) = 0 THEN EXCLUDED.key_points_zh
          ELSE etf_topic_posts.key_points_zh
        END,
        updated_at = NOW()
    `, [JSON.stringify(admitted.map(({ post, titleZh, keyPointsZh, generator }) => ({
      id: post.id,
      native_id: post.nativeId,
      subreddit: post.subreddit,
      author: post.author,
      title: post.title,
      title_zh: titleZh,
      body: post.body,
      url: post.url,
      published_at: post.publishedAt,
      timestamp_kind: post.timestampKind,
      first_tracked_at: input.observedAt,
      last_observed_at: input.observedAt,
      tracking_until: trackingUntil,
      latest_engagement: post.engagement,
      peak_engagement: post.engagement,
      key_points_zh: keyPointsZh,
      summary_generator: generator,
    })))]);
  }

  if (input.observations.length) {
    await runEtfQuery(`
      INSERT INTO etf_topic_observations (post_id, observed_at, score, comments, engagement, rank)
      SELECT item.post_id, item.observed_at, item.score, item.comments, item.engagement, item.rank
      FROM jsonb_to_recordset($1::jsonb) AS item(
        post_id TEXT, observed_at TIMESTAMPTZ, score BIGINT, comments BIGINT, engagement BIGINT, rank INTEGER
      )
      WHERE EXISTS (SELECT 1 FROM etf_topic_posts WHERE etf_topic_posts.id = item.post_id)
      ON CONFLICT (post_id, observed_at) DO NOTHING
    `, [JSON.stringify(input.observations.map((observation) => ({
      post_id: observation.postId,
      observed_at: observation.observedAt,
      score: observation.score,
      comments: observation.comments,
      engagement: observation.engagement,
      rank: observation.rank,
    })))]);
    await runEtfQuery(`
      UPDATE etf_topic_posts AS post SET
        last_observed_at = GREATEST(post.last_observed_at, item.observed_at),
        latest_engagement = CASE WHEN item.observed_at >= post.last_observed_at THEN item.engagement ELSE post.latest_engagement END,
        peak_engagement = GREATEST(post.peak_engagement, item.engagement),
        updated_at = NOW()
      FROM jsonb_to_recordset($1::jsonb) AS item(post_id TEXT, observed_at TIMESTAMPTZ, engagement BIGINT)
      WHERE post.id = item.post_id
    `, [JSON.stringify(input.observations.map((observation) => ({
      post_id: observation.postId,
      observed_at: observation.observedAt,
      engagement: observation.engagement,
    })))]);
  }

  await runEtfQuery(`
    INSERT INTO etf_topic_selections (beijing_hour, selected_at, items)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (beijing_hour) DO UPDATE SET selected_at = EXCLUDED.selected_at, items = EXCLUDED.items
  `, [input.beijingHour, input.observedAt, JSON.stringify(input.selection)]);

  const activeCount = await runEtfQuery<{ active: string }>(
    "SELECT COUNT(*)::text AS active FROM etf_topic_posts WHERE tracking_until > $1",
    [input.observedAt],
  );
  return { activeTracked: count(activeCount.rows[0]?.active) };
}

function rowToSelection(row: Record<string, unknown>): EtfSelectionRecord {
  const items = Array.isArray(row.items) ? row.items as EtfSelectionItem[] : [];
  return {
    beijingHour: String(row.beijing_hour),
    selectedAt: iso(row.selected_at),
    items,
  };
}

export async function getLatestEtfSelection(): Promise<EtfSelectionRecord | null> {
  if (storageMode() === "memory") {
    const records = [...selectionMemory.values()].sort((left, right) => right.beijingHour.localeCompare(left.beijingHour));
    return records[0] ?? null;
  }
  const result = await runEtfQuery(
    "SELECT beijing_hour, selected_at, items FROM etf_topic_selections ORDER BY beijing_hour DESC LIMIT 1",
  );
  return result.rows.length ? rowToSelection(result.rows[0]) : null;
}

export async function listEtfSelectionsForDates(dateKeys: string[]): Promise<EtfSelectionRecord[]> {
  if (!dateKeys.length) return [];
  if (storageMode() === "memory") {
    return [...selectionMemory.values()]
      .filter((record) => dateKeys.includes(record.beijingHour.slice(0, 10)))
      .sort((left, right) => left.beijingHour.localeCompare(right.beijingHour));
  }
  const result = await runEtfQuery(`
    SELECT beijing_hour, selected_at, items
    FROM etf_topic_selections
    WHERE substring(beijing_hour, 1, 10) = ANY($1)
    ORDER BY beijing_hour ASC
  `, [dateKeys]);
  return result.rows.map(rowToSelection);
}

export async function saveEtfDigest(record: EtfDigestRecord): Promise<void> {
  if (storageMode() === "memory") {
    digestMemory.set(`${record.kind}:${record.periodKey}`, record);
    return;
  }
  await runEtfQuery(`
    INSERT INTO etf_topic_digests (kind, period_key, title_zh, content, generator, created_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    ON CONFLICT (kind, period_key) DO UPDATE SET
      title_zh = EXCLUDED.title_zh, content = EXCLUDED.content, generator = EXCLUDED.generator
  `, [record.kind, record.periodKey, record.titleZh, JSON.stringify(record.content), record.generator, record.createdAt]);
}

function rowToDigest(row: Record<string, unknown>): EtfDigestRecord {
  return {
    kind: row.kind === "weekly" ? "weekly" : "daily",
    periodKey: String(row.period_key),
    titleZh: String(row.title_zh),
    content: row.content as EtfDigestContent,
    generator: row.generator === "ai" ? "ai" : "deterministic",
    createdAt: iso(row.created_at),
  };
}

export async function getEtfDigest(kind: "daily" | "weekly", periodKey: string): Promise<EtfDigestRecord | null> {
  if (storageMode() === "memory") return digestMemory.get(`${kind}:${periodKey}`) ?? null;
  const result = await runEtfQuery(
    "SELECT kind, period_key, title_zh, content, generator, created_at FROM etf_topic_digests WHERE kind = $1 AND period_key = $2",
    [kind, periodKey],
  );
  return result.rows.length ? rowToDigest(result.rows[0]) : null;
}

export async function listEtfDigests(kind: "daily" | "weekly", limit = 7): Promise<EtfDigestRecord[]> {
  if (storageMode() === "memory") {
    return [...digestMemory.values()]
      .filter((record) => record.kind === kind)
      .sort((left, right) => right.periodKey.localeCompare(left.periodKey))
      .slice(0, limit);
  }
  const result = await runEtfQuery(
    "SELECT kind, period_key, title_zh, content, generator, created_at FROM etf_topic_digests WHERE kind = $1 ORDER BY period_key DESC LIMIT $2",
    [kind, limit],
  );
  return result.rows.map(rowToDigest);
}

async function listObservationsForPosts(postIds: string[]): Promise<Map<string, EtfObservation[]>> {
  const series = new Map<string, EtfObservation[]>();
  if (!postIds.length) return series;
  if (storageMode() === "memory") {
    for (const postId of postIds) {
      series.set(postId, (observationMemory.get(postId) ?? []).slice(-24));
    }
    return series;
  }
  const result = await runEtfQuery(`
    SELECT post_id, observed_at, score, comments, engagement, rank
    FROM (
      SELECT post_id, observed_at, score, comments, engagement, rank,
             ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY observed_at DESC) AS recency
      FROM etf_topic_observations
      WHERE post_id = ANY($1)
    ) AS ranked
    WHERE recency <= 24
    ORDER BY post_id, observed_at ASC
  `, [postIds]);
  for (const row of result.rows) {
    const postId = String(row.post_id);
    const list = series.get(postId) ?? [];
    list.push({
      postId,
      observedAt: iso(row.observed_at),
      score: count(row.score),
      comments: count(row.comments),
      engagement: count(row.engagement),
      rank: row.rank === null || row.rank === undefined ? null : count(row.rank),
    });
    series.set(postId, list);
  }
  return series;
}

async function listTopAuthors(nowIso: string): Promise<Array<{ author: string; posts: number; peakEngagement: number }>> {
  const sinceIso = new Date(new Date(nowIso).getTime() - 7 * 24 * 3_600_000).toISOString();
  if (storageMode() === "memory") {
    const stats = new Map<string, { posts: number; peakEngagement: number }>();
    for (const post of postMemory.values()) {
      if (!post.author || post.firstTrackedAt < sinceIso) continue;
      const entry = stats.get(post.author) ?? { posts: 0, peakEngagement: 0 };
      entry.posts += 1;
      entry.peakEngagement = Math.max(entry.peakEngagement, post.peakEngagement);
      stats.set(post.author, entry);
    }
    return [...stats.entries()]
      .sort(([, left], [, right]) => right.peakEngagement - left.peakEngagement)
      .slice(0, 8)
      .map(([author, entry]) => ({ author, ...entry }));
  }
  const result = await runEtfQuery(`
    SELECT author, COUNT(*)::text AS posts, MAX(peak_engagement)::text AS peak
    FROM etf_topic_posts
    WHERE author <> '' AND first_tracked_at >= $1
    GROUP BY author
    ORDER BY MAX(peak_engagement) DESC
    LIMIT 8
  `, [sinceIso]);
  return result.rows.map((row) => ({
    author: String(row.author),
    posts: count(row.posts),
    peakEngagement: count(row.peak),
  }));
}

export async function getEtfTopicsView(nowIso = new Date().toISOString()): Promise<EtfTopicsView> {
  const [latestSelection, tracked, topAuthors, dailyDigests, weeklyDigests] = await Promise.all([
    getLatestEtfSelection(),
    getActiveEtfTracked(nowIso),
    listTopAuthors(nowIso),
    listEtfDigests("daily", 7),
    listEtfDigests("weekly", 1),
  ]);
  const observations = await listObservationsForPosts(tracked.map((post) => post.id));
  return {
    updatedAt: latestSelection?.selectedAt ?? null,
    storageMode: storageMode(),
    latestSelection,
    tracked: tracked.map((post) => ({
      ...post,
      active: post.trackingUntil > nowIso,
      observations: observations.get(post.id) ?? [],
    })),
    topAuthors,
    dailyDigests,
    weeklyDigest: weeklyDigests[0] ?? null,
  };
}
