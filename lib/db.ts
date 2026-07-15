import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  BriefRecord,
  BriefStatus,
  DailyBrief,
  RawStory,
  RedditPost,
  RedditSearchOptions,
  RedditSearchResult,
  TimestampKind,
} from "./types";

interface DatabaseRow {
  id: string;
  brief_date: string | Date;
  status: BriefStatus;
  payload: DailyBrief | string;
  created_at: string | Date;
  updated_at: string | Date;
  published_at: string | Date | null;
  has_pdf: boolean;
}

interface MemoryEntry extends BriefRecord {
  pdf?: Buffer;
}

interface RedditDatabaseRow {
  id: string;
  subreddit: string;
  title: string;
  description: string;
  url: string;
  source: string;
  engagement: number | string;
  published_at: string | Date;
  collected_at: string | Date;
  timestamp_kind: TimestampKind;
  created_at: string | Date;
  updated_at: string | Date;
}

declare global {
  var __analystArenaPool: Pool | undefined;
  var __analystArenaSchemaReady: Promise<void> | undefined;
  var __analystArenaMemory: Map<string, MemoryEntry> | undefined;
  var __analystArenaRedditMemory: Map<string, RedditPost> | undefined;
}

const memory = globalThis.__analystArenaMemory ?? new Map<string, MemoryEntry>();
globalThis.__analystArenaMemory = memory;
const redditMemory = globalThis.__analystArenaRedditMemory ?? new Map<string, RedditPost>();
globalThis.__analystArenaRedditMemory = redditMemory;

export function storageMode(): "postgres" | "memory" {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}

function pool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!globalThis.__analystArenaPool) {
    const isPrivateOrLocal = /localhost|127\.0\.0\.1|\.internal(?::|\/)/i.test(process.env.DATABASE_URL);
    globalThis.__analystArenaPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 8_000,
      ssl: isPrivateOrLocal ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalThis.__analystArenaPool;
}

async function ensureSchema(): Promise<void> {
  if (storageMode() === "memory") return;
  if (!globalThis.__analystArenaSchemaReady) {
    globalThis.__analystArenaSchemaReady = pool().query(`
      CREATE TABLE IF NOT EXISTS daily_briefs (
        id UUID PRIMARY KEY,
        brief_date DATE NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
        payload JSONB NOT NULL,
        pdf_data BYTEA,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS daily_briefs_status_date_idx
        ON daily_briefs (status, brief_date DESC);

      CREATE TABLE IF NOT EXISTS reddit_posts (
        id TEXT PRIMARY KEY,
        subreddit TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        source TEXT NOT NULL,
        engagement BIGINT NOT NULL DEFAULT 0,
        published_at TIMESTAMPTZ NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL,
        timestamp_kind TEXT NOT NULL CHECK (timestamp_kind IN ('published', 'collected')),
        search_document TSVECTOR GENERATED ALWAYS AS (
          to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(subreddit, ''))
        ) STORED,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS reddit_posts_search_idx
        ON reddit_posts USING GIN (search_document);
      CREATE INDEX IF NOT EXISTS reddit_posts_published_idx
        ON reddit_posts (published_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS reddit_posts_subreddit_published_idx
        ON reddit_posts (subreddit, published_at DESC, id DESC);
    `).then(() => undefined);
  }
  await globalThis.__analystArenaSchemaReady;
}

function dateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function rowToRecord(row: DatabaseRow): BriefRecord {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as DailyBrief : row.payload;
  const brief: DailyBrief = {
    ...payload,
    id: row.id,
    status: row.status,
    publishedAt: row.published_at ? iso(row.published_at) : undefined,
    storageMode: "postgres",
  };
  return {
    id: row.id,
    date: dateOnly(row.brief_date),
    status: row.status,
    brief,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: row.published_at ? iso(row.published_at) : undefined,
    hasPdf: row.has_pdf,
  };
}

function cloneMemory(entry: MemoryEntry): BriefRecord {
  return {
    id: entry.id,
    date: entry.date,
    status: entry.status,
    brief: structuredClone(entry.brief),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    publishedAt: entry.publishedAt,
    hasPdf: Boolean(entry.pdf),
  };
}

function normalizeSubreddit(value: string): string {
  return value.trim().replace(/^r\//i, "").replace(/[^a-z0-9_+-]/gi, "").toLowerCase() || "unknown";
}

function subredditFromStory(story: RawStory): string {
  const sourceMatch = story.source.match(/(?:^|\s)r\/([a-z0-9_+-]+)/i);
  if (sourceMatch?.[1]) return normalizeSubreddit(sourceMatch[1]);
  try {
    const urlMatch = new URL(story.url).pathname.match(/\/r\/([^/]+)/i);
    if (urlMatch?.[1]) return normalizeSubreddit(decodeURIComponent(urlMatch[1]));
  } catch {
    // Invalid external URLs are still retained; their subreddit remains unknown.
  }
  return "unknown";
}

function validIso(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function redditRowToPost(row: RedditDatabaseRow): RedditPost {
  return {
    id: row.id,
    subreddit: row.subreddit,
    title: row.title,
    description: row.description,
    url: row.url,
    source: row.source,
    engagement: Number(row.engagement) || 0,
    publishedAt: iso(row.published_at),
    collectedAt: iso(row.collected_at),
    timestampKind: row.timestamp_kind,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function encodeRedditCursor(post: RedditPost): string {
  return Buffer.from(JSON.stringify({ publishedAt: post.publishedAt, id: post.id })).toString("base64url");
}

export async function saveRedditStories(stories: RawStory[]): Promise<number> {
  if (!stories.length) return 0;
  const now = new Date().toISOString();
  const posts = stories.map((story) => {
    const collectedAt = validIso(story.collectedAt, now);
    return {
      id: story.id,
      subreddit: subredditFromStory(story),
      title: story.title,
      description: story.description,
      url: story.url,
      source: story.source,
      engagement: Math.max(0, Math.trunc(story.engagement ?? 0)),
      published_at: validIso(story.publishedAt, collectedAt),
      collected_at: collectedAt,
      timestamp_kind: story.timestampKind ?? "published",
    };
  });

  if (storageMode() === "memory") {
    for (const post of posts) {
      const existing = redditMemory.get(post.id);
      redditMemory.set(post.id, {
        id: post.id,
        subreddit: post.subreddit,
        title: post.title,
        description: post.description,
        url: post.url,
        source: post.source,
        engagement: post.engagement,
        publishedAt: post.published_at,
        collectedAt: post.collected_at,
        timestampKind: post.timestamp_kind,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    return posts.length;
  }

  await ensureSchema();
  const result = await pool().query(`
    INSERT INTO reddit_posts (
      id, subreddit, title, description, url, source, engagement,
      published_at, collected_at, timestamp_kind
    )
    SELECT
      item.id, item.subreddit, item.title, item.description, item.url, item.source,
      item.engagement, item.published_at, item.collected_at, item.timestamp_kind
    FROM jsonb_to_recordset($1::jsonb) AS item(
      id TEXT, subreddit TEXT, title TEXT, description TEXT, url TEXT, source TEXT,
      engagement BIGINT, published_at TIMESTAMPTZ, collected_at TIMESTAMPTZ, timestamp_kind TEXT
    )
    ON CONFLICT (id) DO UPDATE SET
      subreddit = EXCLUDED.subreddit,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      url = EXCLUDED.url,
      source = EXCLUDED.source,
      engagement = EXCLUDED.engagement,
      published_at = EXCLUDED.published_at,
      collected_at = EXCLUDED.collected_at,
      timestamp_kind = EXCLUDED.timestamp_kind,
      updated_at = NOW()
  `, [JSON.stringify(posts)]);
  return result.rowCount ?? 0;
}

export async function searchRedditPosts(options: RedditSearchOptions): Promise<RedditSearchResult> {
  const normalizedSubreddit = options.subreddit ? normalizeSubreddit(options.subreddit) : undefined;
  if (storageMode() === "memory") {
    const query = options.q?.toLocaleLowerCase() ?? "";
    const filtered = [...redditMemory.values()]
      .filter((post) => !query || `${post.title} ${post.description} ${post.subreddit}`.toLocaleLowerCase().includes(query))
      .filter((post) => !normalizedSubreddit || post.subreddit === normalizedSubreddit)
      .filter((post) => !options.from || post.publishedAt >= options.from)
      .filter((post) => !options.to || post.publishedAt <= options.to)
      .filter((post) => !options.cursor || post.publishedAt < options.cursor.publishedAt || (post.publishedAt === options.cursor.publishedAt && post.id < options.cursor.id))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id));
    const hasNext = filtered.length > options.limit;
    const items = filtered.slice(0, options.limit).map((post) => structuredClone(post));
    return { items, nextCursor: hasNext && items.length ? encodeRedditCursor(items.at(-1)!) : undefined };
  }

  await ensureSchema();
  const values: unknown[] = [];
  const conditions: string[] = [];
  const addValue = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (options.q) {
    const parameter = addValue(options.q);
    conditions.push(`(
      search_document @@ websearch_to_tsquery('simple', ${parameter})
      OR POSITION(lower(${parameter}) IN lower(title)) > 0
      OR POSITION(lower(${parameter}) IN lower(description)) > 0
    )`);
  }
  if (normalizedSubreddit) conditions.push(`subreddit = ${addValue(normalizedSubreddit)}`);
  if (options.from) conditions.push(`published_at >= ${addValue(options.from)}::timestamptz`);
  if (options.to) conditions.push(`published_at <= ${addValue(options.to)}::timestamptz`);
  if (options.cursor) {
    const timestamp = addValue(options.cursor.publishedAt);
    const id = addValue(options.cursor.id);
    conditions.push(`(published_at, id) < (${timestamp}::timestamptz, ${id})`);
  }
  const limit = addValue(options.limit + 1);
  const result = await pool().query<RedditDatabaseRow>(`
    SELECT id, subreddit, title, description, url, source, engagement,
           published_at, collected_at, timestamp_kind, created_at, updated_at
    FROM reddit_posts
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY published_at DESC, id DESC
    LIMIT ${limit}
  `, values);
  const hasNext = result.rows.length > options.limit;
  const items = result.rows.slice(0, options.limit).map(redditRowToPost);
  return { items, nextCursor: hasNext && items.length ? encodeRedditCursor(items.at(-1)!) : undefined };
}

export async function saveDraft(brief: DailyBrief): Promise<BriefRecord> {
  if (storageMode() === "memory") {
    const existing = [...memory.values()].find((entry) => entry.date === brief.date);
    if (existing?.status === "published") return cloneMemory(existing);
    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    const entry: MemoryEntry = {
      id,
      date: brief.date,
      status: "draft",
      brief: { ...structuredClone(brief), id, status: "draft", storageMode: "memory" },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      hasPdf: false,
    };
    memory.set(id, entry);
    return cloneMemory(entry);
  }

  await ensureSchema();
  const id = randomUUID();
  const result = await pool().query<DatabaseRow>(`
    INSERT INTO daily_briefs (id, brief_date, status, payload)
    VALUES ($1, $2, 'draft', $3::jsonb)
    ON CONFLICT (brief_date) DO UPDATE
      SET payload = EXCLUDED.payload, status = 'draft', pdf_data = NULL,
          published_at = NULL, updated_at = NOW()
      WHERE daily_briefs.status <> 'published'
    RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
  `, [id, brief.date, JSON.stringify(brief)]);
  if (result.rows[0]) return rowToRecord(result.rows[0]);
  const existing = await getBriefByDate(brief.date);
  if (!existing) throw new Error("Unable to save daily brief");
  return existing;
}

export async function listBriefs(status?: BriefStatus, limit = 40): Promise<BriefRecord[]> {
  if (storageMode() === "memory") {
    return [...memory.values()]
      .filter((entry) => !status || entry.status === status)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map(cloneMemory);
  }
  await ensureSchema();
  const result = status
    ? await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE status = $1 ORDER BY brief_date DESC LIMIT $2`, [status, limit])
    : await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs ORDER BY brief_date DESC LIMIT $1`, [limit]);
  return result.rows.map(rowToRecord);
}

export async function getBrief(id: string): Promise<BriefRecord | null> {
  if (storageMode() === "memory") return memory.has(id) ? cloneMemory(memory.get(id)!) : null;
  await ensureSchema();
  const result = await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE id = $1`, [id]);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function getBriefByDate(date: string): Promise<BriefRecord | null> {
  if (storageMode() === "memory") {
    const entry = [...memory.values()].find((candidate) => candidate.date === date);
    return entry ? cloneMemory(entry) : null;
  }
  await ensureSchema();
  const result = await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE brief_date = $1`, [date]);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function getLatestPublished(): Promise<BriefRecord | null> {
  if (storageMode() === "memory") {
    const latest = [...memory.values()].filter((entry) => entry.status === "published").sort((a, b) => b.date.localeCompare(a.date))[0];
    return latest ? cloneMemory(latest) : null;
  }
  await ensureSchema();
  const result = await pool().query<DatabaseRow>(`SELECT *, (pdf_data IS NOT NULL) AS has_pdf FROM daily_briefs WHERE status = 'published' ORDER BY brief_date DESC LIMIT 1`);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function updateDraft(id: string, brief: DailyBrief): Promise<BriefRecord> {
  const current = await getBrief(id);
  if (!current) throw new Error("找不到这份日报");
  if (current.status !== "draft") throw new Error("已发布日报不可直接修改");
  if (storageMode() === "memory") {
    const entry = memory.get(id)!;
    entry.brief = { ...structuredClone(brief), id, status: "draft", storageMode: "memory" };
    entry.updatedAt = new Date().toISOString();
    memory.set(id, entry);
    return cloneMemory(entry);
  }
  const result = await pool().query<DatabaseRow>(`
    UPDATE daily_briefs SET payload = $2::jsonb, updated_at = NOW()
    WHERE id = $1 AND status = 'draft'
    RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
  `, [id, JSON.stringify(brief)]);
  if (!result.rows[0]) throw new Error("日报更新失败");
  return rowToRecord(result.rows[0]);
}

export async function publishBrief(id: string, brief: DailyBrief, pdf: Buffer): Promise<BriefRecord> {
  const now = new Date().toISOString();
  if (storageMode() === "memory") {
    const entry = memory.get(id);
    if (!entry) throw new Error("找不到这份日报");
    entry.status = "published";
    entry.publishedAt = now;
    entry.updatedAt = now;
    entry.pdf = pdf;
    entry.hasPdf = true;
    entry.brief = { ...structuredClone(brief), id, status: "published", publishedAt: now, storageMode: "memory" };
    memory.set(id, entry);
    return cloneMemory(entry);
  }
  await ensureSchema();
  const payload = { ...brief, id, status: "published" as const, publishedAt: now, storageMode: "postgres" as const };
  const result = await pool().query<DatabaseRow>(`
    UPDATE daily_briefs
      SET status = 'published', payload = $2::jsonb, pdf_data = $3,
          published_at = NOW(), updated_at = NOW()
    WHERE id = $1
    RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
  `, [id, JSON.stringify(payload), pdf]);
  if (!result.rows[0]) throw new Error("发布失败");
  return rowToRecord(result.rows[0]);
}

export async function getPublishedPdf(id: string): Promise<{ pdf: Buffer; date: string } | null> {
  if (storageMode() === "memory") {
    const entry = memory.get(id);
    return entry?.status === "published" && entry.pdf ? { pdf: entry.pdf, date: entry.date } : null;
  }
  await ensureSchema();
  const result = await pool().query<{ pdf_data: Buffer; brief_date: string | Date }>(`SELECT pdf_data, brief_date FROM daily_briefs WHERE id = $1 AND status = 'published' AND pdf_data IS NOT NULL`, [id]);
  return result.rows[0] ? { pdf: result.rows[0].pdf_data, date: dateOnly(result.rows[0].brief_date) } : null;
}

export async function databaseHealth(): Promise<{ mode: "postgres" | "memory"; ok: boolean; redditPosts: number }> {
  if (storageMode() === "memory") return { mode: "memory", ok: true, redditPosts: redditMemory.size };
  try {
    await ensureSchema();
    const result = await pool().query<{ count: string }>("SELECT COUNT(*)::text AS count FROM reddit_posts");
    return { mode: "postgres", ok: true, redditPosts: Number(result.rows[0]?.count ?? 0) };
  } catch {
    return { mode: "postgres", ok: false, redditPosts: 0 };
  }
}
