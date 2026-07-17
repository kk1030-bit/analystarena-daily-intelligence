import { NextResponse } from "next/server";
import { isStockSearchRequest, stockSearchConfigured } from "@/lib/auth";
import { stocksForImpactEngine, storageMode } from "@/lib/db";
import { identifyEquityImpacts } from "@/lib/equity-impact";
import { readJsonBody, RequestBodyTooLargeError } from "@/lib/request-json";
import type { Headline, SourceType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 200_000;

function parsePublishedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: Request) {
  if (!stockSearchConfigured()) return NextResponse.json({ error: "股票辨识接口凭证尚未配置" }, { status: 503, headers });
  if (!isStockSearchRequest(request)) return NextResponse.json({ error: "请提供有效的 Bearer Token 或 X-API-Key" }, { status: 401, headers });
  if (process.env.NODE_ENV === "production" && storageMode() !== "postgres") return NextResponse.json({ error: "正式环境的 PostgreSQL 尚未连接" }, { status: 503, headers });
  try {
    const parsedBody = await readJsonBody(request, MAX_BODY_BYTES);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return NextResponse.json({ error: "请求正文必须是 JSON 对象" }, { status: 400, headers });
    }
    const body = parsedBody as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 500) : "";
    if (!title) return NextResponse.json({ error: "title 不能为空" }, { status: 400, headers });
    const sourceTypes: SourceType[] = ["Official", "News", "Reddit", "X"];
    const sourceType = sourceTypes.includes(body.sourceType as SourceType) ? body.sourceType as SourceType : "News";
    const publishedAt = body.publishedAt === undefined ? new Date().toISOString() : parsePublishedAt(body.publishedAt);
    if (!publishedAt) {
      return NextResponse.json({ error: "publishedAt 必须是带时区的有效 RFC 3339 时间" }, { status: 400, headers });
    }
    const headline: Headline = {
      id: crypto.randomUUID(), rank: 1,
      ticker: typeof body.ticker === "string" ? body.ticker.slice(0, 24) : "EVENT",
      title,
      summary: typeof body.summary === "string" ? body.summary.slice(0, 2_000) : title,
      keyPoints: Array.isArray(body.keyPoints) ? body.keyPoints.filter((value): value is string => typeof value === "string").slice(0, 8).map((value) => value.slice(0, 500)) : [],
      publishedAt,
      timestampKind: "published",
      marketImpact: typeof body.marketImpact === "string" ? body.marketImpact.slice(0, 1_000) : "",
      category: "Other", impact: 3, confidence: 50, mentions: 1, sentiment: "neutral",
      sources: [{ name: typeof body.source === "string" ? body.source.slice(0, 120) : "外部请求", type: sourceType, url: "https://analystarena-daily-intelligence.onrender.com/" }],
    };
    const impacts = identifyEquityImpacts(headline, await stocksForImpactEngine(publishedAt.slice(0, 10)));
    return NextResponse.json({
      data: impacts,
      meta: {
        count: impacts.length,
        potentialBeneficiaries: impacts.filter((item) => item.direction === "potential_upside" && item.mappingConfidence >= 70).length,
        disclosure: "映射可信度表示新闻与公司的关系强度，不是股价上涨概率，也不构成投资建议。",
      },
    }, { headers });
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "新闻股票辨识失败" }, { status, headers });
  }
}
