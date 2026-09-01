import { NextResponse } from "next/server";
import { adminAuditActor, isAdminRequest } from "@/lib/auth";
import { getBrief, publishBrief, StaleBriefRevisionError, verifyBriefEvidenceAuthority } from "@/lib/db";
import { generateBriefPdf } from "@/lib/pdf";
import { publicationEvidenceIssues } from "@/lib/publication-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({})) as {
      expectedSnapshotId?: string;
      expectedPayloadHash?: string;
    };
    if (!body.expectedSnapshotId?.trim() || !body.expectedPayloadHash?.trim()) {
      return NextResponse.json({
        error: "发布请求缺少审核时看到的快照版本，请刷新审核台后重试。",
        code: "REVIEWED_SNAPSHOT_REQUIRED",
      }, { status: 409 });
    }
    const record = await getBrief(id);
    if (!record) return NextResponse.json({ error: "找不到日报" }, { status: 404 });
    if (record.status !== "draft") return NextResponse.json({ error: "这份日报已经发布" }, { status: 409 });
    if (record.brief.snapshot?.id !== body.expectedSnapshotId
      || record.brief.snapshot?.payloadHash !== body.expectedPayloadHash) {
      return NextResponse.json({
        error: "日报在您审核后已有新版本，请刷新并重新审核后再发布。",
        code: "STALE_BRIEF_REVISION",
      }, { status: 409 });
    }

    // Publication checks, PDF generation, and the final promotion all consume
    // the exact frozen review snapshot. Translation and equity enrichment must
    // already have been saved by review/rebase; rerunning either here would
    // create an unreviewed payload and a TOCTOU window.
    const preparedDraft = structuredClone(record.brief);
    const headlines = preparedDraft.headlines;
    const evidenceIssues = [
      ...publicationEvidenceIssues(preparedDraft),
      ...(await verifyBriefEvidenceAuthority(preparedDraft)).map((item) => ({
        ...item,
        headlineRank: headlines.find((headline) => headline.id === item.headlineId)?.rank ?? 0,
        claimKey: "database_authority",
      })),
    ];
    if (evidenceIssues.length) {
      return NextResponse.json({
        error: `有 ${evidenceIssues.length} 项判断尚未通过可稽核证据核验，请补齐证据并完成确认后再发布。`,
        code: "EVIDENCE_REVIEW_REQUIRED",
        issues: evidenceIssues,
      }, { status: 409 });
    }
    const missingMappings = headlines.filter((headline) => !Array.isArray(headline.equityImpacts));
    if (missingMappings.length) {
      const issues = missingMappings.map((headline) => ({
        code: "EQUITY_MAPPING_UNAVAILABLE",
        headlineId: headline.id,
        headlineRank: headline.rank,
        claimKey: "equity_impacts",
        reason: "该头条没有可审核的股票影响映射，请先保存映射结果后再发布。",
      }));
      return NextResponse.json({
        error: "股票影响映射暂时无法完成，请稍后重试后再发布。",
        code: "EQUITY_MAPPING_UNAVAILABLE",
        headlines: (missingMappings.length ? missingMappings : headlines).map((headline) => ({ id: headline.id, rank: headline.rank, title: headline.title })),
        issues,
      }, { status: 409 });
    }

    const pending = headlines.flatMap((headline) => (headline.equityImpacts ?? [])
      .filter((item) => !item.reviewStatus || item.reviewStatus === "auto_pending")
      .map((item) => ({
        headlineId: headline.id,
        headlineRank: headline.rank,
        symbol: item.symbol,
        companyName: item.companyName,
        mappingConfidence: item.mappingConfidence,
      })));
    if (pending.length) {
      const issues = pending.map((item) => ({
        code: "EQUITY_REVIEW_REQUIRED",
        headlineId: item.headlineId,
        headlineRank: item.headlineRank,
        claimKey: `equity_impact:${item.symbol}`,
        reason: `${item.symbol}（${item.companyName}）的股票影响映射尚未人工批准或驳回；当前映射可信度为 ${item.mappingConfidence}%。`,
      }));
      return NextResponse.json({
        error: `还有 ${pending.length} 个高可信股票映射尚未审核，请先批准或驳回后再发布。`,
        code: "EQUITY_REVIEW_REQUIRED",
        pending,
        issues,
      }, { status: 409 });
    }

    const prepared = { ...preparedDraft, id, status: "published" as const, publishedAt: new Date().toISOString() };
    const pdf = await generateBriefPdf(prepared);
    const published = await publishBrief(id, prepared, pdf, {
      stream: "publish",
      batchKey: `publish:${id}:${Date.now()}`,
      actor: adminAuditActor(request, "人工审核通过并发布日报"),
    });
    return NextResponse.json({ ...published, pdfUrl: `/api/briefs/${id}/pdf` });
  } catch (error) {
    if (error instanceof StaleBriefRevisionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "发布失败" }, { status: 500 });
  }
}
