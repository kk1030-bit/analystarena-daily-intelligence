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
  label: string;
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
