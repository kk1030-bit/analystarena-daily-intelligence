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
export type TimestampKind = "published" | "collected";

export interface SourceLink {
  name: string;
  type: SourceType;
  url: string;
  publishedAt?: string;
  timestampKind?: TimestampKind;
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
  title: string;
  description: string;
  url: string;
  publishedAt: string;
  source: string;
  sourceType: SourceType;
  engagement?: number;
  collectedAt?: string;
  timestampKind?: TimestampKind;
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
  items: Array<StockProfile & { latestPrice?: StockPriceDaily }>;
}
