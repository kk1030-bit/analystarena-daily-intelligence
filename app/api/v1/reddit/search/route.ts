import { NextResponse } from "next/server";
import { isRedditSearchRequest, redditSearchConfigured } from "@/lib/auth";
import { searchRedditPosts, storageMode } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...responseHeaders, ...extraHeaders } });
}

function parseDate(value: string | null, boundary: "from" | "to"): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const normalized = dateOnly
    ? `${value}T${boundary === "from" ? "00:00:00.000" : "23:59:59.999"}Z`
    : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${boundary} 必须是有效的 ISO 8601 日期或时间`);
  return parsed.toISOString();
}

function decodeCursor(value: string | null): { publishedAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof decoded.publishedAt !== "string" || Number.isNaN(new Date(decoded.publishedAt).getTime())) throw new Error();
    if (typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 256) throw new Error();
    return { publishedAt: new Date(decoded.publishedAt).toISOString(), id: decoded.id };
  } catch {
    throw new Error("cursor 无效，请使用上一次响应返回的 nextCursor");
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: responseHeaders });
}

export async function GET(request: Request) {
  if (!redditSearchConfigured()) {
    return json({ error: { code: "API_NOT_CONFIGURED", message: "搜索接口凭证尚未配置" } }, 503);
  }
  if (!isRedditSearchRequest(request)) {
    return json(
      { error: { code: "UNAUTHORIZED", message: "请提供有效的 Bearer Token 或 X-API-Key" } },
      401,
      { "WWW-Authenticate": 'Bearer realm="AnalystArena Reddit Search"' },
    );
  }
  if (process.env.NODE_ENV === "production" && storageMode() !== "postgres") {
    return json({ error: { code: "DATABASE_UNAVAILABLE", message: "正式环境的 PostgreSQL 尚未连接" } }, 503);
  }

  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim() || undefined;
    const subreddit = url.searchParams.get("subreddit")?.trim() || undefined;
    if (q && q.length > 200) return json({ error: { code: "INVALID_QUERY", message: "q 最多 200 个字符" } }, 400);
    if (subreddit && subreddit.length > 80) return json({ error: { code: "INVALID_QUERY", message: "subreddit 最多 80 个字符" } }, 400);

    const rawLimit = url.searchParams.get("limit") ?? "25";
    if (!/^\d+$/.test(rawLimit)) return json({ error: { code: "INVALID_QUERY", message: "limit 必须是整数" } }, 400);
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 100) return json({ error: { code: "INVALID_QUERY", message: "limit 必须介于 1 和 100" } }, 400);

    const from = parseDate(url.searchParams.get("from"), "from");
    const to = parseDate(url.searchParams.get("to"), "to");
    if (from && to && from > to) return json({ error: { code: "INVALID_QUERY", message: "from 不得晚于 to" } }, 400);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const result = await searchRedditPosts({ q, subreddit, from, to, limit, cursor });

    return json({
      data: result.items,
      pagination: { limit, nextCursor: result.nextCursor ?? null },
      query: { q: q ?? null, subreddit: subreddit?.replace(/^r\//i, "") ?? null, from: from ?? null, to: to ?? null },
      meta: { count: result.items.length, storageMode: storageMode() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "搜索请求处理失败";
    const isClientError = /必须|无效|不得/.test(message);
    return json({ error: { code: isClientError ? "INVALID_QUERY" : "INTERNAL_ERROR", message } }, isClientError ? 400 : 500);
  }
}
