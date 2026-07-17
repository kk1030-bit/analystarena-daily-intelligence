import { NextResponse } from "next/server";
import { generateBriefPdf } from "@/lib/pdf";
import type { DailyBrief } from "@/lib/types";
import { localizeBriefContent } from "@/lib/translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 180_000) return NextResponse.json({ error: "日报内容过大" }, { status: 413 });

  try {
    const body = await request.json() as { brief?: DailyBrief };
    const brief = body.brief;
    if (!brief || typeof brief.date !== "string" || !Array.isArray(brief.headlines) || brief.headlines.length < 1 || brief.headlines.length > 8) {
      return NextResponse.json({ error: "日报格式不正确" }, { status: 400 });
    }
    const invalid = brief.headlines.some((headline) => typeof headline.title !== "string" || typeof headline.summary !== "string" || typeof headline.marketImpact !== "string");
    if (invalid) return NextResponse.json({ error: "新闻内容不完整" }, { status: 400 });

    // Preview exports should remain available while background translation is still
    // completing. The publish endpoint keeps its own strict translation gate.
    const localized = await localizeBriefContent(brief, { strict: false });
    const pdf = await generateBriefPdf(localized);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="AnalystArena-Top5-${brief.date.slice(0, 10)}.pdf"`,
        "Cache-Control": "no-store",
        ...(localized.translationEnabled === false ? { "X-AnalystArena-Translation-Warning": "1" } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PDF 生成失败" }, { status: 500 });
  }
}
