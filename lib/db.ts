import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  aliasesForHeadline,
  canonicalJson,
  createStableEventIdentity,
  eventVersionMaterial,
  findSemanticEvent,
  mergeRetainedEvidence,
  stableHash,
} from "./event-versioning";
import { ensureRawStoryIdentity } from "./source-identity";
import {
  assertPublishedAtRawConsistency,
  parseStrictSourceTimestamp,
  requireStrictSourceTimestamp,
} from "./source-time";
import {
  assertEvidenceBoundToSourceCapture,
  canonicalEvidenceJson,
  evidenceVersionMaterialHash,
  normalizeSourceEvidence,
  sha256ExactUtf8,
  validateHeadlineEvidence,
} from "./source-evidence";
import {
  compareEventBaseline,
  compareEventVersions,
  compareSnapshotEvent,
  extractNumericFacts,
  projectWhatChanged,
  WHAT_CHANGED_ALGORITHM_VERSION,
  WHAT_CHANGED_IMPLEMENTATION_HASH,
} from "./what-changed";
import type {
  BriefSnapshotEventRecord,
  BriefSnapshotEventProjection,
  BriefSnapshotRecord,
  BriefSnapshotStream,
  BriefRecord,
  BriefStatus,
  CollectionRunRecord,
  DailyBrief,
  EventMatchMethod,
  EventRecord,
  EvidenceRetractionRequest,
  EventVersionRecord,
  EventVersionComparison,
  Headline,
  NumericFact,
  RawStory,
  SnapshotEventChange,
  SourceCapture,
  SourceEvidence,
  SourceLink,
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
  WhatChangedProjection,
} from "./types";

export interface SaveSourceStoriesResult {
  count: number;
  stories: RawStory[];
}

interface DatabaseRow {
  id: string;
  brief_date: string | Date;
  status: BriefStatus;
  payload: DailyBrief | string;
  created_at: string | Date;
  updated_at: string | Date;
  published_at: string | Date | null;
  has_pdf: boolean;
  current_snapshot_id: string | null;
}

interface MemoryEntry extends BriefRecord {
  pdf?: Buffer;
  currentSnapshotId: string;
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

interface MemoryEvidenceRetraction {
  request: EvidenceRetractionRequest;
  requestHash: string;
  toEventVersionId: string;
  actorType: "system" | "admin";
  actorIdHash: string;
  requestedAt: string;
}

interface MemoryPublicationAudit {
  briefId: string;
  snapshotId: string;
  snapshotPayloadHash: string;
  pdfSha256: string;
  actorType: "system" | "admin";
  actorIdHash?: string;
  actionReason?: string;
  requestId?: string;
  publishedAt: string;
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
  actor_type: BriefSnapshotRecord["actorType"] | null;
  actor_id_hash: string | null;
  action_reason: string | null;
  action_request_id: string | null;
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
  version_actor_type: EventVersionRecord["actorType"] | null;
  version_actor_id_hash: string | null;
  version_change_reason: string | null;
  version_request_id: string | null;
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
  payload: EventVersionPayload | string;
  actor_type: EventVersionRecord["actorType"] | null;
  actor_id_hash: string | null;
  change_reason: string | null;
  request_id: string | null;
  created_at: string | Date;
}

interface EventVersionPayload {
  evidence?: unknown;
  state?: unknown;
  presentation?: unknown;
  headline?: Headline;
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

interface BriefSnapshotClaimPresentationRow {
  snapshot_id: string;
  event_id: string;
  event_version_id: string;
  claim_key: string;
  ordinal: number;
  statement: string;
  language: string;
}

interface EventVersionComparisonRow {
  event_id: string;
  current_version_id: string;
  previous_version_id: string | null;
  status: EventVersionComparison["status"];
  algorithm_version: string;
  input_hash: string;
  result_hash: string;
  summary: string;
  compared_at: string | Date;
}

interface WhatChangedItemRow {
  item_id: string;
  ordinal: number;
  kind: SnapshotEventChange["items"][number]["kind"];
  subject_key: string;
  reason_code: string;
  summary: string;
  before_value: Record<string, unknown> | string | null;
  after_value: Record<string, unknown> | string | null;
  evidence_version_ids: string[] | string;
  change_hash: string;
}

interface NumericFactRow {
  fact_key: string;
  claim_key: string;
  metric_key: string;
  subject_key: string;
  period_key: string;
  value_canonical: string;
  unit: string;
  currency: string | null;
  scale: string;
  raw_token: string;
  start_offset: number;
  end_offset: number;
  original_text: string;
  parser_version: string;
  comparison_status: NumericFact["comparisonStatus"];
  comparison_reason: string;
  evidence_version_ids: string[] | string | null;
}

interface SnapshotEventChangeRow {
  current_snapshot_id: string;
  event_id: string;
  current_event_version_id: string;
  baseline_kind: SnapshotEventChange["baselineKind"];
  baseline_snapshot_id: string | null;
  baseline_event_version_id: string | null;
  historical_observation_snapshot_id: string | null;
  presence: SnapshotEventChange["presence"];
  previous_rank: number | null;
  current_rank: number;
  rank_delta: number | null;
  rank_movement: SnapshotEventChange["rankMovement"];
  status: SnapshotEventChange["status"];
  algorithm_version: string;
  input_hash: string;
  result_hash: string;
  summary: string;
  compared_at: string | Date;
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
  var __analystArenaEvidenceRetractionMemory: Map<string, MemoryEvidenceRetraction> | undefined;
  var __analystArenaPublicationAuditMemory: Map<string, MemoryPublicationAudit> | undefined;
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
const evidenceRetractionMemory = globalThis.__analystArenaEvidenceRetractionMemory
  ?? new Map<string, MemoryEvidenceRetraction>();
globalThis.__analystArenaEvidenceRetractionMemory = evidenceRetractionMemory;
const publicationAuditMemory = globalThis.__analystArenaPublicationAuditMemory
  ?? new Map<string, MemoryPublicationAudit>();
globalThis.__analystArenaPublicationAuditMemory = publicationAuditMemory;

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
  // node-postgres materializes a PostgreSQL DATE at local midnight. Converting
  // that value through UTC can move Beijing/Taipei deployments to the previous
  // calendar day, so DATE values must be read from their local date fields.
  return [
    value.getFullYear().toString().padStart(4, "0"),
    (value.getMonth() + 1).toString().padStart(2, "0"),
    value.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function validIsoOrNow(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new TypeError(`Invalid observation timestamp: ${value}`);
  }
  return parsed.toISOString();
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
    actorType: row.actor_type ?? undefined,
    actorIdHash: row.actor_id_hash ?? undefined,
    actionReason: row.action_reason ?? undefined,
    actionRequestId: row.action_request_id ?? undefined,
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

function parseEventVersionPayload(
  payload: EventDatabaseRow["version_payload"] | EventVersionRow["payload"],
): EventVersionPayload | undefined {
  if (!payload) return undefined;
  return typeof payload === "string" ? JSON.parse(payload) as EventVersionPayload : payload;
}

function payloadHeadline(payload: EventDatabaseRow["version_payload"] | EventVersionRow["payload"]): Headline | undefined {
  return parseEventVersionPayload(payload)?.headline;
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
    actorType: row.actor_type ?? undefined,
    actorIdHash: row.actor_id_hash ?? undefined,
    changeReason: row.change_reason ?? undefined,
    requestId: row.request_id ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function jsonObject(value: Record<string, unknown> | string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
}

function postgresTextArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (!value || value === "{}") return [];
  return value
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((item) => item.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function rowToWhatChangedItem(row: WhatChangedItemRow) {
  return {
    id: row.item_id,
    ordinal: row.ordinal,
    kind: row.kind,
    subjectKey: row.subject_key,
    reasonCode: row.reason_code,
    summary: row.summary,
    before: jsonObject(row.before_value),
    after: jsonObject(row.after_value),
    evidenceVersionIds: postgresTextArray(row.evidence_version_ids),
    changeHash: row.change_hash,
  };
}

function rowToEventVersionComparison(
  row: EventVersionComparisonRow,
  items: ReturnType<typeof rowToWhatChangedItem>[],
): EventVersionComparison {
  return {
    eventId: row.event_id,
    previousVersionId: row.previous_version_id ?? undefined,
    currentVersionId: row.current_version_id,
    status: row.status,
    algorithmVersion: row.algorithm_version,
    inputHash: row.input_hash,
    resultHash: row.result_hash,
    comparedAt: iso(row.compared_at),
    summary: row.summary,
    items,
  };
}

function rowToNumericFact(row: NumericFactRow): NumericFact {
  return {
    factKey: row.fact_key,
    claimKey: row.claim_key,
    metricKey: row.metric_key,
    subjectKey: row.subject_key,
    periodKey: row.period_key,
    value: row.value_canonical,
    unit: row.unit,
    currency: row.currency ?? undefined,
    scale: row.scale,
    rawToken: row.raw_token,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    originalText: row.original_text,
    parserVersion: row.parser_version,
    comparisonStatus: row.comparison_status,
    comparisonReason: row.comparison_reason,
    evidenceVersionIds: postgresTextArray(row.evidence_version_ids),
  };
}

function rowToSnapshotEventChange(
  row: SnapshotEventChangeRow,
  items: ReturnType<typeof rowToWhatChangedItem>[],
): SnapshotEventChange {
  return {
    currentSnapshotId: row.current_snapshot_id,
    eventId: row.event_id,
    currentEventVersionId: row.current_event_version_id,
    baselineKind: row.baseline_kind,
    baselineSnapshotId: row.baseline_snapshot_id ?? undefined,
    baselineEventVersionId: row.baseline_event_version_id ?? undefined,
    historicalObservationSnapshotId: row.historical_observation_snapshot_id ?? undefined,
    presence: row.presence,
    previousRank: row.previous_rank ?? undefined,
    currentRank: row.current_rank,
    rankDelta: row.rank_delta ?? undefined,
    rankMovement: row.rank_movement,
    status: row.status,
    algorithmVersion: row.algorithm_version,
    inputHash: row.input_hash,
    resultHash: row.result_hash,
    comparedAt: iso(row.compared_at),
    summary: row.summary,
    items,
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

function strictOptionalSourceTimestamp(value: string | null | undefined, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = parseStrictSourceTimestamp(value);
  if (!parsed) {
    throw new TypeError(`Invalid ${fieldName}; an explicit timezone and valid calendar timestamp are required: ${value}`);
  }
  return parsed;
}

function snapshotEventProjection(
  event: BriefSnapshotEventRecord,
): BriefSnapshotEventProjection {
  return {
    eventId: event.eventId,
    eventVersionId: event.eventVersionId,
    rank: event.rank,
    rankingScore: event.rankingScore,
    freshnessScore: event.freshnessScore,
    impact: event.impact,
    confidence: event.confidence,
    mentions: event.mentions,
    crossSourceCount: event.crossSourceCount,
    matchMethod: event.matchMethod,
    matchConfidence: event.matchConfidence,
  };
}

function sourceCaptureForStory(story: RawStory) {
  const collectedAt = requireStrictSourceTimestamp(
    story.lastCollectedAt ?? story.collectedAt ?? "",
    "source collection timestamp",
  );
  return story.capture ?? {
    rawUrl: story.url,
    canonicalUrl: story.canonicalUrl,
    originalPublishedAt: story.timestampKind === "collected"
      ? null
      : requireStrictSourceTimestamp(story.publishedAt, "source publication timestamp"),
    publishedAtRaw: story.publishedAtRaw,
    publishedAtField: story.publishedAtField,
    sourceUpdatedAt: story.sourceUpdatedAt,
    collectedAt,
    scope: "legacy_metadata" as const,
    capturedContentHash: story.contentHash!,
    extractionMethod: "legacy-title-description",
    extractorVersion: "legacy-metadata/v1",
    backfillQuality: "unverified_legacy" as const,
  };
}

function assertSourceCaptureArtifact(capture: ReturnType<typeof sourceCaptureForStory>): void {
  const quality = capture.backfillQuality ?? "native";
  if (quality === "native" && capture.capturedArtifact === undefined) {
    throw new Error("Native source capture must preserve the exact UTF-8 artifact");
  }
  if (capture.capturedArtifact === undefined) return;
  if (capture.capturedArtifactEncoding !== "utf8") {
    throw new Error("Captured source artifact must declare UTF-8 encoding");
  }
  const actualSize = Buffer.byteLength(capture.capturedArtifact, "utf8");
  if (capture.capturedArtifactSizeBytes !== actualSize) {
    throw new Error(`Captured source artifact byte size mismatch: expected ${capture.capturedArtifactSizeBytes}, got ${actualSize}`);
  }
  const actualHash = sha256ExactUtf8(capture.capturedArtifact);
  if (capture.capturedContentHash !== actualHash) {
    throw new Error(`Captured source artifact hash mismatch: expected ${capture.capturedContentHash}, got ${actualHash}`);
  }
}

function strictSourceTimes(story: RawStory, capture: ReturnType<typeof sourceCaptureForStory>) {
  const timestampKind = story.timestampKind ?? "published";
  const firstCollectedAt = requireStrictSourceTimestamp(
    story.firstCollectedAt ?? story.collectedAt ?? "",
    "first source collection timestamp",
  );
  const lastCollectedAt = requireStrictSourceTimestamp(
    story.lastCollectedAt ?? story.collectedAt ?? "",
    "last source collection timestamp",
  );
  const publishedAt = requireStrictSourceTimestamp(story.publishedAt, "source display timestamp");
  const originalPublishedAt = story.originalPublishedAt !== undefined
    ? strictOptionalSourceTimestamp(story.originalPublishedAt, "original source publication timestamp")
    : timestampKind === "collected" ? null : publishedAt;
  if ((capture.backfillQuality ?? "native") === "native" && capture.originalPublishedAt === undefined) {
    throw new Error("Native source capture must explicitly preserve originalPublishedAt, including null when unavailable");
  }
  const captureOriginalPublishedAt = capture.originalPublishedAt !== undefined
    ? strictOptionalSourceTimestamp(capture.originalPublishedAt, "capture original publication timestamp")
    : originalPublishedAt;
  const captureCollectedAt = requireStrictSourceTimestamp(capture.collectedAt, "capture collection timestamp");
  const storyPublishedAtRaw = story.publishedAtRaw?.trim() || null;
  const capturePublishedAtRaw = capture.publishedAtRaw?.trim() || null;

  if (storyPublishedAtRaw !== null && capturePublishedAtRaw !== null
    && storyPublishedAtRaw !== capturePublishedAtRaw) {
    throw new Error("Source and capture publishedAtRaw values must be identical");
  }
  const publishedAtRaw = capturePublishedAtRaw ?? storyPublishedAtRaw;
  assertPublishedAtRawConsistency(publishedAtRaw, originalPublishedAt, timestampKind);

  if (firstCollectedAt > lastCollectedAt) {
    throw new Error("First source collection timestamp cannot be later than the last collection timestamp");
  }
  if (captureCollectedAt !== lastCollectedAt) {
    throw new Error("Source and capture collection timestamps must identify the same observation");
  }
  if (captureOriginalPublishedAt !== originalPublishedAt) {
    throw new Error("Source and capture original publication timestamps must be identical");
  }
  if (timestampKind === "published") {
    if (!originalPublishedAt || publishedAt !== originalPublishedAt) {
      throw new Error("Published source time requires a matching non-null original publication timestamp");
    }
  } else if (originalPublishedAt !== null || publishedAt !== lastCollectedAt) {
    throw new Error("Collected source time requires a null original publication timestamp and display time equal to collection time");
  }

  return {
    timestampKind,
    firstCollectedAt,
    lastCollectedAt,
    publishedAt,
    originalPublishedAt,
    captureOriginalPublishedAt,
    captureCollectedAt,
  };
}

function sourceObservationIdentity(
  story: RawStory,
  sourceDocumentVersionId: string,
  collectedAt: string,
): string {
  const capture = sourceCaptureForStory(story);
  return `obs_${sha256ExactUtf8(canonicalEvidenceJson([
    "source-collection-observation",
    1,
    story.sourceDocumentId,
    sourceDocumentVersionId,
    story.source,
    story.sourceType,
    collectedAt,
    capture.rawUrl,
    capture.finalUrl ?? null,
    capture.feedUrl ?? null,
    capture.mimeType ?? null,
    capture.httpStatus ?? null,
    capture.scope,
    capture.capturedContentHash,
  ]))}`;
}

function observationTime(story: RawStory): number {
  const parsed = Date.parse(story.lastCollectedAt ?? story.collectedAt ?? story.publishedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function saveSourceStories(stories: RawStory[]): Promise<SaveSourceStoriesResult> {
  if (!stories.length) return { count: 0, stories: [] };
  const identified = stories.map((input) => {
    const story = ensureRawStoryIdentity(input);
    if (input.sourceDocumentId !== undefined && input.sourceDocumentId !== story.sourceDocumentId) {
      throw new TypeError("Provided sourceDocumentId does not match the canonical source identity");
    }
    for (const evidence of input.evidence ?? []) {
      if (evidence.sourceDocumentId !== story.sourceDocumentId) {
        throw new TypeError(`Evidence ${evidence.anchorKey} does not match the canonical source identity`);
      }
    }
    if (input.capture?.canonicalUrl !== undefined
      && input.capture.canonicalUrl !== story.capture?.canonicalUrl) {
      throw new TypeError("Provided capture canonicalUrl does not match the canonical source identity");
    }
    return story;
  });
  // Validate the whole batch before either the in-memory store or PostgreSQL
  // can observe a partial write.
  for (const story of identified) {
    const capture = sourceCaptureForStory(story);
    assertSourceCaptureArtifact(capture);
    strictSourceTimes(story, capture);
    assertEvidenceBoundToSourceCapture(story, capture);
  }
  const observations = identified
    .map((story, index) => ({ story, index }))
    .sort((left, right) => (left.story.sourceDocumentId ?? "").localeCompare(right.story.sourceDocumentId ?? "")
      || observationTime(left.story) - observationTime(right.story)
      || left.index - right.index);
  const resolved = new Array<RawStory>(identified.length);

  if (storageMode() === "memory") {
    for (const observation of observations) {
      const story = observation.story;
      const capture = sourceCaptureForStory(story);
      assertSourceCaptureArtifact(capture);
      const sourceTimes = strictSourceTimes(story, capture);
      const documentId = story.sourceDocumentId!;
      const existing = sourceDocumentMemory.get(documentId);
      const firstCollectedAt = existing?.story.firstCollectedAt
        ? earlierIso(
            requireStrictSourceTimestamp(existing.story.firstCollectedAt, "stored first source collection timestamp"),
            sourceTimes.firstCollectedAt,
          )
        : sourceTimes.firstCollectedAt;
      const lastCollectedAt = existing?.story.lastCollectedAt
        ? laterIso(
            requireStrictSourceTimestamp(existing.story.lastCollectedAt, "stored last source collection timestamp"),
            sourceTimes.lastCollectedAt,
          )
        : sourceTimes.lastCollectedAt;
      const versions = existing?.versions ?? [];
      const previousVersion = versions.at(-1);
      const sourceVersionId = previousVersion && previousVersion.contentHash === story.contentHash
        ? previousVersion.id
        : randomUUID();
      const observationCollectedAt = sourceTimes.lastCollectedAt;
      const sourceObservationId = sourceObservationIdentity(story, sourceVersionId, observationCollectedAt);
      const normalizedEvidence = (story.evidence ?? []).map((rawEvidence) => {
        const evidence = normalizeSourceEvidence({
          ...rawEvidence,
          sourceDocumentId: documentId,
          sourceDocumentVersionId: sourceVersionId,
        });
        const priorEvidence = [...versions].reverse()
          .flatMap((version) => [...(version.story.evidence ?? [])].reverse())
          .find((candidate) => candidate.id === evidence.id);
        const materialHash = evidenceVersionMaterialHash(evidence);
        const priorHash = priorEvidence ? evidenceVersionMaterialHash(priorEvidence) : undefined;
        return priorHash === materialHash
          ? {
              ...structuredClone(priorEvidence!),
              // The immutable evidence version describes the quote/locator
              // material. `capturedAt` belongs to this collection observation,
              // so a recapture must not inherit the version's first-seen time.
              capturedAt: evidence.capturedAt,
            }
          : { ...evidence, versionId: randomUUID() };
      });
      const normalizedStory: RawStory = {
        ...structuredClone(story),
        firstCollectedAt,
        lastCollectedAt,
        collectedAt: sourceTimes.lastCollectedAt,
        publishedAt: sourceTimes.publishedAt,
        originalPublishedAt: sourceTimes.originalPublishedAt,
        timestampKind: sourceTimes.timestampKind,
        capture: {
          ...structuredClone(capture),
          originalPublishedAt: sourceTimes.captureOriginalPublishedAt,
          collectedAt: sourceTimes.captureCollectedAt,
        },
        sourceDocumentVersionId: sourceVersionId,
        sourceObservationId,
        evidence: normalizedEvidence,
      };
      if (!previousVersion || previousVersion.contentHash !== normalizedStory.contentHash) {
        versions.push({
          id: sourceVersionId,
          versionNumber: (previousVersion?.versionNumber ?? 0) + 1,
          previousVersionId: previousVersion?.id,
          contentHash: normalizedStory.contentHash!,
          story: structuredClone(normalizedStory),
          collectedAt: normalizedStory.lastCollectedAt ?? normalizedStory.collectedAt ?? new Date().toISOString(),
        });
      }
      sourceDocumentMemory.set(documentId, { story: normalizedStory, versions });
      resolved[observation.index] = normalizedStory;
    }
    return { count: resolved.length, stories: resolved };
  }

  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('analystarena_source_documents'))");
    for (const observation of observations) {
      const story = observation.story;
      const capture = sourceCaptureForStory(story);
      assertSourceCaptureArtifact(capture);
      const sourceTimes = strictSourceTimes(story, capture);
      const {
        firstCollectedAt,
        lastCollectedAt,
        captureCollectedAt,
        publishedAt,
        originalPublishedAt,
        captureOriginalPublishedAt,
      } = sourceTimes;
      const sourceUpdatedAt = strictOptionalSourceTimestamp(story.sourceUpdatedAt, "source update timestamp");
      const captureSourceUpdatedAt = capture.sourceUpdatedAt !== undefined
        ? strictOptionalSourceTimestamp(capture.sourceUpdatedAt, "capture source update timestamp")
        : sourceUpdatedAt;
      await client.query(`
        INSERT INTO source_documents (
          id, native_id, canonical_url, source_name, source_type,
          published_at, timestamp_kind, first_collected_at, last_collected_at,
          original_published_at, published_at_raw, published_at_field, source_updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO UPDATE SET
          native_id = COALESCE(EXCLUDED.native_id, source_documents.native_id),
          canonical_url = EXCLUDED.canonical_url,
          source_name = EXCLUDED.source_name,
          source_type = EXCLUDED.source_type,
          published_at = CASE
            WHEN source_documents.timestamp_kind = 'published'
              AND source_documents.original_published_at IS NOT NULL
              THEN source_documents.published_at
            WHEN EXCLUDED.timestamp_kind = 'published'
              THEN EXCLUDED.published_at
            ELSE GREATEST(source_documents.last_collected_at, EXCLUDED.last_collected_at)
          END,
          timestamp_kind = CASE
            WHEN (
              source_documents.timestamp_kind = 'published'
              AND source_documents.original_published_at IS NOT NULL
            ) OR EXCLUDED.timestamp_kind = 'published'
              THEN 'published'
            ELSE 'collected'
          END,
          original_published_at = CASE
            WHEN source_documents.timestamp_kind = 'published'
              AND source_documents.original_published_at IS NOT NULL
              THEN source_documents.original_published_at
            WHEN EXCLUDED.timestamp_kind = 'published'
              THEN EXCLUDED.original_published_at
            ELSE NULL
          END,
          published_at_raw = CASE
            WHEN source_documents.timestamp_kind = 'published'
              AND source_documents.original_published_at IS NOT NULL
              THEN source_documents.published_at_raw
            WHEN EXCLUDED.timestamp_kind = 'published'
              THEN EXCLUDED.published_at_raw
            ELSE NULL
          END,
          published_at_field = CASE
            WHEN source_documents.timestamp_kind = 'published'
              AND source_documents.original_published_at IS NOT NULL
              THEN source_documents.published_at_field
            WHEN EXCLUDED.timestamp_kind = 'published'
              THEN EXCLUDED.published_at_field
            ELSE NULL
          END,
          source_updated_at = GREATEST(source_documents.source_updated_at, EXCLUDED.source_updated_at),
          first_collected_at = LEAST(source_documents.first_collected_at, EXCLUDED.first_collected_at),
          last_collected_at = GREATEST(source_documents.last_collected_at, EXCLUDED.last_collected_at),
          updated_at = NOW()
      `, [
        story.sourceDocumentId,
        story.nativeId ?? null,
        story.canonicalUrl,
        story.source,
        story.sourceType,
        publishedAt,
        sourceTimes.timestampKind,
        firstCollectedAt,
        lastCollectedAt,
        originalPublishedAt,
        story.publishedAtRaw ?? null,
        story.publishedAtField ?? null,
        sourceUpdatedAt,
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
      const sourceVersionId = latest?.content_hash === story.contentHash ? latest.id : randomUUID();
      const storyForVersion: RawStory = { ...story, sourceDocumentVersionId: sourceVersionId };
      if (!latest || latest.content_hash !== story.contentHash) {
        await client.query(`
          INSERT INTO source_document_versions (
            id, source_document_id, version_number, previous_version_id,
            content_hash, payload, collected_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `, [
          sourceVersionId,
          story.sourceDocumentId,
          (latest?.version_number ?? 0) + 1,
          latest?.id ?? null,
          story.contentHash,
          JSON.stringify(storyForVersion),
          lastCollectedAt,
        ]);
      }
      await client.query(`
        INSERT INTO source_version_provenance (
          source_document_version_id, source_document_id, native_id, source_name, source_type,
          timestamp_kind, canonical_url, raw_url, final_url, feed_url, mime_type, http_status,
          original_published_at, published_at_raw, published_at_field, source_updated_at,
          collected_at, capture_scope, captured_content_hash,
          captured_artifact, captured_artifact_encoding, captured_artifact_size_bytes,
          captured_text_hash, extraction_method, extractor_version, backfill_quality
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
        ) ON CONFLICT (source_document_version_id) DO NOTHING
      `, [
        sourceVersionId,
        story.sourceDocumentId,
        story.nativeId ?? null,
        story.source,
        story.sourceType,
        sourceTimes.timestampKind,
        story.canonicalUrl,
        capture.rawUrl ?? story.url,
        capture.finalUrl ?? null,
        capture.feedUrl ?? null,
        capture.mimeType ?? null,
        capture.httpStatus ?? null,
        captureOriginalPublishedAt,
        capture.publishedAtRaw ?? story.publishedAtRaw ?? null,
        capture.publishedAtField ?? story.publishedAtField ?? null,
        captureSourceUpdatedAt,
        captureCollectedAt,
        capture.scope,
        capture.capturedContentHash,
        capture.capturedArtifact ?? null,
        capture.capturedArtifactEncoding ?? null,
        capture.capturedArtifactSizeBytes ?? null,
        capture.capturedTextHash ?? null,
        capture.extractionMethod,
        capture.extractorVersion,
        capture.backfillQuality ?? "native",
      ]);
      const provenanceResult = await client.query<{
        native_id: string | null;
        timestamp_kind: TimestampKind;
        canonical_url: string;
        original_published_at: string | Date | null;
        published_at_raw: string | null;
        published_at_field: string | null;
        source_updated_at: string | Date | null;
        captured_content_hash: string;
        captured_artifact: string | null;
        captured_artifact_encoding: "utf8" | null;
        captured_artifact_size_bytes: number | null;
        captured_text_hash: string | null;
        extraction_method: string;
        extractor_version: string;
        backfill_quality: SourceCapture["backfillQuality"];
      }>(`
        SELECT native_id, timestamp_kind, canonical_url,
               original_published_at, published_at_raw, published_at_field,
               source_updated_at, captured_content_hash, captured_artifact,
               captured_artifact_encoding, captured_artifact_size_bytes,
               captured_text_hash, extraction_method, extractor_version, backfill_quality
        FROM source_version_provenance
        WHERE source_document_id = $1 AND source_document_version_id = $2
      `, [story.sourceDocumentId, sourceVersionId]);
      const provenance = provenanceResult.rows[0];
      if (!provenance) throw new Error(`Source version ${sourceVersionId} has no immutable provenance`);
      const sourceObservationId = sourceObservationIdentity(story, sourceVersionId, lastCollectedAt);
      await client.query(`
        INSERT INTO source_collection_observations (
          id, source_document_id, source_document_version_id,
          source_name, source_type, collected_at, raw_url, final_url,
          feed_url, mime_type, http_status, capture_scope, captured_content_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO NOTHING
      `, [
        sourceObservationId,
        story.sourceDocumentId,
        sourceVersionId,
        story.source,
        story.sourceType,
        lastCollectedAt,
        capture.rawUrl ?? story.url,
        capture.finalUrl ?? null,
        capture.feedUrl ?? null,
        capture.mimeType ?? null,
        capture.httpStatus ?? null,
        capture.scope,
        capture.capturedContentHash,
      ]);

      const normalizedEvidence = [];
      for (const rawEvidence of story.evidence ?? []) {
        const evidence = normalizeSourceEvidence({
          ...rawEvidence,
          sourceDocumentId: story.sourceDocumentId!,
          sourceDocumentVersionId: sourceVersionId,
        });
        await client.query(`
          INSERT INTO evidence_items (id, source_document_id, anchor_key)
          VALUES ($1, $2, $3)
          ON CONFLICT (source_document_id, anchor_key) DO NOTHING
        `, [evidence.id, story.sourceDocumentId, evidence.anchorKey]);
        const previousEvidence = await client.query<{
          id: string;
          version_number: number;
          material_hash: string;
          source_document_version_id: string;
          quote_original: string | null;
          quote_original_hash: string | null;
          quote_language: string | null;
          quote_zh_cn: string | null;
          locator: SourceEvidence["locator"];
          locator_hash: string;
          locator_status: SourceEvidence["locatorStatus"];
          directness: SourceEvidence["directness"];
          capture_scope: SourceEvidence["captureScope"];
          extraction_method: string;
          extractor_version: string;
          captured_at: string | Date;
        }>(`
          SELECT id, version_number, material_hash, source_document_version_id,
                 quote_original, quote_original_hash, quote_language, quote_zh_cn,
                 locator, locator_hash, locator_status, directness, capture_scope,
                 extraction_method, extractor_version, captured_at
          FROM evidence_versions
          WHERE evidence_item_id = $1
          ORDER BY version_number DESC
          LIMIT 1
          FOR UPDATE
        `, [evidence.id]);
        const prior = previousEvidence.rows[0];
        const materialHash = evidenceVersionMaterialHash(evidence);
        const evidenceVersionId = prior?.material_hash === materialHash
          && prior.source_document_version_id === sourceVersionId ? prior.id : randomUUID();
        if (evidenceVersionId !== prior?.id) {
          const unavailableReason = evidence.locator.kind === "unavailable"
            ? [evidence.locator.reasonCode, evidence.locator.detail].filter(Boolean).join(": ")
            : null;
          await client.query(`
            INSERT INTO evidence_versions (
              id, evidence_item_id, source_document_id, source_document_version_id,
              version_number, previous_version_id, material_hash,
              quote_original, quote_original_hash, quote_language, quote_zh_cn,
              locator, locator_hash, locator_kind, locator_status, availability_status,
              directness, capture_scope, extraction_method, extractor_version,
              captured_at, unavailable_reason
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
              $17, $18, $19, $20, $21, $22
            )
          `, [
            evidenceVersionId,
            evidence.id,
            story.sourceDocumentId,
            sourceVersionId,
            (prior?.version_number ?? 0) + 1,
            prior?.id ?? null,
            materialHash,
            evidence.quoteOriginal ?? null,
            evidence.quoteHash ?? null,
            evidence.quoteLanguage ?? null,
            evidence.quoteZhCn ?? null,
            JSON.stringify(evidence.locator),
            evidence.locatorHash,
            evidence.locator.kind,
            evidence.locatorStatus,
            evidence.locatorStatus === "unavailable" ? "unavailable" : "available",
            evidence.directness,
            evidence.captureScope,
            evidence.extractionMethod,
            evidence.extractorVersion,
            evidence.capturedAt,
            unavailableReason,
          ]);
        }
        normalizedEvidence.push(prior?.id === evidenceVersionId ? normalizeSourceEvidence({
          id: evidence.id,
          versionId: prior.id,
          sourceDocumentId: story.sourceDocumentId!,
          sourceDocumentVersionId: prior.source_document_version_id,
          anchorKey: evidence.anchorKey,
          ...(prior.quote_original === null ? {} : { quoteOriginal: prior.quote_original }),
          ...(prior.quote_original_hash === null ? {} : { quoteHash: prior.quote_original_hash }),
          ...(prior.quote_language === null ? {} : { quoteLanguage: prior.quote_language }),
          ...(prior.quote_zh_cn === null ? {} : { quoteZhCn: prior.quote_zh_cn }),
          locator: prior.locator,
          locatorHash: prior.locator_hash,
          locatorStatus: prior.locator_status,
          directness: prior.directness,
          captureScope: prior.capture_scope,
          extractionMethod: prior.extraction_method,
          extractorVersion: prior.extractor_version,
          // `evidence_versions.captured_at` is when this immutable material
          // version was first recorded. A returned story is a projection of
          // the current source observation and must carry that observation's
          // capture time even when the version id is reused.
          capturedAt: evidence.capturedAt,
        }) : { ...evidence, versionId: evidenceVersionId });
      }
      const canonicalOriginalPublishedAt = dbOptionalIso(provenance.original_published_at);
      const canonicalCapture: SourceCapture = {
        rawUrl: capture.rawUrl ?? story.url,
        canonicalUrl: provenance.canonical_url,
        ...(capture.finalUrl ? { finalUrl: capture.finalUrl } : {}),
        ...(capture.feedUrl ? { feedUrl: capture.feedUrl } : {}),
        ...(capture.mimeType ? { mimeType: capture.mimeType } : {}),
        ...(capture.httpStatus === undefined ? {} : { httpStatus: capture.httpStatus }),
        originalPublishedAt: canonicalOriginalPublishedAt,
        ...(provenance.published_at_raw ? { publishedAtRaw: provenance.published_at_raw } : {}),
        ...(provenance.published_at_field ? { publishedAtField: provenance.published_at_field } : {}),
        ...(provenance.source_updated_at ? { sourceUpdatedAt: iso(provenance.source_updated_at) } : {}),
        collectedAt: lastCollectedAt,
        scope: capture.scope,
        capturedContentHash: provenance.captured_content_hash,
        ...(provenance.captured_artifact === null ? {} : { capturedArtifact: provenance.captured_artifact }),
        ...(provenance.captured_artifact_encoding === null ? {} : {
          capturedArtifactEncoding: provenance.captured_artifact_encoding,
        }),
        ...(provenance.captured_artifact_size_bytes === null ? {} : {
          capturedArtifactSizeBytes: provenance.captured_artifact_size_bytes,
        }),
        ...(provenance.captured_text_hash === null ? {} : { capturedTextHash: provenance.captured_text_hash }),
        extractionMethod: provenance.extraction_method,
        extractorVersion: provenance.extractor_version,
        backfillQuality: provenance.backfill_quality,
      };
      assertSourceCaptureArtifact(canonicalCapture);
      resolved[observation.index] = {
        ...storyForVersion,
        url: capture.rawUrl ?? story.url,
        nativeId: provenance.native_id ?? undefined,
        canonicalUrl: provenance.canonical_url,
        contentHash: provenance.captured_content_hash,
        publishedAt: canonicalOriginalPublishedAt ?? lastCollectedAt,
        originalPublishedAt: canonicalOriginalPublishedAt,
        publishedAtRaw: provenance.published_at_raw ?? undefined,
        publishedAtField: provenance.published_at_field ?? undefined,
        sourceUpdatedAt: provenance.source_updated_at ? iso(provenance.source_updated_at) : undefined,
        collectedAt: lastCollectedAt,
        lastCollectedAt,
        timestampKind: provenance.timestamp_kind,
        capture: canonicalCapture,
        sourceObservationId,
        evidence: normalizedEvidence,
      };
    }
    await client.query("COMMIT");
    return { count: resolved.length, stories: resolved };
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
  actor?: {
    type: "system" | "admin";
    /** Keyed-HMAC pseudonymous actor identifier; never pass a credential itself. */
    idHash?: string;
    reason?: string;
    requestId?: string;
  };
  evidenceRetractions?: EvidenceRetractionRequest[];
}

type NormalizedPersistBriefOptions =
  Required<Pick<PersistBriefOptions, "stream" | "batchKey" | "observedAt">>
  & {
    actor: NonNullable<PersistBriefOptions["actor"]>;
    evidenceRetractions: EvidenceRetractionRequest[];
  };

function normalizeActor(actor: PersistBriefOptions["actor"]): NonNullable<PersistBriefOptions["actor"]> {
  const normalized = actor ?? { type: "system" as const };
  if (normalized.idHash && !/^[0-9a-f]{64}$/.test(normalized.idHash)) {
    throw new TypeError("actor.idHash must be a lowercase SHA-256 digest");
  }
  if (normalized.type === "admin"
    && (!normalized.idHash || !normalized.reason?.trim() || !normalized.requestId?.trim())) {
    throw new TypeError(
      "admin changes require a pseudonymous actor hash, explicit reason, and server request ID",
    );
  }
  return {
    ...normalized,
    reason: normalized.reason?.trim(),
    requestId: normalized.requestId?.trim(),
  };
}

function groupEvidenceRetractions(
  options: NormalizedPersistBriefOptions,
): Map<string, EvidenceRetractionRequest[]> {
  if (!options.evidenceRetractions.length) return new Map();
  if (!options.actor.idHash || !options.actor.reason?.trim()) {
    throw new TypeError("evidence retractions require an identified actor and an explicit audit reason");
  }
  const seen = new Set<string>();
  const grouped = new Map<string, EvidenceRetractionRequest[]>();
  for (const request of options.evidenceRetractions) {
    if (Boolean(request.claimKey) !== Boolean(request.citationRelation)
      || (request.citationRelation !== undefined
        && !["supports", "contradicts", "context"].includes(request.citationRelation))) {
      throw new TypeError(
        `retraction ${request.requestId} must pair a claim key with one exact citation relation`,
      );
    }
    if (seen.has(request.requestId)) {
      throw new TypeError(`duplicate evidence retraction request ID: ${request.requestId}`);
    }
    seen.add(request.requestId);
    const requests = grouped.get(request.eventId) ?? [];
    requests.push(structuredClone(request));
    grouped.set(request.eventId, requests);
  }
  return grouped;
}

type DailyBriefWrite =
  | { kind: "save_draft" }
  | { kind: "update_draft"; id: string; expectedSnapshotId?: string };

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

function latestMemoryObservation(
  eventId: string,
  boundary: { date: string; maximumSameDateSequence: number },
): BriefSnapshotEventRecord | undefined {
  return [...briefSnapshotMemory.values()]
    .filter((snapshot) =>
      snapshot.date < boundary.date
      || (
        snapshot.date === boundary.date
        && snapshot.sequenceNumber <= boundary.maximumSameDateSequence
      ))
    .sort((left, right) => right.date.localeCompare(left.date)
      || right.sequenceNumber - left.sequenceNumber)
    .flatMap((snapshot) => snapshot.events)
    .find((event) => event.eventId === eventId);
}

function previousPublishedMemorySnapshot(date: string): BriefSnapshotRecord | undefined {
  const record = [...memory.values()]
    .filter((entry) => entry.status === "published" && entry.date < date)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const snapshotId = record?.brief.snapshot?.id;
  return snapshotId ? briefSnapshotMemory.get(snapshotId) : undefined;
}

function latestPublishedMemoryObservation(
  eventId: string,
  beforeDate: string,
): BriefSnapshotEventRecord | undefined {
  for (const record of [...memory.values()]
    .filter((entry) => entry.status === "published" && entry.date < beforeDate)
    .sort((left, right) => right.date.localeCompare(left.date))) {
    const snapshotId = record.brief.snapshot?.id;
    const event = snapshotId
      ? briefSnapshotMemory.get(snapshotId)?.events.find((candidate) => candidate.eventId === eventId)
      : undefined;
    if (event) return event;
  }
  return undefined;
}

function withoutDerivedWhatChanged(headline: Headline): Headline {
  const sanitized = structuredClone(headline);
  delete sanitized.whatChanged;
  return sanitized;
}

function applyEvidenceRetractions(
  previous: EventVersionRecord | undefined,
  current: Headline,
  requests: EvidenceRetractionRequest[],
): { headline: Headline; applied: EvidenceRetractionRequest[] } {
  if (!requests.length) return { headline: current, applied: [] };
  if (!previous) {
    throw new EvidenceIntegrityError(requests.map((request) => ({
      code: "RETRACTION_PREVIOUS_VERSION_REQUIRED",
      message: `Retraction ${request.requestId} requires an existing event version`,
      headlineId: current.id,
    })));
  }

  const headline = structuredClone(current);
  const applied: EvidenceRetractionRequest[] = [];
  for (const request of requests) {
    if (!request.requestId.trim() || !request.reasonNote.trim()) {
      throw new EvidenceIntegrityError([{
        code: "RETRACTION_REASON_REQUIRED",
        message: "Evidence retractions require a stable request ID and non-empty reason",
        headlineId: current.id,
      }]);
    }
    if (request.eventId !== current.id || request.fromEventVersionId !== previous.id) {
      throw new EvidenceIntegrityError([{
        code: "RETRACTION_VERSION_MISMATCH",
        message: `Retraction ${request.requestId} does not target the exact previous event version`,
        headlineId: current.id,
      }]);
    }
    const previousEvidence = previous.headline.sources
      .flatMap((source) => source.evidence ?? [])
      .find((evidence) =>
        evidence.id === request.evidenceItemId
        && evidence.versionId === request.evidenceVersionId);
    if (!previousEvidence) {
      throw new EvidenceIntegrityError([{
        code: "RETRACTION_EVIDENCE_MISSING",
        message: `Retraction ${request.requestId} targets evidence outside the previous event version`,
        headlineId: current.id,
      }]);
    }
    let previousCitationRelation: EvidenceRetractionRequest["citationRelation"];
    if (request.claimKey) {
      const claim = previous.headline.claims?.find((candidate) => candidate.claimKey === request.claimKey);
      const citations = claim?.citations.filter((candidate) =>
        candidate.id === request.evidenceItemId
        && candidate.versionId === request.evidenceVersionId
        && candidate.relation === request.citationRelation) ?? [];
      if (!claim || citations.length !== 1) {
        throw new EvidenceIntegrityError([{
          code: "RETRACTION_CLAIM_SUPPORT_MISSING",
          message: `Retraction ${request.requestId} does not target one exact ${request.citationRelation} relationship for ${request.claimKey}`,
          headlineId: current.id,
        }]);
      }
      previousCitationRelation = citations[0].relation;
    }

    if (!request.claimKey) {
      headline.sources = headline.sources.map((source) => ({
        ...source,
        evidence: source.evidence?.filter((evidence) =>
          evidence.id !== request.evidenceItemId
          || evidence.versionId !== request.evidenceVersionId),
      }));
    }
    headline.claims = headline.claims?.map((claim) => {
      if (request.claimKey && claim.claimKey !== request.claimKey) return claim;
      const citations = claim.citations.filter((citation) =>
        citation.id !== request.evidenceItemId
        || citation.versionId !== request.evidenceVersionId
        || (
          request.claimKey
          && citation.relation !== previousCitationRelation
        ));
      if (citations.length === claim.citations.length) return claim;
      const lostPublishableSupport = !citations.some((citation) =>
        citation.relation === "supports"
        && citation.confidence > 0
        && citation.locatorStatus !== "unavailable"
        && citation.directness !== "unavailable");
      return {
        ...claim,
        citations: citations.map((citation, order) => ({ ...citation, order })),
        verificationStatus: lostPublishableSupport
          ? "pending_confirmation" as const
          : claim.verificationStatus,
      };
    });

    if (request.replacementEvidenceVersionId) {
      const replacement = headline.sources
        .flatMap((source) => source.evidence ?? [])
        .find((evidence) => evidence.versionId === request.replacementEvidenceVersionId);
      if (!replacement) {
        throw new EvidenceIntegrityError([{
          code: "RETRACTION_REPLACEMENT_MISSING",
          message: `Replacement ${request.replacementEvidenceVersionId} is not part of the new event version`,
          headlineId: current.id,
        }]);
      }
      if (request.claimKey) {
        const replacementSupport = headline.claims
          ?.find((claim) => claim.claimKey === request.claimKey)
          ?.citations.some((citation) =>
            citation.relation === "supports"
            && citation.id === replacement.id
            && citation.versionId === replacement.versionId
            && citation.sourceDocumentId === replacement.sourceDocumentId
            && citation.sourceDocumentVersionId === replacement.sourceDocumentVersionId);
        if (!replacementSupport) {
          throw new EvidenceIntegrityError([{
            code: "RETRACTION_REPLACEMENT_SUPPORT_MISSING",
            message: `Replacement ${request.replacementEvidenceVersionId} is not exact support for ${request.claimKey}`,
            headlineId: current.id,
          }]);
        }
      }
    }
    applied.push(structuredClone(request));
  }
  return { headline, applied };
}

function changeItemClaimKey(
  item: EventVersionComparison["items"][number],
): string | undefined {
  for (const value of [item.before, item.after]) {
    if (value && typeof value.claimKey === "string" && value.claimKey.trim()) {
      return value.claimKey;
    }
  }
  return undefined;
}

function retractionAuthorizesChangeItem(
  request: EvidenceRetractionRequest,
  item: EventVersionComparison["items"][number],
): boolean {
  if (!item.evidenceVersionIds.includes(request.evidenceVersionId)) return false;
  if (request.claimKey) {
    const relation = item.before && typeof item.before.relation === "string"
      ? item.before.relation
      : item.kind === "claim_support_removed" || item.kind === "claim_support_changed"
        ? "supports"
        : undefined;
    return (
      item.kind === "claim_support_removed"
      || item.kind === "claim_support_changed"
      || item.kind === "claim_relation_removed"
      || item.kind === "claim_relation_changed"
    )
      && changeItemClaimKey(item) === request.claimKey
      && relation === request.citationRelation;
  }
  return item.kind === "evidence_removed"
    || item.kind === "evidence_revised"
    || item.kind === "claim_support_removed"
    || item.kind === "claim_support_changed"
    || item.kind === "claim_relation_removed"
    || item.kind === "claim_relation_changed";
}

function assertRetractionScope(
  comparison: EventVersionComparison,
  requests: EvidenceRetractionRequest[],
): void {
  const removalItems = comparison.items.filter((item) =>
    item.kind === "evidence_removed"
    || item.kind === "claim_support_removed"
    || item.kind === "claim_relation_removed");
  const unauthorized = removalItems.filter((item) => !requests.some((request) =>
    retractionAuthorizesChangeItem(request, item)));
  if (unauthorized.length) {
    throw new EvidenceIntegrityError(unauthorized.map((item) => ({
      code: "UNAUTHORIZED_EVIDENCE_REMOVAL",
      message: `Change item ${item.id} removes evidence without a matching scoped retraction`,
      headlineId: comparison.eventId,
    })));
  }
  const unused = requests.filter((request) => !comparison.items.some((item) =>
    retractionAuthorizesChangeItem(request, item)));
  if (unused.length) {
    throw new EvidenceIntegrityError(unused.map((request) => ({
      code: "RETRACTION_CHANGE_ITEM_BINDING_MISSING",
      message: `Retraction ${request.requestId} did not authorize an exact evidence change item`,
      headlineId: request.eventId,
    })));
  }
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
  const reviewedPayload: Partial<DailyBrief> = structuredClone(brief);
  delete reviewedPayload.id;
  delete reviewedPayload.status;
  delete reviewedPayload.publishedAt;
  delete reviewedPayload.storageMode;
  delete reviewedPayload.snapshot;
  return stableHash({
    schema: "brief-snapshot-payload/v2",
    payload: reviewedPayload,
  });
}

function persistenceInputHash(
  brief: DailyBrief,
  options: NormalizedPersistBriefOptions,
): string {
  return stableHash({
    schema: "brief-persistence-input/v1",
    brief: snapshotPayloadHash(brief),
    actor: options.actor,
    evidenceRetractions: [...options.evidenceRetractions]
      .sort((left, right) => left.requestId.localeCompare(right.requestId)),
  });
}

async function persistBriefObservationMemory(
  brief: DailyBrief,
  options: NormalizedPersistBriefOptions,
  dailyWrite?: DailyBriefWrite,
): Promise<PersistBriefResult> {
  const runKey = collectionRunKey(options.stream, options.batchKey);
  const inputHash = persistenceInputHash(brief, options);
  const generatedAt = validIsoOrNow(brief.generatedAt);
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

  if (dailyWrite?.kind === "update_draft") {
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
  const retractionBackup = structuredClone([...evidenceRetractionMemory.entries()]);

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
    const pendingRetractions = groupEvidenceRetractions(options);
    const appliedRetractionIds = new Set<string>();
    const idMap = new Map<string, string>();
    const stableHeadlines: Headline[] = [];
    const observations: BriefSnapshotEventRecord[] = [];
    const versionsByEvent = new Map<string, EventVersionRecord>();

    for (const incomingCandidate of brief.headlines) {
      const incoming = withoutDerivedWhatChanged(incomingCandidate);
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
      if (previousVersion
        && Date.parse(options.observedAt) < Date.parse(previousVersion.observedAt)) {
        throw new EvidenceIntegrityError([{
          code: "EVENT_OBSERVATION_TIME_REGRESSION",
          message: `Observation ${options.observedAt} precedes event version ${previousVersion.id} at ${previousVersion.observedAt}`,
          headlineId: entry.id,
        }]);
      }
      let stableHeadline = mergeRetainedEvidence(previousVersion?.headline, { ...structuredClone(incoming), id: entry.id });
      const retractionResult = applyEvidenceRetractions(
        previousVersion,
        stableHeadline,
        pendingRetractions.get(entry.id) ?? [],
      );
      stableHeadline = retractionResult.headline;
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
          actorType: options.actor.type,
          actorIdHash: options.actor.idHash,
          changeReason: options.actor.reason,
          requestId: options.actor.requestId,
          createdAt,
        };
        const numericFacts = extractNumericFacts(stableHeadline);
        version.numericFacts = numericFacts;
        version.comparison = compareEventVersions(previousVersion, version, {
          previous: previousVersion?.numericFacts ?? (
            previousVersion ? extractNumericFacts(previousVersion.headline) : undefined
          ),
          current: numericFacts,
        });
        assertRetractionScope(version.comparison, retractionResult.applied);
        entry.versions.push(version);
      }
      if (retractionResult.applied.length && version === previousVersion) {
        throw new EvidenceIntegrityError(retractionResult.applied.map((request) => ({
          code: "RETRACTION_DID_NOT_CREATE_VERSION",
          message: `Retraction ${request.requestId} did not change the immutable event material`,
          headlineId: entry!.id,
        })));
      }
      for (const request of retractionResult.applied) {
        const requestHash = stableHash(request);
        const existingRetraction = evidenceRetractionMemory.get(request.requestId);
        if (existingRetraction) {
          if (existingRetraction.requestHash !== requestHash) {
            throw new Error(`Retraction request ${request.requestId} was reused with different content`);
          }
          throw new Error(`Retraction request ${request.requestId} was already applied`);
        }
        evidenceRetractionMemory.set(request.requestId, {
          request: structuredClone(request),
          requestHash,
          toEventVersionId: version.id,
          actorType: options.actor.type,
          actorIdHash: options.actor.idHash!,
          requestedAt: options.observedAt,
        });
        appliedRetractionIds.add(request.requestId);
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
      versionsByEvent.set(entry.id, version);
      stableHeadlines.push(stableHeadline);
      observations.push({
        snapshotId: "",
        eventId: entry.id,
        eventVersionId: version.id,
        rank: stableHeadline.rank,
        rankingScore: stableHeadline.rankingScore,
        freshnessScore: stableHeadline.freshnessScore,
        impact: stableHeadline.impact,
        confidence: stableHeadline.confidence,
        mentions: stableHeadline.mentions,
        crossSourceCount: stableHeadline.crossSourceCount,
        matchMethod,
        matchConfidence,
      });
    }
    if (appliedRetractionIds.size !== options.evidenceRetractions.length) {
      const missing = options.evidenceRetractions
        .filter((request) => !appliedRetractionIds.has(request.requestId));
      throw new EvidenceIntegrityError(missing.map((request) => ({
        code: "RETRACTION_EVENT_NOT_IN_SNAPSHOT",
        message: `Retraction ${request.requestId} did not resolve to a current snapshot event`,
        headlineId: request.eventId,
      })));
    }

    const previous = [...briefSnapshotMemory.values()]
      .filter((snapshot) => snapshot.date === brief.date)
      .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0];
    if (previous && Date.parse(generatedAt) < Date.parse(previous.generatedAt)) {
      throw new EvidenceIntegrityError([{
        code: "SNAPSHOT_GENERATED_TIME_REGRESSION",
        message: `Snapshot time ${generatedAt} precedes same-date snapshot ${previous.id} at ${previous.generatedAt}`,
        headlineId: brief.headlines[0]?.id ?? "brief",
      }]);
    }
    const sequenceNumber = (previous?.sequenceNumber ?? 0) + 1;
    const snapshotId = randomUUID();
    const persistedAt = new Date().toISOString();
    const previousPublished = previousPublishedMemorySnapshot(brief.date);
    const finalizedObservations: BriefSnapshotEventRecord[] = [];
    const projectedHeadlines = stableHeadlines.map((headline, index) => {
      const baseObservation = observations[index];
      const currentObservation: BriefSnapshotEventRecord = {
        ...baseObservation,
        snapshotId,
      };
      const currentVersion = versionsByEvent.get(headline.id);
      if (!currentVersion) throw new Error(`Missing current event version for ${headline.id}`);
      const allVersions = eventMemory.get(headline.id)?.versions ?? [];
      const intrinsicComparison = currentVersion.comparison ?? compareEventVersions(
        currentVersion.previousVersionId
          ? allVersions.find((candidate) => candidate.id === currentVersion.previousVersionId)
          : undefined,
        currentVersion,
        {
          previous: currentVersion.previousVersionId
            ? allVersions.find((candidate) => candidate.id === currentVersion.previousVersionId)?.numericFacts
            : undefined,
          current: currentVersion.numericFacts,
        },
      );
      const historicalObservation = latestMemoryObservation(headline.id, {
        date: brief.date,
        maximumSameDateSequence: previous?.sequenceNumber ?? 0,
      });
      const isFirstSeen = !historicalObservation
        && currentVersion.versionNumber === 1
        && !currentVersion.previousVersionId;
      const operationalBaseline = previous?.events.find((event) => event.eventId === headline.id);
      const operationalPreviousVersion = operationalBaseline
        ? allVersions.find((candidate) => candidate.id === operationalBaseline.eventVersionId)
        : undefined;
      const operationalContent = operationalBaseline
        && operationalPreviousVersion
        && operationalPreviousVersion.id !== currentVersion.id
        ? compareEventBaseline(operationalPreviousVersion, currentVersion, {
            previous: operationalPreviousVersion.numericFacts,
            current: currentVersion.numericFacts,
          })
        : undefined;
      const operational = compareSnapshotEvent({
        baselineKind: "previous_observation",
        baselineSnapshotId: previous?.id,
        baselineEvent: operationalBaseline,
        historicalObservation: operationalBaseline ? undefined : historicalObservation,
        current: currentObservation,
        currentSnapshotId: snapshotId,
        comparedAt: options.observedAt,
        isFirstSeen,
        legacyUnverified: intrinsicComparison.status === "legacy_unverified",
        contentComparison: operationalContent,
      });

      const investorBaseline = previousPublished?.events.find((event) => event.eventId === headline.id);
      const investorHistorical = investorBaseline
        ? undefined
        : latestPublishedMemoryObservation(headline.id, brief.date);
      const investorPreviousVersion = investorBaseline
        ? allVersions.find((candidate) => candidate.id === investorBaseline.eventVersionId)
        : undefined;
      const investorContent = investorBaseline
        && investorPreviousVersion
        && investorPreviousVersion.id !== currentVersion.id
        ? compareEventBaseline(investorPreviousVersion, currentVersion, {
            previous: investorPreviousVersion.numericFacts,
            current: currentVersion.numericFacts,
          })
        : undefined;
      const investor = compareSnapshotEvent({
        baselineKind: "previous_published",
        baselineSnapshotId: previousPublished?.id,
        baselineEvent: investorBaseline,
        historicalObservation: investorBaseline ? undefined : investorHistorical,
        current: currentObservation,
        currentSnapshotId: snapshotId,
        comparedAt: options.observedAt,
        isFirstSeen,
        legacyUnverified: intrinsicComparison.status === "legacy_unverified",
        contentComparison: investorContent,
      });
      const whatChanged = projectWhatChanged({
        investor,
        operational,
        latestVersion: intrinsicComparison,
      });
      finalizedObservations.push({
        ...currentObservation,
        changes: [operational, investor],
      });
      return { ...headline, whatChanged };
    });
    let stableBrief = remapBriefRelations(brief, idMap, projectedHeadlines);
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
        events: finalizedObservations.map(snapshotEventProjection),
      },
    };
    const snapshot: BriefSnapshotRecord = {
      id: snapshotId,
      runId: run.id,
      stream: options.stream,
      batchKey: options.batchKey,
      sequenceNumber,
      date: brief.date,
      generatedAt,
      previousSnapshotId: previous?.id,
      payloadHash,
      brief: structuredClone(stableBrief),
      createdAt: persistedAt,
      actorType: options.actor.type,
      actorIdHash: options.actor.idHash,
      actionReason: options.actor.reason,
      actionRequestId: options.actor.requestId,
      events: finalizedObservations,
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
          currentSnapshotId: snapshotId,
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
      entry.currentSnapshotId = snapshotId;
      entry.updatedAt = persistedAt;
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
    evidenceRetractionMemory.clear();
    for (const [key, value] of retractionBackup) evidenceRetractionMemory.set(key, value);
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
           previous_snapshot_id, payload_hash, payload, actor_type, actor_id_hash,
           action_reason, action_request_id, created_at
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
  const events: BriefSnapshotEventRecord[] = [];
  for (const eventRow of eventResult.rows) {
    const event = rowToSnapshotEvent(eventRow);
    events.push({
      ...event,
      changes: await loadSnapshotEventChanges(client, row.id, event.eventId),
    });
  }
  return rowToBriefSnapshot(row, events);
}

async function loadLatestEventVersion(client: PoolClient, eventId: string, lock = false): Promise<EventVersionRecord | undefined> {
  const result = await client.query<EventVersionRow>(`
    SELECT id, event_id, version_number, previous_version_id, content_hash,
           evidence_hash, state_hash, presentation_hash, observed_at, run_id,
           payload, actor_type, actor_id_hash, change_reason, request_id,
           created_at
    FROM event_versions
    WHERE event_id = $1
    ORDER BY version_number DESC
    LIMIT 1
    ${lock ? "FOR UPDATE" : ""}
  `, [eventId]);
  return result.rows[0]
    ? await loadEventVersionAudit(client, rowToEventVersion(result.rows[0]))
    : undefined;
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

async function loadEventVersionById(
  client: PoolClient | Pool,
  eventId: string,
  versionId: string,
): Promise<EventVersionRecord | undefined> {
  const result = await client.query<EventVersionRow>(`
    SELECT id, event_id, version_number, previous_version_id, content_hash,
           evidence_hash, state_hash, presentation_hash, observed_at, run_id,
           payload, actor_type, actor_id_hash, change_reason, request_id,
           created_at
    FROM event_versions
    WHERE event_id = $1 AND id = $2
  `, [eventId, versionId]);
  return result.rows[0]
    ? await loadEventVersionAudit(client, rowToEventVersion(result.rows[0]))
    : undefined;
}

async function loadSnapshotEvent(
  client: PoolClient | Pool,
  snapshotId: string | undefined,
  eventId: string,
): Promise<BriefSnapshotEventRecord | undefined> {
  if (!snapshotId) return undefined;
  const result = await client.query<BriefSnapshotEventRow>(`
    SELECT snapshot_id, event_id, event_version_id, rank, ranking_score,
           freshness_score, impact, confidence, mentions, cross_source_count,
           match_method, match_confidence
    FROM brief_snapshot_events
    WHERE snapshot_id = $1 AND event_id = $2
  `, [snapshotId, eventId]);
  return result.rows[0] ? rowToSnapshotEvent(result.rows[0]) : undefined;
}

async function loadLatestSnapshotObservation(
  client: PoolClient | Pool,
  eventId: string,
  beforeDate: string,
  maximumSameDateSequence: number,
  createdAsOf?: string,
): Promise<BriefSnapshotEventRecord | undefined> {
  const result = await client.query<BriefSnapshotEventRow>(`
    SELECT observation.snapshot_id, observation.event_id,
           observation.event_version_id, observation.rank,
           observation.ranking_score, observation.freshness_score,
           observation.impact, observation.confidence, observation.mentions,
           observation.cross_source_count, observation.match_method,
           observation.match_confidence
    FROM brief_snapshot_events AS observation
    JOIN brief_snapshots AS snapshot ON snapshot.id = observation.snapshot_id
    WHERE observation.event_id = $1
      AND (
        snapshot.brief_date < $2
        OR (
          snapshot.brief_date = $2
          AND snapshot.sequence_number <= $3
        )
      )
      AND ($4::timestamptz IS NULL OR snapshot.created_at <= $4::timestamptz)
    ORDER BY snapshot.brief_date DESC, snapshot.sequence_number DESC
    LIMIT 1
  `, [eventId, beforeDate, maximumSameDateSequence, createdAsOf ?? null]);
  return result.rows[0] ? rowToSnapshotEvent(result.rows[0]) : undefined;
}

async function loadPreviousPublishedSnapshotId(
  client: PoolClient | Pool,
  date: string,
  publishedAsOf?: string,
): Promise<string | undefined> {
  const result = await client.query<{ current_snapshot_id: string }>(`
    SELECT current_snapshot_id
    FROM daily_briefs
    WHERE status = 'published'
      AND brief_date < $1
      AND current_snapshot_id IS NOT NULL
      AND ($2::timestamptz IS NULL OR published_at <= $2::timestamptz)
    ORDER BY brief_date DESC
    LIMIT 1
  `, [date, publishedAsOf ?? null]);
  return result.rows[0]?.current_snapshot_id;
}

async function loadLatestPublishedObservation(
  client: PoolClient | Pool,
  eventId: string,
  beforeDate: string,
  publishedAsOf?: string,
): Promise<BriefSnapshotEventRecord | undefined> {
  const result = await client.query<BriefSnapshotEventRow>(`
    SELECT observation.snapshot_id, observation.event_id,
           observation.event_version_id, observation.rank,
           observation.ranking_score, observation.freshness_score,
           observation.impact, observation.confidence, observation.mentions,
           observation.cross_source_count, observation.match_method,
           observation.match_confidence
    FROM daily_briefs AS brief
    JOIN brief_snapshot_events AS observation
      ON observation.snapshot_id = brief.current_snapshot_id
    WHERE brief.status = 'published'
      AND brief.brief_date < $2
      AND ($3::timestamptz IS NULL OR brief.published_at <= $3::timestamptz)
      AND observation.event_id = $1
    ORDER BY brief.brief_date DESC
    LIMIT 1
  `, [eventId, beforeDate, publishedAsOf ?? null]);
  return result.rows[0] ? rowToSnapshotEvent(result.rows[0]) : undefined;
}

export class EvidenceIntegrityError extends Error {
  readonly code = "EVIDENCE_INTEGRITY_ERROR";
  readonly issues: Array<{ code: string; message: string; headlineId: string }>;

  constructor(issues: Array<{ code: string; message: string; headlineId: string }>) {
    super(`Evidence integrity validation failed: ${issues.map((issue) => `${issue.code} (${issue.headlineId})`).join(", ")}`);
    this.name = "EvidenceIntegrityError";
    this.issues = issues;
  }
}

async function persistHeadlineEvidenceRelations(
  client: PoolClient,
  eventId: string,
  eventVersionId: string,
  headline: Headline,
): Promise<void> {
  const sourceVersions = headline.sources
    .filter((source): source is typeof source & { sourceDocumentId: string; sourceDocumentVersionId: string } =>
      Boolean(source.sourceDocumentId && source.sourceDocumentVersionId))
    .filter((source, index, all) => all.findIndex((candidate) =>
      candidate.sourceDocumentVersionId === source.sourceDocumentVersionId) === index);

  const authoritativeSources = sourceVersions.map((source, index) => ({
    source,
    sourceRole: source.role
      ?? (index === 0 ? "primary" : source.type === "Reddit" || source.type === "X" ? "social_signal" : "corroborating"),
    sourceOrdinal: index + 1,
  }));

  for (const { source, sourceRole, sourceOrdinal } of authoritativeSources) {
    await client.query(`
      INSERT INTO event_version_sources (
        event_id, event_version_id, source_document_id, source_document_version_id,
        source_role, ordinal
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [eventId, eventVersionId, source.sourceDocumentId, source.sourceDocumentVersionId, sourceRole, sourceOrdinal]);

    for (const [evidenceIndex, evidence] of (source.evidence ?? []).entries()) {
      if (!evidence.versionId
        || evidence.sourceDocumentId !== source.sourceDocumentId
        || evidence.sourceDocumentVersionId !== source.sourceDocumentVersionId) {
        throw new EvidenceIntegrityError([{
          code: "EVENT_EVIDENCE_VERSION_REQUIRED",
          message: `Evidence ${evidence.id} must bind to the exact displayed source version`,
          headlineId: headline.id,
        }]);
      }
      await client.query(`
        INSERT INTO event_version_evidence (
          event_id, event_version_id, source_document_id, source_document_version_id,
          source_role, source_ordinal, evidence_item_id, evidence_version_id,
          directness, evidence_ordinal
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        eventId,
        eventVersionId,
        source.sourceDocumentId,
        source.sourceDocumentVersionId,
        sourceRole,
        sourceOrdinal,
        evidence.id,
        evidence.versionId,
        evidence.directness,
        evidenceIndex + 1,
      ]);
    }
  }

  if (!headline.claims?.length) return;
  const validation = validateHeadlineEvidence(headline);
  if (!validation.valid) throw new EvidenceIntegrityError(validation.issues);

  for (const claim of headline.claims) {
    const claimDatabaseId = randomUUID();
    await client.query(`
      INSERT INTO event_claims (
        id, event_id, event_version_id, claim_key, claim_type, ordinal,
        statement, original_statement, statement_hash, language,
        verification_status, generator, generator_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      claimDatabaseId,
      eventId,
      eventVersionId,
      claim.claimKey,
      claim.type,
      claim.ordinal + 1,
      claim.statement,
      claim.originalStatement ?? null,
      claim.statementHash,
      claim.language,
      claim.verificationStatus,
      claim.generator,
      claim.generatorVersion,
    ]);
    for (const [citationIndex, citation] of claim.citations.entries()) {
      if (!citation.sourceDocumentVersionId || !citation.versionId) {
        throw new EvidenceIntegrityError([{
          code: "CITATION_VERSION_REQUIRED",
          message: `Claim ${claim.claimKey} must cite an exact source and evidence version`,
          headlineId: headline.id,
        }]);
      }
      await client.query(`
        INSERT INTO claim_evidence_links (
          event_id, event_version_id, claim_id, claim_key,
          source_document_id, source_document_version_id,
          evidence_item_id, evidence_version_id, relation, directness,
          confidence, ordinal
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        eventId,
        eventVersionId,
        claimDatabaseId,
        claim.claimKey,
        citation.sourceDocumentId,
        citation.sourceDocumentVersionId,
        citation.id,
        citation.versionId,
        citation.relation,
        citation.directness,
        citation.confidence,
        citationIndex + 1,
      ]);
    }
  }
}

async function persistEventVersionAudit(
  client: PoolClient,
  comparison: EventVersionComparison,
  numericFacts: NumericFact[],
): Promise<void> {
  await client.query(`
    INSERT INTO event_version_comparisons (
      event_id, current_version_id, previous_version_id, status,
      algorithm_version, input_hash, result_hash, summary, compared_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    comparison.eventId,
    comparison.currentVersionId,
    comparison.previousVersionId ?? null,
    comparison.status,
    comparison.algorithmVersion,
    comparison.inputHash,
    comparison.resultHash,
    comparison.summary,
    comparison.comparedAt,
  ]);

  for (const item of comparison.items) {
    await client.query(`
      INSERT INTO event_version_change_items (
        event_id, current_version_id, algorithm_version, item_id, ordinal,
        kind, subject_key, reason_code, summary, before_value, after_value,
        evidence_version_ids, change_hash
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
        $12::uuid[], $13
      )
    `, [
      comparison.eventId,
      comparison.currentVersionId,
      comparison.algorithmVersion,
      item.id,
      item.ordinal,
      item.kind,
      item.subjectKey,
      item.reasonCode,
      item.summary,
      item.before === undefined ? null : JSON.stringify(item.before),
      item.after === undefined ? null : JSON.stringify(item.after),
      item.evidenceVersionIds,
      item.changeHash,
    ]);
  }

  for (const fact of numericFacts) {
    await client.query(`
      INSERT INTO event_version_numeric_facts (
        event_id, event_version_id, fact_key, claim_key, metric_key,
        subject_key, period_key, value_numeric, value_canonical, unit,
        currency, scale, raw_token, start_offset, end_offset, original_text,
        parser_version, comparison_status, comparison_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::numeric, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
    `, [
      comparison.eventId,
      comparison.currentVersionId,
      fact.factKey,
      fact.claimKey,
      fact.metricKey,
      fact.subjectKey,
      fact.periodKey,
      fact.value,
      fact.unit,
      fact.currency ?? null,
      fact.scale,
      fact.rawToken,
      fact.startOffset,
      fact.endOffset,
      fact.originalText,
      fact.parserVersion,
      fact.comparisonStatus,
      fact.comparisonReason,
    ]);

    for (const evidenceVersionId of fact.evidenceVersionIds) {
      const inserted = await client.query(`
        INSERT INTO event_version_numeric_fact_evidence (
          event_id, event_version_id, fact_key, claim_id, claim_key,
          evidence_item_id, evidence_version_id, relation
        )
        SELECT
          link.event_id, link.event_version_id, $3, link.claim_id,
          link.claim_key, link.evidence_item_id, link.evidence_version_id,
          link.relation
        FROM claim_evidence_links AS link
        WHERE link.event_id = $1
          AND link.event_version_id = $2
          AND link.claim_key = $4
          AND link.evidence_version_id = $5
          AND link.relation = 'supports'
      `, [
        comparison.eventId,
        comparison.currentVersionId,
        fact.factKey,
        fact.claimKey,
        evidenceVersionId,
      ]);
      if (inserted.rowCount !== 1) {
        throw new EvidenceIntegrityError([{
          code: "NUMERIC_FACT_EVIDENCE_MISMATCH",
          message: `Numeric fact ${fact.factKey} is not bound to exact supporting evidence ${evidenceVersionId}`,
          headlineId: comparison.eventId,
        }]);
      }
    }
  }
}

async function persistRetractionChangeItemBindings(
  client: PoolClient,
  request: EvidenceRetractionRequest,
  currentVersionId: string,
): Promise<void> {
  const inserted = await client.query(`
    INSERT INTO event_version_change_item_retractions (
      event_id, current_version_id, algorithm_version, item_id,
      request_id, evidence_version_id
    )
    SELECT
      item.event_id, item.current_version_id, item.algorithm_version,
      item.item_id, $3, $4
    FROM event_version_change_items AS item
    WHERE item.event_id = $1
      AND item.current_version_id = $2
      AND item.kind IN (
        'evidence_removed', 'claim_support_removed',
        'evidence_revised', 'claim_support_changed',
        'claim_relation_removed', 'claim_relation_changed'
      )
      AND $4::uuid = ANY(item.evidence_version_ids)
      AND (
        $5::text IS NULL
        OR (
          item.kind IN (
            'claim_support_removed', 'claim_support_changed',
            'claim_relation_removed', 'claim_relation_changed'
          )
          AND COALESCE(
            item.before_value->>'claimKey',
            item.after_value->>'claimKey'
          ) = $5
          AND COALESCE(
            item.before_value->>'relation',
            CASE
              WHEN item.kind IN ('claim_support_removed', 'claim_support_changed')
              THEN 'supports'
              ELSE NULL
            END
          ) = $6
        )
      )
    ON CONFLICT DO NOTHING
  `, [
    request.eventId,
    currentVersionId,
    request.requestId,
    request.evidenceVersionId,
    request.claimKey ?? null,
    request.citationRelation ?? null,
  ]);
  if (!inserted.rowCount) {
    throw new EvidenceIntegrityError([{
      code: "RETRACTION_CHANGE_ITEM_BINDING_MISSING",
      message: `Retraction ${request.requestId} did not create an exact evidence change item`,
      headlineId: request.eventId,
    }]);
  }
}

async function assertWhatChangedAlgorithmRegistry(client: PoolClient): Promise<void> {
  const expectedConfig = {
    schema: "what-changed/v1",
    evidence: "exact-event-and-claim-relation-bindings",
    numbers: "original-claim-explicit-unit-v1",
    direction: "explicit-market-direction",
    rankDelta: "previous-current",
    baselines: ["previous_observation", "previous_published"],
  };
  const result = await client.query<{
    implementation_hash: string;
    config: Record<string, unknown> | string;
  }>(`
    SELECT implementation_hash, config
    FROM comparison_algorithms
    WHERE version = $1
  `, [WHAT_CHANGED_ALGORITHM_VERSION]);
  const row = result.rows[0];
  const config = row
    ? (typeof row.config === "string" ? JSON.parse(row.config) as Record<string, unknown> : row.config)
    : undefined;
  if (row?.implementation_hash !== WHAT_CHANGED_IMPLEMENTATION_HASH
    || canonicalJson(config) !== canonicalJson(expectedConfig)) {
    throw new Error(
      `What Changed algorithm registry mismatch for ${WHAT_CHANGED_ALGORITHM_VERSION}`,
    );
  }
}

async function persistSnapshotEventChange(
  client: PoolClient,
  change: SnapshotEventChange,
  historicalObservation?: BriefSnapshotEventRecord,
): Promise<void> {
  await client.query(`
    INSERT INTO brief_snapshot_event_changes (
      current_snapshot_id, event_id, current_event_version_id, baseline_kind,
      baseline_snapshot_id, baseline_event_id, baseline_event_version_id,
      historical_observation_snapshot_id, historical_observation_event_id,
      historical_observation_event_version_id, presence, previous_rank,
      current_rank, rank_delta, rank_movement, status, algorithm_version,
      input_hash, result_hash, summary, compared_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21
    )
  `, [
    change.currentSnapshotId,
    change.eventId,
    change.currentEventVersionId,
    change.baselineKind,
    change.baselineSnapshotId ?? null,
    change.baselineEventVersionId ? change.eventId : null,
    change.baselineEventVersionId ?? null,
    historicalObservation?.snapshotId ?? null,
    historicalObservation?.eventId ?? null,
    historicalObservation?.eventVersionId ?? null,
    change.presence,
    change.previousRank ?? null,
    change.currentRank,
    change.rankDelta ?? null,
    change.rankMovement,
    change.status,
    change.algorithmVersion,
    change.inputHash,
    change.resultHash,
    change.summary,
    change.comparedAt,
  ]);

  for (const item of change.items) {
    await client.query(`
      INSERT INTO brief_snapshot_event_change_items (
        current_snapshot_id, event_id, baseline_kind, algorithm_version,
        item_id, ordinal, kind, subject_key, reason_code, summary,
        before_value, after_value, evidence_version_ids, change_hash
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11::jsonb, $12::jsonb, $13::uuid[], $14
      )
    `, [
      change.currentSnapshotId,
      change.eventId,
      change.baselineKind,
      change.algorithmVersion,
      item.id,
      item.ordinal,
      item.kind,
      item.subjectKey,
      item.reasonCode,
      item.summary,
      item.before === undefined ? null : JSON.stringify(item.before),
      item.after === undefined ? null : JSON.stringify(item.after),
      item.evidenceVersionIds,
      item.changeHash,
    ]);
  }
}

async function loadEventVersionAudit(
  client: PoolClient | Pool,
  version: EventVersionRecord,
): Promise<EventVersionRecord> {
  const comparisonResult = await client.query<EventVersionComparisonRow>(`
    SELECT event_id, current_version_id, previous_version_id, status,
           algorithm_version, input_hash, result_hash, summary, compared_at
    FROM event_version_comparisons
    WHERE event_id = $1 AND current_version_id = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [version.eventId, version.id]);
  const comparisonRow = comparisonResult.rows[0];
  let comparison: EventVersionComparison | undefined;
  if (comparisonRow) {
    const itemRows = await client.query<WhatChangedItemRow>(`
      SELECT item_id, ordinal, kind, subject_key, reason_code, summary,
             before_value, after_value, evidence_version_ids, change_hash
      FROM event_version_change_items
      WHERE event_id = $1 AND current_version_id = $2
        AND algorithm_version = $3
      ORDER BY ordinal
    `, [version.eventId, version.id, comparisonRow.algorithm_version]);
    comparison = rowToEventVersionComparison(
      comparisonRow,
      itemRows.rows.map(rowToWhatChangedItem),
    );
  }
  const factRows = await client.query<NumericFactRow>(`
    SELECT fact.fact_key, fact.claim_key, fact.metric_key, fact.subject_key,
           fact.period_key, fact.value_canonical, fact.unit, fact.currency,
           fact.scale, fact.raw_token, fact.start_offset, fact.end_offset,
           fact.original_text, fact.parser_version, fact.comparison_status,
           fact.comparison_reason,
           COALESCE(
             array_agg(binding.evidence_version_id::text)
               FILTER (WHERE binding.evidence_version_id IS NOT NULL),
             '{}'
           ) AS evidence_version_ids
    FROM event_version_numeric_facts AS fact
    LEFT JOIN event_version_numeric_fact_evidence AS binding
      ON binding.event_id = fact.event_id
     AND binding.event_version_id = fact.event_version_id
     AND binding.fact_key = fact.fact_key
    WHERE fact.event_id = $1 AND fact.event_version_id = $2
    GROUP BY
      fact.fact_key, fact.claim_key, fact.metric_key, fact.subject_key,
      fact.period_key, fact.value_canonical, fact.unit, fact.currency,
      fact.scale, fact.raw_token, fact.start_offset, fact.end_offset,
      fact.original_text, fact.parser_version, fact.comparison_status,
      fact.comparison_reason
    ORDER BY fact.fact_key
  `, [version.eventId, version.id]);
  return {
    ...version,
    comparison,
    numericFacts: factRows.rows.map(rowToNumericFact),
  };
}

async function loadSnapshotEventChanges(
  client: PoolClient | Pool,
  snapshotId: string,
  eventId: string,
): Promise<SnapshotEventChange[]> {
  const rows = await client.query<SnapshotEventChangeRow>(`
    SELECT current_snapshot_id, event_id, current_event_version_id,
           baseline_kind, baseline_snapshot_id, baseline_event_version_id,
           historical_observation_snapshot_id, presence, previous_rank,
           current_rank, rank_delta, rank_movement, status,
           algorithm_version, input_hash, result_hash, summary, compared_at
    FROM brief_snapshot_event_changes
    WHERE current_snapshot_id = $1 AND event_id = $2
    ORDER BY baseline_kind
  `, [snapshotId, eventId]);
  const changes: SnapshotEventChange[] = [];
  for (const row of rows.rows) {
    const itemRows = await client.query<WhatChangedItemRow>(`
      SELECT item_id, ordinal, kind, subject_key, reason_code, summary,
             before_value, after_value, evidence_version_ids, change_hash
      FROM brief_snapshot_event_change_items
      WHERE current_snapshot_id = $1 AND event_id = $2
        AND baseline_kind = $3 AND algorithm_version = $4
      ORDER BY ordinal
    `, [snapshotId, eventId, row.baseline_kind, row.algorithm_version]);
    changes.push(rowToSnapshotEventChange(row, itemRows.rows.map(rowToWhatChangedItem)));
  }
  return changes;
}

async function persistBriefObservationPostgres(
  brief: DailyBrief,
  options: NormalizedPersistBriefOptions,
  dailyWrite?: DailyBriefWrite,
): Promise<PersistBriefResult> {
  await ensureSchema();
  const client = await pool().connect();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const inputHash = persistenceInputHash(brief, options);
  const generatedAt = validIsoOrNow(brief.generatedAt);
  let activeRunId: string = runId;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('analystarena_event_observation'))");
    // Acquire the visibility boundary before reading any historical snapshot.
    // The snapshot INSERT trigger holds the same lock through COMMIT, while
    // publication takes it before verification. This makes comparison inputs
    // follow commit-visible order instead of transaction start or insert time.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('analystarena_snapshot_visibility'))",
    );
    await assertWhatChangedAlgorithmRegistry(client);
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
    if (dailyWrite?.kind === "update_draft" && !currentRecord) {
      throw new Error("Daily brief not found");
    }
    if (dailyWrite?.kind === "update_draft" && currentRecord?.status !== "draft") {
      throw new Error("Published daily briefs are immutable");
    }
    const expectedSnapshotId = dailyWrite?.kind === "update_draft"
      ? dailyWrite.expectedSnapshotId
      : undefined;
    if (dailyWrite?.kind === "update_draft"
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
             v.actor_type AS version_actor_type,
             v.actor_id_hash AS version_actor_id_hash,
             v.change_reason AS version_change_reason,
             v.request_id AS version_request_id,
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
    const pendingRetractions = groupEvidenceRetractions(options);
    const appliedRetractionIds = new Set<string>();
    const idMap = new Map<string, string>();
    const stableHeadlines: Headline[] = [];
    const pendingObservations: Omit<BriefSnapshotEventRecord, "snapshotId">[] = [];
    const versionsByEvent = new Map<string, EventVersionRecord>();

    for (const incomingCandidate of brief.headlines) {
      const incoming = withoutDerivedWhatChanged(incomingCandidate);
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
                    NULL::text AS version_actor_type,
                    NULL::text AS version_actor_id_hash,
                    NULL::text AS version_change_reason,
                    NULL::text AS version_request_id,
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
      if (previousVersion
        && Date.parse(options.observedAt) < Date.parse(previousVersion.observedAt)) {
        throw new EvidenceIntegrityError([{
          code: "EVENT_OBSERVATION_TIME_REGRESSION",
          message: `Observation ${options.observedAt} precedes event version ${previousVersion.id} at ${previousVersion.observedAt}`,
          headlineId: state.event.id,
        }]);
      }
      let stableHeadline = mergeRetainedEvidence(previousVersion?.headline, { ...structuredClone(incoming), id: state.event.id });
      const retractionResult = applyEvidenceRetractions(
        previousVersion,
        stableHeadline,
        pendingRetractions.get(state.event.id) ?? [],
      );
      stableHeadline = retractionResult.headline;
      const material = eventVersionMaterial(stableHeadline);
      let version = previousVersion;
      if (!version || version.contentHash !== material.versionHash) {
        const versionId = randomUUID();
        const versionNumber = (previousVersion?.versionNumber ?? 0) + 1;
        const insertedVersion = await client.query<EventVersionRow>(`
          INSERT INTO event_versions (
            id, event_id, version_number, previous_version_id,
            content_hash, evidence_hash, state_hash, presentation_hash,
            observed_at, run_id, payload, actor_type, actor_id_hash,
            change_reason, request_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
            $12, $13, $14, $15
          )
          RETURNING id, event_id, version_number, previous_version_id,
                    content_hash, evidence_hash, state_hash, presentation_hash,
                    observed_at, run_id, payload, actor_type, actor_id_hash,
                    change_reason, request_id, created_at
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
          options.actor.type,
          options.actor.idHash ?? null,
          options.actor.reason ?? null,
          options.actor.requestId ?? null,
        ]);
        version = rowToEventVersion(insertedVersion.rows[0]);
        await persistHeadlineEvidenceRelations(client, state.event.id, version.id, stableHeadline);
        const numericFacts = extractNumericFacts(stableHeadline);
        const comparison = compareEventVersions(previousVersion, version, {
          previous: previousVersion?.numericFacts,
          current: numericFacts,
        });
        assertRetractionScope(comparison, retractionResult.applied);
        await persistEventVersionAudit(client, comparison, numericFacts);
        version = { ...version, comparison, numericFacts };
      }
      if (retractionResult.applied.length && version === previousVersion) {
        throw new EvidenceIntegrityError(retractionResult.applied.map((request) => ({
          code: "RETRACTION_DID_NOT_CREATE_VERSION",
          message: `Retraction ${request.requestId} did not change the immutable event material`,
          headlineId: state!.event.id,
        })));
      }
      for (const request of retractionResult.applied) {
        const requestHash = stableHash(request);
        const existing = await client.query<{ request_hash: string }>(`
          SELECT request_hash FROM evidence_retraction_requests
          WHERE request_id = $1
        `, [request.requestId]);
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            throw new Error(`Retraction request ${request.requestId} was reused with different content`);
          }
          throw new Error(`Retraction request ${request.requestId} was already applied`);
        }
        const insertedRetraction = await client.query(`
          INSERT INTO evidence_retraction_requests (
            request_id, request_hash, event_id, from_event_version_id,
            to_event_version_id, evidence_item_id, evidence_version_id,
            claim_id, claim_key, citation_relation, reason_code, reason_note,
            replacement_evidence_version_id, actor_type, actor_id_hash,
            applied_run_id, requested_at
          )
          SELECT
            $1, $2, evidence.event_id, evidence.event_version_id,
            $5, evidence.evidence_item_id, evidence.evidence_version_id,
            claim.id, $8, $9, $10, $11, $12, $13, $14, $15, $16
          FROM event_version_evidence AS evidence
          LEFT JOIN claim_evidence_links AS claim_link
            ON claim_link.event_id = evidence.event_id
           AND claim_link.event_version_id = evidence.event_version_id
           AND claim_link.claim_key = $8
           AND claim_link.relation = $9
           AND claim_link.evidence_item_id = evidence.evidence_item_id
           AND claim_link.evidence_version_id = evidence.evidence_version_id
          LEFT JOIN event_claims AS claim
            ON claim.event_id = claim_link.event_id
           AND claim.event_version_id = claim_link.event_version_id
           AND claim.id = claim_link.claim_id
           AND claim.claim_key = claim_link.claim_key
          WHERE evidence.event_id = $3
            AND evidence.event_version_id = $4
            AND evidence.evidence_item_id = $6
            AND evidence.evidence_version_id = $7
            AND (
              ($8::text IS NULL AND $9::text IS NULL)
              OR claim.id IS NOT NULL
            )
        `, [
          request.requestId,
          requestHash,
          request.eventId,
          request.fromEventVersionId,
          version.id,
          request.evidenceItemId,
          request.evidenceVersionId,
          request.claimKey ?? null,
          request.citationRelation ?? null,
          request.reasonCode,
          request.reasonNote,
          request.replacementEvidenceVersionId ?? null,
          options.actor.type,
          options.actor.idHash!,
          activeRunId,
          options.observedAt,
        ]);
        if (insertedRetraction.rowCount !== 1) {
          throw new EvidenceIntegrityError([{
            code: "RETRACTION_AUTHORITY_MISMATCH",
            message: `Retraction ${request.requestId} does not match PostgreSQL evidence authority`,
            headlineId: state.event.id,
          }]);
        }
        await persistRetractionChangeItemBindings(client, request, version.id);
        appliedRetractionIds.add(request.requestId);
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
      versionsByEvent.set(state.event.id, version);
      stableHeadlines.push(stableHeadline);
      pendingObservations.push({
        eventId: state.event.id,
        eventVersionId: version.id,
        rank: stableHeadline.rank,
        rankingScore: stableHeadline.rankingScore,
        freshnessScore: stableHeadline.freshnessScore,
        impact: stableHeadline.impact,
        confidence: stableHeadline.confidence,
        mentions: stableHeadline.mentions,
        crossSourceCount: stableHeadline.crossSourceCount,
        matchMethod,
        matchConfidence,
      });
    }
    if (appliedRetractionIds.size !== options.evidenceRetractions.length) {
      const missing = options.evidenceRetractions
        .filter((request) => !appliedRetractionIds.has(request.requestId));
      throw new EvidenceIntegrityError(missing.map((request) => ({
        code: "RETRACTION_EVENT_NOT_IN_SNAPSHOT",
        message: `Retraction ${request.requestId} did not resolve to a current snapshot event`,
        headlineId: request.eventId,
      })));
    }

    const previousResult = await client.query<{
      id: string;
      sequence_number: number;
      generated_at: string | Date;
    }>(`
      SELECT id, sequence_number, generated_at FROM brief_snapshots
      WHERE brief_date = $1
      ORDER BY sequence_number DESC
      LIMIT 1
      FOR SHARE
    `, [brief.date]);
    const previousSnapshotId = previousResult.rows[0]?.id;
    const sequenceNumber = (previousResult.rows[0]?.sequence_number ?? 0) + 1;
    if (previousResult.rows[0]
      && Date.parse(generatedAt) < Date.parse(iso(previousResult.rows[0].generated_at))) {
      throw new EvidenceIntegrityError([{
        code: "SNAPSHOT_GENERATED_TIME_REGRESSION",
        message: `Snapshot time ${generatedAt} precedes same-date snapshot ${previousSnapshotId}`,
        headlineId: brief.headlines[0]?.id ?? "brief",
      }]);
    }
    const snapshotId = randomUUID();
    const persistedAt = new Date().toISOString();
    const previousPublishedSnapshotId = await loadPreviousPublishedSnapshotId(client, brief.date);
    const finalizedObservations: BriefSnapshotEventRecord[] = [];
    const historicalByChange = new Map<string, BriefSnapshotEventRecord>();
    const projectedHeadlines: Headline[] = [];
    for (const [index, headline] of stableHeadlines.entries()) {
      const currentObservation: BriefSnapshotEventRecord = {
        ...pendingObservations[index],
        snapshotId,
      };
      const currentVersion = versionsByEvent.get(headline.id);
      if (!currentVersion?.comparison) {
        throw new Error(`Event version ${currentObservation.eventVersionId} has no immutable comparison`);
      }
      const historicalObservation = await loadLatestSnapshotObservation(
        client,
        headline.id,
        brief.date,
        sequenceNumber - 1,
      );
      const isFirstSeen = !historicalObservation
        && currentVersion.versionNumber === 1
        && !currentVersion.previousVersionId;

      const operationalBaseline = await loadSnapshotEvent(client, previousSnapshotId, headline.id);
      const operationalPreviousVersion = operationalBaseline
        && operationalBaseline.eventVersionId !== currentVersion.id
        ? await loadEventVersionById(client, headline.id, operationalBaseline.eventVersionId)
        : undefined;
      const operationalContent = operationalPreviousVersion
        ? compareEventBaseline(operationalPreviousVersion, currentVersion, {
            previous: operationalPreviousVersion.numericFacts,
            current: currentVersion.numericFacts,
          })
        : undefined;
      const operationalHistorical = operationalBaseline ? undefined : historicalObservation;
      const operational = compareSnapshotEvent({
        baselineKind: "previous_observation",
        baselineSnapshotId: previousSnapshotId,
        baselineEvent: operationalBaseline,
        historicalObservation: operationalHistorical,
        current: currentObservation,
        currentSnapshotId: snapshotId,
        comparedAt: options.observedAt,
        isFirstSeen,
        legacyUnverified: currentVersion.comparison.status === "legacy_unverified",
        contentComparison: operationalContent,
      });
      if (operationalHistorical) {
        historicalByChange.set(`${headline.id}:previous_observation`, operationalHistorical);
      }

      const investorBaseline = await loadSnapshotEvent(client, previousPublishedSnapshotId, headline.id);
      const investorPreviousVersion = investorBaseline
        && investorBaseline.eventVersionId !== currentVersion.id
        ? await loadEventVersionById(client, headline.id, investorBaseline.eventVersionId)
        : undefined;
      const investorContent = investorPreviousVersion
        ? compareEventBaseline(investorPreviousVersion, currentVersion, {
            previous: investorPreviousVersion.numericFacts,
            current: currentVersion.numericFacts,
          })
        : undefined;
      const investorHistorical = investorBaseline
        ? undefined
        : await loadLatestPublishedObservation(client, headline.id, brief.date);
      const investor = compareSnapshotEvent({
        baselineKind: "previous_published",
        baselineSnapshotId: previousPublishedSnapshotId,
        baselineEvent: investorBaseline,
        historicalObservation: investorHistorical,
        current: currentObservation,
        currentSnapshotId: snapshotId,
        comparedAt: options.observedAt,
        isFirstSeen,
        legacyUnverified: currentVersion.comparison.status === "legacy_unverified",
        contentComparison: investorContent,
      });
      if (investorHistorical) {
        historicalByChange.set(`${headline.id}:previous_published`, investorHistorical);
      }
      const whatChanged = projectWhatChanged({
        investor,
        operational,
        latestVersion: currentVersion.comparison,
      });
      finalizedObservations.push({
        ...currentObservation,
        changes: [operational, investor],
      });
      projectedHeadlines.push({ ...headline, whatChanged });
    }
    let stableBrief = remapBriefRelations(brief, idMap, projectedHeadlines);
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
        events: finalizedObservations.map(snapshotEventProjection),
      },
    };
    await client.query(`
      INSERT INTO brief_snapshots (
        id, run_id, stream, batch_key, sequence_number, brief_date, generated_at,
        previous_snapshot_id, payload_hash, payload, actor_type, actor_id_hash,
        action_reason, action_request_id, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
        $11, $12, $13, $14, clock_timestamp()
      )
    `, [
      snapshotId,
      activeRunId,
      options.stream,
      options.batchKey,
      sequenceNumber,
      brief.date,
      generatedAt,
      previousSnapshotId ?? null,
      payloadHash,
      JSON.stringify(stableBrief),
      options.actor.type,
      options.actor.idHash ?? null,
      options.actor.reason ?? null,
      options.actor.requestId ?? null,
    ]);
    if (finalizedObservations.length) {
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
      `, [snapshotId, JSON.stringify(finalizedObservations.map((observation) => ({
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
    for (const observation of finalizedObservations) {
      for (const change of observation.changes ?? []) {
        await persistSnapshotEventChange(
          client,
          change,
          historicalByChange.get(`${observation.eventId}:${change.baselineKind}`),
        );
      }
    }
    const snapshotEventVersions = new Map(
      finalizedObservations.map((observation) => [observation.eventId, observation.eventVersionId]),
    );
    const claimPresentations = stableBrief.headlines.flatMap((headline) => {
      const eventVersionId = snapshotEventVersions.get(headline.id);
      if (!eventVersionId) throw new Error(`Snapshot event ${headline.id} has no exact event version`);
      return (headline.claims ?? []).map((claim) => ({
        event_id: headline.id,
        event_version_id: eventVersionId,
        claim_key: claim.claimKey,
        ordinal: claim.ordinal,
        statement: claim.statement,
        language: claim.language,
      }));
    });
    if (claimPresentations.length) {
      await client.query(`
        INSERT INTO brief_snapshot_claim_presentations (
          snapshot_id, event_id, event_version_id, claim_key,
          ordinal, statement, language
        )
        SELECT $1, item.event_id, item.event_version_id, item.claim_key,
               item.ordinal, item.statement, item.language
        FROM jsonb_to_recordset($2::jsonb) AS item(
          event_id TEXT, event_version_id UUID, claim_key TEXT,
          ordinal INTEGER, statement TEXT, language TEXT
        )
      `, [snapshotId, JSON.stringify(claimPresentations)]);
    }
    for (const headline of stableBrief.headlines) {
      const eventVersionId = snapshotEventVersions.get(headline.id);
      if (!eventVersionId) throw new Error(`Snapshot event ${headline.id} has no exact event version`);
      const observedSources = headline.sources
        .filter((source): source is typeof source & {
          sourceDocumentId: string;
          sourceDocumentVersionId: string;
          sourceObservationId: string;
        } => Boolean(source.sourceDocumentId && source.sourceDocumentVersionId && source.sourceObservationId))
        .filter((source, index, all) => all.findIndex((candidate) =>
          candidate.sourceDocumentVersionId === source.sourceDocumentVersionId) === index);
      for (const source of observedSources) {
        const insertedObservation = await client.query(`
          INSERT INTO brief_snapshot_source_observations (
            snapshot_id, event_id, event_version_id,
            source_document_id, source_document_version_id,
            source_observation_id, source_role, ordinal
          )
          SELECT $1, $2, $3, event_source.source_document_id,
                 event_source.source_document_version_id, $6,
                 event_source.source_role, event_source.ordinal
          FROM event_version_sources AS event_source
          WHERE event_source.event_id = $2
            AND event_source.event_version_id = $3
            AND event_source.source_document_id = $4
            AND event_source.source_document_version_id = $5
        `, [
          snapshotId,
          headline.id,
          eventVersionId,
          source.sourceDocumentId,
          source.sourceDocumentVersionId,
          source.sourceObservationId,
        ]);
        if (insertedObservation.rowCount !== 1) {
          throw new Error(`Source observation ${source.sourceObservationId} is not bound to event version ${eventVersionId}`);
        }
      }
    }
    let record: BriefRecord | undefined;
    if (dailyWrite?.kind === "save_draft") {
      const dailyId = currentRecord?.id ?? randomUUID();
      const saved = await client.query<DatabaseRow>(`
        INSERT INTO daily_briefs (id, brief_date, status, payload, current_snapshot_id)
        VALUES ($1, $2, 'draft', $3::jsonb, $4)
        ON CONFLICT (brief_date) DO UPDATE
          SET payload = EXCLUDED.payload, status = 'draft', pdf_data = NULL,
              published_at = NULL, current_snapshot_id = EXCLUDED.current_snapshot_id,
              updated_at = NOW()
          WHERE daily_briefs.status <> 'published'
        RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
      `, [dailyId, stableBrief.date, JSON.stringify(stableBrief), snapshotId]);
      if (saved.rows[0]) record = rowToRecord(saved.rows[0]);
      else record = await loadDailyRecordForWrite(client, dailyWrite, brief.date) ?? undefined;
    } else if (dailyWrite?.kind === "update_draft") {
      const updated = await client.query<DatabaseRow>(`
        UPDATE daily_briefs
        SET payload = $2::jsonb, current_snapshot_id = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'draft'
        RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
      `, [dailyWrite.id, JSON.stringify(stableBrief), snapshotId]);
      if (!updated.rows[0]) throw new Error("Unable to update draft");
      record = rowToRecord(updated.rows[0]);
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
      events: finalizedObservations,
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
    actor: normalizeActor(options.actor),
    evidenceRetractions: structuredClone(options.evidenceRetractions ?? []),
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
           previous_snapshot_id, payload_hash, payload, actor_type, actor_id_hash,
           action_reason, action_request_id, created_at
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
    const mappedEvents: BriefSnapshotEventRecord[] = [];
    for (const eventRow of events.rows) {
      const event = rowToSnapshotEvent(eventRow);
      mappedEvents.push({
        ...event,
        changes: await loadSnapshotEventChanges(pool(), row.id, event.eventId),
      });
    }
    snapshots.push(rowToBriefSnapshot(row, mappedEvents));
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
           payload, actor_type, actor_id_hash, change_reason, request_id,
           created_at
    FROM event_versions WHERE event_id = $1 ORDER BY version_number ASC
  `, [eventId]);
  const versions: EventVersionRecord[] = [];
  for (const row of result.rows) {
    versions.push(await loadEventVersionAudit(pool(), rowToEventVersion(row)));
  }
  return versions;
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
    actor: normalizeActor(options.actor),
    evidenceRetractions: structuredClone(options.evidenceRetractions ?? []),
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
    actor: normalizeActor(options.actor),
    evidenceRetractions: structuredClone(options.evidenceRetractions ?? []),
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

export interface EvidenceAuthorityIssue {
  headlineId: string;
  code: string;
  reason: string;
}

function authorityIssue(headlineId: string, code: string, reason: string): EvidenceAuthorityIssue {
  return { headlineId, code, reason };
}

function dbOptionalIso(value: string | Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

async function authoritativeWhatChangedProjection(
  snapshotId: string,
  eventId: string,
  currentVersionId: string,
): Promise<WhatChangedProjection> {
  const snapshotBoundaryResult = await pool().query<{
    brief_date: string | Date;
    sequence_number: number;
    previous_snapshot_id: string | null;
    publication_boundary: string | Date | null;
    snapshot_created_at: string | Date;
  }>(`
    SELECT snapshot.brief_date, snapshot.sequence_number,
           snapshot.previous_snapshot_id,
           audit.published_at AS publication_boundary,
           snapshot.created_at AS snapshot_created_at
    FROM brief_snapshots AS snapshot
    LEFT JOIN brief_publication_audits AS audit
      ON audit.snapshot_id = snapshot.id
    WHERE snapshot.id = $1
  `, [snapshotId]);
  const snapshotBoundary = snapshotBoundaryResult.rows[0];
  if (!snapshotBoundary) {
    throw new Error(`Snapshot ${snapshotId} does not exist`);
  }
  const snapshotDate = dateOnly(snapshotBoundary.brief_date);
  const publishedAsOf = snapshotBoundary.publication_boundary
    ? iso(snapshotBoundary.publication_boundary)
    : undefined;
  const snapshotCreatedAsOf = iso(snapshotBoundary.snapshot_created_at);
  const currentVersion = await loadEventVersionById(pool(), eventId, currentVersionId);
  if (!currentVersion?.comparison) {
    throw new Error(`Event version ${currentVersionId} has no comparison authority`);
  }
  if (currentVersion.comparison.status !== "legacy_unverified") {
    const previousVersion = currentVersion.previousVersionId
      ? await loadEventVersionById(pool(), eventId, currentVersion.previousVersionId)
      : undefined;
    const recomputed = compareEventVersions(previousVersion, currentVersion, {
      previous: previousVersion?.numericFacts,
      current: currentVersion.numericFacts,
    });
    if (canonicalEvidenceJson(recomputed) !== canonicalEvidenceJson(currentVersion.comparison)) {
      throw new Error(`Event version ${currentVersionId} comparison cannot be recomputed`);
    }
  }

  const storedChanges = await loadSnapshotEventChanges(pool(), snapshotId, eventId);
  const changes = new Map(storedChanges.map((change) => [change.baselineKind, change]));
  const recomputedChanges = new Map<SnapshotEventChange["baselineKind"], SnapshotEventChange>();
  const currentEvent = await loadSnapshotEvent(pool(), snapshotId, eventId);
  if (!currentEvent || currentEvent.eventVersionId !== currentVersionId) {
    throw new Error(`Snapshot ${snapshotId} current event authority mismatch`);
  }
  const expectedOperationalBaselineId = snapshotBoundary.previous_snapshot_id ?? undefined;
  const expectedPublishedBaselineId = await loadPreviousPublishedSnapshotId(
    pool(),
    snapshotDate,
    publishedAsOf,
  );
  const expectedOperationalBaselineEvent = await loadSnapshotEvent(
    pool(),
    expectedOperationalBaselineId,
    eventId,
  );
  const expectedOperationalHistorical = expectedOperationalBaselineEvent
    ? undefined
    : await loadLatestSnapshotObservation(
        pool(),
        eventId,
        snapshotDate,
        snapshotBoundary.sequence_number - 1,
        snapshotCreatedAsOf,
      );
  const expectedPublishedBaselineEvent = await loadSnapshotEvent(
    pool(),
    expectedPublishedBaselineId,
    eventId,
  );
  const expectedPublishedHistorical = expectedPublishedBaselineEvent
    ? undefined
    : await loadLatestPublishedObservation(
        pool(),
        eventId,
        snapshotDate,
        publishedAsOf,
      );
  const isFirstSeen = !expectedOperationalBaselineEvent
    && !expectedOperationalHistorical
    && currentVersion.versionNumber === 1
    && !currentVersion.previousVersionId;
  const legacyUnverified = currentVersion.comparison.status === "legacy_unverified";

  for (const baselineKind of ["previous_observation", "previous_published"] as const) {
    const stored = changes.get(baselineKind);
    if (!stored) throw new Error(`Snapshot ${snapshotId} lacks ${baselineKind} comparison`);
    const expectedBaselineSnapshotId = baselineKind === "previous_observation"
      ? expectedOperationalBaselineId
      : expectedPublishedBaselineId;
    if (stored.baselineSnapshotId !== expectedBaselineSnapshotId) {
      throw new Error(`Snapshot ${snapshotId} ${baselineKind} selected the wrong baseline snapshot`);
    }
    const baselineEvent = baselineKind === "previous_observation"
      ? expectedOperationalBaselineEvent
      : expectedPublishedBaselineEvent;
    if ((baselineEvent?.eventVersionId ?? undefined) !== stored.baselineEventVersionId) {
      throw new Error(`Snapshot ${snapshotId} ${baselineKind} endpoint mismatch`);
    }
    const historicalObservation = baselineKind === "previous_observation"
      ? expectedOperationalHistorical
      : expectedPublishedHistorical;
    if (stored.historicalObservationSnapshotId !== historicalObservation?.snapshotId) {
      throw new Error(
        `Snapshot ${snapshotId} ${baselineKind} selected the wrong historical observation`,
      );
    }
    const baselineVersion = baselineEvent
      && baselineEvent.eventVersionId !== currentVersionId
      ? await loadEventVersionById(pool(), eventId, baselineEvent.eventVersionId)
      : undefined;
    if (baselineEvent
      && baselineEvent.eventVersionId !== currentVersionId
      && !baselineVersion) {
      throw new Error(`Snapshot ${snapshotId} ${baselineKind} event version is missing`);
    }
    const contentComparison = baselineVersion
      ? compareEventBaseline(baselineVersion, currentVersion, {
          previous: baselineVersion.numericFacts,
          current: currentVersion.numericFacts,
        })
      : undefined;
    const recomputed = compareSnapshotEvent({
      baselineKind,
      baselineSnapshotId: expectedBaselineSnapshotId,
      baselineEvent,
      historicalObservation,
      current: currentEvent,
      currentSnapshotId: snapshotId,
      comparedAt: stored.comparedAt,
      isFirstSeen,
      legacyUnverified,
      contentComparison,
    });
    if (canonicalEvidenceJson(recomputed) !== canonicalEvidenceJson(stored)) {
      throw new Error(`Snapshot ${snapshotId} ${baselineKind} comparison cannot be recomputed`);
    }
    recomputedChanges.set(baselineKind, recomputed);
  }
  return projectWhatChanged({
    investor: recomputedChanges.get("previous_published")!,
    operational: recomputedChanges.get("previous_observation")!,
    latestVersion: currentVersion.comparison,
  });
}

/**
 * Verifies the snapshot projection against normalized PostgreSQL authority.
 * This prevents a client from reusing real IDs while forging quote text,
 * hashes, locators, claim status, or source-version relationships in JSON.
 */
export async function verifyBriefEvidenceAuthority(brief: DailyBrief): Promise<EvidenceAuthorityIssue[]> {
  if (storageMode() === "memory") {
    return brief.mode === "demo" ? [] : brief.headlines.map((headline) => authorityIssue(
      headline.id,
      "DATABASE_AUTHORITY_UNAVAILABLE",
      "实时日报必须使用 PostgreSQL 核对不可变来源、证据与声明版本",
    ));
  }
  await ensureSchema();
  const snapshot = brief.snapshot;
  const snapshotId = snapshot?.id;
  if (!snapshotId) return brief.headlines.map((headline) =>
    authorityIssue(headline.id, "SNAPSHOT_AUTHORITY_MISSING", "日报没有可核对的不可变快照版本"));

  const issues: EvidenceAuthorityIssue[] = [];
  const snapshotEvents = await pool().query<BriefSnapshotEventRow>(`
    SELECT snapshot_id, event_id, event_version_id, rank, ranking_score,
           freshness_score, impact, confidence, mentions, cross_source_count,
           match_method, match_confidence
    FROM brief_snapshot_events
    WHERE snapshot_id = $1
  `, [snapshotId]);
  const authoritativeSnapshotEvents = new Map(snapshotEvents.rows.map((row) => [row.event_id, rowToSnapshotEvent(row)]));
  const eventVersions = new Map(snapshotEvents.rows.map((row) => [row.event_id, row.event_version_id]));
  const projectedEventIds = brief.headlines.map((headline) => headline.id);
  if (new Set(projectedEventIds).size !== projectedEventIds.length
    || eventVersions.size !== projectedEventIds.length
    || projectedEventIds.some((eventId) => !eventVersions.has(eventId))) {
    for (const headline of brief.headlines) {
      issues.push(authorityIssue(
        headline.id,
        "SNAPSHOT_EVENT_SET_AUTHORITY_MISMATCH",
        "页面事件集合与不可变快照登记的事件集合或数量不同",
      ));
    }
  }
  const projectedSnapshotEvents = snapshot?.events ?? [];
  const projectedSnapshotEventMap = new Map(projectedSnapshotEvents.map((event) => [event.eventId, event]));
  if (projectedSnapshotEventMap.size !== projectedSnapshotEvents.length
    || projectedSnapshotEventMap.size !== authoritativeSnapshotEvents.size
    || [...authoritativeSnapshotEvents.keys()].some((eventId) => !projectedSnapshotEventMap.has(eventId))) {
    for (const headline of brief.headlines) {
      issues.push(authorityIssue(
        headline.id,
        "SNAPSHOT_EVENT_PROJECTION_SET_MISMATCH",
        "待发布快照的事件投影集合与数据库冻结的快照事件集合不一致。",
      ));
    }
  }

  for (const headline of brief.headlines) {
    const eventVersionId = eventVersions.get(headline.id);
    if (!eventVersionId) {
      issues.push(authorityIssue(headline.id, "EVENT_VERSION_AUTHORITY_MISSING", "快照没有对应的事件版本"));
      continue;
    }
    const authoritativeSnapshotEvent = authoritativeSnapshotEvents.get(headline.id);
    const projectedSnapshotEvent = projectedSnapshotEventMap.get(headline.id);
    if (!authoritativeSnapshotEvent || !projectedSnapshotEvent) {
      issues.push(authorityIssue(
        headline.id,
        "SNAPSHOT_EVENT_PROJECTION_AUTHORITY_MISSING",
        "待发布事件缺少可与数据库逐项核对的快照事件投影。",
      ));
    } else {
      const authoritativeProjection = snapshotEventProjection(authoritativeSnapshotEvent);
      if (canonicalEvidenceJson(projectedSnapshotEvent) !== canonicalEvidenceJson(authoritativeProjection)) {
        issues.push(authorityIssue(
          headline.id,
          "SNAPSHOT_EVENT_PROJECTION_AUTHORITY_MISMATCH",
          "事件版本、排名分数、新鲜度、影响、置信度、提及数、跨来源数或匹配结果与数据库快照不一致。",
        ));
      }
      const projectedRanking = {
        rank: headline.rank,
        rankingScore: headline.rankingScore ?? null,
        freshnessScore: headline.freshnessScore ?? null,
        impact: headline.impact,
        confidence: headline.confidence,
        mentions: headline.mentions,
        crossSourceCount: headline.crossSourceCount ?? null,
      };
      const authoritativeRanking = {
        rank: authoritativeSnapshotEvent.rank,
        rankingScore: authoritativeSnapshotEvent.rankingScore ?? null,
        freshnessScore: authoritativeSnapshotEvent.freshnessScore ?? null,
        impact: authoritativeSnapshotEvent.impact,
        confidence: authoritativeSnapshotEvent.confidence,
        mentions: authoritativeSnapshotEvent.mentions,
        crossSourceCount: authoritativeSnapshotEvent.crossSourceCount ?? null,
      };
      if (canonicalEvidenceJson(projectedRanking) !== canonicalEvidenceJson(authoritativeRanking)) {
        issues.push(authorityIssue(
          headline.id,
          "SNAPSHOT_RANKING_AUTHORITY_MISMATCH",
          "待发布头条的排名和评分字段与数据库冻结的快照事件不一致。",
        ));
      }
    }
    const eventVersionResult = await pool().query<EventVersionRow>(`
      SELECT id, event_id, version_number, previous_version_id, content_hash,
             evidence_hash, state_hash, presentation_hash, observed_at, run_id,
             payload, actor_type, actor_id_hash, change_reason, request_id,
             created_at
      FROM event_versions
      WHERE event_id = $1 AND id = $2
    `, [headline.id, eventVersionId]);
    const eventVersionRow = eventVersionResult.rows[0];
    if (!eventVersionRow) {
      issues.push(authorityIssue(
        headline.id,
        "EVENT_VERSION_AUTHORITY_MISSING",
        "快照指向的事件版本不存在。",
      ));
    } else {
      try {
        const authorityPayload = parseEventVersionPayload(eventVersionRow.payload);
        const authorityHeadline = authorityPayload?.headline;
        if (!authorityHeadline) throw new Error("event version has no headline payload");
        const authorityMaterial = eventVersionMaterial(authorityHeadline);
        const projectedMaterial = eventVersionMaterial(headline);
        const storedHashes = {
          versionHash: eventVersionRow.content_hash,
          evidenceHash: eventVersionRow.evidence_hash,
          stateHash: eventVersionRow.state_hash,
          presentationHash: eventVersionRow.presentation_hash,
        };
        const authorityHashes = {
          versionHash: authorityMaterial.versionHash,
          evidenceHash: authorityMaterial.evidenceHash,
          stateHash: authorityMaterial.stateHash,
          presentationHash: authorityMaterial.presentationHash,
        };
        if (canonicalEvidenceJson(storedHashes) !== canonicalEvidenceJson(authorityHashes)
          || canonicalEvidenceJson({ evidence: authorityPayload?.evidence })
            !== canonicalEvidenceJson({ evidence: authorityMaterial.payload.evidence })
          || canonicalEvidenceJson({ state: authorityPayload?.state })
            !== canonicalEvidenceJson({ state: authorityMaterial.payload.state })
          || canonicalEvidenceJson({ presentation: authorityPayload?.presentation })
            !== canonicalEvidenceJson({ presentation: authorityMaterial.payload.presentation })) {
          issues.push(authorityIssue(
            headline.id,
            "EVENT_VERSION_INTERNAL_INTEGRITY_MISMATCH",
            "数据库事件版本的内容、证据、状态或展示哈希无法由其冻结载荷重算得到。",
          ));
        }
        const projectedHashes = {
          versionHash: projectedMaterial.versionHash,
          evidenceHash: projectedMaterial.evidenceHash,
          stateHash: projectedMaterial.stateHash,
        };
        const authoritativeStateHashes = {
          versionHash: eventVersionRow.content_hash,
          evidenceHash: eventVersionRow.evidence_hash,
          stateHash: eventVersionRow.state_hash,
        };
        if (canonicalEvidenceJson(projectedHashes) !== canonicalEvidenceJson(authoritativeStateHashes)
          || canonicalEvidenceJson({ evidence: projectedMaterial.payload.evidence })
            !== canonicalEvidenceJson({ evidence: authorityPayload?.evidence })
          || canonicalEvidenceJson({ state: projectedMaterial.payload.state })
            !== canonicalEvidenceJson({ state: authorityPayload?.state })) {
          issues.push(authorityIssue(
            headline.id,
            "EVENT_VERSION_STATE_AUTHORITY_MISMATCH",
            "待发布事件的版本哈希、证据状态或投资判断状态与快照指向的数据库事件版本不一致。",
          ));
        }
        // A translated title/summary is a snapshot presentation and may have a
        // different presentation hash. Those page fields are bound below by
        // exact claim rows. Equity narratives are not standalone claims, so
        // they must remain byte-for-byte equal to the reviewed event version.
        const projectedPresentation = projectedMaterial.payload.presentation as { equityNarrative?: unknown } | undefined;
        const authorityPresentation = authorityPayload?.presentation as { equityNarrative?: unknown } | undefined;
        if (canonicalEvidenceJson({ equityNarrative: projectedPresentation?.equityNarrative })
          !== canonicalEvidenceJson({ equityNarrative: authorityPresentation?.equityNarrative })) {
          issues.push(authorityIssue(
            headline.id,
            "EVENT_PRESENTATION_AUTHORITY_MISMATCH",
            "待发布的股票影响说明在审核后发生变化，必须另存为新快照并重新审核。",
          ));
        }
      } catch {
        issues.push(authorityIssue(
          headline.id,
          "EVENT_VERSION_INTERNAL_INTEGRITY_INVALID",
          "数据库事件版本载荷无法解析或无法重算权威哈希。",
        ));
      }
    }
    try {
      const authoritativeWhatChanged = await authoritativeWhatChangedProjection(
        snapshotId,
        headline.id,
        eventVersionId,
      );
      if (!headline.whatChanged) {
        issues.push(authorityIssue(
          headline.id,
          "WHAT_CHANGED_AUTHORITY_MISSING",
          "待发布事件缺少不可变的前后版本比较结果。",
        ));
      } else if (canonicalEvidenceJson(headline.whatChanged)
        !== canonicalEvidenceJson(authoritativeWhatChanged)) {
        issues.push(authorityIssue(
          headline.id,
          "WHAT_CHANGED_AUTHORITY_MISMATCH",
          "待发布事件的上一版、当前版、变化原因或排名变化与数据库权威记录不一致。",
        ));
      }
    } catch {
      issues.push(authorityIssue(
        headline.id,
        "WHAT_CHANGED_INTERNAL_INTEGRITY_INVALID",
        "数据库中的差异算法版本、比较端点或结果哈希无法由权威版本链重算。",
      ));
    }
    const sourceRows = await pool().query<{
      source_observation_id: string;
      source_role: NonNullable<SourceLink["role"]>;
      source_ordinal: number;
      source_document_id: string;
      source_document_version_id: string;
      content_hash: string;
      original_title: string | null;
      feed_namespace: string | null;
      native_id: string | null;
      observation_source_name: string;
      observation_source_type: SourceLink["type"];
      observation_collected_at: string | Date;
      observation_raw_url: string;
      observation_final_url: string | null;
      observation_feed_url: string | null;
      observation_mime_type: string | null;
      observation_http_status: number | null;
      observation_capture_scope: SourceCapture["scope"];
      timestamp_kind: TimestampKind;
      canonical_url: string;
      original_published_at: string | Date | null;
      published_at_raw: string | null;
      published_at_field: string | null;
      source_updated_at: string | Date | null;
      captured_content_hash: string;
      captured_artifact: string | null;
      captured_artifact_encoding: "utf8" | null;
      captured_artifact_size_bytes: number | null;
      captured_text_hash: string | null;
      extraction_method: string;
      extractor_version: string;
      backfill_quality: NonNullable<SourceCapture["backfillQuality"]>;
    }>(`
      SELECT observation.id AS source_observation_id,
             snapshot_source.source_role, snapshot_source.ordinal AS source_ordinal,
             snapshot_source.source_document_id, snapshot_source.source_document_version_id,
             sdv.content_hash, NULLIF(sdv.payload->>'originalTitle', '') AS original_title,
             NULLIF(sdv.payload->>'feedNamespace', '') AS feed_namespace,
             p.native_id,
             observation.source_name AS observation_source_name,
             observation.source_type AS observation_source_type,
             observation.collected_at AS observation_collected_at,
             observation.raw_url AS observation_raw_url,
             observation.final_url AS observation_final_url,
             observation.feed_url AS observation_feed_url,
             observation.mime_type AS observation_mime_type,
             observation.http_status AS observation_http_status,
             observation.capture_scope AS observation_capture_scope,
             p.timestamp_kind, p.canonical_url, p.original_published_at,
             p.published_at_raw, p.published_at_field, p.source_updated_at,
             p.captured_content_hash, p.captured_artifact,
             p.captured_artifact_encoding, p.captured_artifact_size_bytes,
             p.captured_text_hash,
             p.extraction_method, p.extractor_version, p.backfill_quality
      FROM brief_snapshot_source_observations AS snapshot_source
      JOIN source_collection_observations AS observation
        ON observation.source_document_id = snapshot_source.source_document_id
       AND observation.source_document_version_id = snapshot_source.source_document_version_id
       AND observation.id = snapshot_source.source_observation_id
      JOIN source_document_versions sdv
        ON sdv.source_document_id = snapshot_source.source_document_id
       AND sdv.id = snapshot_source.source_document_version_id
      JOIN source_version_provenance p
        ON p.source_document_id = snapshot_source.source_document_id
       AND p.source_document_version_id = snapshot_source.source_document_version_id
      WHERE snapshot_source.snapshot_id = $1
        AND snapshot_source.event_id = $2
        AND snapshot_source.event_version_id = $3
      ORDER BY snapshot_source.ordinal
    `, [snapshotId, headline.id, eventVersionId]);
    const eventSourceRows = await pool().query<{
      source_document_id: string;
      source_document_version_id: string;
      source_role: string;
      ordinal: number;
    }>(`
      SELECT source_document_id, source_document_version_id, source_role, ordinal
      FROM event_version_sources
      WHERE event_id = $1 AND event_version_id = $2
      ORDER BY ordinal
    `, [headline.id, eventVersionId]);
    const snapshotSourceRegistration = sourceRows.rows.map((row) => ({
      sourceDocumentId: row.source_document_id,
      sourceDocumentVersionId: row.source_document_version_id,
      sourceRole: row.source_role,
      ordinal: row.source_ordinal,
    }));
    const eventSourceRegistration = eventSourceRows.rows.map((row) => ({
      sourceDocumentId: row.source_document_id,
      sourceDocumentVersionId: row.source_document_version_id,
      sourceRole: row.source_role,
      ordinal: row.ordinal,
    }));
    if (canonicalEvidenceJson(snapshotSourceRegistration) !== canonicalEvidenceJson(eventSourceRegistration)) {
      issues.push(authorityIssue(
        headline.id,
        "SNAPSHOT_SOURCE_SET_AUTHORITY_MISMATCH",
        "快照采集观察没有完整覆盖事件版本登记的来源集合",
      ));
    }
    const authoritativeSources = new Map(sourceRows.rows.map((row) => [row.source_observation_id, row]));
    const projectedObservationIds = headline.sources
      .map((source) => source.sourceObservationId)
      .filter((id): id is string => Boolean(id));
    if (authoritativeSources.size !== headline.sources.length
      || projectedObservationIds.length !== headline.sources.length
      || new Set(projectedObservationIds).size !== projectedObservationIds.length
      || projectedObservationIds.some((id) => !authoritativeSources.has(id))) {
      issues.push(authorityIssue(
        headline.id,
        "SOURCE_OBSERVATION_SET_AUTHORITY_MISMATCH",
        "页面来源集合必须逐项对应快照登记的不可变采集观察",
      ));
    }
    for (const [sourceIndex, source] of headline.sources.entries()) {
      if (!source.sourceObservationId || !source.sourceDocumentVersionId || !source.sourceDocumentId) {
        issues.push(authorityIssue(headline.id, "SOURCE_AUTHORITY_ID_MISSING", `来源 ${source.name} 缺少文档、版本或采集观察 ID`));
        continue;
      }
      const row = authoritativeSources.get(source.sourceObservationId);
      if (!row || row.source_document_id !== source.sourceDocumentId) {
        issues.push(authorityIssue(headline.id, "SOURCE_VERSION_AUTHORITY_MISMATCH", `来源 ${source.name} 未登记在该快照事件版本`));
        continue;
      }
      const capture = source.capture;
      const authoritativeOriginalPublishedAt = dbOptionalIso(row.original_published_at);
      const authoritativeCollectedAt = dbOptionalIso(row.observation_collected_at)!;
      const authoritativePublishedAt = authoritativeOriginalPublishedAt ?? authoritativeCollectedAt;
      const projected = {
        sourceObservationId: source.sourceObservationId,
        role: source.role ?? null,
        ordinal: sourceIndex + 1,
        sourceDocumentId: source.sourceDocumentId,
        sourceDocumentVersionId: source.sourceDocumentVersionId,
        contentHash: source.contentHash ?? null,
        originalTitle: source.originalTitle ?? null,
        feedNamespace: source.feedNamespace ?? null,
        nativeId: source.nativeId ?? null,
        sourceName: source.name,
        sourceType: source.type,
        url: source.url,
        timestampKind: source.timestampKind ?? null,
        canonicalUrl: source.canonicalUrl ?? null,
        publishedAt: source.publishedAt ? (parseStrictSourceTimestamp(source.publishedAt) ?? `invalid:${source.publishedAt}`) : null,
        collectedAt: source.collectedAt ? (parseStrictSourceTimestamp(source.collectedAt) ?? `invalid:${source.collectedAt}`) : null,
        originalPublishedAt: source.originalPublishedAt
          ? (parseStrictSourceTimestamp(source.originalPublishedAt) ?? `invalid:${source.originalPublishedAt}`)
          : null,
        publishedAtRaw: source.publishedAtRaw ?? null,
        publishedAtField: source.publishedAtField ?? null,
        sourceUpdatedAt: source.sourceUpdatedAt
          ? (parseStrictSourceTimestamp(source.sourceUpdatedAt) ?? `invalid:${source.sourceUpdatedAt}`)
          : null,
        rawUrl: capture?.rawUrl ?? null,
        captureCanonicalUrl: capture?.canonicalUrl ?? null,
        finalUrl: capture?.finalUrl ?? null,
        feedUrl: capture?.feedUrl ?? null,
        mimeType: capture?.mimeType ?? null,
        httpStatus: capture?.httpStatus ?? null,
        captureOriginalPublishedAt: capture?.originalPublishedAt
          ? (parseStrictSourceTimestamp(capture.originalPublishedAt) ?? `invalid:${capture.originalPublishedAt}`)
          : null,
        capturePublishedAtRaw: capture?.publishedAtRaw ?? null,
        capturePublishedAtField: capture?.publishedAtField ?? null,
        captureSourceUpdatedAt: capture?.sourceUpdatedAt
          ? (parseStrictSourceTimestamp(capture.sourceUpdatedAt) ?? `invalid:${capture.sourceUpdatedAt}`)
          : null,
        captureCollectedAt: capture?.collectedAt
          ? (parseStrictSourceTimestamp(capture.collectedAt) ?? `invalid:${capture.collectedAt}`)
          : null,
        captureScope: capture?.scope ?? null,
        capturedContentHash: capture?.capturedContentHash ?? null,
        capturedArtifact: capture?.capturedArtifact ?? null,
        capturedArtifactEncoding: capture?.capturedArtifactEncoding ?? null,
        capturedArtifactSizeBytes: capture?.capturedArtifactSizeBytes ?? null,
        capturedTextHash: capture?.capturedTextHash ?? null,
        extractionMethod: capture?.extractionMethod ?? null,
        extractorVersion: capture?.extractorVersion ?? null,
        backfillQuality: capture?.backfillQuality ?? "native",
      };
      const authority = {
        sourceObservationId: row.source_observation_id,
        role: row.source_role,
        ordinal: row.source_ordinal,
        sourceDocumentId: row.source_document_id,
        sourceDocumentVersionId: row.source_document_version_id,
        contentHash: row.content_hash,
        originalTitle: row.original_title,
        feedNamespace: row.feed_namespace,
        nativeId: row.native_id,
        sourceName: row.observation_source_name,
        sourceType: row.observation_source_type,
        url: row.observation_raw_url,
        timestampKind: row.timestamp_kind,
        canonicalUrl: row.canonical_url,
        publishedAt: authoritativePublishedAt,
        collectedAt: authoritativeCollectedAt,
        originalPublishedAt: authoritativeOriginalPublishedAt,
        publishedAtRaw: row.published_at_raw,
        publishedAtField: row.published_at_field,
        sourceUpdatedAt: dbOptionalIso(row.source_updated_at),
        rawUrl: row.observation_raw_url,
        captureCanonicalUrl: row.canonical_url,
        finalUrl: row.observation_final_url,
        feedUrl: row.observation_feed_url,
        mimeType: row.observation_mime_type,
        httpStatus: row.observation_http_status,
        captureOriginalPublishedAt: authoritativeOriginalPublishedAt,
        capturePublishedAtRaw: row.published_at_raw,
        capturePublishedAtField: row.published_at_field,
        captureSourceUpdatedAt: dbOptionalIso(row.source_updated_at),
        captureCollectedAt: authoritativeCollectedAt,
        captureScope: row.observation_capture_scope,
        capturedContentHash: row.captured_content_hash,
        capturedArtifact: row.captured_artifact,
        capturedArtifactEncoding: row.captured_artifact_encoding,
        capturedArtifactSizeBytes: row.captured_artifact_size_bytes,
        capturedTextHash: row.captured_text_hash,
        extractionMethod: row.extraction_method,
        extractorVersion: row.extractor_version,
        backfillQuality: row.backfill_quality,
      };
      if (canonicalEvidenceJson(projected) !== canonicalEvidenceJson(authority)) {
        issues.push(authorityIssue(headline.id, "SOURCE_PROVENANCE_AUTHORITY_MISMATCH", `来源 ${source.name} 的采集证明与数据库不一致`));
      }
      if (row.captured_artifact !== null) {
        const artifactHash = sha256ExactUtf8(row.captured_artifact);
        const artifactSize = Buffer.byteLength(row.captured_artifact, "utf8");
        if (artifactHash !== row.captured_content_hash || artifactSize !== row.captured_artifact_size_bytes) {
          issues.push(authorityIssue(headline.id, "SOURCE_ARTIFACT_INTEGRITY_MISMATCH", `来源 ${source.name} 的原始采集物无法重算出登记哈希或字节数`));
        }
      } else if (row.backfill_quality === "native") {
        issues.push(authorityIssue(headline.id, "SOURCE_ARTIFACT_MISSING", `原生采集来源 ${source.name} 缺少精确原始采集物`));
      }
      const expectedObservationId = `obs_${sha256ExactUtf8(canonicalEvidenceJson([
        "source-collection-observation",
        1,
        row.source_document_id,
        row.source_document_version_id,
        row.observation_source_name,
        row.observation_source_type,
        authoritativeCollectedAt,
        row.observation_raw_url,
        row.observation_final_url,
        row.observation_feed_url,
        row.observation_mime_type,
        row.observation_http_status,
        row.observation_capture_scope,
        row.captured_content_hash,
      ]))}`;
      if (row.source_observation_id !== expectedObservationId) {
        issues.push(authorityIssue(headline.id, "SOURCE_OBSERVATION_ID_MISMATCH", `来源 ${source.name} 的采集观察 ID 无法由权威字段重算`));
      }
      const expectedTimestampKind: TimestampKind = authoritativeOriginalPublishedAt ? "published" : "collected";
      if (row.timestamp_kind !== expectedTimestampKind) {
        issues.push(authorityIssue(headline.id, "SOURCE_TIME_AUTHORITY_INCONSISTENT", `来源 ${source.name} 的时间类型与可证明发布时间不一致`));
      }
    }

    const primarySources = sourceRows.rows.filter((row) => row.source_role === "primary");
    if (primarySources.length !== 1) {
      issues.push(authorityIssue(headline.id, "PRIMARY_SOURCE_AUTHORITY_MISMATCH", "每个事件版本必须且只能有一个权威主来源"));
    } else {
      const primary = primarySources[0];
      const originalPublishedAt = dbOptionalIso(primary.original_published_at);
      const collectedAt = dbOptionalIso(primary.observation_collected_at)!;
      const expectedPublishedAt = originalPublishedAt ?? collectedAt;
      const expectedKind: TimestampKind = originalPublishedAt ? "published" : "collected";
      const projectedHeadlineTime = headline.publishedAt
        ? parseStrictSourceTimestamp(headline.publishedAt)
        : null;
      if (projectedHeadlineTime !== expectedPublishedAt
        || headline.timestampKind !== expectedKind
        || headline.newsTimeSource !== primary.observation_source_name) {
        issues.push(authorityIssue(
          headline.id,
          "HEADLINE_TIME_AUTHORITY_MISMATCH",
          "头条发布时间、时间类型或时间来源与快照主来源观察不一致",
        ));
      }
    }

    // Evidence versions are immutable quote/locator revisions and may be
    // reused by later source observations. Their database `captured_at` is the
    // first observation that created the version; the evidence projected into
    // this snapshot must instead be bound to this snapshot's exact source
    // observation time.
    const observationCapturedAtBySourceOrdinal = new Map(sourceRows.rows.map((row) => [
      row.source_ordinal,
      dbOptionalIso(row.observation_collected_at)!,
    ]));
    const evidenceRows = await pool().query<{
      id: string;
      evidence_item_id: string;
      anchor_key: string;
      source_document_id: string;
      source_document_version_id: string;
      source_ordinal: number;
      evidence_ordinal: number;
      material_hash: string;
      quote_original: string | null;
      quote_original_hash: string | null;
      quote_language: string | null;
      quote_zh_cn: string | null;
      locator: SourceEvidence["locator"];
      locator_hash: string;
      locator_status: SourceEvidence["locatorStatus"];
      directness: SourceEvidence["directness"];
      capture_scope: SourceEvidence["captureScope"];
      extraction_method: string;
      extractor_version: string;
      captured_at: string | Date;
    }>(`
      SELECT evidence.id, evidence.evidence_item_id, item.anchor_key,
             evidence.source_document_id, evidence.source_document_version_id,
             projection.source_ordinal, projection.evidence_ordinal,
             evidence.material_hash, evidence.quote_original, evidence.quote_original_hash,
             evidence.quote_language, evidence.quote_zh_cn, evidence.locator,
             evidence.locator_hash, evidence.locator_status, evidence.directness,
             evidence.capture_scope, evidence.extraction_method,
             evidence.extractor_version, evidence.captured_at
      FROM event_version_evidence AS projection
      JOIN evidence_versions AS evidence
        ON evidence.source_document_id = projection.source_document_id
       AND evidence.source_document_version_id = projection.source_document_version_id
       AND evidence.evidence_item_id = projection.evidence_item_id
       AND evidence.id = projection.evidence_version_id
      JOIN evidence_items AS item
        ON item.source_document_id = evidence.source_document_id
       AND item.id = evidence.evidence_item_id
      WHERE projection.event_id = $1 AND projection.event_version_id = $2
      ORDER BY projection.source_ordinal, projection.evidence_ordinal
    `, [headline.id, eventVersionId]);
    const authoritativeEvidence = new Map(evidenceRows.rows.map((row) => [row.id, row]));
    const projectedEvidence = headline.sources.flatMap((source, sourceIndex) =>
      (source.evidence ?? []).map((evidence, evidenceIndex) => ({ evidence, sourceIndex, evidenceIndex })));
    const projectedEvidenceVersionIds = projectedEvidence
      .map(({ evidence }) => evidence.versionId)
      .filter((id): id is string => Boolean(id));
    if (authoritativeEvidence.size !== projectedEvidence.length
      || projectedEvidenceVersionIds.length !== projectedEvidence.length
      || new Set(projectedEvidenceVersionIds).size !== projectedEvidenceVersionIds.length
      || projectedEvidenceVersionIds.some((id) => !authoritativeEvidence.has(id))) {
      issues.push(authorityIssue(headline.id, "EVIDENCE_SET_AUTHORITY_MISMATCH", "页面完整证据集合与事件版本登记集合不同"));
    }
    for (const { evidence, sourceIndex, evidenceIndex } of projectedEvidence) {
      const row = evidence.versionId ? authoritativeEvidence.get(evidence.versionId) : undefined;
      if (!row) {
        issues.push(authorityIssue(headline.id, "EVIDENCE_AUTHORITY_MISSING", `证据 ${evidence.id} 没有数据库版本`));
        continue;
      }
      const projected = {
        id: evidence.id,
        versionId: evidence.versionId ?? null,
        sourceDocumentId: evidence.sourceDocumentId,
        sourceDocumentVersionId: evidence.sourceDocumentVersionId ?? null,
        sourceOrdinal: sourceIndex + 1,
        evidenceOrdinal: evidenceIndex + 1,
        anchorKey: evidence.anchorKey,
        quoteOriginal: evidence.quoteOriginal ?? null,
        quoteHash: evidence.quoteHash ?? null,
        quoteLanguage: evidence.quoteLanguage ?? null,
        quoteZhCn: evidence.quoteZhCn ?? null,
        locator: evidence.locator,
        locatorHash: evidence.locatorHash,
        locatorStatus: evidence.locatorStatus,
        directness: evidence.directness,
        captureScope: evidence.captureScope,
        extractionMethod: evidence.extractionMethod,
        extractorVersion: evidence.extractorVersion,
        capturedAt: parseStrictSourceTimestamp(evidence.capturedAt) ?? `invalid:${evidence.capturedAt}`,
      };
      const authority = {
        id: row.evidence_item_id,
        versionId: row.id,
        sourceDocumentId: row.source_document_id,
        sourceDocumentVersionId: row.source_document_version_id,
        sourceOrdinal: row.source_ordinal,
        evidenceOrdinal: row.evidence_ordinal,
        anchorKey: row.anchor_key,
        quoteOriginal: row.quote_original,
        quoteHash: row.quote_original_hash,
        quoteLanguage: row.quote_language,
        quoteZhCn: row.quote_zh_cn,
        locator: row.locator,
        locatorHash: row.locator_hash,
        locatorStatus: row.locator_status,
        directness: row.directness,
        captureScope: row.capture_scope,
        extractionMethod: row.extraction_method,
        extractorVersion: row.extractor_version,
        capturedAt: observationCapturedAtBySourceOrdinal.get(row.source_ordinal) ?? null,
      };
      if (canonicalEvidenceJson(projected) !== canonicalEvidenceJson(authority)) {
        issues.push(authorityIssue(headline.id, "EVIDENCE_AUTHORITY_MISMATCH", `证据 ${evidence.id} 的原文、哈希或定位与数据库不一致`));
      }
      const rowEvidence: SourceEvidence = {
        id: row.evidence_item_id,
        versionId: row.id,
        sourceDocumentId: row.source_document_id,
        sourceDocumentVersionId: row.source_document_version_id,
        anchorKey: row.anchor_key,
        ...(row.quote_original === null ? {} : { quoteOriginal: row.quote_original }),
        ...(row.quote_original_hash === null ? {} : { quoteHash: row.quote_original_hash }),
        ...(row.quote_language === null ? {} : { quoteLanguage: row.quote_language }),
        ...(row.quote_zh_cn === null ? {} : { quoteZhCn: row.quote_zh_cn }),
        locator: row.locator,
        locatorHash: row.locator_hash,
        locatorStatus: row.locator_status,
        directness: row.directness,
        captureScope: row.capture_scope,
        extractionMethod: row.extraction_method,
        extractorVersion: row.extractor_version,
        capturedAt: dbOptionalIso(row.captured_at)!,
      };
      try {
        if (evidenceVersionMaterialHash(rowEvidence) !== row.material_hash) {
          issues.push(authorityIssue(headline.id, "EVIDENCE_MATERIAL_HASH_MISMATCH", `证据 ${evidence.id} 无法重算出数据库材料哈希`));
        }
      } catch {
        issues.push(authorityIssue(headline.id, "EVIDENCE_INTERNAL_INTEGRITY_INVALID", `证据 ${evidence.id} 的数据库内容不满足精确证据规则`));
      }
    }

    const claimPresentationRows = await pool().query<BriefSnapshotClaimPresentationRow>(`
      SELECT snapshot_id, event_id, event_version_id, claim_key,
             ordinal, statement, language
      FROM brief_snapshot_claim_presentations
      WHERE snapshot_id = $1 AND event_id = $2 AND event_version_id = $3
    `, [snapshotId, headline.id, eventVersionId]);
    const authoritativeClaimPresentations = new Map(
      claimPresentationRows.rows.map((row) => [row.claim_key, row]),
    );
    const projectedClaims = headline.claims ?? [];
    if (authoritativeClaimPresentations.size !== projectedClaims.length
      || new Set(projectedClaims.map((claim) => claim.claimKey)).size !== projectedClaims.length
      || projectedClaims.some((claim) => !authoritativeClaimPresentations.has(claim.claimKey))) {
      issues.push(authorityIssue(
        headline.id,
        "CLAIM_PRESENTATION_SET_AUTHORITY_MISMATCH",
        "页面声明展示集合与不可变快照登记集合不同",
      ));
    }
    for (const claim of projectedClaims) {
      const presentation = authoritativeClaimPresentations.get(claim.claimKey);
      if (!presentation) {
        issues.push(authorityIssue(
          headline.id,
          "CLAIM_PRESENTATION_AUTHORITY_MISSING",
          `声明 ${claim.claimKey} 没有不可变快照展示记录`,
        ));
        continue;
      }
      if (presentation.event_version_id !== eventVersionId
        || presentation.ordinal !== claim.ordinal
        || presentation.statement !== claim.statement
        || presentation.language !== claim.language) {
        issues.push(authorityIssue(
          headline.id,
          "CLAIM_PRESENTATION_AUTHORITY_MISMATCH",
          `声明 ${claim.claimKey} 的展示正文或语言与不可变快照不一致`,
        ));
      }
    }

    const claimRows = await pool().query<{
      id: string;
      claim_key: string;
      claim_type: string;
      original_statement: string | null;
      statement: string;
      statement_hash: string;
      language: string;
      verification_status: string;
      generator: string;
      generator_version: string;
      ordinal: number;
    }>(`
      SELECT id, claim_key, claim_type, original_statement, statement,
             statement_hash, language, verification_status, generator,
             generator_version, ordinal
      FROM event_claims
      WHERE event_id = $1 AND event_version_id = $2
    `, [headline.id, eventVersionId]);
    const authoritativeClaims = new Map(claimRows.rows.map((row) => [row.claim_key, row]));
    if (authoritativeClaims.size !== projectedClaims.length
      || new Set(projectedClaims.map((claim) => claim.claimKey)).size !== projectedClaims.length
      || projectedClaims.some((claim) => !authoritativeClaims.has(claim.claimKey))) {
      issues.push(authorityIssue(headline.id, "CLAIM_SET_AUTHORITY_MISMATCH", "页面声明集合与事件版本声明集合不同"));
    }
    const linkRows = await pool().query<{
      claim_id: string;
      claim_key: string;
      source_document_id: string;
      source_document_version_id: string;
      evidence_item_id: string;
      evidence_version_id: string;
      relation: string;
      directness: string;
      confidence: number | string;
      ordinal: number;
    }>(`
      SELECT claim_id, claim_key, source_document_id, source_document_version_id,
             evidence_item_id, evidence_version_id, relation, directness, confidence, ordinal
      FROM claim_evidence_links
      WHERE event_id = $1 AND event_version_id = $2
    `, [headline.id, eventVersionId]);
    const linksByClaim = new Map<string, typeof linkRows.rows>();
    for (const link of linkRows.rows) {
      const rows = linksByClaim.get(link.claim_id) ?? [];
      rows.push(link);
      linksByClaim.set(link.claim_id, rows);
    }
    for (const rows of linksByClaim.values()) rows.sort((left, right) => left.ordinal - right.ordinal);
    const projectedCitationCount = projectedClaims.reduce((sum, claim) => sum + claim.citations.length, 0);
    if (projectedCitationCount !== linkRows.rows.length) {
      issues.push(authorityIssue(headline.id, "CITATION_SET_AUTHORITY_MISMATCH", "页面引用总数与事件版本引用总数不同"));
    }
    for (const claim of projectedClaims) {
      const row = authoritativeClaims.get(claim.claimKey);
      if (!row) {
        issues.push(authorityIssue(headline.id, "CLAIM_AUTHORITY_MISSING", `声明 ${claim.claimKey} 不属于该事件版本`));
        continue;
      }
      if (row.claim_type !== claim.type
        || row.ordinal !== claim.ordinal + 1
        || row.original_statement !== (claim.originalStatement ?? null)
        || row.statement_hash !== claim.statementHash
        || row.verification_status !== claim.verificationStatus
        || row.generator !== claim.generator
        || row.generator_version !== claim.generatorVersion) {
        issues.push(authorityIssue(headline.id, "CLAIM_AUTHORITY_MISMATCH", `声明 ${claim.claimKey} 与数据库权威版本不一致`));
      }
      if (row.statement_hash !== sha256ExactUtf8(row.original_statement ?? row.statement)) {
        issues.push(authorityIssue(headline.id, "CLAIM_STATEMENT_HASH_MISMATCH", `声明 ${claim.claimKey} 的数据库正文无法重算出声明哈希`));
      }
      const claimLinks = linksByClaim.get(row.id) ?? [];
      if (claimLinks.length !== claim.citations.length) {
        issues.push(authorityIssue(headline.id, "CITATION_SET_AUTHORITY_MISMATCH", `声明 ${claim.claimKey} 的引用集合数量与数据库不同`));
      }
      for (const [citationIndex, citation] of claim.citations.entries()) {
        const link = claimLinks[citationIndex];
        if (!link
          || link.claim_key !== claim.claimKey
          || link.source_document_id !== citation.sourceDocumentId
          || link.source_document_version_id !== citation.sourceDocumentVersionId
          || link.evidence_item_id !== citation.id
          || link.evidence_version_id !== citation.versionId
          || link.relation !== citation.relation
          || link.directness !== citation.directness
          || Number(link.confidence) !== citation.confidence
          || link.ordinal !== citationIndex + 1
          || citation.order !== citationIndex) {
          issues.push(authorityIssue(headline.id, "CITATION_LINK_AUTHORITY_MISMATCH", `声明 ${claim.claimKey} 的引用关系与数据库不一致`));
        }
        const evidence = citation.versionId ? authoritativeEvidence.get(citation.versionId) : undefined;
        if (!evidence) {
          issues.push(authorityIssue(headline.id, "CITATION_EVIDENCE_AUTHORITY_MISSING", `声明 ${claim.claimKey} 引用了未登记在事件版本的证据`));
          continue;
        }
        const projectedCitationEvidence = {
          id: citation.id,
          versionId: citation.versionId ?? null,
          sourceDocumentId: citation.sourceDocumentId,
          sourceDocumentVersionId: citation.sourceDocumentVersionId ?? null,
          anchorKey: citation.anchorKey,
          quoteOriginal: citation.quoteOriginal ?? null,
          quoteHash: citation.quoteHash ?? null,
          quoteLanguage: citation.quoteLanguage ?? null,
          quoteZhCn: citation.quoteZhCn ?? null,
          locator: citation.locator,
          locatorHash: citation.locatorHash,
          locatorStatus: citation.locatorStatus,
          directness: citation.directness,
          captureScope: citation.captureScope,
          extractionMethod: citation.extractionMethod,
          extractorVersion: citation.extractorVersion,
          capturedAt: parseStrictSourceTimestamp(citation.capturedAt) ?? `invalid:${citation.capturedAt}`,
        };
        const authorityCitationEvidence = {
          id: evidence.evidence_item_id,
          versionId: evidence.id,
          sourceDocumentId: evidence.source_document_id,
          sourceDocumentVersionId: evidence.source_document_version_id,
          anchorKey: evidence.anchor_key,
          quoteOriginal: evidence.quote_original,
          quoteHash: evidence.quote_original_hash,
          quoteLanguage: evidence.quote_language,
          quoteZhCn: evidence.quote_zh_cn,
          locator: evidence.locator,
          locatorHash: evidence.locator_hash,
          locatorStatus: evidence.locator_status,
          directness: evidence.directness,
          captureScope: evidence.capture_scope,
          extractionMethod: evidence.extraction_method,
          extractorVersion: evidence.extractor_version,
          capturedAt: observationCapturedAtBySourceOrdinal.get(evidence.source_ordinal) ?? null,
        };
        if (canonicalEvidenceJson(projectedCitationEvidence) !== canonicalEvidenceJson(authorityCitationEvidence)) {
          issues.push(authorityIssue(headline.id, "CITATION_EVIDENCE_AUTHORITY_MISMATCH", `声明 ${claim.claimKey} 的引用证据正文或定位与数据库不一致`));
        }
      }
    }
  }
  return issues;
}

function publicationComparableBrief(brief: DailyBrief): string {
  const reviewedContent = structuredClone(brief);
  delete reviewedContent.id;
  delete reviewedContent.status;
  delete reviewedContent.publishedAt;
  delete reviewedContent.storageMode;
  return canonicalJson(reviewedContent);
}

function assertExactReviewedSnapshot(
  submitted: DailyBrief,
  authoritativeDraft: DailyBrief,
  currentSnapshotId: string | null | undefined,
): string {
  const submittedSnapshotId = submitted.snapshot?.id;
  const draftSnapshotId = authoritativeDraft.snapshot?.id;
  if (!submittedSnapshotId || !draftSnapshotId || !currentSnapshotId) {
    throw new StaleBriefRevisionError("A complete reviewed snapshot revision is required before publishing");
  }
  if (submittedSnapshotId !== draftSnapshotId || submittedSnapshotId !== currentSnapshotId) {
    throw new StaleBriefRevisionError("The reviewed snapshot changed before publication; reload and review it again");
  }
  if (publicationComparableBrief(submitted) !== publicationComparableBrief(authoritativeDraft)) {
    throw new StaleBriefRevisionError("The submitted publication payload is not the exact reviewed draft");
  }
  return submittedSnapshotId;
}

function publishedBriefFromDraft(
  draft: DailyBrief,
  id: string,
  publishedAt: string,
  mode: "memory" | "postgres",
): DailyBrief {
  return {
    ...structuredClone(draft),
    id,
    status: "published",
    publishedAt,
    storageMode: mode,
  };
}

function assertCurrentMemoryPublishedBaseline(snapshot: BriefSnapshotRecord): void {
  const expected = previousPublishedMemorySnapshot(snapshot.date)?.id;
  for (const headline of snapshot.brief.headlines) {
    if (headline.whatChanged?.investor.baselineSnapshotId !== expected) {
      throw new StaleBriefRevisionError(
        "The previous published brief changed; rebuild and review What Changed before publishing",
      );
    }
  }
}

async function assertCurrentPostgresPublishedBaseline(
  client: PoolClient,
  snapshotId: string,
): Promise<void> {
  const boundary = await client.query<{ brief_date: string | Date }>(`
    SELECT brief_date FROM brief_snapshots WHERE id = $1
  `, [snapshotId]);
  if (!boundary.rows[0]) {
    throw new StaleBriefRevisionError("The reviewed snapshot authority is missing");
  }
  const expected = await loadPreviousPublishedSnapshotId(
    client,
    dateOnly(boundary.rows[0].brief_date),
  );
  const endpoints = await client.query<{
    event_id: string;
    baseline_snapshot_id: string | null;
  }>(`
    SELECT observation.event_id, comparison.baseline_snapshot_id
    FROM brief_snapshot_events AS observation
    LEFT JOIN brief_snapshot_event_changes AS comparison
      ON comparison.current_snapshot_id = observation.snapshot_id
     AND comparison.event_id = observation.event_id
     AND comparison.baseline_kind = 'previous_published'
     AND comparison.algorithm_version = $2
    WHERE observation.snapshot_id = $1
  `, [snapshotId, WHAT_CHANGED_ALGORITHM_VERSION]);
  if (!endpoints.rows.length
    || endpoints.rows.some((row) => row.baseline_snapshot_id !== (expected ?? null))) {
    throw new StaleBriefRevisionError(
      "The previous published brief changed; rebuild and review What Changed before publishing",
    );
  }
}

function publishBriefMemory(
  id: string,
  brief: DailyBrief,
  pdf: Buffer,
  actor: NonNullable<PersistBriefOptions["actor"]>,
): BriefRecord {
  // The normalized actor is intentionally carried across the promotion
  // boundary so the publication audit can be recorded without re-reading a
  // credential or accepting an unvalidated actor shape.
  void actor;
  const entry = memory.get(id);
  if (!entry) throw new Error("Daily brief not found");
  if (entry.status !== "draft") throw new Error("Only a draft can be published");
  const snapshotId = assertExactReviewedSnapshot(brief, entry.brief, entry.currentSnapshotId);
  const snapshot = briefSnapshotMemory.get(snapshotId);
  if (!snapshot
    || snapshot.payloadHash !== entry.brief.snapshot?.payloadHash
    || publicationComparableBrief(snapshot.brief)
      !== publicationComparableBrief(entry.brief)) {
    throw new StaleBriefRevisionError(
      "The reviewed draft does not match its immutable snapshot authority",
    );
  }
  assertCurrentMemoryPublishedBaseline(snapshot);
  const latestPublishedAt = [...publicationAuditMemory.values()]
    .map((audit) => Date.parse(audit.publishedAt))
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
  const publishedAt = new Date(Math.max(
    Date.now(),
    Number.isFinite(latestPublishedAt) ? latestPublishedAt + 1 : Date.now(),
  )).toISOString();

  // No await occurs between checking the three snapshot pointers and replacing
  // the record, so this is the memory backend's compare-and-swap boundary.
  if (memory.get(id) !== entry
    || entry.status !== "draft"
    || entry.currentSnapshotId !== snapshotId
    || entry.brief.snapshot?.id !== snapshotId) {
    throw new StaleBriefRevisionError("The reviewed snapshot changed during publication");
  }
  const published: MemoryEntry = {
    ...entry,
    status: "published",
    brief: publishedBriefFromDraft(entry.brief, id, publishedAt, "memory"),
    publishedAt,
    updatedAt: publishedAt,
    pdf: Buffer.from(pdf),
    hasPdf: true,
    currentSnapshotId: snapshotId,
  };
  const publicationAudit: MemoryPublicationAudit = {
    briefId: id,
    snapshotId,
    snapshotPayloadHash: snapshot.payloadHash,
    pdfSha256: createHash("sha256").update(pdf).digest("hex"),
    actorType: actor.type,
    actorIdHash: actor.idHash,
    actionReason: actor.reason,
    requestId: actor.requestId,
    publishedAt,
  };
  memory.set(id, published);
  publicationAuditMemory.set(id, publicationAudit);
  return cloneMemory(published);
}

async function publishBriefPostgres(
  id: string,
  brief: DailyBrief,
  pdf: Buffer,
  actor: NonNullable<PersistBriefOptions["actor"]>,
): Promise<BriefRecord> {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('analystarena_snapshot_visibility'))",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('analystarena_brief_publication'))",
    );
    const locked = await client.query<DatabaseRow>(`
      SELECT *, (pdf_data IS NOT NULL) AS has_pdf
      FROM daily_briefs
      WHERE id = $1
      FOR UPDATE
    `, [id]);
    const row = locked.rows[0];
    if (!row) throw new Error("Daily brief not found");
    if (row.status !== "draft") throw new Error("Only a draft can be published");

    const draft = rowToRecord(row).brief;
    const snapshotId = assertExactReviewedSnapshot(brief, draft, row.current_snapshot_id);
    const snapshotAuthority = await client.query<{
      payload_hash: string;
      payload: DailyBrief | string;
    }>(`
      SELECT payload_hash, payload
      FROM brief_snapshots
      WHERE id = $1
      FOR SHARE
    `, [snapshotId]);
    const snapshotRow = snapshotAuthority.rows[0];
    if (!snapshotRow) {
      throw new StaleBriefRevisionError("The reviewed snapshot authority is missing");
    }
    const snapshotBrief = typeof snapshotRow.payload === "string"
      ? JSON.parse(snapshotRow.payload) as DailyBrief
      : snapshotRow.payload;
    if (snapshotRow.payload_hash !== draft.snapshot?.payloadHash
      || snapshotPayloadHash(snapshotBrief) !== snapshotRow.payload_hash
      || publicationComparableBrief(snapshotBrief)
        !== publicationComparableBrief(draft)) {
      throw new StaleBriefRevisionError(
        "The reviewed draft does not match its immutable snapshot authority",
      );
    }
    await assertCurrentPostgresPublishedBaseline(client, snapshotId);
    const publicationClock = await client.query<{ published_at: string | Date }>(`
      SELECT GREATEST(
        clock_timestamp(),
        COALESCE(
          MAX(authority.published_at) + INTERVAL '1 millisecond',
          '-infinity'::timestamptz
        )
      ) AS published_at
      FROM (
        SELECT audit.published_at
        FROM brief_publication_audits AS audit
        UNION ALL
        SELECT existing.published_at
        FROM daily_briefs AS existing
        WHERE existing.status = 'published'
          AND existing.id <> $1
          AND existing.published_at IS NOT NULL
      ) AS authority
    `, [id]);
    const publishedAt = iso(publicationClock.rows[0].published_at);
    const publishedPayload = publishedBriefFromDraft(draft, id, publishedAt, "postgres");
    const updated = await client.query<DatabaseRow>(`
      UPDATE daily_briefs
      SET status = 'published',
          payload = $2::jsonb,
          pdf_data = $3,
          published_at = $4,
          updated_at = $4,
          current_snapshot_id = $5
      WHERE id = $1
        AND status = 'draft'
        AND current_snapshot_id = $5
      RETURNING *, (pdf_data IS NOT NULL) AS has_pdf
    `, [id, JSON.stringify(publishedPayload), pdf, publishedAt, snapshotId]);
    if (!updated.rows[0]) {
      throw new StaleBriefRevisionError("The reviewed snapshot changed during publication");
    }
    await client.query(`
      INSERT INTO brief_publication_audits (
        brief_id, snapshot_id, snapshot_payload_hash, pdf_sha256,
        actor_type, actor_id_hash, action_reason, request_id, published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      id,
      snapshotId,
      snapshotRow.payload_hash,
      createHash("sha256").update(pdf).digest("hex"),
      actor.type,
      actor.idHash ?? null,
      actor.reason ?? null,
      actor.requestId ?? null,
      publishedAt,
    ]);
    await client.query("COMMIT");
    return rowToRecord(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function publishBrief(
  id: string,
  brief: DailyBrief,
  pdf: Buffer,
  options: PersistBriefOptions = {},
): Promise<BriefRecord> {
  const actor = normalizeActor(options.actor);
  const result = storageMode() === "memory"
    ? publishBriefMemory(id, brief, pdf, actor)
    : await publishBriefPostgres(id, brief, pdf, actor);
  return result;
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
