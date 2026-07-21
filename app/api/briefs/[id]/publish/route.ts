import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getBrief, publishBrief, StaleBriefRevisionError } from "@/lib/db";
import { attachEquityImpacts } from "@/lib/equity-impact";
import { generateBriefPdf } from "@/lib/pdf";
import { localizeBriefContent } from "@/lib/translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await context.params;
  try {
    const record = await getBrief(id);
    if (!record) return NextResponse.json({ error: "找不到日报" }, { status: 404 });
    if (record.status !== "draft") return NextResponse.json({ error: "这份日报已经发布" }, { status: 409 });

    const headlines = await attachEquityImpacts(record.brief.headlines);
    const preparedDraft = { ...record.brief, headlines };
    const missingMappings = headlines.filter((headline) => !Array.isArray(headline.equityImpacts));
    if (headlines === record.brief.headlines || missingMappings.length) {
      return NextResponse.json({
        error: "股票影响映射暂时无法完成，请稍后重试后再发布。",
        code: "EQUITY_MAPPING_UNAVAILABLE",
        headlines: (missingMappings.length ? missingMappings : headlines).map((headline) => ({ id: headline.id, rank: headline.rank, title: headline.title })),
      }, { status: 409 });
    }

    const pending = headlines.flatMap((headline) => (headline.equityImpacts ?? [])
      .filter((item) => item.mappingConfidence >= 70 && (!item.reviewStatus || item.reviewStatus === "auto_pending"))
      .map((item) => ({
        headlineId: headline.id,
        headlineRank: headline.rank,
        symbol: item.symbol,
        companyName: item.companyName,
        mappingConfidence: item.mappingConfidence,
      })));
    if (pending.length) {
      return NextResponse.json({
        error: `还有 ${pending.length} 个高可信股票映射尚未审核，请先批准或驳回后再发布。`,
        code: "EQUITY_REVIEW_REQUIRED",
        pending,
      }, { status: 409 });
    }

    const localized = await localizeBriefContent(preparedDraft, { strict: true });
    const prepared = { ...localized, id, status: "published" as const, publishedAt: new Date().toISOString() };
    const pdf = await generateBriefPdf(prepared);
    const published = await publishBrief(id, prepared, pdf, {
      stream: "publish",
      batchKey: `publish:${id}:${Date.now()}`,
    });
    return NextResponse.json({ ...published, pdfUrl: `/api/briefs/${id}/pdf` });
  } catch (error) {
    if (error instanceof StaleBriefRevisionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "发布失败" }, { status: 500 });
  }
}
