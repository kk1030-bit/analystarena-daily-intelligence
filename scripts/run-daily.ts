import { collectBrowserStories } from "../lib/collectors/browser";

const endpoint = process.env.DAILY_BRIEF_ENDPOINT || "https://analystarena-daily-intelligence.onrender.com/api/cron/daily";
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET is required");

const collected = await collectBrowserStories();
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(collected),
  signal: AbortSignal.timeout(240_000),
});
const body = await response.text();
if (!response.ok) throw new Error(`Daily brief endpoint failed (${response.status}): ${body}`);
console.log(body);
