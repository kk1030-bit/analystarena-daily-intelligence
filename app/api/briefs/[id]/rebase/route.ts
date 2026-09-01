import { NextResponse } from "next/server";
import { adminAuditActor, isAdminRequest } from "@/lib/auth";
import { getBrief, StaleBriefRevisionError, updateDraft } from "@/lib/db";
import { attachEquityImpacts } from "@/lib/equity-impact";
import { localizeBriefContent } from "@/lib/translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await context.params;
  try {
    const current = await getBrief(id);
    if (!current) return NextResponse.json({ error: "日报不存在" }, { status: 404 });
    if (current.status !== "draft") {
      return NextResponse.json({ error: "已发布日报不可重新建立审核链" }, { status: 409 });
    }
    if (current.brief.headlines.every((headline) => headline.whatChanged)) {
      return NextResponse.json(current);
    }

    // Pre-7/23 drafts have no stored comparison result. Re-observe the exact
    // draft through the normal immutable pipeline and mark legacy endpoints
    // honestly; never manufacture a yesterday delta during migration.
    const localized = await localizeBriefContent(current.brief, { strict: true });
    const headlines = await attachEquityImpacts(localized.headlines);
    const rebased = await updateDraft(id, { ...localized, headlines }, {
      stream: "review",
      batchKey: `review-rebase:${id}:${Date.now()}`,
      expectedSnapshotId: current.brief.snapshot?.id,
      actor: adminAuditActor(request, "为旧草稿建立可稽核 What Changed 快照"),
    });
    return NextResponse.json(rebased);
  } catch (error) {
    if (error instanceof StaleBriefRevisionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({
      error: error instanceof Error ? error.message : "审核链升级失败",
    }, { status: 400 });
  }
}
