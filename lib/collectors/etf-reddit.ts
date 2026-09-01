import type { Browser, Page } from "playwright-core";
import type { CollectorStatus } from "../types";
import { ETF_SUBREDDITS } from "../etf-topics";
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

interface ListingRow {
  nativeId: string;
  author: string;
  title: string;
  body: string;
  url: string;
  scoreText: string;
  commentsText: string;
  publishedAtRaw: string;
}

async function collectListing(page: Page, host: "old.reddit.com" | "www.reddit.com", subreddit: string): Promise<ListingRow[]> {
  await page.goto(`https://${host}/r/${subreddit}/hot/`, { waitUntil: "commit", timeout: 12_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  return page.locator("body").evaluate((body, rowLimit) => {
    const legacy = Array.from(body.querySelectorAll(".thing.link")).slice(0, rowLimit).map((node) => {
      const title = node.querySelector<HTMLAnchorElement>("a.title");
      const comments = node.querySelector<HTMLAnchorElement>("a.comments");
      const score = node.querySelector<HTMLElement>(".score.unvoted");
      const time = node.querySelector<HTMLTimeElement>("time");
      const bodyElement = node.querySelector<HTMLElement>(".usertext-body .md");
      return {
        nativeId: (node.getAttribute("data-fullname") ?? "").replace(/^t3_/i, ""),
        author: node.getAttribute("data-author") ?? "",
        title: title?.textContent?.trim() ?? "",
        body: bodyElement?.innerText?.trim() ?? "",
        url: comments?.href ?? title?.href ?? "",
        scoreText: score?.getAttribute("title") ?? score?.textContent ?? "",
        commentsText: comments?.textContent ?? "",
        publishedAtRaw: time?.dateTime ?? "",
      };
    }).filter((row) => row.title && row.url);
    if (legacy.length) return legacy;
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

function rowFromListing(subreddit: string, row: ListingRow): EtfCollectedRow {
  return {
    nativeId: row.nativeId,
    subreddit,
    author: row.author,
    title: row.title,
    body: row.body,
    url: row.url,
    score: parseRedditCount(row.scoreText),
    comments: parseRedditCount(row.commentsText),
    publishedAtRaw: row.publishedAtRaw.trim() || null,
  };
}

async function collectListings(page: Page, host: "old.reddit.com" | "www.reddit.com"): Promise<EtfCollectedRow[]> {
  const rows: EtfCollectedRow[] = [];
  for (const subreddit of ETF_SUBREDDITS) {
    try {
      const listing = await collectListing(page, host, subreddit);
      rows.push(...listing.map((row) => rowFromListing(subreddit.toLowerCase(), row)));
    } catch {
      // One unreachable subreddit must not drop the other listings.
    }
  }
  return rows;
}

function toOldRedditUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)reddit\.com$/i.test(parsed.hostname) && parsed.hostname.toLowerCase() !== "redd.it") return null;
    parsed.hostname = "old.reddit.com";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function subredditFromUrl(url: string): string {
  return url.match(/\/r\/([^/]+)\//i)?.[1]?.toLowerCase() ?? "etfs";
}

/** Re-observes one tracked post on its old.reddit permalink page. */
async function revisitTrackedPost(page: Page, url: string): Promise<EtfCollectedRow | null> {
  const oldUrl = toOldRedditUrl(url);
  if (!oldUrl) return null;
  await page.goto(oldUrl, { waitUntil: "commit", timeout: 12_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  const row = await page.locator("body").evaluate((body) => {
    const node = body.querySelector("#siteTable .thing.link") ?? body.querySelector(".thing.link");
    if (!node) return null;
    const title = node.querySelector<HTMLAnchorElement>("a.title");
    const comments = node.querySelector<HTMLAnchorElement>("a.comments");
    const score = node.querySelector<HTMLElement>(".score.unvoted");
    const time = node.querySelector<HTMLTimeElement>("time");
    const bodyElement = node.querySelector<HTMLElement>(".usertext-body .md");
    return {
      nativeId: (node.getAttribute("data-fullname") ?? "").replace(/^t3_/i, ""),
      author: node.getAttribute("data-author") ?? "",
      title: title?.textContent?.trim() ?? "",
      body: bodyElement?.innerText?.trim() ?? "",
      url: comments?.href ?? title?.href ?? "",
      scoreText: score?.getAttribute("title") ?? score?.textContent ?? "",
      commentsText: comments?.textContent ?? "",
      publishedAtRaw: time?.dateTime ?? "",
    };
  });
  if (!row || !row.title) return null;
  return rowFromListing(subredditFromUrl(oldUrl), { ...row, url });
}

/**
 * Collects the hourly ETF review batch: hot listings from the ETF subreddits
 * plus fresh observations for already-tracked posts that fell out of the hot
 * pages, so their 24-hour engagement history keeps updating.
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
      { name: "Playwright · Reddit 旧版", collect: () => collectListings(page, "old.reddit.com") },
      { name: "Playwright · Reddit 主站", collect: () => collectListings(page, "www.reddit.com") },
    ]);
    posts.push(...listings.items);
    statuses.push(listings.status);

    const listedUrls = new Set(posts.map((post) => post.url.replace(/^https?:\/\/[^/]+/i, "")));
    const revisitTargets = trackedUrls
      .filter((url) => !listedUrls.has(url.replace(/^https?:\/\/[^/]+/i, "")))
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
        backend: "Playwright · 帖子回访",
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
