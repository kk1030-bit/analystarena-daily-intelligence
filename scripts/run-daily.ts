import { existsSync, readFileSync } from "node:fs";
import { collectBrowserStories } from "../lib/collectors/browser";
import {
  adaptCrawl4aiCollectOutput,
  missingCrawl4aiStatus,
  type Crawl4aiAdapterResult,
} from "../lib/collectors/crawl4ai";
import { safeCollectorNote } from "../lib/collectors/router";

const endpoint = process.env.DAILY_BRIEF_ENDPOINT || "https://analystarena-daily-intelligence.onrender.com/api/cron/daily";
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET is required");

const crawlOutputPath = process.env.CRAWL4AI_OUTPUT || "crawl-results.json";
let detail: Crawl4aiAdapterResult = { stories: [], status: missingCrawl4aiStatus(crawlOutputPath) };
if (existsSync(crawlOutputPath)) {
  try {
    detail = adaptCrawl4aiCollectOutput(JSON.parse(readFileSync(crawlOutputPath, "utf8")));
  } catch (error) {
    detail = {
      stories: [],
      status: { name: "News 全文", channel: "News", backend: "crawl4ai", ok: false, count: 0, note: safeCollectorNote(error) },
    };
  }
}
console.log(`crawl4ai detail stories: ${detail.stories.length}${detail.status.note ? ` (${detail.status.note})` : ""}`);

const collected = await collectBrowserStories();
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    stories: [...collected.stories, ...detail.stories],
    statuses: [...collected.statuses, detail.status],
    batchKey: `github-actions:${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
  }),
  signal: AbortSignal.timeout(240_000),
});
const body = await response.text();
if (!response.ok) throw new Error(`Daily brief endpoint failed (${response.status}): ${body}`);
console.log(body);
