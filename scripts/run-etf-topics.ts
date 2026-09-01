import { collectEtfRedditPosts } from "../lib/collectors/etf-reddit";

const endpoint = process.env.ETF_TOPICS_ENDPOINT
  || "https://analystarena-daily-intelligence.onrender.com/api/cron/etf-topics";
const viewEndpoint = process.env.ETF_TOPICS_VIEW_ENDPOINT
  || "https://analystarena-daily-intelligence.onrender.com/api/etf-topics";
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET is required");

// Tracked posts that fell out of the hot listings still need this hour's
// engagement observation, so ask the site which posts are inside their
// 24-hour tracking window. A cold or unreachable view degrades gracefully.
let trackedUrls: string[] = [];
try {
  const viewResponse = await fetch(viewEndpoint, { signal: AbortSignal.timeout(30_000) });
  if (viewResponse.ok) {
    const view = await viewResponse.json() as { tracked?: Array<{ url?: unknown; active?: unknown }> };
    trackedUrls = (view.tracked ?? [])
      .filter((post) => post.active !== false && typeof post.url === "string")
      .map((post) => post.url as string);
  }
} catch {
  trackedUrls = [];
}

const collected = await collectEtfRedditPosts(trackedUrls);
console.log(`collected ${collected.posts.length} ETF candidate posts (${trackedUrls.length} tracked revisit targets)`);

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    observedAt: new Date().toISOString(),
    posts: collected.posts,
    statuses: collected.statuses,
    batchKey: `github-actions-etf:${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
  }),
  signal: AbortSignal.timeout(240_000),
});
const body = await response.text();
if (!response.ok) throw new Error(`ETF topics endpoint failed (${response.status}): ${body}`);
console.log(body);
