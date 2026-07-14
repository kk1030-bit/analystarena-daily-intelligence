import { existsSync } from "node:fs";
import { chromium as playwrightChromium, type Browser, type Page } from "playwright-core";
import serverlessChromium from "@sparticuz/chromium";
import type { CollectorStatus, RawStory } from "../types";

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

async function collectReddit(page: Page): Promise<RawStory[]> {
  const stories: RawStory[] = [];
  for (const community of redditCommunities) {
    await page.goto(`https://old.reddit.com/r/${community}/hot/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const rows = await page.locator(".thing.link").evaluateAll((nodes) => nodes.slice(0, 8).map((node) => {
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
    }));

    for (const row of rows) {
      if (!row.title || !row.url) continue;
      const engagement = numberFromLabel(row.score) + numberFromLabel(row.comments) * 2;
      stories.push({
        id: idFor(`reddit:${community}:${row.title}`),
        title: row.title,
        description: `Reddit r/${community} 熱門討論，互動指標 ${engagement}。`,
        url: row.url,
        publishedAt: row.publishedAt || new Date().toISOString(),
        source: `r/${community}`,
        sourceType: "Reddit",
        engagement,
        collectedAt: new Date().toISOString(),
      });
    }
  }
  return stories;
}

async function collectX(page: Page): Promise<RawStory[]> {
  if (process.env.X_AUTH_TOKEN) {
    await page.context().addCookies([{
      name: "auth_token",
      value: process.env.X_AUTH_TOKEN,
      domain: ".x.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    }]);
  }

  const stories: RawStory[] = [];
  for (const query of xQueries) {
    const url = `https://x.com/search?q=${encodeURIComponent(`${query} lang:en -is:reply`)}&src=typed_query&f=live`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
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
      stories.push({
        id: idFor(`x:${tweet.link}`),
        title: tweet.text.slice(0, 180),
        description: `X 即時搜尋「${query}」所擷取的公開貼文。`,
        url: tweet.link,
        publishedAt: tweet.publishedAt || new Date().toISOString(),
        source: `X · ${query}`,
        sourceType: "X",
        engagement: numberFromLabel(tweet.metricText),
        collectedAt: new Date().toISOString(),
      });
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
      timezoneId: "Asia/Taipei",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    try {
      const reddit = await collectReddit(page);
      stories.push(...reddit);
      statuses.push({ name: "Reddit Playwright", ok: reddit.length > 0, count: reddit.length });
    } catch (error) {
      statuses.push({ name: "Reddit Playwright", ok: false, count: 0, note: error instanceof Error ? error.message : "collector failed" });
    }

    try {
      const x = await collectX(page);
      stories.push(...x);
      statuses.push({
        name: "X Playwright",
        ok: x.length > 0,
        count: x.length,
        note: !process.env.X_AUTH_TOKEN ? "未設定 X_AUTH_TOKEN，公開搜尋可能受限" : undefined,
      });
    } catch (error) {
      statuses.push({ name: "X Playwright", ok: false, count: 0, note: error instanceof Error ? error.message : "collector failed" });
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : "browser launch failed";
    statuses.push({ name: "Browser runtime", ok: false, count: 0, note });
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return { stories, statuses };
}
