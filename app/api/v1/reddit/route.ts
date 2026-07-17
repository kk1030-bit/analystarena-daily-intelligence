import { NextResponse } from "next/server";
import { redditSearchConfigured } from "@/lib/auth";
import { storageMode } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
  const trustedForwardedHost = forwardedHost && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(forwardedHost)
    ? forwardedHost
    : null;
  const origin = renderHost
    ? `https://${renderHost}`
    : trustedForwardedHost
      ? `${forwardedProtocol === "http" ? "http" : "https"}://${trustedForwardedHost}`
      : new URL(request.url).origin;
  return NextResponse.json({
    service: "AnalystArena Reddit Search API",
    version: "v1",
    status: redditSearchConfigured() ? "ready" : "credential-not-configured",
    storageMode: storageMode(),
    authentication: {
      preferred: "Authorization: Bearer <REDDIT_SEARCH_API_TOKEN>",
      alternative: "X-API-Key: <REDDIT_SEARCH_API_TOKEN>",
    },
    endpoint: `${origin}/api/v1/reddit/search`,
    parameters: {
      q: "可选，标题、正文与 subreddit 全文搜索，最多 200 字符",
      subreddit: "可选，例如 stocks 或 r/stocks",
      from: "可选，ISO 8601 日期或时间，包含边界",
      to: "可选，ISO 8601 日期或时间，包含边界",
      limit: "可选，1 至 100，默认 25",
      cursor: "可选，直接使用上一页的 pagination.nextCursor",
    },
  }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
