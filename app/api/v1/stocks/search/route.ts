import { NextResponse } from "next/server";
import { isStockSearchRequest, stockSearchConfigured } from "@/lib/auth";
import { searchStockProfiles, storageMode } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}

export async function GET(request: Request) {
  if (!stockSearchConfigured()) return NextResponse.json({ error: "股票搜索接口凭证尚未配置" }, { status: 503, headers });
  if (!isStockSearchRequest(request)) return NextResponse.json({ error: "请提供有效的 Bearer Token 或 X-API-Key" }, { status: 401, headers });
  if (process.env.NODE_ENV === "production" && storageMode() !== "postgres") return NextResponse.json({ error: "正式环境的 PostgreSQL 尚未连接" }, { status: 503, headers });
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const rawLimit = url.searchParams.get("limit") ?? "25";
  if (query.length > 200 || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
    return NextResponse.json({ error: "q 最多 200 个字符，limit 必须介于 1 和 100" }, { status: 400, headers });
  }
  try {
    const result = await searchStockProfiles(query, Number(rawLimit));
    return NextResponse.json({ data: result.items, meta: { count: result.items.length, storageMode: storageMode() } }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "股票搜索失败" }, { status: 500, headers });
  }
}
