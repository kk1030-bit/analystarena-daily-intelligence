import type { CollectorStatus } from "./types";
import {
  ETF_SUBREDDITS,
  rowFromRedditJsonPost,
  type EtfIncomingPost,
  type RedditJsonPost,
} from "./etf-topics";
import { collectFirstAvailable } from "./collectors/router";

const USER_AGENT = "web:analystarena-etf-topics:v1.0 (research digest; contact via repository)";
const LISTING_LIMIT = 12;
const MAX_REVISITS = 25;
const REQUEST_TIMEOUT_MS = 12_000;

export interface EtfServerCollectResult {
  posts: EtfIncomingPost[];
  status: CollectorStatus;
  revisitStatus?: CollectorStatus;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

declare global {
  var __analystArenaRedditOauthToken: CachedToken | undefined;
}

function oauthConfigured(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname} HTTP ${response.status}`);
  return response.json();
}

/** Application-only OAuth token for Reddit's sanctioned data API. */
async function redditOauthToken(): Promise<string> {
  const cached = globalThis.__analystArenaRedditOauthToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Reddit OAuth token HTTP ${response.status}`);
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Reddit OAuth token response is missing access_token");
  }
  const expiresIn = Number(payload.expires_in);
  const token: CachedToken = {
    token: payload.access_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3_000) * 1_000,
  };
  globalThis.__analystArenaRedditOauthToken = token;
  return token.token;
}

function listingChildren(payload: unknown): RedditJsonPost[] {
  const data = (payload as { data?: { children?: Array<{ data?: unknown }> } })?.data;
  return (data?.children ?? [])
    .map((child) => child?.data ?? null)
    .filter((child): child is RedditJsonPost => Boolean(child) && typeof child === "object");
}

type ListingFetcher = (subreddit: string) => Promise<unknown>;

async function collectListings(fetchListing: ListingFetcher): Promise<EtfIncomingPost[]> {
  const rows: EtfIncomingPost[] = [];
  let lastError: unknown;
  for (const subreddit of ETF_SUBREDDITS) {
    try {
      for (const post of listingChildren(await fetchListing(subreddit))) {
        const row = rowFromRedditJsonPost(subreddit.toLowerCase(), post);
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

function redditPathname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)reddit\.com$/i.test(parsed.hostname)) return null;
    return parsed.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function subredditFromPath(pathname: string): string {
  return pathname.match(/\/r\/([^/]+)\//i)?.[1]?.toLowerCase() ?? "etfs";
}

async function revisitPermalink(url: string, useOauth: boolean): Promise<EtfIncomingPost | null> {
  const pathname = redditPathname(url);
  if (!pathname) return null;
  const payload = useOauth
    ? await fetchJson(`https://oauth.reddit.com${pathname}?raw_json=1`, {
        authorization: `Bearer ${await redditOauthToken()}`,
      })
    : await fetchJson(`https://www.reddit.com${pathname}.json?raw_json=1`, {});
  const post = (payload as Array<{ data?: { children?: Array<{ data?: unknown }> } }>)?.[0]?.data?.children?.[0]?.data;
  if (!post || typeof post !== "object") return null;
  const row = rowFromRedditJsonPost(subredditFromPath(`${pathname}/`), post as RedditJsonPost);
  return row ? { ...row, url } : null;
}

/**
 * Server-side ETF Reddit collection, used when the GitHub Actions batch
 * arrives empty (Reddit blocks that network path). The sanctioned OAuth API
 * is preferred when `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are configured;
 * the public JSON listings are the fallback. Credentials never enter logs.
 */
export async function collectEtfServerSide(trackedUrls: string[] = []): Promise<EtfServerCollectResult> {
  const backends: Array<{ name: string; collect: () => Promise<EtfIncomingPost[]> }> = [];
  if (oauthConfigured()) {
    backends.push({
      name: "Reddit OAuth API",
      collect: () => collectListings(async (subreddit) => fetchJson(
        `https://oauth.reddit.com/r/${subreddit}/hot?limit=${LISTING_LIMIT}&raw_json=1`,
        { authorization: `Bearer ${await redditOauthToken()}` },
      )),
    });
  }
  backends.push(
    {
      name: "Reddit 公开 JSON · 主站",
      collect: () => collectListings((subreddit) => fetchJson(
        `https://www.reddit.com/r/${subreddit}/hot.json?limit=${LISTING_LIMIT}&raw_json=1`,
        {},
      )),
    },
    {
      name: "Reddit 公开 JSON · 旧版",
      collect: () => collectListings((subreddit) => fetchJson(
        `https://old.reddit.com/r/${subreddit}/hot.json?limit=${LISTING_LIMIT}&raw_json=1`,
        {},
      )),
    },
  );

  const listings = await collectFirstAvailable("ETF Reddit · 服务器", backends);
  const posts = [...listings.items];
  const useOauth = listings.status.backend === "Reddit OAuth API";

  let revisitStatus: CollectorStatus | undefined;
  if (listings.status.ok && trackedUrls.length) {
    const listedPaths = new Set(posts.map((post) => redditPathname(post.url)).filter(Boolean));
    const targets = trackedUrls
      .filter((url) => {
        const pathname = redditPathname(url);
        return pathname !== null && !listedPaths.has(pathname);
      })
      .slice(0, MAX_REVISITS);
    let revisited = 0;
    for (const url of targets) {
      try {
        const row = await revisitPermalink(url, useOauth);
        if (row) {
          posts.push(row);
          revisited += 1;
        }
      } catch {
        // A deleted or unreachable tracked post simply misses this hour's observation.
      }
    }
    if (targets.length) {
      revisitStatus = {
        name: "ETF 追踪回访 · 服务器",
        channel: "ETF Reddit",
        backend: useOauth ? "Reddit OAuth API" : "Reddit 公开 JSON",
        ok: revisited > 0,
        count: revisited,
        note: revisited < targets.length ? `${targets.length - revisited} 篇追踪帖本轮未取得更新` : undefined,
      };
    }
  }

  return { posts, status: listings.status, revisitStatus };
}
