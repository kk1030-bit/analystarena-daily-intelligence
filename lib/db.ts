import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type {
  BriefRecord,
  BriefStatus,
  DailyBrief,
  RawStory,
  RedditPost,
  RedditSearchOptions,
  RedditSearchResult,
  StockPriceDaily,
  StockPriceSummary,
  StockProfile,
  StockSearchResult,
  StockSyncPayload,
  StockSyncRun,
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

interface StockProfileRow {
  symbol: string;
  provider_symbol: string;
  short_name: string | null;
  long_name: string | null;
  exchange: string | null;
  currency: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  website: string | null;
  business_summary: string | null;
  market_cap: string | number | null;
  average_volume_3m: string | number | null;
  aliases: string[] | string;
  exposure_tags: string[] | string;
  active: boolean;
  profile_fetch_ok: boolean;
  source_updated_at: string | Date;
  latest_price?: StockPriceRow | null;
  price_summary?: StockPriceSummaryRow | null;
}

interface StockPriceSummaryRow {
  as_of: string | Date | null;
  last_price: string | number | null;
  previous_close: string | number | null;
  close_5_sessions_ago: string | number | null;
  latest_volume: string | number | null;
  average_volume_20d: string | number | null;
}

interface StockPriceRow {
  symbol: string;
  trading_date: string | Date;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  adjusted_close: string | number | null;
  volume: string | number | null;
  dividends: string | number | null;
  stock_splits: string | number | null;
  source_updated_at: string | Date;
}

declare global {
  var __analystArenaPool: Pool | undefined;
  var __analystArenaSchemaReady: Promise<void> | undefined;
  var __analystArenaMemory: Map<string, MemoryEntry> | undefined;
  var __analystArenaRedditMemory: Map<string, RedditPost> | undefined;
  var __analystArenaStockMemory: Map<string, StockProfile> | undefined;
  var __analystArenaStockPriceMemory: Map<string, StockPriceDaily> | undefined;
  var __analystArenaStockRunMemory: Map<string, StockSyncRun> | undefined;
  var __analystArenaStockSeedLoaded: boolean | undefined;
}

const memory = globalThis.__analystArenaMemory ?? new Map<string, MemoryEntry>();
globalThis.__analystArenaMemory = memory;
const redditMemory = globalThis.__analystArenaRedditMemory ?? new Map<string, RedditPost>();
globalThis.__analystArenaRedditMemory = redditMemory;
const stockMemory = globalThis.__analystArenaStockMemory ?? new Map<string, StockProfile>();
globalThis.__analystArenaStockMemory = stockMemory;
const stockPriceMemory = globalThis.__analystArenaStockPriceMemory ?? new Map<string, StockPriceDaily>();
globalThis.__analystArenaStockPriceMemory = stockPriceMemory;
const stockRunMemory = globalThis.__analystArenaStockRunMemory ?? new Map<string, StockSyncRun>();
globalThis.__analystArenaStockRunMemory = stockRunMemory;

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

      CREATE TABLE IF NOT EXISTS stock_profiles (
        symbol TEXT PRIMARY KEY,
        provider_symbol TEXT NOT NULL,
        short_name TEXT,
        long_name TEXT,
        exchange TEXT,
        currency TEXT,
        country TEXT,
        sector TEXT,
        industry TEXT,
        website TEXT,
        business_summary TEXT,
        market_cap NUMERIC,
        average_volume_3m BIGINT,
        aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
        exposure_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        profile_fetch_ok BOOLEAN NOT NULL DEFAULT TRUE,
        source_updated_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS stock_profiles_active_market_cap_idx
        ON stock_profiles (active, market_cap DESC NULLS LAST);
      ALTER TABLE stock_profiles
        ADD COLUMN IF NOT EXISTS profile_fetch_ok BOOLEAN NOT NULL DEFAULT TRUE;
      CREATE INDEX IF NOT EXISTS stock_profiles_search_idx
        ON stock_profiles USING GIN (to_tsvector('simple',
          coalesce(symbol, '') || ' ' || coalesce(short_name, '') || ' ' ||
          coalesce(long_name, '') || ' ' || coalesce(sector, '') || ' ' || coalesce(industry, '')
        ));

      CREATE TABLE IF NOT EXISTS stock_prices_daily (
        symbol TEXT NOT NULL REFERENCES stock_profiles(symbol) ON DELETE CASCADE,
        trading_date DATE NOT NULL,
        open NUMERIC,
        high NUMERIC,
        low NUMERIC,
        close NUMERIC,
        adjusted_close NUMERIC,
        volume BIGINT,
        dividends NUMERIC,
        stock_splits NUMERIC,
        source_updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (symbol, trading_date)
      );
      CREATE INDEX IF NOT EXISTS stock_prices_symbol_date_idx
        ON stock_prices_daily (symbol, trading_date DESC);

      CREATE TABLE IF NOT EXISTS stock_sync_runs (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
        source_version TEXT NOT NULL,
        errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        profile_count INTEGER NOT NULL DEFAULT 0,
        price_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
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

function optionalNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function jsonStringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function stockRowToProfile(row: StockProfileRow): StockProfile {
  return {
    symbol: row.symbol,
    providerSymbol: row.provider_symbol,
    shortName: row.short_name ?? undefined,
    longName: row.long_name ?? undefined,
    exchange: row.exchange ?? undefined,
    currency: row.currency ?? undefined,
    country: row.country ?? undefined,
    sector: row.sector ?? undefined,
    industry: row.industry ?? undefined,
    website: row.website ?? undefined,
    businessSummary: row.business_summary ?? undefined,
    marketCap: optionalNumber(row.market_cap),
    averageVolume3m: optionalNumber(row.average_volume_3m),
    aliases: jsonStringArray(row.aliases),
    exposureTags: jsonStringArray(row.exposure_tags),
    active: row.active,
    profileFetchOk: row.profile_fetch_ok,
    sourceUpdatedAt: iso(row.source_updated_at),
  };
}

function stockRowToPrice(row: StockPriceRow): StockPriceDaily {
  return {
    symbol: row.symbol,
    tradingDate: dateOnly(row.trading_date),
    open: optionalNumber(row.open),
    high: optionalNumber(row.high),
    low: optionalNumber(row.low),
    close: optionalNumber(row.close),
    adjustedClose: optionalNumber(row.adjusted_close),
    volume: optionalNumber(row.volume),
    dividends: optionalNumber(row.dividends),
    stockSplits: optionalNumber(row.stock_splits),
    sourceUpdatedAt: iso(row.source_updated_at),
  };
}

function stockRowToPriceSummary(row: StockPriceSummaryRow): StockPriceSummary | undefined {
  if (!row.as_of) return undefined;
  return {
    asOf: dateOnly(row.as_of),
    lastPrice: optionalNumber(row.last_price),
    previousClose: optionalNumber(row.previous_close),
    close5SessionsAgo: optionalNumber(row.close_5_sessions_ago),
    latestVolume: optionalNumber(row.latest_volume),
    averageVolume20d: optionalNumber(row.average_volume_20d),
  };
}

function loadStockSeed(): void {
  if (globalThis.__analystArenaStockSeedLoaded) return;
  globalThis.__analystArenaStockSeedLoaded = true;
  const seedPath = path.join(process.cwd(), "data", "us-stocks-core.json");
  if (!existsSync(seedPath)) return;
  try {
    const seed = JSON.parse(readFileSync(seedPath, "utf8")) as Partial<StockSyncPayload>;
    for (const profile of seed.profiles ?? []) stockMemory.set(profile.symbol, structuredClone(profile));
    for (const price of seed.prices ?? []) stockPriceMemory.set(`${price.symbol}:${price.tradingDate}`, structuredClone(price));
    if (seed.run) stockRunMemory.set(seed.run.id, structuredClone(seed.run));
  } catch (error) {
    console.warn("Unable to load bundled stock seed", error);
  }
}

function latestMemoryPrice(symbol: string, asOfDate?: string): StockPriceDaily | undefined {
  return [...stockPriceMemory.values()]
    .filter((price) => price.symbol === symbol && (!asOfDate || price.tradingDate <= asOfDate))
    .sort((left, right) => right.tradingDate.localeCompare(left.tradingDate))[0];
}

function memoryPriceSummary(symbol: string, asOfDate?: string): StockPriceSummary | undefined {
  const prices = [...stockPriceMemory.values()]
    .filter((price) => price.symbol === symbol && (!asOfDate || price.tradingDate <= asOfDate))
    .sort((left, right) => right.tradingDate.localeCompare(left.tradingDate))
    .slice(0, 21);
  const latest = prices[0];
  if (!latest) return undefined;
  const closingPrice = (price: StockPriceDaily | undefined) => price?.adjustedClose ?? price?.close;
  const comparisonVolumes = prices.slice(1, 21).map((price) => price.volume).filter((value): value is number => value !== undefined);
  return {
    asOf: latest.tradingDate,
    lastPrice: closingPrice(latest),
    previousClose: closingPrice(prices[1]),
    close5SessionsAgo: closingPrice(prices[5]),
    latestVolume: latest.volume,
    averageVolume20d: comparisonVolumes.length
      ? comparisonVolumes.reduce((sum, value) => sum + value, 0) / comparisonVolumes.length
      : undefined,
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

export async function saveStockSync(payload: StockSyncPayload): Promise<{ profiles: number; prices: number }> {
  if (storageMode() === "memory") {
    loadStockSeed();
    for (const profile of payload.profiles) {
      const existing = stockMemory.get(profile.symbol);
      if (existing && Date.parse(profile.sourceUpdatedAt) < Date.parse(existing.sourceUpdatedAt)) continue;
      if (existing && profile.profileFetchOk === false) {
        stockMemory.set(profile.symbol, {
          ...existing,
          providerSymbol: profile.providerSymbol,
          aliases: profile.aliases,
          exposureTags: profile.exposureTags,
          active: profile.active,
          profileFetchOk: false,
          sourceUpdatedAt: profile.sourceUpdatedAt,
        });
      } else if (existing) {
        stockMemory.set(profile.symbol, {
          ...existing,
          ...structuredClone(profile),
          shortName: profile.shortName ?? existing.shortName,
          longName: profile.longName ?? existing.longName,
          exchange: profile.exchange ?? existing.exchange,
          currency: profile.currency ?? existing.currency,
          country: profile.country ?? existing.country,
          sector: profile.sector ?? existing.sector,
          industry: profile.industry ?? existing.industry,
          website: profile.website ?? existing.website,
          businessSummary: profile.businessSummary ?? existing.businessSummary,
          marketCap: profile.marketCap ?? existing.marketCap,
          averageVolume3m: profile.averageVolume3m ?? existing.averageVolume3m,
        });
      } else {
        stockMemory.set(profile.symbol, structuredClone(profile));
      }
    }
    for (const price of payload.prices) {
      const key = `${price.symbol}:${price.tradingDate}`;
      const existing = stockPriceMemory.get(key);
      if (!existing || Date.parse(price.sourceUpdatedAt) >= Date.parse(existing.sourceUpdatedAt)) stockPriceMemory.set(key, structuredClone(price));
    }
    const existingRun = stockRunMemory.get(payload.run.id);
    if (!(existingRun && existingRun.status !== "running" && payload.run.status === "running")) {
      stockRunMemory.set(payload.run.id, structuredClone({
        ...payload.run,
        profileCount: payload.run.profileCount ?? payload.profiles.length,
        priceCount: payload.run.priceCount ?? payload.prices.length,
      }));
    }
    return { profiles: payload.profiles.length, prices: payload.prices.length };
  }

  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (payload.profiles.length) {
      await client.query(`
        INSERT INTO stock_profiles (
          symbol, provider_symbol, short_name, long_name, exchange, currency, country,
          sector, industry, website, business_summary, market_cap, average_volume_3m,
          aliases, exposure_tags, active, profile_fetch_ok, source_updated_at
        )
        SELECT item.symbol, item.provider_symbol, item.short_name, item.long_name,
          item.exchange, item.currency, item.country, item.sector, item.industry,
          item.website, item.business_summary, item.market_cap, item.average_volume_3m,
          item.aliases, item.exposure_tags, item.active, item.profile_fetch_ok, item.source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS item(
          symbol TEXT, provider_symbol TEXT, short_name TEXT, long_name TEXT,
          exchange TEXT, currency TEXT, country TEXT, sector TEXT, industry TEXT,
          website TEXT, business_summary TEXT, market_cap NUMERIC, average_volume_3m BIGINT,
          aliases JSONB, exposure_tags JSONB, active BOOLEAN, profile_fetch_ok BOOLEAN, source_updated_at TIMESTAMPTZ
        )
        ON CONFLICT (symbol) DO UPDATE SET
          provider_symbol = EXCLUDED.provider_symbol,
          short_name = COALESCE(EXCLUDED.short_name, stock_profiles.short_name),
          long_name = COALESCE(EXCLUDED.long_name, stock_profiles.long_name),
          exchange = COALESCE(EXCLUDED.exchange, stock_profiles.exchange),
          currency = COALESCE(EXCLUDED.currency, stock_profiles.currency),
          country = COALESCE(EXCLUDED.country, stock_profiles.country),
          sector = COALESCE(EXCLUDED.sector, stock_profiles.sector),
          industry = COALESCE(EXCLUDED.industry, stock_profiles.industry),
          website = COALESCE(EXCLUDED.website, stock_profiles.website),
          business_summary = COALESCE(EXCLUDED.business_summary, stock_profiles.business_summary),
          market_cap = COALESCE(EXCLUDED.market_cap, stock_profiles.market_cap),
          average_volume_3m = COALESCE(EXCLUDED.average_volume_3m, stock_profiles.average_volume_3m),
          aliases = EXCLUDED.aliases,
          exposure_tags = EXCLUDED.exposure_tags,
          active = EXCLUDED.active,
          profile_fetch_ok = EXCLUDED.profile_fetch_ok,
          source_updated_at = EXCLUDED.source_updated_at,
          updated_at = NOW()
        WHERE EXCLUDED.source_updated_at >= stock_profiles.source_updated_at
      `, [JSON.stringify(payload.profiles.map((profile) => ({
        symbol: profile.symbol,
        provider_symbol: profile.providerSymbol,
        short_name: profile.shortName ?? null,
        long_name: profile.longName ?? null,
        exchange: profile.exchange ?? null,
        currency: profile.currency ?? null,
        country: profile.country ?? null,
        sector: profile.sector ?? null,
        industry: profile.industry ?? null,
        website: profile.website ?? null,
        business_summary: profile.businessSummary ?? null,
        market_cap: profile.marketCap ?? null,
        average_volume_3m: profile.averageVolume3m ?? null,
        aliases: profile.aliases,
        exposure_tags: profile.exposureTags,
        active: profile.active,
        profile_fetch_ok: profile.profileFetchOk !== false,
        source_updated_at: profile.sourceUpdatedAt,
      }))) ]);
    }
    if (payload.prices.length) {
      await client.query(`
        INSERT INTO stock_prices_daily (
          symbol, trading_date, open, high, low, close, adjusted_close, volume,
          dividends, stock_splits, source_updated_at
        )
        SELECT item.symbol, item.trading_date, item.open, item.high, item.low, item.close,
          item.adjusted_close, item.volume, item.dividends, item.stock_splits, item.source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS item(
          symbol TEXT, trading_date DATE, open NUMERIC, high NUMERIC, low NUMERIC,
          close NUMERIC, adjusted_close NUMERIC, volume BIGINT, dividends NUMERIC,
          stock_splits NUMERIC, source_updated_at TIMESTAMPTZ
        )
        ON CONFLICT (symbol, trading_date) DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
          close = EXCLUDED.close, adjusted_close = EXCLUDED.adjusted_close,
          volume = EXCLUDED.volume, dividends = EXCLUDED.dividends,
          stock_splits = EXCLUDED.stock_splits, source_updated_at = EXCLUDED.source_updated_at
        WHERE EXCLUDED.source_updated_at >= stock_prices_daily.source_updated_at
      `, [JSON.stringify(payload.prices.map((price) => ({
        symbol: price.symbol,
        trading_date: price.tradingDate,
        open: price.open ?? null,
        high: price.high ?? null,
        low: price.low ?? null,
        close: price.close ?? null,
        adjusted_close: price.adjustedClose ?? null,
        volume: price.volume ?? null,
        dividends: price.dividends ?? null,
        stock_splits: price.stockSplits ?? null,
        source_updated_at: price.sourceUpdatedAt,
      }))) ]);
    }
    await client.query(`
      INSERT INTO stock_sync_runs (
        id, started_at, completed_at, status, source_version, errors, profile_count, price_count
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        completed_at = CASE
          WHEN stock_sync_runs.status <> 'running' AND EXCLUDED.status = 'running' THEN stock_sync_runs.completed_at
          ELSE EXCLUDED.completed_at
        END,
        status = CASE
          WHEN stock_sync_runs.status <> 'running' AND EXCLUDED.status = 'running' THEN stock_sync_runs.status
          ELSE EXCLUDED.status
        END,
        source_version = EXCLUDED.source_version,
        errors = CASE
          WHEN stock_sync_runs.status <> 'running' AND EXCLUDED.status = 'running' THEN stock_sync_runs.errors
          ELSE EXCLUDED.errors
        END,
        profile_count = CASE
          WHEN stock_sync_runs.status <> 'running' AND EXCLUDED.status = 'running' THEN stock_sync_runs.profile_count
          ELSE EXCLUDED.profile_count
        END,
        price_count = CASE
          WHEN stock_sync_runs.status <> 'running' AND EXCLUDED.status = 'running' THEN stock_sync_runs.price_count
          ELSE EXCLUDED.price_count
        END,
        updated_at = NOW()
    `, [payload.run.id, payload.run.startedAt, payload.run.completedAt ?? null, payload.run.status,
      payload.run.sourceVersion, JSON.stringify(payload.run.errors),
      payload.run.profileCount ?? payload.profiles.length,
      payload.run.priceCount ?? payload.prices.length]);
    await client.query("COMMIT");
    return { profiles: payload.profiles.length, prices: payload.prices.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function searchStockProfiles(query = "", limit = 30, asOfDate?: string): Promise<StockSearchResult> {
  const normalized = query.trim().toLocaleLowerCase();
  const safeLimit = Math.max(1, Math.min(2_500, Math.trunc(limit)));
  if (storageMode() === "memory") {
    loadStockSeed();
    const items = [...stockMemory.values()]
      .filter((profile) => profile.active)
      .filter((profile) => {
        if (!normalized) return true;
        const document = [profile.symbol, profile.providerSymbol, profile.shortName, profile.longName,
          profile.sector, profile.industry, ...profile.aliases, ...profile.exposureTags].filter(Boolean).join(" ").toLocaleLowerCase();
        return document.includes(normalized);
      })
      .sort((left, right) => {
        const leftExact = [left.symbol, left.providerSymbol].some((value) => value.toLocaleLowerCase() === normalized) ? 1 : 0;
        const rightExact = [right.symbol, right.providerSymbol].some((value) => value.toLocaleLowerCase() === normalized) ? 1 : 0;
        return rightExact - leftExact || (right.marketCap ?? 0) - (left.marketCap ?? 0);
      })
      .slice(0, safeLimit)
      .map((profile) => ({
        ...structuredClone(profile),
        latestPrice: latestMemoryPrice(profile.symbol, asOfDate),
        priceSummary: memoryPriceSummary(profile.symbol, asOfDate),
      }));
    return { items };
  }

  await ensureSchema();
  const result = await pool().query<StockProfileRow>(`
    SELECT profile.*, CASE WHEN latest.symbol IS NULL THEN NULL ELSE to_jsonb(latest) END AS latest_price,
      CASE WHEN summary.as_of IS NULL THEN NULL ELSE to_jsonb(summary) END AS price_summary
    FROM stock_profiles profile
    LEFT JOIN LATERAL (
      SELECT price.symbol, price.trading_date, price.open, price.high, price.low, price.close,
        price.adjusted_close, price.volume, price.dividends, price.stock_splits, price.source_updated_at
      FROM stock_prices_daily price
      WHERE price.symbol = profile.symbol
        AND ($3::date IS NULL OR price.trading_date <= $3::date)
      ORDER BY price.trading_date DESC
      LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        MAX(CASE WHEN recent.ordinal = 1 THEN recent.trading_date END) AS as_of,
        MAX(CASE WHEN recent.ordinal = 1 THEN recent.price END) AS last_price,
        MAX(CASE WHEN recent.ordinal = 2 THEN recent.price END) AS previous_close,
        MAX(CASE WHEN recent.ordinal = 6 THEN recent.price END) AS close_5_sessions_ago,
        MAX(CASE WHEN recent.ordinal = 1 THEN recent.volume END) AS latest_volume,
        AVG(recent.volume) FILTER (WHERE recent.ordinal BETWEEN 2 AND 21) AS average_volume_20d
      FROM (
        SELECT price.trading_date, COALESCE(price.adjusted_close, price.close) AS price,
          price.volume, ROW_NUMBER() OVER (ORDER BY price.trading_date DESC) AS ordinal
        FROM stock_prices_daily price
        WHERE price.symbol = profile.symbol
          AND ($3::date IS NULL OR price.trading_date <= $3::date)
        ORDER BY price.trading_date DESC
        LIMIT 21
      ) recent
    ) summary ON TRUE
    WHERE profile.active = TRUE AND (
      $1 = '' OR lower(profile.symbol) = lower($1)
      OR lower(profile.provider_symbol) = lower($1)
      OR to_tsvector('simple', coalesce(profile.symbol, '') || ' ' || coalesce(profile.short_name, '') || ' ' ||
          coalesce(profile.long_name, '') || ' ' || coalesce(profile.sector, '') || ' ' || coalesce(profile.industry, ''))
        @@ websearch_to_tsquery('simple', $1)
      OR lower(profile.aliases::text) LIKE '%' || lower($1) || '%'
      OR lower(profile.exposure_tags::text) LIKE '%' || lower($1) || '%'
    )
    ORDER BY CASE WHEN lower(profile.symbol) = lower($1) OR lower(profile.provider_symbol) = lower($1) THEN 0 ELSE 1 END,
      profile.market_cap DESC NULLS LAST
    LIMIT $2
  `, [query.trim(), safeLimit, asOfDate ?? null]);
  return {
    items: result.rows.map((row) => ({
      ...stockRowToProfile(row),
      latestPrice: row.latest_price ? stockRowToPrice(row.latest_price) : undefined,
      priceSummary: row.price_summary ? stockRowToPriceSummary(row.price_summary) : undefined,
    })),
  };
}

export async function stocksForImpactEngine(asOfDate?: string): Promise<StockSearchResult["items"]> {
  return (await searchStockProfiles("", 2_500, asOfDate)).items;
}

export async function databaseHealth(): Promise<{
  mode: "postgres" | "memory";
  ok: boolean;
  redditPosts: number;
  stocks: number;
  stockPrices: number;
  lastStockSyncAt?: string;
  lastStockSyncOk?: boolean;
}> {
  if (storageMode() === "memory") {
    loadStockSeed();
    const lastRun = [...stockRunMemory.values()].sort((left, right) =>
      (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0];
    return {
      mode: "memory",
      ok: true,
      redditPosts: redditMemory.size,
      stocks: stockMemory.size,
      stockPrices: stockPriceMemory.size,
      lastStockSyncAt: lastRun?.completedAt ?? lastRun?.startedAt,
      lastStockSyncOk: lastRun ? lastRun.status === "success" : undefined,
    };
  }
  try {
    await ensureSchema();
    const result = await pool().query<{
      reddit_count: string;
      stock_count: string;
      price_count: string;
      last_sync_at: string | Date | null;
      last_sync_ok: boolean | null;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM reddit_posts) AS reddit_count,
        (SELECT COUNT(*)::text FROM stock_profiles WHERE active = TRUE) AS stock_count,
        (SELECT COUNT(*)::text FROM stock_prices_daily) AS price_count,
        (SELECT COALESCE(completed_at, started_at) FROM stock_sync_runs ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 1) AS last_sync_at,
        (SELECT status = 'success' FROM stock_sync_runs ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 1) AS last_sync_ok
    `);
    const row = result.rows[0];
    return {
      mode: "postgres",
      ok: true,
      redditPosts: Number(row?.reddit_count ?? 0),
      stocks: Number(row?.stock_count ?? 0),
      stockPrices: Number(row?.price_count ?? 0),
      lastStockSyncAt: row?.last_sync_at ? iso(row.last_sync_at) : undefined,
      lastStockSyncOk: row?.last_sync_ok ?? undefined,
    };
  } catch {
    return { mode: "postgres", ok: false, redditPosts: 0, stocks: 0, stockPrices: 0 };
  }
}
