import { existsSync } from "node:fs";
import { chromium as playwrightChromium, type Browser, type Page } from "playwright-core";
import serverlessChromium from "@sparticuz/chromium";
import type { CollectorStatus, RawStory } from "../types";
import { collectFirstAvailable, safeCollectorNote } from "./router";

const redditCommunities = ["stocks", "investing", "SecurityAnalysis", "MachineLearning"];
const xQueries = ["Nvidia", "OpenAI", "FOMC", "TSMC", "semiconductor", "AI capex"];

function idFor(value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

function numberFromLabel(value: string): number {
  const match = value.replace(/,/g, "").match(/([\d.]+)\s*([KMB]?)/i);
  if (!match) return 0;
  const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2].toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

function preciseTimestamp(value: string): { publishedAt: string; collectedAt: string; timestampKind: "published" | "collected" } {
  const collectedAt = new Date().toISOString();
  const publishedAt = new Date(value);
  return Number.isNaN(publishedAt.valueOf())
    ? { publishedAt: collectedAt, collectedAt, timestampKind: "collected" }
    : { publishedAt: publishedAt.toISOString(), collectedAt, timestampKind: "published" };
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

async function launchBrowser(): Promise<Browser> {
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
    let rows: Array<{ title: string; url: string; comments: string; score: string; publishedAt: string }> = [];
    try {
      await page.goto(`https://${host}/r/${community}/hot/`, { waitUntil: "commit", timeout: isRender ? 7_000 : 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: isRender ? 2_000 : 5_000 }).catch(() => undefined);
      rows = await page.locator("body").evaluate((body) => {
          const modern = Array.from(body.querySelectorAll("shreddit-post")).slice(0, 8).map((node) => {
            const element = node as HTMLElement;
            const title = element.getAttribute("post-title") ?? element.querySelector("h3")?.textContent?.trim() ?? "";
            const href = element.getAttribute("content-href") ?? element.querySelector<HTMLAnchorElement>("a[slot='full-post-link']")?.href ?? "";
            return {
              title,
              url: href.startsWith("http") ? href : `${location.origin}${href}`,
              comments: element.getAttribute("comment-count") ?? "",
              score: element.getAttribute("score") ?? "",
              publishedAt: element.getAttribute("created-timestamp") ?? "",
            };
          });
          if (modern.length) return modern;
          return Array.from(body.querySelectorAll(".thing.link")).slice(0, 8).map((node) => {
            const title = node.querySelector<HTMLAnchorElement>("a.title");
            const comments = node.querySelector<HTMLAnchorElement>("a.comments");
            const score = node.querySelector<HTMLElement>(".score.unvoted");
            const time = node.querySelector<HTMLTimeElement>("time");
            return {
              title: title?.textContent?.trim() ?? "",
              url: title?.href ?? "",
              comments: comments?.textContent ?? "",
              score: score?.getAttribute("title") ?? score?.textContent ?? "",
              publishedAt: time?.dateTime ?? "",
            };
          });
      });
    } catch {
      // Continue with the remaining communities; the route-level fallback will
      // try another Reddit surface when this backend yields no usable rows.
    }

    for (const row of rows) {
      if (!row.title || !row.url) continue;
      const engagement = numberFromLabel(row.score) + numberFromLabel(row.comments) * 2;
      const timestamp = preciseTimestamp(row.publishedAt);
      stories.push({
        id: idFor(`reddit:${community}:${row.title}`),
        title: row.title,
        description: `Reddit r/${community} 热门讨论，互动指标 ${engagement}。`,
        url: row.url,
        publishedAt: timestamp.publishedAt,
        source: `r/${community}`,
        sourceType: "Reddit",
        engagement,
        collectedAt: timestamp.collectedAt,
        timestampKind: timestamp.timestampKind,
      });
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
      const tweets = await page.locator("article[data-testid='tweet']").evaluateAll((nodes) => nodes.slice(0, 5).map((node) => {
      const text = node.querySelector<HTMLElement>("[data-testid='tweetText']")?.innerText?.trim() ?? "";
      const time = node.querySelector<HTMLTimeElement>("time");
      const link = time?.closest<HTMLAnchorElement>("a")?.href ?? "";
      const metricText = Array.from(node.querySelectorAll<HTMLElement>("[role='group'] [data-testid]"))
        .map((element) => element.getAttribute("aria-label") ?? element.textContent ?? "")
        .join(" ");
      return { text, link, publishedAt: time?.dateTime ?? "", metricText };
      }));

      for (const tweet of tweets) {
        if (!tweet.text || !tweet.link) continue;
        const timestamp = preciseTimestamp(tweet.publishedAt);
        stories.push({
          id: idFor(`x:${tweet.link}`),
          title: tweet.text.slice(0, 180),
          description: `X 实时搜索“${query}”所抓取的公开帖子。`,
          url: tweet.link,
          publishedAt: timestamp.publishedAt,
          source: `X · ${query}`,
          sourceType: "X",
          engagement: numberFromLabel(tweet.metricText),
          collectedAt: timestamp.collectedAt,
          timestampKind: timestamp.timestampKind,
        });
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
