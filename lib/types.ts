export type Category =
  | "Macro"
  | "AI"
  | "Semiconductor"
  | "Crypto"
  | "ETF"
  | "Earnings"
  | "Geopolitics"
  | "Other";

export type SourceType = "Official" | "News" | "Reddit" | "X";
export type Sentiment = "positive" | "neutral" | "negative";
export type MarketDirection = "bullish" | "bearish" | "mixed" | "neutral";
export type TimestampKind = "published" | "collected";
export type SourceRole = "primary" | "corroborating" | "context" | "contradicting" | "social_signal";

export type SourceCaptureScope =
  | "rss_entry"
  | "atom_entry"
  | "detail_page"
  | "reddit_post"
  | "x_post"
  | "pdf"
  | "legacy_metadata";

export type EvidenceLocatorStatus = "exact" | "derived" | "unavailable";
export type EvidenceDirectness = "direct" | "indirect" | "derived" | "unavailable";
export type EvidenceSupportRelation = "supports" | "contradicts" | "context";
export type ClaimVerificationStatus =
  | "supported"
  | "partially_supported"
  | "pending_confirmation"
  | "legacy_unverified";
export type ClaimType =
  | "title"
  | "summary"
  | "important_information"
  | "market_impact"
  | "direction_rationale"
  | "equity_impact";

export interface FeedFieldLocator {
  kind: "feed_field";
  feedUrl: string;
  entryId?: string;
  field: "title" | "description" | "summary" | "content";
  fieldPath: string;
}

export interface HtmlTextQuoteLocator {
  kind: "html_text_quote";
  pageUrl: string;
  selector?: string;
  contentRootSelector?: string;
  textQuote: {
    exact: string;
    prefix?: string;
    suffix?: string;
  };
  blockIndex?: number;
  blockIndexBasis?: "normalized_content_blocks";
}

export interface RedditPostFieldLocator {
  kind: "reddit_post_field";
  postId: string;
  field: "title" | "body";
}

export interface XPostFieldLocator {
  kind: "x_post_field";
  statusId: string;
  field: "text";
}

export interface PdfTextLocator {
  kind: "pdf_text";
  pdfUrl: string;
  pageNumber: number;
  startOffset?: number;
  endOffset?: number;
}

export interface UnavailableEvidenceLocator {
  kind: "unavailable";
  reasonCode:
    | "body_not_collected"
    | "source_not_resolved"
    | "content_not_extracted"
    | "legacy_metadata_only"
    | "unsupported_content_type"
    | "collection_failed";
  detail?: string;
}

export type EvidenceLocator =
  | FeedFieldLocator
  | HtmlTextQuoteLocator
  | RedditPostFieldLocator
  | XPostFieldLocator
  | PdfTextLocator
  | UnavailableEvidenceLocator;

export interface SourceCapture {
  rawUrl: string;
  canonicalUrl?: string;
  finalUrl?: string;
  feedUrl?: string;
  mimeType?: string;
  httpStatus?: number;
  originalPublishedAt?: string | null;
  publishedAtRaw?: string;
  publishedAtField?: string;
  sourceUpdatedAt?: string;
  collectedAt: string;
  scope: SourceCaptureScope;
  capturedContentHash: string;
  /** Exact UTF-8 capture material whose bytes produce capturedContentHash. */
  capturedArtifact?: string;
  capturedArtifactEncoding?: "utf8";
  capturedArtifactSizeBytes?: number;
  capturedTextHash?: string;
  extractionMethod: string;
  extractorVersion: string;
  backfillQuality?: "native" | "exact_legacy_metadata" | "unverified_legacy";
}

/** Exact source text plus a truthful, machine-readable locator. */
export interface SourceEvidence {
  id: string;
  versionId?: string;
  sourceDocumentId: string;
  sourceDocumentVersionId?: string;
  anchorKey: string;
  quoteOriginal?: string;
  quoteHash?: string;
  quoteLanguage?: string;
  quoteZhCn?: string;
  locator: EvidenceLocator;
  locatorHash: string;
  locatorStatus: EvidenceLocatorStatus;
  directness: EvidenceDirectness;
  captureScope: SourceCaptureScope;
  extractionMethod: string;
  extractorVersion: string;
  /** Capture time of the source observation projecting this evidence. */
  capturedAt: string;
}

export interface EvidenceCitation extends SourceEvidence {
  relation: EvidenceSupportRelation;
  confidence: number;
  order: number;
}

export interface HeadlineClaim {
  id: string;
  claimKey: string;
  type: ClaimType;
  ordinal: number;
  statement: string;
  originalStatement?: string;
  statementHash: string;
  language: string;
  verificationStatus: ClaimVerificationStatus;
  citations: EvidenceCitation[];
  generator: "collector" | "deterministic" | "ai" | "review" | "legacy";
  generatorVersion: string;
}

export interface SourceLink {
  name: string;
  type: SourceType;
  role?: SourceRole;
  url: string;
  sourceDocumentId?: string;
  sourceDocumentVersionId?: string;
  sourceObservationId?: string;
  nativeId?: string;
  feedNamespace?: string;
  canonicalUrl?: string;
  originalTitle?: string;
  contentHash?: string;
  publishedAt?: string;
  collectedAt?: string;
  timestampKind?: TimestampKind;
  originalPublishedAt?: string | null;
  publishedAtRaw?: string;
  publishedAtField?: string;
  sourceUpdatedAt?: string;
  capture?: SourceCapture;
  evidence?: SourceEvidence[];
}

export interface TermNote {
  term: string;
  note: string;
}

export type EquityImpactDirection = "potential_upside" | "potential_downside" | "mixed" | "unclear";
export type EquityRelation = "issuer" | "supplier" | "customer" | "competitor" | "sector_peer" | "macro_exposure";
export type ImpactReviewStatus = "auto_pending" | "approved" | "rejected" | "edited";

export interface EquityImpactEvidence {
  basis: "explicit_symbol" | "company_alias" | "event_rule" | "curated_exposure";
  statement: string;
  weight: number;
}

export interface EquityMarketContext {
  asOf: string;
  lastPrice?: number;
  return1dPct?: number;
  return5dPct?: number;
  volumeVs20d?: number;
  freshness: "fresh" | "stale" | "missing";
}

export interface EquityImpactAssessment {
  symbol: string;
  providerSymbol: string;
  companyName: string;
  direction: EquityImpactDirection;
  relation: EquityRelation;
  mappingConfidence: number;
  directionConfidence?: number;
  mechanism: string;
  assumptions: string[];
  counterCase: string;
  evidence: EquityImpactEvidence[];
  marketContext?: EquityMarketContext;
  engineVersion: string;
  reviewStatus: ImpactReviewStatus;
}

export interface Headline {
  id: string;
  rank: number;
  ticker: string;
  title: string;
  summary: string;
  keyPoints?: string[];
  termNotes?: TermNote[];
  publishedAt?: string;
  newsTimeSource?: string;
  timestampKind?: TimestampKind;
  marketImpact: string;
  marketDirection?: MarketDirection;
  directionConfidence?: number;
  directionRationale?: string;
  equityImpacts?: EquityImpactAssessment[];
  category: Category;
  impact: number;
  confidence: number;
  mentions: number;
  rankingScore?: number;
  freshnessScore?: number;
  crossSourceCount?: number;
  sentiment: Sentiment;
  sources: SourceLink[];
  claims?: HeadlineClaim[];
}

export interface MarketHeat {
  category: Category;
  score: number;
  direction: "up" | "flat" | "down";
  note: string;
}

export interface SocialTopic {
  id?: string;
  label: string;
  description?: string;
  url?: string;
  source?: string;
  platform?: "Reddit" | "X";
  publishedAt?: string;
  timestampKind?: TimestampKind;
  category?: Category;
  signalScore?: number;
  metricKind?: "engagement" | "mentions" | "estimated";
  relatedHeadlineId?: string;
  relationKind?: "same-source" | "semantic";
  mentions: number;
  change: number;
  sentiment: Sentiment;
}

export interface WatchItem {
  time: string;
  event: string;
  why: string;
  category: Category;
}

export interface DailyBrief {
  id?: string;
  date: string;
  generatedAt: string;
  mode: "demo" | "live";
  aiEnabled: boolean;
  translationEnabled?: boolean;
  status?: BriefStatus;
  publishedAt?: string;
  storageMode?: "postgres" | "memory";
  snapshot?: BriefSnapshotMetadata;
  collectorStatuses?: CollectorStatus[];
  warning?: string;
  stats: {
    candidates: number;
    consolidatedEvents: number;
    topStories: number;
    sourcesOnline: number;
  };
  headlines: Headline[];
  marketHeat: MarketHeat[];
  socialBuzz: {
    reddit: SocialTopic[];
    x: SocialTopic[];
  };
  watchlist: WatchItem[];
}

export interface RawStory {
  id: string;
  sourceDocumentId?: string;
  nativeId?: string;
  feedNamespace?: string;
  canonicalUrl?: string;
  title: string;
  originalTitle?: string;
  description: string;
  originalDescription?: string;
  url: string;
  publishedAt: string;
  originalPublishedAt?: string | null;
  publishedAtRaw?: string;
  publishedAtField?: string;
  sourceUpdatedAt?: string;
  updatedAt?: string;
  source: string;
  sourceType: SourceType;
  engagement?: number;
  collectedAt?: string;
  firstCollectedAt?: string;
  lastCollectedAt?: string;
  contentHash?: string;
  timestampKind?: TimestampKind;
  sourceDocumentVersionId?: string;
  sourceObservationId?: string;
  capture?: SourceCapture;
  evidence?: SourceEvidence[];
}

export type BriefSnapshotStream =
  | "shared"
  | "manual"
  | "privileged"
  | "cron"
  | "generate"
  | "review"
  | "publish"
  | "legacy"
  | "unspecified";

export interface BriefSnapshotMetadata {
  id: string;
  runId: string;
  stream: BriefSnapshotStream;
  batchKey: string;
  sequenceNumber: number;
  previousSnapshotId?: string;
  payloadHash: string;
  persistedAt: string;
  /**
   * Frozen snapshot-to-event projection used by the publication authority
   * gate. These values describe ranking/matching in this exact snapshot and
   * therefore do not belong to the reusable event version itself.
   */
  events: BriefSnapshotEventProjection[];
}

export interface CollectionRunRecord {
  id: string;
  stream: BriefSnapshotStream;
  batchKey: string;
  status: "running" | "success" | "failed";
  briefDate: string;
  inputHash?: string;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface EventRecord {
  id: string;
  stableKey: string;
  canonicalTitle: string;
  category: Category;
  ticker: string;
  firstSeenAt: string;
  lastSeenAt: string;
  identityQuality: "source_alias" | "semantic_high" | "new" | "legacy_unmatched";
}

export interface EventVersionRecord {
  id: string;
  eventId: string;
  versionNumber: number;
  previousVersionId?: string;
  contentHash: string;
  evidenceHash: string;
  stateHash: string;
  presentationHash: string;
  observedAt: string;
  runId: string;
  headline: Headline;
  createdAt: string;
}

export type EventMatchMethod = "existing_id" | "source_alias" | "semantic_high" | "new" | "legacy";

export interface BriefSnapshotEventRecord {
  snapshotId: string;
  eventId: string;
  eventVersionId: string;
  rank: number;
  rankingScore?: number;
  freshnessScore?: number;
  impact: number;
  confidence: number;
  mentions: number;
  crossSourceCount?: number;
  matchMethod: EventMatchMethod;
  matchConfidence: number;
}

export type BriefSnapshotEventProjection = Omit<BriefSnapshotEventRecord, "snapshotId">;

export interface BriefSnapshotRecord {
  id: string;
  runId: string;
  stream: BriefSnapshotStream;
  batchKey: string;
  sequenceNumber: number;
  date: string;
  generatedAt: string;
  previousSnapshotId?: string;
  payloadHash: string;
  brief: DailyBrief;
  createdAt: string;
  events: BriefSnapshotEventRecord[];
}

export interface RedditPost {
  id: string;
  subreddit: string;
  title: string;
  description: string;
  url: string;
  source: string;
  engagement: number;
  publishedAt: string;
  collectedAt: string;
  timestampKind: TimestampKind;
  createdAt: string;
  updatedAt: string;
}

export interface RedditSearchOptions {
  q?: string;
  subreddit?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: {
    publishedAt: string;
    id: string;
  };
}

export interface RedditSearchResult {
  items: RedditPost[];
  nextCursor?: string;
}

export type BriefStatus = "draft" | "published";

export interface BriefRecord {
  id: string;
  date: string;
  status: BriefStatus;
  brief: DailyBrief;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  hasPdf: boolean;
}

export interface CollectorStatus {
  name: string;
  ok: boolean;
  count: number;
  note?: string;
  channel?: string;
  backend?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
  lastSuccessAt?: string;
  attempts?: CollectorAttempt[];
}

export interface CollectorAttempt {
  backend: string;
  ok: boolean;
  count: number;
  latencyMs: number;
  completedAt: string;
  note?: string;
}

export interface StockProfile {
  symbol: string;
  providerSymbol: string;
  shortName?: string;
  longName?: string;
  exchange?: string;
  currency?: string;
  country?: string;
  sector?: string;
  industry?: string;
  website?: string;
  businessSummary?: string;
  marketCap?: number;
  averageVolume3m?: number;
  aliases: string[];
  exposureTags: string[];
  active: boolean;
  profileFetchOk?: boolean;
  sourceUpdatedAt: string;
}

export interface StockPriceDaily {
  symbol: string;
  tradingDate: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  adjustedClose?: number;
  volume?: number;
  dividends?: number;
  stockSplits?: number;
  sourceUpdatedAt: string;
}

export interface StockPriceSummary {
  asOf: string;
  lastPrice?: number;
  previousClose?: number;
  close5SessionsAgo?: number;
  latestVolume?: number;
  averageVolume20d?: number;
}

export interface StockSyncRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "partial" | "failed";
  sourceVersion: string;
  errors: string[];
  profileCount?: number;
  priceCount?: number;
}

export interface StockSyncPayload {
  run: StockSyncRun;
  profiles: StockProfile[];
  prices: StockPriceDaily[];
}

export interface StockSearchResult {
  items: Array<StockProfile & { latestPrice?: StockPriceDaily; priceSummary?: StockPriceSummary }>;
}
