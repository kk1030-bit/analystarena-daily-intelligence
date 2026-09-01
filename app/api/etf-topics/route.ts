import { NextResponse } from "next/server";
import { getEtfTopicsView } from "@/lib/etf-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public read model for the ETFs hot-topics section: the latest hourly top-5,
 * every post inside its 24-hour tracking window with engagement history, the
 * recent daily digests and the latest weekly digest. The hourly GitHub Actions
 * collector also reads this to learn which tracked posts to re-observe.
 */
export async function GET() {
  try {
    const view = await getEtfTopicsView();
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ETF 热门话题读取失败" },
      { status: 500 },
    );
  }
}
