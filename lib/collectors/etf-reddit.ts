import type { Browser, Page } from "playwright-core";
import type { CollectorStatus } from "../types";
import { ETF_MAX_BODY_LENGTH, ETF_SUBREDDITS } from "../etf-topics";
import { launchBrowser } from "./browser";
import { collectFirstAvailable, safeCollectorNote } from "./router";

const LISTING_ROWS_PER_SUBREDDIT = 12;
const MAX_TRACKED_REVISITS = 25;

/** Raw collected row; validation and identity derivation happen server-side. */
export interface EtfCollectedRow {
  nativeId: string;
  subreddit: string;
  author: string;
  title: string;
  body: string;
  url: string;
  score: number;
  comments: number;
  publishedAtRaw: string | null;
}

export interface EtfCollectResult {
  posts: EtfCollectedRow[];
  statuses: CollectorStatus[];
}

function parseRedditCount(value: string): number {
  const match = value.replace(/,/g, "").match(/([\d.]+)\s*([km]?)/i);
  if (!match) return 0;
  const multiplier = { k: 1_000, m: 1_000_000 }[match[2].toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

function clampCount(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

interface RedditJsonPost {
  id?: unknown;
  author?: unknown;
  title?: unknown;
  selftext?: unknown;
  permalink?: unknown;
  score?: unknown;
  num_comments?: unknown;
  created_utc?: unknown;
  stickied?: unknown;
}

function rowFromJsonPost(subreddit: string, post: RedditJsonPost): EtfCollectedRow | null {
  const title = typeof post.title === "string" ? post.title.trim() : "";
  const permalink = typeof post.permalink === "string" ? post.permalink : "";
  const nativeId = typeof post.id === "string" ? post.id.trim() : "";
  if (!title || !permalink.startsWith("/") || !nativeId || post.stickied === true) return null;
  const createdUtc = Number(post.created_utc);
  return {
    nativeId,
    subreddit,
    author: typeof post.author === "string" ? post.author : "",
    title,
    body: typeof post.selftext === "string" ? post.selftext.slice(0, ETF_MAX_BODY_LENGTH) : "",
    url: `https://www.reddit.com${permalink}`,
    score: clampCount(post.score),
    comments: clampCount(post.num_comments),
    publishedAtRaw: Number.isFinite(createdUtc) && createdUtc > 0
      ? new Date(createdUtc * 1_000).toISOString()
      : null,
  };
}

async function ensureOrigin(page: Page, host: string): Promise<void> {
  let currentHost = "";
  try {
    currentHost = new URL(page.url()).hostname;
  } catch {
    currentHost = "";
  }
  if (currentHost !== host) {
    await page.goto(`https://${host}/r/${ETF_SUBREDDITS[0]}/hot/`, { waitUntil: "commit", timeout: 12_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  }
}

/**
 * Fetches one subreddit's hot listing through Reddit's JSON API using the
 * browser context's request client, so the call carries the context cookies
 * and user agent without depending on a volatile SPA execution context.
 */
async function fetchListingJson(page: Page, host: string, subreddit: string): Promise<RedditJsonPost[]> {
  const response = await page.context().request.get(
    `https://${host}/r/${subreddit}/hot.json?limit=${LISTING_ROWS_PER_SUBREDDIT}&raw_json=1`,
    { headers: { accept: "application/json" }, timeout: 12_000 },
  );
  if (!response.ok()) throw new Error(`${subreddit} hot.json HTTP ${response.status()}`);
  const payload = await response.json() as { data?: { children?: Array<{ data?: unknown }> } };
  return (payload.data?.children ?? [])
    .map((child) => child?.data ?? null)
    .filter((child): child is RedditJsonPost => Boolean(child) && typeof child === "object");
}

async function collectListingsJson(page: Page, host: "www.reddit.com" | "old.reddit.com"): Promise<EtfCollectedRow[]> {
  // Establish first-party cookies for the request client before the API calls.
  await ensureOrigin(page, host).catch(() => undefined);
  const rows: EtfCollectedRow[] = [];
  let lastError: unknown;
  for (const subreddit of ETF_SUBREDDITS) {
    try {
      const posts = await fetchListingJson(page, host, subreddit);
      for (const post of posts) {
        const row = rowFromJsonPost(subreddit.toLowerCase(), post);
        if (row) rows.push(row);
      }
    } catch (error) {
      // One unreachable subreddit must not drop the other listings.
      lastError = error;
    }
  }
  if (!rows.length && lastError) throw lastError;
  return rows;
}

interface ListingDomRow {
  nativeId: string;
  author: string;
  title: string;
  body: string;
  url: string;
  scoreText: string;
  commentsText: string;
  publishedAtRaw: string;
}

/** DOM fallback for when the JSON API is unavailable to this network path. */
async function collectListingDom(page: Page, subreddit: string): Promise<ListingDomRow[]> {
  await page.goto(`https://www.reddit.com/r/${subreddit}/hot/`, { waitUntil: "commit", timeout: 12_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  await page.locator("shreddit-post").first().waitFor({ state: "attached", timeout: 8_000 }).catch(() => undefined);
  return page.locator("body").evaluate((body, rowLimit) => {
    return Array.from(body.querySelectorAll("shreddit-post")).slice(0, rowLimit).map((node) => {
      const element = node as HTMLElement;
      const href = element.getAttribute("permalink") ?? element.getAttribute("content-href") ?? "";
      const bodyElement = element.querySelector<HTMLElement>(
        "[slot='text-body'], shreddit-post-text-body, [data-post-click-location='text-body']",
      );
      return {
        nativeId: (element.getAttribute("post-id") ?? element.id ?? "").replace(/^t3_/i, ""),
        author: element.getAttribute("author") ?? "",
        title: element.getAttribute("post-title") ?? element.querySelector("h3")?.textContent?.trim() ?? "",
        body: bodyElement?.innerText?.trim() ?? "",
        url: href.startsWith("http") ? href : href ? `${location.origin}${href}` : "",
        scoreText: element.getAttribute("score") ?? "",
        commentsText: element.getAttribute("comment-count") ?? "",
        publishedAtRaw: element.getAttribute("created-timestamp") ?? "",
      };
    }).filter((row) => row.title && row.url);
  }, LISTING_ROWS_PER_SUBREDDIT);
}

async function collectListingsDom(page: Page): Promise<EtfCollectedRow[]> {
  const rows: EtfCollectedRow[] = [];
  let lastError: unknown;
  for (const subreddit of ETF_SUBREDDITS) {
    try {
      const listing = await collectListingDom(page, subreddit);
      rows.push(...listing.map((row) => ({
        nativeId: row.nativeId,
        subreddit: subreddit.toLowerCase(),
        author: row.author,
        title: row.title,
        body: row.body.slice(0, ETF_MAX_BODY_LENGTH),
        url: row.url,
        score: parseRedditCount(row.scoreText),
        comments: parseRedditCount(row.commentsText),
        publishedAtRaw: row.publishedAtRaw.trim() || null,
      })));
    } catch (error) {
      // One unreachable subreddit must not drop the other listings.
      lastError = error;
    }
  }
  if (!rows.length && lastError) throw lastError;
  return rows;
}

function redditPathname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)reddit\.com$/i.test(parsed.hostname)) return null;
    return parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  } catch {
    return null;
  }
}

function subredditFromPath(pathname: string): string {
  return pathname.match(/\/r\/([^/]+)\//i)?.[1]?.toLowerCase() ?? "etfs";
}

/** Re-observes one tracked post through its permalink JSON document. */
async function revisitTrackedPost(page: Page, url: string): Promise<EtfCollectedRow | null> {
  const pathname = redditPathname(url);
  if (!pathname) return null;
  const response = await page.context().request.get(
    `https://www.reddit.com${pathname.replace(/\/$/, "")}.json?raw_json=1`,
    { headers: { accept: "application/json" }, timeout: 12_000 },
  );
  if (!response.ok()) throw new Error(`permalink JSON HTTP ${response.status()}`);
  const payload = await response.json() as Array<{ data?: { children?: Array<{ data?: unknown }> } }>;
  const post = payload?.[0]?.data?.children?.[0]?.data ?? null;
  if (!post || typeof post !== "object") return null;
  const row = rowFromJsonPost(subredditFromPath(pathname), post as RedditJsonPost);
  return row ? { ...row, url } : null;
}

/**
 * Collects the hourly ETF review batch: hot listings from the ETF subreddits
 * plus fresh observations for already-tracked posts that fell out of the hot
 * pages, so their 24-hour engagement history keeps updating. The JSON API is
 * preferred (exact counts, full self-text, ISO timestamps); shreddit DOM
 * scraping remains as the fallback when JSON is blocked on a network path.
 */
export async function collectEtfRedditPosts(trackedUrls: string[] = []): Promise<EtfCollectResult> {
  let browser: Browser | undefined;
  const posts: EtfCollectedRow[] = [];
  const statuses: CollectorStatus[] = [];
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "Asia/Shanghai",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    const listings = await collectFirstAvailable("ETF Reddit", [
      { name: "Reddit JSON · 主站", collect: () => collectListingsJson(page, "www.reddit.com") },
      { name: "Reddit JSON · 旧版", collect: () => collectListingsJson(page, "old.reddit.com") },
      { name: "Playwright · Reddit 主站 DOM", collect: () => collectListingsDom(page) },
    ]);
    posts.push(...listings.items);
    statuses.push(listings.status);

    const listedPaths = new Set(posts.map((post) => redditPathname(post.url)).filter(Boolean));
    const revisitTargets = trackedUrls
      .filter((url) => {
        const pathname = redditPathname(url);
        return pathname !== null && !listedPaths.has(pathname);
      })
      .slice(0, MAX_TRACKED_REVISITS);
    let revisited = 0;
    for (const url of revisitTargets) {
      try {
        const row = await revisitTrackedPost(page, url);
        if (row) {
          posts.push(row);
          revisited += 1;
        }
      } catch {
        // A deleted or unreachable tracked post simply misses this hour's observation.
      }
    }
    if (revisitTargets.length) {
      statuses.push({
        name: "ETF 追踪回访",
        channel: "ETF Reddit",
        backend: "Reddit JSON · 帖子回访",
        ok: revisited > 0,
        count: revisited,
        note: revisited < revisitTargets.length ? `${revisitTargets.length - revisited} 篇追踪帖本轮未取得更新` : undefined,
      });
    }
  } catch (error) {
    statuses.push({
      name: "ETF Reddit runtime",
      channel: "ETF Reddit",
      backend: "Playwright",
      ok: false,
      count: 0,
      note: safeCollectorNote(error),
    });
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return { posts, statuses };
}
