import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getBrief, publishBrief } from "@/lib/db";
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
    const localized = await localizeBriefContent(record.brief);
    const prepared = { ...localized, id, status: "published" as const, publishedAt: new Date().toISOString() };
    const pdf = await generateBriefPdf(prepared);
    const published = await publishBrief(id, prepared, pdf);
    return NextResponse.json({ ...published, pdfUrl: `/api/briefs/${id}/pdf` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "发布失败" }, { status: 500 });
  }
}
