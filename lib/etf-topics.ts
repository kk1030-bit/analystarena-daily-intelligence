import { deriveSourceIdentity } from "./source-identity";
import { parseStrictSourceTimestamp, requireStrictSourceTimestamp } from "./source-time";

/** Five posts per hourly review, tracked for 24 hours: at most 120 live posts. */
export const ETF_TOP_PER_HOUR = 5;
export const ETF_TRACK_HOURS = 24;
export const ETF_MAX_TRACKED = ETF_TOP_PER_HOUR * ETF_TRACK_HOURS;
export const ETF_MAX_BATCH_POSTS = 80;
export const ETF_MAX_BODY_LENGTH = 8_000;

/** Subreddits whose ETF sections we review; r/ETFs is always on-topic. */
export const ETF_SUBREDDITS = ["ETFs", "investing", "Bogleheads", "dividends", "stocks"] as const;

const ETF_TERMS = new RegExp([
  String.raw`\betfs?\b`,
  "index fund",
  "expense ratio",
  "total market",
  String.raw`s&p ?500`,
  String.raw`three.fund|3.fund`,
  "bogle",
  String.raw`\bdca\b`,
  String.raw`dividend (etf|fund|portfolio|yield)`,
  String.raw`\b(voo|vti|vtsax|vxus|vym|vig|vug|vt|spy|qqq|qqqm|schd|schg|jepi|jepq|bnd|agg|avuv|iwm|dia|soxx|smh|splg|ivv|fxaix|swppx)\b`,
].join("|"), "i");

export interface EtfIncomingPost {
  nativeId?: string;
  subreddit: string;
  author: string;
  title: string;
  body: string;
  url: string;
  score: number;
  comments: number;
  publishedAtRaw: string | null;
}

export interface EtfValidatedPost {
  /** Stable source-document ID derived from the canonical Reddit URL. */
  id: string;
  nativeId: string;
  subreddit: string;
  author: string;
  title: string;
  body: string;
  url: string;
  score: number;
  comments: number;
  engagement: number;
  publishedAt: string;
  timestampKind: "published" | "collected";
}

export interface EtfValidatedBatch {
  observedAt: string;
  posts: EtfValidatedPost[];
  skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function clampCount(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1_000_000_000, parsed));
}

export function etfEngagement(score: number, comments: number): number {
  return clampCount(score) + clampCount(comments) * 2;
}

export function normalizeSubreddit(value: string): string {
  return value.replace(/^\/?r\//i, "").trim().toLowerCase();
}

export function normalizeRedditAuthor(value: string): string {
  return value.replace(/^\/?u\//i, "").trim().slice(0, 80);
}

/** ETF relevance gate: r/ETFs is always on-topic, others must mention ETF terms. */
export function isEtfRelevant(subreddit: string, title: string, body: string): boolean {
  if (normalizeSubreddit(subreddit) === "etfs") return true;
  return ETF_TERMS.test(`${title} ${body}`);
}

/**
 * Validates one collector batch fail-open per post: a malformed post is
 * skipped and counted, a malformed batch shape is rejected entirely.
 */
export function validateEtfBatch(value: unknown, fallbackObservedAt = new Date().toISOString()): EtfValidatedBatch {
  if (!isRecord(value)) throw new TypeError("ETF batch must be a JSON object");
  const observedAt = typeof value.observedAt === "string"
    ? requireStrictSourceTimestamp(value.observedAt, "observedAt")
    : requireStrictSourceTimestamp(fallbackObservedAt, "observedAt");
  if (!Array.isArray(value.posts)) throw new TypeError("ETF batch posts must be an array");

  const posts: EtfValidatedPost[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of value.posts.slice(0, ETF_MAX_BATCH_POSTS)) {
    if (!isRecord(item)) {
      skipped += 1;
      continue;
    }
    const title = cleanText(item.title, 500);
    const subreddit = normalizeSubreddit(cleanText(item.subreddit, 80));
    const url = typeof item.url === "string" ? item.url.trim().slice(0, 1_500) : "";
    if (!title || !subreddit || !/^https?:\/\//i.test(url)) {
      skipped += 1;
      continue;
    }
    let identity;
    try {
      identity = deriveSourceIdentity({
        url,
        sourceType: "Reddit",
        source: `r/${subreddit}`,
        nativeId: typeof item.nativeId === "string" ? item.nativeId.replace(/^t3_/i, "").trim() || undefined : undefined,
      });
    } catch {
      skipped += 1;
      continue;
    }
    if (!identity.nativeId || seen.has(identity.sourceDocumentId)) {
      skipped += 1;
      continue;
    }
    seen.add(identity.sourceDocumentId);
    const score = clampCount(item.score);
    const comments = clampCount(item.comments);
    const publishedAtRaw = typeof item.publishedAtRaw === "string" ? item.publishedAtRaw : null;
    const publishedAt = parseStrictSourceTimestamp(publishedAtRaw);
    posts.push({
      id: identity.sourceDocumentId,
      nativeId: identity.nativeId,
      subreddit,
      author: normalizeRedditAuthor(cleanText(item.author, 100)),
      title,
      body: cleanText(item.body, ETF_MAX_BODY_LENGTH),
      url: identity.canonicalUrl,
      score,
      comments,
      engagement: etfEngagement(score, comments),
      publishedAt: publishedAt ?? observedAt,
      timestampKind: publishedAt ? "published" : "collected",
    });
  }
  return { observedAt, posts, skipped };
}

/** Ranks by engagement, then recency, then stable ID order. */
export function selectTopEtfPosts(posts: EtfValidatedPost[], limit = ETF_TOP_PER_HOUR): EtfValidatedPost[] {
  return [...posts]
    .sort((left, right) => right.engagement - left.engagement
      || right.publishedAt.localeCompare(left.publishedAt)
      || left.id.localeCompare(right.id))
    .slice(0, limit);
}

const beijingParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

function partsFor(value: Date): Record<string, string> {
  return Object.fromEntries(beijingParts.formatToParts(value).map((part) => [part.type, part.value]));
}

/** Beijing calendar date, e.g. `2026-09-01`. */
export function etfBeijingDate(value: Date = new Date()): string {
  const parts = partsFor(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Beijing review-hour key, e.g. `2026-09-01 15`. One selection per key. */
export function etfBeijingHourKey(value: Date = new Date()): string {
  const parts = partsFor(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}`;
}

function dateFromBeijingDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+08:00`);
}

export function previousBeijingDate(dateKey: string): string {
  return etfBeijingDate(new Date(dateFromBeijingDate(dateKey).getTime() - 12 * 3_600_000));
}

/** ISO weekday in Beijing: 1 = Monday … 7 = Sunday. */
export function beijingWeekday(dateKey: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" })
    .format(dateFromBeijingDate(dateKey).getTime() + 6 * 3_600_000);
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] ?? 1;
}

export function enumerateBeijingDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate && dates.length < 60) {
    dates.push(cursor);
    cursor = etfBeijingDate(new Date(dateFromBeijingDate(cursor).getTime() + 36 * 3_600_000));
  }
  return dates;
}

export interface EtfWeekPeriod {
  startDate: string;
  endDate: string;
  periodKey: string;
}

/** The most recent complete Beijing Monday-to-Sunday week before `now`. */
export function lastCompletedBeijingWeek(now: Date = new Date()): EtfWeekPeriod {
  const today = etfBeijingDate(now);
  let cursor = previousBeijingDate(today);
  while (beijingWeekday(cursor) !== 7) cursor = previousBeijingDate(cursor);
  const endDate = cursor;
  for (let steps = 0; steps < 6; steps += 1) cursor = previousBeijingDate(cursor);
  return { startDate: cursor, endDate, periodKey: `${cursor}~${endDate}` };
}

/** The UTC window covering one Beijing calendar date. */
export function beijingDateUtcRange(dateKey: string): { startIso: string; endIso: string } {
  const start = dateFromBeijingDate(dateKey);
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 24 * 3_600_000).toISOString(),
  };
}

export interface EtfSelectionItem {
  postId: string;
  rank: number;
  engagement: number;
  score: number;
  comments: number;
  title: string;
  titleZh: string;
  keyPointsZh: string[];
  url: string;
  subreddit: string;
  author: string;
}

export interface EtfDigestTopPost {
  title: string;
  titleZh: string;
  url: string;
  subreddit: string;
  author: string;
  peakEngagement: number;
  keyPointsZh: string[];
}

export interface EtfDigestContent {
  startDate: string;
  endDate: string;
  overviewZh: string;
  topPosts: EtfDigestTopPost[];
  stats: {
    selections: number;
    uniquePosts: number;
    subreddits: Array<{ name: string; posts: number }>;
    topAuthors: Array<{ author: string; posts: number; peakEngagement: number }>;
  };
}

interface DigestSourcePost {
  postId: string;
  title: string;
  titleZh: string;
  url: string;
  subreddit: string;
  author: string;
  peakEngagement: number;
  keyPointsZh: string[];
}

/** Aggregates one period's hourly selections into ranked digest material. */
export function aggregateEtfDigest(
  startDate: string,
  endDate: string,
  selections: Array<{ items: EtfSelectionItem[] }>,
  topLimit: number,
): EtfDigestContent {
  const byPost = new Map<string, DigestSourcePost>();
  for (const selection of selections) {
    for (const item of selection.items) {
      const existing = byPost.get(item.postId);
      if (!existing) {
        byPost.set(item.postId, {
          postId: item.postId,
          title: item.title,
          titleZh: item.titleZh,
          url: item.url,
          subreddit: item.subreddit,
          author: item.author,
          peakEngagement: item.engagement,
          keyPointsZh: item.keyPointsZh,
        });
      } else {
        existing.peakEngagement = Math.max(existing.peakEngagement, item.engagement);
        if (item.keyPointsZh.length > existing.keyPointsZh.length) existing.keyPointsZh = item.keyPointsZh;
        if (item.titleZh && !existing.titleZh) existing.titleZh = item.titleZh;
      }
    }
  }
  const posts = [...byPost.values()].sort((left, right) => right.peakEngagement - left.peakEngagement
    || left.postId.localeCompare(right.postId));

  const subredditCounts = new Map<string, number>();
  const authorStats = new Map<string, { posts: number; peakEngagement: number }>();
  for (const post of posts) {
    subredditCounts.set(post.subreddit, (subredditCounts.get(post.subreddit) ?? 0) + 1);
    if (post.author) {
      const stats = authorStats.get(post.author) ?? { posts: 0, peakEngagement: 0 };
      stats.posts += 1;
      stats.peakEngagement = Math.max(stats.peakEngagement, post.peakEngagement);
      authorStats.set(post.author, stats);
    }
  }

  return {
    startDate,
    endDate,
    overviewZh: "",
    topPosts: posts.slice(0, topLimit).map((post) => ({
      title: post.title,
      titleZh: post.titleZh,
      url: post.url,
      subreddit: post.subreddit,
      author: post.author,
      peakEngagement: post.peakEngagement,
      keyPointsZh: post.keyPointsZh,
    })),
    stats: {
      selections: selections.length,
      uniquePosts: posts.length,
      subreddits: [...subredditCounts.entries()]
        .sort(([, left], [, right]) => right - left)
        .slice(0, 8)
        .map(([name, count]) => ({ name, posts: count })),
      topAuthors: [...authorStats.entries()]
        .sort(([, left], [, right]) => right.peakEngagement - left.peakEngagement)
        .slice(0, 8)
        .map(([author, stats]) => ({ author, posts: stats.posts, peakEngagement: stats.peakEngagement })),
    },
  };
}

/** Rule-based digest overview used whenever the AI overview is unavailable. */
export function deterministicEtfOverview(kind: "daily" | "weekly", content: EtfDigestContent): string {
  const scope = kind === "daily" ? `${content.endDate} 全天` : `${content.startDate} 至 ${content.endDate} 一周`;
  const lead = content.topPosts[0];
  const parts = [
    `${scope}共完成 ${content.stats.selections} 次整点评审，累计追踪 ${content.stats.uniquePosts} 篇 ETF 热门讨论。`,
  ];
  if (lead) {
    parts.push(`热度最高的是 r/${lead.subreddit} 的《${lead.titleZh || lead.title}》，峰值热度 ${lead.peakEngagement}。`);
  }
  if (content.stats.subreddits.length) {
    parts.push(`讨论主要来自 ${content.stats.subreddits.slice(0, 3).map((item) => `r/${item.name}`).join("、")}。`);
  }
  return parts.join("");
}
