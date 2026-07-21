import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  aliasesForHeadline,
  briefPayloadHash,
  createStableEventIdentity,
  eventVersionMaterial,
  findSemanticEvent,
  mergeRetainedEvidence,
} from "./event-versioning";
import { ensureRawStoryIdentity } from "./source-identity";
import type {
  BriefSnapshotEventRecord,
  BriefSnapshotRecord,
  BriefSnapshotStream,
  BriefRecord,
  BriefStatus,
  CollectionRunRecord,
  DailyBrief,
  EventMatchMethod,
  EventRecord,
  EventVersionRecord,
  Headline,
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

interface MemoryEventEntry extends EventRecord {
  versions: EventVersionRecord[];
}

interface MemoryEventAlias {
  type: "document" | "url" | "legacy";
  key: string;
  eventId: string;
  canonicalUrl?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface MemorySourceDocument {
  story: RawStory;
  versions: Array<{
    id: string;
    versionNumber: number;
    previousVersionId?: string;
    contentHash: string;
    story: RawStory;
    collectedAt: string;
  }>;
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

interface CollectionRunRow {
  id: string;
  stream: BriefSnapshotStream;
  batch_key: string;
  status: "running" | "success" | "failed";
  brief_date: string | Date;
  input_hash: string | null;
  started_at: string | Date;
  completed_at: string | Date | null;
  error_code: string | null;
  error_detail: string | null;
}

interface BriefSnapshotRow {
  id: string;
  run_id: string;
  stream: BriefSnapshotStream;
  batch_key: string;
  sequence_number: number;
  brief_date: string | Date;
  generated_at: string | Date;
  previous_snapshot_id: string | null;
  payload_hash: string;
  payload: DailyBrief | string;
  created_at: string | Date;
}

interface EventDatabaseRow {
  id: string;
  stable_key: string;
  canonical_title: string;
  category: EventRecord["category"];
  ticker: string;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  identity_quality: EventRecord["identityQuality"];
  version_id: string | null;
  version_number: number | null;
  version_previous_id: string | null;
  version_content_hash: string | null;
  version_evidence_hash: string | null;
  version_state_hash: string | null;
  version_presentation_hash: string | null;
  version_observed_at: string | Date | null;
  version_run_id: string | null;
  version_payload: { headline?: Headline } | string | null;
  version_created_at: string | Date | null;
}

interface EventVersionRow {
  id: string;
  event_id: string;
  version_number: number;
  previous_version_id: string | null;
  content_hash: string;
  evidence_hash: string;
  state_hash: string;
  presentation_hash: string;
  observed_at: string | Date;
  run_id: string;
  payload: { headline?: Headline } | string;
  created_at: string | Date;
}

interface BriefSnapshotEventRow {
  snapshot_id: string;
  event_id: string;
  event_version_id: string;
  rank: number;
  ranking_score: number | string | null;
  freshness_score: number | string | null;
  impact: number;
  confidence: number;
  mentions: number;
  cross_source_count: number | null;
  match_method: EventMatchMethod;
  match_confidence: number | string;
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
  var __analystArenaEventMemory: Map<string, MemoryEventEntry> | undefined;
  var __analystArenaEventAliasMemory: Map<string, MemoryEventAlias> | undefined;
  var __analystArenaSourceDocumentMemory: Map<string, MemorySourceDocument> | undefined;
  var __analystArenaCollectionRunMemory: Map<string, CollectionRunRecord> | undefined;
  var __analystArenaBriefSnapshotMemory: Map<string, BriefSnapshotRecord> | undefined;
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
const eventMemory = globalThis.__analystArenaEventMemory ?? new Map<string, MemoryEventEntry>();
globalThis.__analystArenaEventMemory = eventMemory;
const eventAliasMemory = globalThis.__analystArenaEventAliasMemory ?? new Map<string, MemoryEventAlias>();
globalThis.__analystArenaEventAliasMemory = eventAliasMemory;
const sourceDocumentMemory = globalThis.__analystArenaSourceDocumentMemory ?? new Map<string, MemorySourceDocument>();
globalThis.__analystArenaSourceDocumentMemory = sourceDocumentMemory;
const collectionRunMemory = globalThis.__analystArenaCollectionRunMemory ?? new Map<string, CollectionRunRecord>();
globalThis.__analystArenaCollectionRunMemory = collectionRunMemory;
const briefSnapshotMemory = globalThis.__analystArenaBriefSnapshotMemory ?? new Map<string, BriefSnapshotRecord>();
globalThis.__analystArenaBriefSnapshotMemory = briefSnapshotMemory;

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

function migrationFiles(): string[] {
  const directory = path.join(process.cwd(), "db", "migrations");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /^\d+[_-].+\.sql$/i.test(file))
    .sort();
}

async function runMigrations(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('analystarena_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = new Set((await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((row) => row.id));
    for (const file of migrationFiles()) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(process.cwd(), "db", "migrations", file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function initializeSchema(): Promise<void> {
  await pool().query(`
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
    `);
  await runMigrations();
}

async function ensureSchema(): Promise<void> {
  if (storageMode() === "memory") return;
  if (!globalThis.__analystArenaSchemaReady) {
    const pending = initializeSchema();
    globalThis.__analystArenaSchemaReady = pending;
    pending.catch(() => {
      if (globalThis.__analystArenaSchemaReady === pending) globalThis.__analystArenaSchemaReady = undefined;
    });
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

function validIsoOrNow(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function collectionRunKey(stream: BriefSnapshotStream, batchKey: string): string {
  return `${stream}:${batchKey}`;
}

function safeBatchKey(brief: DailyBrief, stream: BriefSnapshotStream, value?: string): string {
  const fallback = `${brief.date}:${validIsoOrNow(brief.generatedAt)}`;
  const normalized = (value?.trim() || fallback).replace(/[^a-zA-Z0-9:._-]/g, "-").slice(0, 180);
  return normalized || `${stream}:${Date.now()}`;
}

function rowToCollectionRun(row: CollectionRunRow): CollectionRunRecord {
  return {
    id: row.id,
    stream: row.stream,
    batchKey: row.batch_key,
    status: row.status,
    briefDate: dateOnly(row.brief_date),
    inputHash: row.input_hash ?? undefined,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
    errorCode: row.error_code ?? undefined,
    errorDetail: row.error_detail ?? undefined,
  };
}

function rowToSnapshotEvent(row: BriefSnapshotEventRow): BriefSnapshotEventRecord {
  return {
    snapshotId: row.snapshot_id,
    eventId: row.event_id,
    eventVersionId: row.event_version_id,
    rank: row.rank,
    rankingScore: row.ranking_score === null ? undefined : Number(row.ranking_score),
    freshnessScore: row.freshness_score === null ? undefined : Number(row.freshness_score),
    impact: row.impact,
    confidence: row.confidence,
    mentions: row.mentions,
    crossSourceCount: row.cross_source_count ?? undefined,
    matchMethod: row.match_method,
    matchConfidence: Number(row.match_confidence),
  };
}

function rowToBriefSnapshot(row: BriefSnapshotRow, events: BriefSnapshotEventRecord[]): BriefSnapshotRecord {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as DailyBrief : row.payload;
  return {
    id: row.id,
    runId: row.run_id,
    stream: row.stream,
    batchKey: row.batch_key,
    sequenceNumber: row.sequence_number,
    date: dateOnly(row.brief_date),
    generatedAt: iso(row.generated_at),
    previousSnapshotId: row.previous_snapshot_id ?? undefined,
    payloadHash: row.payload_hash,
    brief: payload,
    createdAt: iso(row.created_at),
    events,
  };
}

function rowToEvent(row: EventDatabaseRow): EventRecord {
  return {
    id: row.id,
    stableKey: row.stable_key,
    canonicalTitle: row.canonical_title,
    category: row.category,
    ticker: row.ticker,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    identityQuality: row.identity_quality,
  };
}

function payloadHeadline(payload: EventDatabaseRow["version_payload"] | EventVersionRow["payload"]): Headline | undefined {
  if (!payload) return undefined;
  const parsed = typeof payload === "string" ? JSON.parse(payload) as { headline?: Headline } : payload;
  return parsed.headline;
}

function rowToEventVersion(row: EventVersionRow): EventVersionRecord {
  const headline = payloadHeadline(row.payload);
  if (!headline) throw new Error(`Event version ${row.id} has no headline payload`);
  return {
    id: row.id,
    eventId: row.event_id,
    versionNumber: row.version_number,
    previousVersionId: row.previous_version_id ?? undefined,
    contentHash: row.content_hash,
    evidenceHash: row.evidence_hash,
    stateHash: row.state_hash,
    presentationHash: row.presentation_hash,
    observedAt: iso(row.observed_at),
    runId: row.run_id,
    headline,
    createdAt: iso(row.created_at),
  };
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

function earlierIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export async function saveSourceStories(stories: RawStory[]): Promise<number> {
  if (!stories.length) return 0;
  const identified = stories.map(ensureRawStoryIdentity);
  const unique = [...new Map(identified.map((story) => [story.sourceDocumentId!, story])).values()];

  if (storageMode() === "memory") {
    for (const story of unique) {
      const documentId = story.sourceDocumentId!;
      const existing = sourceDocumentMemory.get(documentId);
      const firstCollectedAt = existing?.story.firstCollectedAt
        ? earlierIso(existing.story.firstCollectedAt, story.firstCollectedAt ?? story.collectedAt ?? existing.story.firstCollectedAt)
        : story.firstCollectedAt ?? story.collectedAt;
      const lastCollectedAt = existing?.story.lastCollectedAt
        ? laterIso(existing.story.lastCollectedAt, story.lastCollectedAt ?? story.collectedAt ?? existing.story.lastCollectedAt)
        : story.lastCollectedAt ?? story.collectedAt;
      const normalizedStory = { ...structuredClone(story), firstCollectedAt, lastCollectedAt };
      const previousVersion = existing?.versions.at(-1);
      const versions = existing?.versions ?? [];
      if (!previousVersion || previousVersion.contentHash !== normalizedStory.contentHash) {
        versions.push({
          id: randomUUID(),
          versionNumber: (previousVersion?.versionNumber ?? 0) + 1,
          previousVersionId: previousVersion?.id,
          contentHash: normalizedStory.contentHash!,
          story: structuredClone(normalizedStory),
          collectedAt: normalizedStory.lastCollectedAt ?? normalizedStory.collectedAt ?? new Date().toISOString(),
        });
      }
      sourceDocumentMemory.set(documentId, { story: normalizedStory, versions });
    }
    return unique.length;
  }

  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('analystarena_source_documents'))");
    for (const story of unique) {
      const firstCollectedAt = validIsoOrNow(story.firstCollectedAt ?? story.collectedAt);
      const lastCollectedAt = validIsoOrNow(story.lastCollectedAt ?? story.collectedAt);
      await client.query(`
        INSERT INTO source_documents (
          id, native_id, canonical_url, source_name, source_type,
          published_at, timestamp_kind, first_collected_at, last_collected_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          native_id = COALESCE(EXCLUDED.native_id, source_documents.native_id),
          canonical_url = EXCLUDED.canonical_url,
          source_name = EXCLUDED.source_name,
          source_type = EXCLUDED.source_type,
          published_at = CASE
            WHEN source_documents.timestamp_kind = 'collected' AND EXCLUDED.timestamp_kind = 'published'
              THEN EXCLUDED.published_at
            ELSE source_documents.published_at
          END,
          timestamp_kind = CASE
            WHEN source_documents.timestamp_kind = 'published' OR EXCLUDED.timestamp_kind = 'published'
              THEN 'published'
            ELSE 'collected'
          END,
          first_collected_at = LEAST(source_documents.first_collected_at, EXCLUDED.first_collected_at),
          last_collected_at = GREATEST(source_documents.last_collected_at, EXCLUDED.last_collected_at),
          updated_at = NOW()
      `, [
        story.sourceDocumentId,
        story.nativeId ?? null,
        story.canonicalUrl,
        story.source,
        story.sourceType,
        story.publishedAt,
        story.timestampKind ?? "published",
        firstCollectedAt,
        lastCollectedAt,
      ]);
      const previous = await client.query<{
        id: string;
        version_number: number;
        content_hash: string;
      }>(`
        SELECT id, version_number, content_hash
        FROM source_document_versions
        WHERE source_document_id = $1
        ORDER BY version_number DESC
        LIMIT 1
        FOR UPDATE
      `, [story.sourceDocumentId]);
      const latest = previous.rows[0];
      if (!latest || latest.content_hash !== story.contentHash) {
        await client.query(`
          INSERT INTO source_document_versions (
            id, source_document_id, version_number, previous_version_id,
            content_hash, payload, collected_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `, [
          randomUUID(),
          story.sourceDocumentId,
          (latest?.version_number ?? 0) + 1,
          latest?.id ?? null,
          story.contentHash,
          JSON.stringify(story),
          lastCollectedAt,
        ]);
      }
    }
    await client.query("COMMIT");
    return unique.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function saveRedditStories(stories: RawStory[]): Promise<number> {
  if (!stories.length) return 0;
  const now = new Date().toISOString();
  const posts = stories.map(ensureRawStoryIdentity).map((story) => {
    const collectedAt = validIso(story.collectedAt, now);
    return {
      id: story.sourceDocumentId!,
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
        publishedAt: existing?.timestampKind === "published" || post.timestamp_kind === "collected"
          ? existing?.publishedAt ?? post.published_at
          : post.published_at,
        collectedAt: existing?.collectedAt ? earlierIso(existing.collectedAt, post.collected_at) : post.collected_at,
        timestampKind: existing?.timestampKind === "published" || post.timestamp_kind === "published" ? "published" : "collected",
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
      published_at = CASE
        WHEN reddit_posts.timestamp_kind = 'collected' AND EXCLUDED.timestamp_kind = 'published'
          THEN EXCLUDED.published_at
        ELSE reddit_posts.published_at
      END,
      collected_at = LEAST(reddit_posts.collected_at, EXCLUDED.collected_at),
      timestamp_kind = CASE
        WHEN reddit_posts.timestamp_kind = 'published' OR EXCLUDED.timestamp_kind = 'published'
          THEN 'published'
        ELSE 'collected'
      END,
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

export interface PersistBriefOptions {
  stream?: BriefSnapshotStream;
  batchKey?: string;
  observedAt?: string;
}

type DailyBriefWrite =
  | { kind: "save_draft" }
  | { kind: "update_draft"; id: string; expectedSnapshotId?: string }
  | { kind: "publish"; id: string; pdf: Buffer; expectedSnapshotId?: string };

interface PersistBriefResult {
  snapshot: BriefSnapshotRecord;
  record?: BriefRecord;
}

export class EventIdentityConflictError extends Error {
  readonly code = "EVENT_IDENTITY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "EventIdentityConflictError";
  }
}

export class StaleBriefRevisionError extends Error {
  readonly code = "STALE_BRIEF_REVISION";

  constructor(message: string) {
    super(message);
    this.name = "StaleBriefRevisionError";
  }
}

function latestMemoryEventVersion(entry: MemoryEventEntry): EventVersionRecord | undefined {
  return entry.versions.at(-1);
}

function remapBriefRelations(brief: DailyBrief, idMap: Map<string, string>, headlines: Headline[]): DailyBrief {
  const remapTopic = (topic: DailyBrief["socialBuzz"]["reddit"][number]) => ({
    ...structuredClone(topic),
    relatedHeadlineId: topic.relatedHeadlineId ? (idMap.get(topic.relatedHeadlineId) ?? topic.relatedHeadlineId) : undefined,
  });
  return {
    ...structuredClone(brief),
    headlines,
    socialBuzz: {
      reddit: brief.socialBuzz.reddit.map(remapTopic),
      x: brief.socialBuzz.x.map(remapTopic),
    },
  };
}

function snapshotPayloadHash(brief: DailyBrief): string {
  return briefPayloadHash(brief.headlines, {
    date: brief.date,
    marketHeat: brief.marketHeat,
    socialBuzz: brief.socialBuzz,
    watchlist: brief.watchlist,
  });
}

async function persistBriefObservationMemory(
  brief: DailyBrief,
  options: Required<Pick<PersistBriefOptions, "stream" | "batchKey" | "observedAt">>,
  dailyWrite?: DailyBriefWrite,
): Promise<PersistBriefResult> {
  const runKey = collectionRunKey(options.stream, options.batchKey);
  const inputHash = snapshotPayloadHash(brief);
  const existingRun = collectionRunMemory.get(runKey);
  if (existingRun?.status === "success") {
    if (existingRun.inputHash && existingRun.inputHash !== inputHash) {
      throw new Error(`Idempotency key ${runKey} was reused with different brief content`);
    }
    const existingSnapshot = [...briefSnapshotMemory.values()].find((snapshot) => snapshot.runId === existingRun.id);
    if (!existingSnapshot) throw new Error(`Successful collection run ${existingRun.id} has no snapshot`);
    const record = dailyWrite?.kind === "save_draft"
      ? [...memory.values()].find((entry) => entry.date === brief.date)
      : dailyWrite ? memory.get(dailyWrite.id) : undefined;
    return { snapshot: structuredClone(existingSnapshot), record: record ? cloneMemory(record) : undefined };
  }

  if (dailyWrite?.kind === "update_draft" || dailyWrite?.kind === "publish") {
    const current = memory.get(dailyWrite.id);
    if (!current) throw new Error("Daily brief not found");
    if (current.status !== "draft") throw new Error("Published daily briefs are immutable");
    const expectedSnapshotId = dailyWrite.expectedSnapshotId;
    if (current.brief.snapshot?.id && !expectedSnapshotId) {
      throw new StaleBriefRevisionError("A snapshot revision is required before saving or publishing");
    }
    if (expectedSnapshotId && current.brief.snapshot?.id
      && expectedSnapshotId !== current.brief.snapshot.id) {
      throw new StaleBriefRevisionError("The daily brief changed after it was opened; reload before saving");
    }
  }

  const memoryBackup = structuredClone([...memory.entries()]);
  const eventBackup = structuredClone([...eventMemory.entries()]);
  const aliasBackup = structuredClone([...eventAliasMemory.entries()]);
  const runBackup = structuredClone([...collectionRunMemory.entries()]);
  const snapshotBackup = structuredClone([...briefSnapshotMemory.entries()]);

  const startedAt = new Date().toISOString();
  const run: CollectionRunRecord = existingRun
    ? { ...existingRun, status: "running", startedAt, completedAt: undefined, errorCode: undefined, errorDetail: undefined }
    : {
        id: randomUUID(),
        stream: options.stream,
        batchKey: options.batchKey,
        status: "running",
        briefDate: brief.date,
        inputHash,
        startedAt,
      };
  run.inputHash = inputHash;
  collectionRunMemory.set(runKey, run);

  try {
    const usedEventIds = new Set<string>();
    const idMap = new Map<string, string>();
    const stableHeadlines: Headline[] = [];
    const observations: BriefSnapshotEventRecord[] = [];

    for (const incoming of brief.headlines) {
      const aliases = aliasesForHeadline(incoming);
      const aliasEventIds = new Set(aliases
        .map((alias) => eventAliasMemory.get(`${alias.type}:${alias.key}`)?.eventId)
        .filter((value): value is string => Boolean(value)));
      if (aliasEventIds.size > 1) {
        throw new EventIdentityConflictError(`Headline ${incoming.id} points to multiple existing events: ${[...aliasEventIds].join(", ")}`);
      }

      let entry = incoming.id.startsWith("evt_") ? eventMemory.get(incoming.id) : undefined;
      let matchMethod: EventMatchMethod = entry ? "existing_id" : "new";
      let matchConfidence = entry ? 1 : 0;
      if (!entry && aliasEventIds.size === 1) {
        entry = eventMemory.get([...aliasEventIds][0]);
        matchMethod = "source_alias";
        matchConfidence = 1;
      }
      if (!entry) {
        const semantic = findSemanticEvent(incoming, [...eventMemory.values()]
          .filter((candidate) => !usedEventIds.has(candidate.id))
          .map((candidate) => ({ event: candidate, headline: latestMemoryEventVersion(candidate)?.headline ?? incoming })));
        if (semantic.candidate) {
          entry = eventMemory.get(semantic.candidate.event.id);
          matchMethod = "semantic_high";
          matchConfidence = semantic.confidence;
        }
      }
      if (!entry) {
        const identity = createStableEventIdentity(incoming);
        const collision = eventMemory.get(identity.id);
        if (collision && collision.stableKey !== identity.stableKey) {
          throw new EventIdentityConflictError(`Stable event hash collision for ${identity.id}`);
        }
        entry = collision ?? {
          id: identity.id,
          stableKey: identity.stableKey,
          canonicalTitle: incoming.sources.find((source) => source.originalTitle)?.originalTitle ?? incoming.title,
          category: incoming.category,
          ticker: incoming.ticker,
          firstSeenAt: options.observedAt,
          lastSeenAt: options.observedAt,
          identityQuality: "new",
          versions: [],
        };
        matchMethod = "new";
        matchConfidence = 1;
      }
      if (usedEventIds.has(entry.id)) {
        throw new EventIdentityConflictError(`Two headlines in one snapshot resolved to event ${entry.id}`);
      }
      usedEventIds.add(entry.id);

      const previousVersion = latestMemoryEventVersion(entry);
      const stableHeadline = mergeRetainedEvidence(previousVersion?.headline, { ...structuredClone(incoming), id: entry.id });
      const material = eventVersionMaterial(stableHeadline);
      let version = previousVersion;
      if (!version || version.contentHash !== material.versionHash) {
        const createdAt = new Date().toISOString();
        version = {
          id: randomUUID(),
          eventId: entry.id,
          versionNumber: (previousVersion?.versionNumber ?? 0) + 1,
          previousVersionId: previousVersion?.id,
          contentHash: material.versionHash,
          evidenceHash: material.evidenceHash,
          stateHash: material.stateHash,
          presentationHash: material.presentationHash,
          observedAt: options.observedAt,
          runId: run.id,
          headline: structuredClone(stableHeadline),
          createdAt,
        };
        entry.versions.push(version);
      }
      entry.canonicalTitle = incoming.sources.find((source) => source.originalTitle)?.originalTitle ?? entry.canonicalTitle;
      entry.category = incoming.category;
      entry.ticker = incoming.ticker;
      entry.lastSeenAt = new Date(Math.max(Date.parse(entry.lastSeenAt), Date.parse(options.observedAt))).toISOString();
      eventMemory.set(entry.id, entry);

      for (const alias of aliases) {
        const key = `${alias.type}:${alias.key}`;
        const current = eventAliasMemory.get(key);
        if (current && current.eventId !== entry.id) {
          throw new EventIdentityConflictError(`Alias ${key} is already assigned to ${current.eventId}`);
        }
        eventAliasMemory.set(key, current
          ? { ...current, lastSeenAt: options.observedAt, canonicalUrl: alias.canonicalUrl ?? current.canonicalUrl }
          : {
              type: alias.type,
              key: alias.key,
              eventId: entry.id,
              canonicalUrl: alias.canonicalUrl,
              firstSeenAt: options.observedAt,
              lastSeenAt: options.observedAt,
            });
      }

      idMap.set(incoming.id, entry.id);
      stableHeadlines.push(stableHeadline);
      observations.push({
        snapshotId: "",
        eventId: entry.id,
        eventVersionId: version.id,
        rank: incoming.rank,
        rankingScore: incoming.rankingScore,
        freshnessScore: incoming.freshnessScore,
        impact: incoming.impact,
        confidence: incoming.confidence,
        mentions: incoming.mentions,
        crossSourceCount: incoming.crossSourceCount,
        matchMethod,
        matchConfidence,
      });
    }

    const previous = [...briefSnapshotMemory.values()]
      .filter((snapshot) => snapshot.date === brief.date)
      .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0];
    const sequenceNumber = (previous?.sequenceNumber ?? 0) + 1;
    const snapshotId = randomUUID();
    const persistedAt = new Date().toISOString();
    let stableBrief = remapBriefRelations(brief, idMap, stableHeadlines);
    const payloadHash = snapshotPayloadHash(stableBrief);
    stableBrief = {
      ...stableBrief,
      snapshot: {
        id: snapshotId,
        runId: run.id,
        stream: options.stream,
        batchKey: options.batchKey,
        sequenceNumber,
        previousSnapshotId: previous?.id,
        payloadHash,
        persistedAt,
      },
    };
    const snapshot: BriefSnapshotRecord = {
      id: snapshotId,
      runId: run.id,
      stream: options.stream,
      batchKey: options.batchKey,
      sequenceNumber,
      date: brief.date,
      generatedAt: validIsoOrNow(brief.generatedAt),
      previousSnapshotId: previous?.id,
      payloadHash,
      brief: structuredClone(stableBrief),
      createdAt: persistedAt,
      events: observations.map((observation) => ({ ...observation, snapshotId })),
    };
    let record: BriefRecord | undefined;
    if (dailyWrite?.kind === "save_draft") {
      const existing = [...memory.values()].find((entry) => entry.date === brief.date);
      if (existing?.status === "published") record = cloneMemory(existing);
      else {
        const id = existing?.id ?? randomUUID();
        const entry: MemoryEntry = {
          id,
          date: stableBrief.date,
          status: "draft",
          brief: { ...structuredClone(stableBrief), id, status: "draft", storageMode: "memory" },
          createdAt: existing?.createdAt ?? persistedAt,
          updatedAt: persistedAt,
          hasPdf: false,
        };
        memory.set(id, entry);
        record = cloneMemory(entry);
      }
    } else if (dailyWrite?.kind === "update_draft") {
      const entry = memory.get(dailyWrite.id);
      if (!entry) throw new Error("Daily brief not found");
      if (entry.status !== "draft") throw new Error("Published daily briefs are immutable");
      if (dailyWrite.expectedSnapshotId && entry.brief.snapshot?.id
        && dailyWrite.expectedSnapshotId !== entry.brief.snapshot.id) {
        throw new StaleBriefRevisionError("The daily brief changed after it was opened; reload before saving");
      }
      entry.brief = { ...structuredClone(stableBrief), id: entry.id, status: "draft", storageMode: "memory" };
      entry.updatedAt = persistedAt;
      memory.set(entry.id, entry);
      record = cloneMemory(entry);
    } else if (dailyWrite?.kind === "publish") {
      const entry = memory.get(dailyWrite.id);
      if (!entry) throw new Error("Daily brief not found");
      if (entry.status !== "draft") throw new Error("Only a draft can be published");
      entry.status = "published";
      entry.publishedAt = persistedAt;
      entry.updatedAt = persistedAt;
      entry.pdf = dailyWrite.pdf;
      entry.hasPdf = true;
      entry.brief = {
        ...structuredClone(stableBrief),
        id: entry.id,
        status: "published",
        publishedAt: persistedAt,
        storageMode: "memory",
      };
      memory.set(entry.id, entry);
      record = cloneMemory(entry);
    }
    briefSnapshotMemory.set(snapshot.id, snapshot);
    collectionRunMemory.set(runKey, { ...run, status: "success", completedAt: persistedAt });
    return { snapshot: structuredClone(snapshot), record };
  } catch (error) {
    memory.clear();
    for (const [key, value] of memoryBackup) memory.set(key, value);
    eventMemory.clear();
    for (const [key, value] of eventBackup) eventMemory.set(key, value);
    eventAliasMemory.clear();
    for (const [key, value] of aliasBackup) eventAliasMemory.set(key, value);
    collectionRunMemory.clear();
    for (const [key, value] of runBackup) collectionRunMemory.set(key, value);
    briefSnapshotMemory.clear();
    for (const [key, value] of snapshotBackup) briefSnapshotMemory.set(key, value);
    collectionRunMemory.set(runKey, {
      ...run,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorCode: error instanceof EventIdentityConflictError ? error.code : "PERSIST_BRIEF_FAILED",
      errorDetail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    throw error;
  }
}

async function loadSnapshotByRun(client: PoolClient, runId: string): Promise<BriefSnapshotRecord | null> {
  const snapshotResult = await client.query<BriefSnapshotRow>(`
    SELECT id, run_id, stream, batch_key, sequence_number, brief_date, generated_at,
           previous_snapshot_id, payload_hash, payload, created_at
    FROM brief_snapshots WHERE run_id = $1
  `, [runId]);
  const row = snapshotResult.rows[0];
  if (!row) return null;
  const eventResult = await client.query<BriefSnapshotEventRow>(`
    SELECT snapshot_id, event_id, event_version_id, rank, ranking_score,
           freshness_score, impact, confidence, mentions, cross_source_count,
           match_method, match_confidence
    FROM brief_snapshot_events WHERE snapshot_id = $1 ORDER BY rank ASC
  `, [row.id]);
  return rowToBriefSnapshot(row, eventResult.rows.map(rowToSnapshotEvent));
}

async function loadLatestEventVersion(client: PoolClient, eventId: string, lock = false): Promise<EventVersionRecord | undefined> {
  const result = await client.query<EventVersionRow>(`
    SELECT id, event_id, version_number, previous_version_id, content_hash,
           evidence_hash, state_hash, presentation_hash, observed_at, run_id,
           payload, created_at
    FROM event_versions
    WHERE event_id = $1
    ORDER BY version_number DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [eventId]);
  return result.rows[0] ? rowToEventVersion(result.rows[0]) : undefined;
}

async function loadDailyRecordForWrite(
  client: PoolClient,
  write: DailyBriefWrite,
  date: string,
  lock = false,
): Promise<BriefRecord | null> {
  const result = write.kind === "save_draft"
    ? await client.query<DatabaseRow>(`
        SELECT *, (pdf_data IS NOT NULL) AS has_pdf
        FROM daily_briefs WHERE brief_date = $1 ${lock ? "FOR UPDATE" : ""}
      `, [date])
    : await client.query<DatabaseRow>(`
        SELECT *, (pdf_data IS NOT NULL) AS has_pdf
        FROM daily_briefs WHERE id = $1 ${lock ? "FOR UPDATE" : ""}
      `, [write.id]);
  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

async function persistBriefObservationPostgres(
  brief: DailyBrief,
  options: Required<Pick<PersistBriefOptions, "stream" | "batchKey" | "observedAt">>,
  dailyWrite?: DailyBriefWrite,
): Promise<PersistBriefResult> {
  await ensureSchema();
  const client = await pool().connect();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const inputHash = snapshotPayloadHash(brief);
  let activeRunId: string = runId;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('analystarena_event_observation'))");
    const existingRunResult = await client.query<CollectionRunRow>(`
      SELECT id, stream, batch_key, status, brief_date, input_hash,
             started_at, completed_at, error_code, error_detail
      FROM collection_runs
      WHERE stream = $1 AND batch_key = $2
      FOR UPDATE
    `, [options.stream, options.batchKey]);
    const existingRun = existingRunResult.rows[0];
    if (existingRun?.status === "success") {
      if (existingRun.input_hash && existingRun.input_hash !== inputHash) {
        throw new Error(`Idempotency key ${options.stream}:${options.batchKey} was reused with different brief content`);
      }
      const existingSnapshot = await loadSnapshotByRun(client, existingRun.id);
      if (!existingSnapshot) throw new Error(`Successful collection run ${existingRun.id} has no snapshot`);
      const record = dailyWrite ? await loadDailyRecordForWrite(client, dailyWrite, brief.date) : null;
      await client.query("COMMIT");
      return { snapshot: existingSnapshot, record: record ?? undefined };
    }
    if (existingRun) {
      activeRunId = existingRun.id;
      await client.query(`
        UPDATE collection_runs
        SET status = 'running', brief_date = $3, input_hash = $4, started_at = $5,
            completed_at = NULL, error_code = NULL, error_detail = NULL
        WHERE stream = $1 AND batch_key = $2
      `, [options.stream, options.batchKey, brief.date, inputHash, startedAt]);
    } else {
      await client.query(`
        INSERT INTO collection_runs (id, stream, batch_key, status, brief_date, input_hash, started_at)
        VALUES ($1, $2, $3, 'running', $4, $5, $6)
      `, [activeRunId, options.stream, options.batchKey, brief.date, inputHash, startedAt]);
    }

    const currentRecord = dailyWrite ? await loadDailyRecordForWrite(client, dailyWrite, brief.date, true) : null;
    if ((dailyWrite?.kind === "update_draft" || dailyWrite?.kind === "publish") && !currentRecord) {
      throw new Error("Daily brief not found");
    }
    if ((dailyWrite?.kind === "update_draft" || dailyWrite?.kind === "publish") && currentRecord?.status !== "draft") {
      throw new Error("Published daily briefs are immutable");
    }
    const expectedSnapshotId = dailyWrite?.kind === "update_draft" || dailyWrite?.kind === "publish"
      ? dailyWrite.expectedSnapshotId
      : undefined;
    if ((dailyWrite?.kind === "update_draft" || dailyWrite?.kind === "publish")
      && currentRecord?.brief.snapshot?.id && !expectedSnapshotId) {
      throw new StaleBriefRevisionError("A snapshot revision is required before saving or publishing");
    }
    if (expectedSnapshotId && currentRecord?.brief.snapshot?.id
      && expectedSnapshotId !== currentRecord.brief.snapshot.id) {
      throw new StaleBriefRevisionError("The daily brief changed after it was opened; reload before saving");
    }

    const allAliases = brief.headlines.flatMap(aliasesForHeadline);
    const aliasCompositeKeys = allAliases.map((alias) => `${alias.type}:${alias.key}`);
    const aliasResult = aliasCompositeKeys.length
      ? await client.query<{ alias_type: string; alias_key: string; event_id: string }>(`
          SELECT alias_type, alias_key, event_id
          FROM event_aliases
          WHERE alias_type || ':' || alias_key = ANY($1::text[])
        `, [aliasCompositeKeys])
      : { rows: [] as Array<{ alias_type: string; alias_key: string; event_id: string }> };
    const aliasEventMap = new Map(aliasResult.rows.map((row) => [`${row.alias_type}:${row.alias_key}`, row.event_id]));
    const exactEventIds = [
      ...brief.headlines.map((headline) => headline.id).filter((id) => id.startsWith("evt_")),
      ...aliasResult.rows.map((row) => row.event_id),
    ];
    const activeSince = new Date(Date.parse(options.observedAt) - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const candidateResult = await client.query<EventDatabaseRow>(`
      SELECT e.id, e.stable_key, e.canonical_title, e.category, e.ticker,
             e.first_seen_at, e.last_seen_at, e.identity_quality,
             v.id AS version_id, v.version_number,
             v.previous_version_id AS version_previous_id,
             v.content_hash AS version_content_hash,
             v.evidence_hash AS version_evidence_hash,
             v.state_hash AS version_state_hash,
             v.presentation_hash AS version_presentation_hash,
             v.observed_at AS version_observed_at,
             v.run_id AS version_run_id,
             v.payload AS version_payload,
             v.created_at AS version_created_at
      FROM events e
      LEFT JOIN LATERAL (
        SELECT * FROM event_versions
        WHERE event_id = e.id
        ORDER BY version_number DESC LIMIT 1
      ) v ON TRUE
      WHERE e.last_seen_at >= $1::timestamptz OR e.id = ANY($2::text[])
    `, [activeSince, exactEventIds]);
    const candidates = new Map(candidateResult.rows.map((row) => {
      const event = rowToEvent(row);
      const headline = payloadHeadline(row.version_payload);
      return [event.id, { event, headline }];
    }));

    const usedEventIds = new Set<string>();
    const idMap = new Map<string, string>();
    const stableHeadlines: Headline[] = [];
    const pendingObservations: Omit<BriefSnapshotEventRecord, "snapshotId">[] = [];

    for (const incoming of brief.headlines) {
      const aliases = aliasesForHeadline(incoming);
      const aliasEventIds = new Set(aliases
        .map((alias) => aliasEventMap.get(`${alias.type}:${alias.key}`))
        .filter((value): value is string => Boolean(value)));
      if (aliasEventIds.size > 1) {
        throw new EventIdentityConflictError(`Headline ${incoming.id} points to multiple existing events: ${[...aliasEventIds].join(", ")}`);
      }

      let state = incoming.id.startsWith("evt_") ? candidates.get(incoming.id) : undefined;
      let matchMethod: EventMatchMethod = state ? "existing_id" : "new";
      let matchConfidence = state ? 1 : 0;
      if (!state && aliasEventIds.size === 1) {
        state = candidates.get([...aliasEventIds][0]);
        matchMethod = "source_alias";
        matchConfidence = 1;
      }
      if (!state) {
        const semantic = findSemanticEvent(incoming, [...candidates.values()]
          .filter((candidate) => candidate.headline && !usedEventIds.has(candidate.event.id))
          .map((candidate) => ({ event: candidate.event, headline: candidate.headline! })));
        if (semantic.candidate) {
          state = candidates.get(semantic.candidate.event.id);
          matchMethod = "semantic_high";
          matchConfidence = semantic.confidence;
        }
      }

      if (!state) {
        const identity = createStableEventIdentity(incoming);
        const inserted = await client.query<EventDatabaseRow>(`
          INSERT INTO events (
            id, stable_key, canonical_title, category, ticker,
            first_seen_at, last_seen_at, identity_quality
          ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'new')
          ON CONFLICT (stable_key) DO UPDATE
            SET last_seen_at = GREATEST(events.last_seen_at, EXCLUDED.last_seen_at)
          RETURNING id, stable_key, canonical_title, category, ticker,
                    first_seen_at, last_seen_at, identity_quality,
                    NULL::uuid AS version_id, NULL::integer AS version_number,
                    NULL::uuid AS version_previous_id, NULL::text AS version_content_hash,
                    NULL::text AS version_evidence_hash, NULL::text AS version_state_hash,
                    NULL::text AS version_presentation_hash,
                    NULL::timestamptz AS version_observed_at,
                    NULL::uuid AS version_run_id, NULL::jsonb AS version_payload,
                    NULL::timestamptz AS version_created_at
        `, [
          identity.id,
          identity.stableKey,
          incoming.sources.find((source) => source.originalTitle)?.originalTitle ?? incoming.title,
          incoming.category,
          incoming.ticker,
          options.observedAt,
        ]);
        const event = rowToEvent(inserted.rows[0]);
        state = { event, headline: (await loadLatestEventVersion(client, event.id))?.headline };
        candidates.set(event.id, state);
        matchMethod = "new";
        matchConfidence = 1;
      }
      if (usedEventIds.has(state.event.id)) {
        throw new EventIdentityConflictError(`Two headlines in one snapshot resolved to event ${state.event.id}`);
      }
      usedEventIds.add(state.event.id);

      await client.query("SELECT id FROM events WHERE id = $1 FOR UPDATE", [state.event.id]);
      const previousVersion = await loadLatestEventVersion(client, state.event.id, true);
      const stableHeadline = mergeRetainedEvidence(previousVersion?.headline, { ...structuredClone(incoming), id: state.event.id });
      const material = eventVersionMaterial(stableHeadline);
      let version = previousVersion;
      if (!version || version.contentHash !== material.versionHash) {
        const versionId = randomUUID();
        const versionNumber = (previousVersion?.versionNumber ?? 0) + 1;
        const insertedVersion = await client.query<EventVersionRow>(`
          INSERT INTO event_versions (
            id, event_id, version_number, previous_version_id,
            content_hash, evidence_hash, state_hash, presentation_hash,
            observed_at, run_id, payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
          RETURNING id, event_id, version_number, previous_version_id,
                    content_hash, evidence_hash, state_hash, presentation_hash,
                    observed_at, run_id, payload, created_at
        `, [
          versionId,
          state.event.id,
          versionNumber,
          previousVersion?.id ?? null,
          material.versionHash,
          material.evidenceHash,
          material.stateHash,
          material.presentationHash,
          options.observedAt,
          activeRunId,
          JSON.stringify(material.payload),
        ]);
        version = rowToEventVersion(insertedVersion.rows[0]);
      }

      await client.query(`
        UPDATE events
        SET canonical_title = COALESCE(NULLIF($2, ''), canonical_title),
            category = $3, ticker = $4,
            last_seen_at = GREATEST(last_seen_at, $5::timestamptz),
            updated_at = NOW()
        WHERE id = $1
      `, [
        state.event.id,
        incoming.sources.find((source) => source.originalTitle)?.originalTitle ?? "",
        incoming.category,
        incoming.ticker,
        options.observedAt,
      ]);

      for (const alias of aliases) {
        await client.query(`
          INSERT INTO event_aliases (
            alias_type, alias_key, event_id, canonical_url, first_seen_at, last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (alias_type, alias_key) DO UPDATE
            SET event_id = EXCLUDED.event_id,
                canonical_url = COALESCE(EXCLUDED.canonical_url, event_aliases.canonical_url),
                last_seen_at = GREATEST(event_aliases.last_seen_at, EXCLUDED.last_seen_at)
        `, [alias.type, alias.key, state.event.id, alias.canonicalUrl ?? null, options.observedAt]);
        aliasEventMap.set(`${alias.type}:${alias.key}`, state.event.id);
      }

      idMap.set(incoming.id, state.event.id);
      stableHeadlines.push(stableHeadline);
      pendingObservations.push({
        eventId: state.event.id,
        eventVersionId: version.id,
        rank: incoming.rank,
        rankingScore: incoming.rankingScore,
        freshnessScore: incoming.freshnessScore,
        impact: incoming.impact,
        confidence: incoming.confidence,
        mentions: incoming.mentions,
        crossSourceCount: incoming.crossSourceCount,
        matchMethod,
        matchConfidence,
      });
    }

    const previousResult = await client.query<{ id: string; sequence_number: number }>(`
      SELECT id, sequence_number FROM brief_snapshots
      WHERE brief_date = $1
      ORDER BY sequence_number DESC
      LIMIT 1
      FOR SHARE
    `, [brief.date]);
    const previousSnapshotId = previousResult.rows[0]?.id;
    const sequenceNumber = (previousResult.rows[0]?.sequence_number ?? 0) + 1;
    const snapshotId = randomUUID();
    const persistedAt = new Date().toISOString();
    let stableBrief = remapBriefRelations(brief, idMap, stableHeadlines);
    const payloadHash = snapshotPayloadHash(stableBrief);
    stableBrief = {
      ...stableBrief,
      snapshot: {
        id: snapshotId,
        runId: activeRunId,
        stream: options.stream,
        batchKey: options.batchKey,
        sequenceNumber,
        previousSnapshotId,
        payloadHash,
        persistedAt,
      },
    };
    await client.query(`
      INSERT INTO brief_snapshots (
        id, run_id, stream, batch_key, sequence_number, brief_date, generated_at,
        previous_snapshot_id, payload_hash, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    `, [
      snapshotId,
      activeRunId,
      options.stream,
      options.batchKey,
      sequenceNumber,
      brief.date,
      validIsoOrNow(brief.generatedAt),
      previousSnapshotId ?? null,
      payloadHash,
      JSON.stringify(stableBrief),
    ]);
    if (pendingObservations.length) {
      await client.query(`
        INSERT INTO brief_snapshot_events (
          snapshot_id, event_id, event_version_id, rank, ranking_score,
          freshness_score, impact, confidence, mentions, cross_source_count,
          match_method, match_confidence
        )
        SELECT $1, item.event_id, item.event_version_id, item.rank,
               item.ranking_score, item.freshness_score, item.impact,
               item.confidence, item.mentions, item.cross_source_count,
               item.match_method, item.match_confidence
        FROM jsonb_to_recordset($2::jsonb) AS item(
          event_id TEXT, event_version_id UUID, rank INTEGER,
          ranking_score NUMERIC, freshness_score NUMERIC, impact INTEGER,
          confidence INTEGER, mentions INTEGER, cross_source_count INTEGER,
          match_method TEXT, match_confidence NUMERIC
        )
      `, [snapshotId, JSON.stringify(pendingObservations.map((observation) => ({
        event_id: observation.eventId,
        event_version_id: observation.eventVersionId,
        rank: observation.rank,
        ranking_score: observation.rankingScore ?? null,
        freshness_score: observation.freshnessScore ?? null,
        impact: observation.impact,
        confidence: observation.confidence,
        mentions: observation.mentions,
        cross_source_count: observation.crossSourceCount ?? null,
        match_method: observation.matchMethod,
        match_confidence: observation.matchConfidence,
      })))]);
    }
    let record: BriefRecord | undefined;
    if (dailyWrite?.kind === "save_draft") {
      const dailyId = currentRecord?.id ?? randomUUID();
      const saved = await client.query<DatabaseRow>(`
        INSERT INTO daily_briefs (id, brief_date, status, payload)
        VALUES ($1, $2, 'draft', $3::jsonb)
        ON CONFLICT (brief_date) DO UPDATE
          SET payload = EXCLUDED.payload, status = 'draft', pdf_data = NULL,
              published_at = NULL, updated_at = NOW()
          WHERE daily_briefs.status <> 'published'
        RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
      `, [dailyId, stableBrief.date, JSON.stringify(stableBrief)]);
      if (saved.rows[0]) record = rowToRecord(saved.rows[0]);
      else record = await loadDailyRecordForWrite(client, dailyWrite, brief.date) ?? undefined;
    } else if (dailyWrite?.kind === "update_draft") {
      const updated = await client.query<DatabaseRow>(`
        UPDATE daily_briefs SET payload = $2::jsonb, updated_at = NOW()
        WHERE id = $1 AND status = 'draft'
        RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
      `, [dailyWrite.id, JSON.stringify(stableBrief)]);
      if (!updated.rows[0]) throw new Error("Unable to update draft");
      record = rowToRecord(updated.rows[0]);
    } else if (dailyWrite?.kind === "publish") {
      const publishedPayload = {
        ...stableBrief,
        id: dailyWrite.id,
        status: "published" as const,
        publishedAt: persistedAt,
        storageMode: "postgres" as const,
      };
      const published = await client.query<DatabaseRow>(`
        UPDATE daily_briefs
          SET status = 'published', payload = $2::jsonb, pdf_data = $3,
              published_at = $4, updated_at = $4
        WHERE id = $1 AND status = 'draft'
        RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
      `, [dailyWrite.id, JSON.stringify(publishedPayload), dailyWrite.pdf, persistedAt]);
      if (!published.rows[0]) throw new Error("Unable to publish draft");
      record = rowToRecord(published.rows[0]);
    }

    await client.query(`
      UPDATE collection_runs
      SET status = 'success', completed_at = NOW(), error_code = NULL, error_detail = NULL
      WHERE id = $1
    `, [activeRunId]);
    await client.query("COMMIT");

    const snapshot = {
      id: snapshotId,
      runId: activeRunId,
      stream: options.stream,
      batchKey: options.batchKey,
      sequenceNumber,
      date: brief.date,
      generatedAt: validIsoOrNow(brief.generatedAt),
      previousSnapshotId,
      payloadHash,
      brief: stableBrief,
      createdAt: persistedAt,
      events: pendingObservations.map((observation) => ({ ...observation, snapshotId })),
    };
    return { snapshot, record };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const errorCode = error instanceof EventIdentityConflictError ? error.code : "PERSIST_BRIEF_FAILED";
    const errorDetail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await pool().query(`
      INSERT INTO collection_runs (
        id, stream, batch_key, status, brief_date, input_hash,
        started_at, completed_at, error_code, error_detail
      ) VALUES ($1, $2, $3, 'failed', $4, $5, $6, NOW(), $7, $8)
      ON CONFLICT (stream, batch_key) DO UPDATE
        SET status = 'failed', completed_at = NOW(), error_code = EXCLUDED.error_code,
            error_detail = EXCLUDED.error_detail
        WHERE collection_runs.status <> 'success'
    `, [activeRunId, options.stream, options.batchKey, brief.date, inputHash, startedAt, errorCode, errorDetail]).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function persistBriefObservation(
  brief: DailyBrief,
  options: PersistBriefOptions = {},
): Promise<BriefSnapshotRecord> {
  const stream = options.stream ?? "unspecified";
  const normalized = {
    stream,
    batchKey: safeBatchKey(brief, stream, options.batchKey),
    observedAt: validIsoOrNow(options.observedAt ?? brief.generatedAt),
  };
  const result = storageMode() === "memory"
    ? await persistBriefObservationMemory(brief, normalized)
    : await persistBriefObservationPostgres(brief, normalized);
  return result.snapshot;
}

export async function listBriefSnapshots(date?: string, limit = 100): Promise<BriefSnapshotRecord[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  if (storageMode() === "memory") {
    return [...briefSnapshotMemory.values()]
      .filter((snapshot) => !date || snapshot.date === date)
      .sort((left, right) => right.sequenceNumber - left.sequenceNumber)
      .slice(0, safeLimit)
      .map((snapshot) => structuredClone(snapshot));
  }
  await ensureSchema();
  const values: unknown[] = [];
  const where = date ? "WHERE brief_date = $1" : "";
  if (date) values.push(date);
  values.push(safeLimit);
  const result = await pool().query<BriefSnapshotRow>(`
    SELECT id, run_id, stream, batch_key, sequence_number, brief_date, generated_at,
           previous_snapshot_id, payload_hash, payload, created_at
    FROM brief_snapshots ${where}
    ORDER BY sequence_number DESC LIMIT $${values.length}
  `, values);
  const snapshots: BriefSnapshotRecord[] = [];
  for (const row of result.rows) {
    const events = await pool().query<BriefSnapshotEventRow>(`
      SELECT snapshot_id, event_id, event_version_id, rank, ranking_score,
             freshness_score, impact, confidence, mentions, cross_source_count,
             match_method, match_confidence
      FROM brief_snapshot_events WHERE snapshot_id = $1 ORDER BY rank ASC
    `, [row.id]);
    snapshots.push(rowToBriefSnapshot(row, events.rows.map(rowToSnapshotEvent)));
  }
  return snapshots;
}

export async function listCollectionRuns(date?: string, limit = 100): Promise<CollectionRunRecord[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  if (storageMode() === "memory") {
    return [...collectionRunMemory.values()]
      .filter((run) => !date || run.briefDate === date)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, safeLimit)
      .map((run) => structuredClone(run));
  }
  await ensureSchema();
  const values: unknown[] = [];
  const where = date ? "WHERE brief_date = $1" : "";
  if (date) values.push(date);
  values.push(safeLimit);
  const result = await pool().query<CollectionRunRow>(`
    SELECT id, stream, batch_key, status, brief_date, input_hash,
           started_at, completed_at, error_code, error_detail
    FROM collection_runs ${where}
    ORDER BY started_at DESC LIMIT $${values.length}
  `, values);
  return result.rows.map(rowToCollectionRun);
}

export async function listEventVersions(eventId: string): Promise<EventVersionRecord[]> {
  if (storageMode() === "memory") {
    return (eventMemory.get(eventId)?.versions ?? []).map((version) => structuredClone(version));
  }
  await ensureSchema();
  const result = await pool().query<EventVersionRow>(`
    SELECT id, event_id, version_number, previous_version_id, content_hash,
           evidence_hash, state_hash, presentation_hash, observed_at, run_id,
           payload, created_at
    FROM event_versions WHERE event_id = $1 ORDER BY version_number ASC
  `, [eventId]);
  return result.rows.map(rowToEventVersion);
}

export async function saveDraft(
  brief: DailyBrief,
  options: PersistBriefOptions = {},
): Promise<BriefRecord> {
  const stream = options.stream ?? "unspecified";
  const normalized = {
    stream,
    batchKey: safeBatchKey(brief, stream, options.batchKey),
    observedAt: validIsoOrNow(options.observedAt ?? brief.generatedAt),
  };
  const result = storageMode() === "memory"
    ? await persistBriefObservationMemory(brief, normalized, { kind: "save_draft" })
    : await persistBriefObservationPostgres(brief, normalized, { kind: "save_draft" });
  if (!result.record) throw new Error("Unable to save daily brief");
  return result.record;
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

export async function updateDraft(
  id: string,
  brief: DailyBrief,
  options: PersistBriefOptions & { expectedSnapshotId?: string } = {},
): Promise<BriefRecord> {
  const stream = options.stream ?? "review";
  const normalized = {
    stream,
    batchKey: safeBatchKey(brief, stream, options.batchKey ?? `${id}:${brief.generatedAt}:${Date.now()}`),
    observedAt: validIsoOrNow(options.observedAt ?? new Date().toISOString()),
  };
  const write: DailyBriefWrite = {
    kind: "update_draft",
    id,
    expectedSnapshotId: options.expectedSnapshotId ?? brief.snapshot?.id,
  };
  const result = storageMode() === "memory"
    ? await persistBriefObservationMemory(brief, normalized, write)
    : await persistBriefObservationPostgres(brief, normalized, write);
  if (!result.record) throw new Error("日报更新失败");
  return result.record;
}

export async function publishBrief(
  id: string,
  brief: DailyBrief,
  pdf: Buffer,
  options: PersistBriefOptions = {},
): Promise<BriefRecord> {
  const stream = options.stream ?? "publish";
  const normalized = {
    stream,
    batchKey: safeBatchKey(brief, stream, options.batchKey ?? `${id}:${brief.generatedAt}:${Date.now()}`),
    observedAt: validIsoOrNow(options.observedAt ?? new Date().toISOString()),
  };
  const write: DailyBriefWrite = { kind: "publish", id, pdf, expectedSnapshotId: brief.snapshot?.id };
  const result = storageMode() === "memory"
    ? await persistBriefObservationMemory(brief, normalized, write)
    : await persistBriefObservationPostgres(brief, normalized, write);
  if (!result.record) throw new Error("发布失败");
  return result.record;
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
  sourceDocuments: number;
  events: number;
  eventVersions: number;
  briefSnapshots: number;
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
      sourceDocuments: sourceDocumentMemory.size,
      events: eventMemory.size,
      eventVersions: [...eventMemory.values()].reduce((sum, event) => sum + event.versions.length, 0),
      briefSnapshots: briefSnapshotMemory.size,
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
      source_document_count: string;
      event_count: string;
      event_version_count: string;
      snapshot_count: string;
      last_sync_at: string | Date | null;
      last_sync_ok: boolean | null;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM reddit_posts) AS reddit_count,
        (SELECT COUNT(*)::text FROM stock_profiles WHERE active = TRUE) AS stock_count,
        (SELECT COUNT(*)::text FROM stock_prices_daily) AS price_count,
        (SELECT COUNT(*)::text FROM source_documents) AS source_document_count,
        (SELECT COUNT(*)::text FROM events) AS event_count,
        (SELECT COUNT(*)::text FROM event_versions) AS event_version_count,
        (SELECT COUNT(*)::text FROM brief_snapshots) AS snapshot_count,
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
      sourceDocuments: Number(row?.source_document_count ?? 0),
      events: Number(row?.event_count ?? 0),
      eventVersions: Number(row?.event_version_count ?? 0),
      briefSnapshots: Number(row?.snapshot_count ?? 0),
      lastStockSyncAt: row?.last_sync_at ? iso(row.last_sync_at) : undefined,
      lastStockSyncOk: row?.last_sync_ok ?? undefined,
    };
  } catch {
    return {
      mode: "postgres",
      ok: false,
      redditPosts: 0,
      stocks: 0,
      stockPrices: 0,
      sourceDocuments: 0,
      events: 0,
      eventVersions: 0,
      briefSnapshots: 0,
    };
  }
}
