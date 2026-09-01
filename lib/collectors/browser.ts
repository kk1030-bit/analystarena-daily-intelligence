import { existsSync } from "node:fs";
import { chromium as playwrightChromium, type Browser, type Page } from "playwright-core";
import serverlessChromium from "@sparticuz/chromium";
import type {
  CollectorStatus,
  EvidenceLocator,
  RawStory,
  SourceCapture,
  SourceEvidence,
} from "../types";
import { createSourceEvidence } from "../source-evidence";
import { ensureRawStoryIdentity, hashSourceContent } from "../source-identity";
import { parseStrictSourceTimestamp, requireStrictSourceTimestamp } from "../source-time";
import { collectFirstAvailable, safeCollectorNote } from "./router";

const redditCommunities = ["stocks", "investing", "SecurityAnalysis", "MachineLearning"];
const xQueries = ["Nvidia", "OpenAI", "FOMC", "TSMC", "semiconductor", "AI capex"];
const SOCIAL_EXTRACTOR_VERSION = "playwright-social-v2";
const DOM_EXTRACTION_METHOD = "playwright_dom_innerText_trim_v1";

export interface RedditCollectedRow {
  title: string;
  body: string | null;
  url: string;
  nativeId: string;
  comments: string;
  score: string;
  publishedAt: string;
  publishedAtField?: string;
}

export interface XCollectedRow {
  text: string;
  link: string;
  publishedAt: string;
  publishedAtField?: string;
  metricText: string;
}

export interface SocialTimestamp {
  /** Compatibility value for existing ranking code; consult timestampKind before displaying it. */
  publishedAt: string;
  /** A publisher/platform timestamp only. Never contains the collection-time fallback. */
  originalPublishedAt: string | null;
  collectedAt: string;
  timestampKind: "published" | "collected";
}

function numberFromLabel(value: string): number {
  const match = value.replace(/,/g, "").match(/([\d.]+)\s*([KMB]?)/i);
  if (!match) return 0;
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2].toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

/**
 * Keeps a missing/invalid platform timestamp distinguishable from collection time.
 * `publishedAt` retains the legacy fallback only because RawStory still requires it.
 */
export function resolveSocialTimestamp(value: string, collectedAt = new Date().toISOString()): SocialTimestamp {
  const collectedIso = requireStrictSourceTimestamp(collectedAt, "collection timestamp");
  const originalPublishedAt = parseStrictSourceTimestamp(value);

  return originalPublishedAt
    ? {
        publishedAt: originalPublishedAt,
        originalPublishedAt,
        collectedAt: collectedIso,
        timestampKind: "published",
      }
    : {
        publishedAt: collectedIso,
        originalPublishedAt: null,
        collectedAt: collectedIso,
        timestampKind: "collected",
      };
}

function evidenceForQuote(
  story: RawStory,
  anchorKey: string,
  quoteOriginal: string,
  locator: EvidenceLocator,
  captureScope: "reddit_post" | "x_post",
  capturedAt: string,
): SourceEvidence {
  const sourceDocumentId = story.sourceDocumentId;
  if (!sourceDocumentId) throw new TypeError("A source document ID is required before evidence can be created");
  return createSourceEvidence({
    sourceDocumentId,
    anchorKey,
    quoteOriginal,
    locator,
    locatorStatus: "exact",
    directness: "direct",
    captureScope,
    extractionMethod: DOM_EXTRACTION_METHOD,
    extractorVersion: SOCIAL_EXTRACTOR_VERSION,
    capturedAt,
  });
}

function unavailableEvidence(
  story: RawStory,
  anchorKey: string,
  capturedAt: string,
): SourceEvidence {
  const sourceDocumentId = story.sourceDocumentId;
  if (!sourceDocumentId) throw new TypeError("A source document ID is required before evidence can be created");
  const locator: EvidenceLocator = {
    kind: "unavailable",
    reasonCode: "body_not_collected",
    detail: "Reddit listing DOM did not expose non-empty post body text at collection time.",
  };
  return createSourceEvidence({
    sourceDocumentId,
    anchorKey,
    locator,
    locatorStatus: "unavailable",
    directness: "unavailable",
    captureScope: "reddit_post",
    extractionMethod: DOM_EXTRACTION_METHOD,
    extractorVersion: SOCIAL_EXTRACTOR_VERSION,
    capturedAt,
  });
}

function captureForStory(
  story: RawStory,
  rawUrl: string,
  capturedText: string,
  capturedFields: Array<[string, string]>,
  timestamp: SocialTimestamp,
  publishedAtRaw: string,
  publishedAtField: string | undefined,
  scope: "reddit_post" | "x_post",
): SourceCapture {
  const capturedArtifact = JSON.stringify([
    "social-capture",
    2,
    scope,
    rawUrl,
    story.nativeId ?? null,
    publishedAtRaw || null,
    publishedAtField ?? null,
    timestamp.originalPublishedAt,
    ...capturedFields,
  ]);
  return {
    rawUrl,
    canonicalUrl: story.canonicalUrl,
    originalPublishedAt: timestamp.originalPublishedAt,
    ...(publishedAtRaw.trim() ? { publishedAtRaw } : {}),
    ...(publishedAtField ? { publishedAtField } : {}),
    collectedAt: timestamp.collectedAt,
    scope,
    capturedContentHash: hashSourceContent(capturedArtifact),
    capturedArtifact,
    capturedArtifactEncoding: "utf8",
    capturedArtifactSizeBytes: Buffer.byteLength(capturedArtifact, "utf8"),
    capturedTextHash: hashSourceContent(capturedText),
    extractionMethod: DOM_EXTRACTION_METHOD,
    extractorVersion: SOCIAL_EXTRACTOR_VERSION,
    backfillQuality: "native",
  };
}

function truncateDisplayText(value: string, maxCodePoints: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= maxCodePoints ? value : codePoints.slice(0, maxCodePoints).join("");
}

/** Builds a Reddit record whose factual fields contain only text observed in the DOM. */
export function buildRedditStory(
  community: string,
  row: RedditCollectedRow,
  collectedAt = new Date().toISOString(),
): RawStory | null {
  const title = row.title.trim();
  const body = row.body?.trim() || null;
  if (!title || !row.url) return null;

  const timestamp = resolveSocialTimestamp(row.publishedAt, collectedAt);
  const engagement = numberFromLabel(row.score) + numberFromLabel(row.comments) * 2;
  const identified = ensureRawStoryIdentity({
    id: row.url,
    nativeId: row.nativeId.trim() || undefined,
    title,
    originalTitle: title,
    description: body ?? "",
    originalDescription: body ?? "",
    url: row.url,
    publishedAt: timestamp.publishedAt,
    originalPublishedAt: timestamp.originalPublishedAt,
    ...(row.publishedAt.trim() ? { publishedAtRaw: row.publishedAt } : {}),
    ...(row.publishedAtField ? { publishedAtField: row.publishedAtField } : {}),
    source: `r/${community}`,
    sourceType: "Reddit",
    engagement,
    collectedAt: timestamp.collectedAt,
    timestampKind: timestamp.timestampKind,
  });
  const postId = identified.nativeId;
  if (!postId) return null;

  const capturedText = body ? `${title}\n\n${body}` : title;
  const capturedFields: Array<[string, string]> = [["title", title]];
  if (body) capturedFields.push(["body", body]);
  const capture = captureForStory(
    identified,
    row.url,
    capturedText,
    capturedFields,
    timestamp,
    row.publishedAt,
    row.publishedAtField,
    "reddit_post",
  );
  const titleEvidence = evidenceForQuote(
    identified,
    "reddit:title",
    title,
    { kind: "reddit_post_field", postId, field: "title" },
    "reddit_post",
    timestamp.collectedAt,
  );
  const bodyEvidence = body
    ? evidenceForQuote(
        identified,
        "reddit:body",
        body,
        { kind: "reddit_post_field", postId, field: "body" },
        "reddit_post",
        timestamp.collectedAt,
      )
    : unavailableEvidence(identified, "reddit:body", timestamp.collectedAt);

  return ensureRawStoryIdentity({ ...identified, capture, evidence: [titleEvidence, bodyEvidence] });
}

/** Builds an X record while retaining the complete tweet as evidence and source content. */
export function buildXStory(
  query: string,
  row: XCollectedRow,
  collectedAt = new Date().toISOString(),
): RawStory | null {
  const text = row.text.trim();
  if (!text || !row.link) return null;

  const timestamp = resolveSocialTimestamp(row.publishedAt, collectedAt);
  const identified = ensureRawStoryIdentity({
    id: row.link,
    title: truncateDisplayText(text, 180),
    originalTitle: text,
    description: text,
    originalDescription: text,
    url: row.link,
    publishedAt: timestamp.publishedAt,
    originalPublishedAt: timestamp.originalPublishedAt,
    ...(row.publishedAt.trim() ? { publishedAtRaw: row.publishedAt } : {}),
    ...(row.publishedAtField ? { publishedAtField: row.publishedAtField } : {}),
    source: `X · ${query}`,
    sourceType: "X",
    engagement: numberFromLabel(row.metricText),
    collectedAt: timestamp.collectedAt,
    timestampKind: timestamp.timestampKind,
  });
  const statusId = identified.nativeId;
  if (!statusId) return null;

  const capture = captureForStory(
    identified,
    row.link,
    text,
    [["text", text]],
    timestamp,
    row.publishedAt,
    row.publishedAtField,
    "x_post",
  );
  const textEvidence = evidenceForQuote(
    identified,
    "x:text",
    text,
    { kind: "x_post_field", statusId, field: "text" },
    "x_post",
    timestamp.collectedAt,
  );

  return ensureRawStoryIdentity({ ...identified, capture, evidence: [textEvidence] });
}

async function executablePath(): Promise<string> {
  const configured = process.env.CHROME_PATH;
  if (configured && existsSync(configured)) return configured;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    const installed = candidates.find((candidate) => existsSync(candidate));
    if (installed) return installed;
  }
  return serverlessChromium.executablePath();
}

export async function launchBrowser(): Promise<Browser> {
  return playwrightChromium.launch({
    executablePath: await executablePath(),
    headless: true,
    args: [...serverlessChromium.args, "--disable-dev-shm-usage", "--no-sandbox"],
  });
}

async function collectReddit(page: Page, host: "www.reddit.com" | "old.reddit.com"): Promise<RawStory[]> {
  const stories: RawStory[] = [];
  const isRender = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  const communitiesForRun = isRender ? redditCommunities.slice(0, 1) : redditCommunities;
  for (const community of communitiesForRun) {
    let rows: RedditCollectedRow[] = [];
    try {
      await page.goto(`https://${host}/r/${community}/hot/`, { waitUntil: "commit", timeout: isRender ? 7_000 : 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: isRender ? 2_000 : 5_000 }).catch(() => undefined);
      rows = await page.locator("body").evaluate((body) => {
        const modern = Array.from(body.querySelectorAll("shreddit-post")).slice(0, 8).map((node) => {
          const element = node as HTMLElement;
          const title = element.getAttribute("post-title") ?? element.querySelector("h3")?.textContent?.trim() ?? "";
          const href = element.getAttribute("permalink")
            ?? element.querySelector<HTMLAnchorElement>("a[slot='full-post-link']")?.href
            ?? element.getAttribute("content-href")
            ?? "";
          const bodyElement = element.querySelector<HTMLElement>(
            "[slot='text-body'], shreddit-post-text-body, [data-post-click-location='text-body']",
          );
          const bodyText = bodyElement?.innerText?.trim();
          const publishedAt = element.getAttribute("created-timestamp") ?? "";
          return {
            title,
            body: bodyText || null,
            url: href.startsWith("http") ? href : `${location.origin}${href}`,
            nativeId: (element.getAttribute("post-id") ?? element.id ?? "").replace(/^t3_/i, ""),
            comments: element.getAttribute("comment-count") ?? "",
            score: element.getAttribute("score") ?? "",
            publishedAt,
            publishedAtField: publishedAt ? "created-timestamp" : undefined,
          };
        });
        if (modern.length) return modern;
        return Array.from(body.querySelectorAll(".thing.link")).slice(0, 8).map((node) => {
          const title = node.querySelector<HTMLAnchorElement>("a.title");
          const comments = node.querySelector<HTMLAnchorElement>("a.comments");
          const score = node.querySelector<HTMLElement>(".score.unvoted");
          const time = node.querySelector<HTMLTimeElement>("time");
          const bodyElement = node.querySelector<HTMLElement>(".usertext-body .md");
          const bodyText = bodyElement?.innerText?.trim();
          const publishedAt = time?.dateTime ?? "";
          return {
            title: title?.textContent?.trim() ?? "",
            body: bodyText || null,
            url: comments?.href ?? title?.href ?? "",
            nativeId: (node.getAttribute("data-fullname") ?? "").replace(/^t3_/i, ""),
            comments: comments?.textContent ?? "",
            score: score?.getAttribute("title") ?? score?.textContent ?? "",
            publishedAt,
            publishedAtField: publishedAt ? "time[datetime]" : undefined,
          };
        });
      });
    } catch {
      // Continue with the remaining communities; the route-level fallback will
      // try another Reddit surface when this backend yields no usable rows.
    }

    for (const row of rows) {
      try {
        const story = buildRedditStory(community, row);
        if (story) stories.push(story);
      } catch {
        // A malformed individual listing row must not discard other valid posts.
      }
    }
  }
  return stories;
}

async function collectX(page: Page): Promise<RawStory[]> {
  if (!process.env.X_AUTH_TOKEN) return [];
  await page.context().addCookies([{
    name: "auth_token",
    value: process.env.X_AUTH_TOKEN,
    domain: ".x.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  }]);

  const stories: RawStory[] = [];
  for (const query of xQueries) {
    try {
      const url = `https://x.com/search?q=${encodeURIComponent(`${query} lang:en -is:reply`)}&src=typed_query&f=live`;
      await page.goto(url, { waitUntil: "commit", timeout: 12_000 });
      await page.locator("article[data-testid='tweet']").first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
      const tweets: XCollectedRow[] = await page.locator("article[data-testid='tweet']").evaluateAll((nodes) => nodes.slice(0, 5).map((node) => {
        const text = node.querySelector<HTMLElement>("[data-testid='tweetText']")?.innerText?.trim() ?? "";
        const time = node.querySelector<HTMLTimeElement>("time");
        const link = time?.closest<HTMLAnchorElement>("a")?.href ?? "";
        const metricText = Array.from(node.querySelectorAll<HTMLElement>("[role='group'] [data-testid]"))
          .map((element) => element.getAttribute("aria-label") ?? element.textContent ?? "")
          .join(" ");
        const publishedAt = time?.dateTime ?? "";
        return {
          text,
          link,
          publishedAt,
          publishedAtField: publishedAt ? "time[datetime]" : undefined,
          metricText,
        };
      }));

      for (const tweet of tweets) {
        try {
          const story = buildXStory(query, tweet);
          if (story) stories.push(story);
        } catch {
          // Continue when X emits an incomplete or malformed individual post row.
        }
      }
    } catch {
      // Continue with remaining tracked queries when an individual search is blocked.
    }
  }
  return stories;
}

export async function collectBrowserStories(): Promise<{ stories: RawStory[]; statuses: CollectorStatus[] }> {
  let browser: Browser | undefined;
  const stories: RawStory[] = [];
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

    const reddit = await collectFirstAvailable("Reddit", [
      { name: "Playwright · Reddit 主站", collect: () => collectReddit(page, "www.reddit.com") },
      { name: "Playwright · Reddit 旧版", collect: () => collectReddit(page, "old.reddit.com") },
    ]);
    stories.push(...reddit.items);
    statuses.push(reddit.status);

    const x = await collectFirstAvailable("X", [{
      name: "Playwright · X 登录态",
      collect: () => process.env.X_AUTH_TOKEN
        ? collectX(page)
        : Promise.reject(new Error("未配置 X 登录凭证，已跳过需要登录的搜索")),
    }]);
    stories.push(...x.items);
    statuses.push(x.status);
  } catch (error) {
    statuses.push({ name: "Browser runtime", channel: "Browser", backend: "Playwright", ok: false, count: 0, note: safeCollectorNote(error) });
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return { stories, statuses };
}
