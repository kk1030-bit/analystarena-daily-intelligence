export type Category =
  | "Macro"
  | "AI"
  | "Semiconductor"
  | "Crypto"
  | "ETF"
  | "Earnings"
  | "Geopolitics";

export type SourceType = "Official" | "News" | "Reddit" | "X";
export type Sentiment = "positive" | "neutral" | "negative";

export interface SourceLink {
  name: string;
  type: SourceType;
  url: string;
  publishedAt?: string;
}

export interface Headline {
  id: string;
  rank: number;
  ticker: string;
  title: string;
  summary: string;
  marketImpact: string;
  category: Category;
  impact: number;
  confidence: number;
  mentions: number;
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
  date: string;
  generatedAt: string;
  mode: "demo" | "live";
  aiEnabled: boolean;
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
}
