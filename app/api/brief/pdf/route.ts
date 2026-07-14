import { NextResponse } from "next/server";
import { generateBriefPdf } from "@/lib/pdf";
import type { DailyBrief } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 180_000) return NextResponse.json({ error: "日報內容過大" }, { status: 413 });

  try {
    const body = await request.json() as { brief?: DailyBrief };
    const brief = body.brief;
    if (!brief || typeof brief.date !== "string" || !Array.isArray(brief.headlines) || brief.headlines.length < 1 || brief.headlines.length > 8) {
      return NextResponse.json({ error: "日報格式不正確" }, { status: 400 });
    }
    const invalid = brief.headlines.some((headline) => typeof headline.title !== "string" || typeof headline.summary !== "string" || typeof headline.marketImpact !== "string");
    if (invalid) return NextResponse.json({ error: "新聞內容不完整" }, { status: 400 });

    const pdf = await generateBriefPdf(brief);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="AnalystArena-Top5-${brief.date.slice(0, 10)}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PDF 產生失敗" }, { status: 500 });
  }
}
