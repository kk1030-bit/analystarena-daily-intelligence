import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { adminAuditActor, isAdminRequest } from "@/lib/auth";
import { getBrief, StaleBriefRevisionError, updateDraft } from "@/lib/db";
import { attachEquityImpacts } from "@/lib/equity-impact";
import { localizeBriefContent } from "@/lib/translation";
import {
  reconcileReviewedBriefEvidence,
  reviewedClaimRetainsCitationRelationship,
} from "@/lib/review-evidence";
import type {
  ManualClaimConfirmation,
  ManualEditedClaimSupport,
} from "@/lib/review-evidence";
import type { DailyBrief, EvidenceRetractionRequest } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deriveReviewRetractions(
  current: DailyBrief,
  reviewed: DailyBrief,
  supplied: EvidenceRetractionRequest[],
  explicitReview: { confirmed: boolean; note?: string },
): EvidenceRetractionRequest[] {
  const result = supplied.map((item) => structuredClone(item));
  const suppliedTargets = new Set(result.map((item) => [
    item.eventId,
    item.fromEventVersionId,
    item.claimKey ?? "",
    item.citationRelation ?? "",
    item.evidenceItemId,
    item.evidenceVersionId,
  ].join("\u0000")));
  const versionByEvent = new Map(
    current.snapshot?.events.map((event) => [event.eventId, event.eventVersionId]) ?? [],
  );
  const reviewedByEvent = new Map(reviewed.headlines.map((headline) => [headline.id, headline]));
  for (const headline of current.headlines) {
    const fromEventVersionId = versionByEvent.get(headline.id);
    if (!fromEventVersionId) continue;
    const nextHeadline = reviewedByEvent.get(headline.id);
    for (const claim of headline.claims ?? []) {
      const nextClaim = nextHeadline?.claims?.find((candidate) =>
        candidate.claimKey === claim.claimKey);
      for (const citation of claim.citations) {
        const retained = reviewedClaimRetainsCitationRelationship(nextClaim, citation);
        if (retained || !citation.versionId) continue;
        const target = [
          headline.id,
          fromEventVersionId,
          claim.claimKey,
          citation.relation,
          citation.id,
          citation.versionId,
        ].join("\u0000");
        if (suppliedTargets.has(target)) continue;
        if (!explicitReview.confirmed || !explicitReview.note?.trim()) {
          throw new Error(
            `声明 ${claim.claimKey} 的旧引用将被撤下；请先逐条选择支持新文字的证据，并填写审核说明`,
          );
        }
        suppliedTargets.add(target);
        result.push({
          requestId: randomUUID(),
          eventId: headline.id,
          fromEventVersionId,
          evidenceItemId: citation.id,
          evidenceVersionId: citation.versionId,
          claimKey: claim.claimKey,
          citationRelation: citation.relation,
          reasonCode: "review_rejected",
          reasonNote: `${explicitReview.note.trim()}（人工编辑声明 ${claim.claimKey} 后，该旧引用不再支持新文字。）`,
        });
      }
    }
  }
  return result;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const record = await getBrief(id);
  if (!record) return NextResponse.json({ error: "找不到日报" }, { status: 404 });
  if (record.status !== "published" && !isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  return NextResponse.json(record);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const { id } = await context.params;
  try {
    const body = await request.json() as {
      brief?: DailyBrief;
      manualConfirmations?: ManualClaimConfirmation[];
      manualEditedClaimSupports?: ManualEditedClaimSupport[];
      evidenceRetractions?: EvidenceRetractionRequest[];
      evidenceReviewConfirmed?: boolean;
      evidenceReviewNote?: string;
    };
    if (!body.brief?.headlines?.length) return NextResponse.json({ error: "日报内容不完整" }, { status: 400 });
    const current = await getBrief(id);
    if (!current) return NextResponse.json({ error: "找不到日报" }, { status: 404 });
    if (current.status !== "draft") return NextResponse.json({ error: "已发布日报不可修改" }, { status: 409 });
    const reconciled = reconcileReviewedBriefEvidence(current.brief, body.brief, {
      manualConfirmations: body.manualConfirmations,
      manualEditedClaimSupports: body.manualEditedClaimSupports,
    });
    if ((body.manualEditedClaimSupports?.length ?? 0) > 0
      && (!body.evidenceReviewConfirmed || !body.evidenceReviewNote?.trim())) {
      throw new Error("人工改写声明前，必须确认证据重绑范围并填写审核说明");
    }
    const localized = await localizeBriefContent(reconciled, { strict: true });
    const headlines = await attachEquityImpacts(localized.headlines);
    const reviewed = { ...localized, headlines };
    const evidenceRetractions = deriveReviewRetractions(
      current.brief,
      reviewed,
      body.evidenceRetractions ?? [],
      {
        confirmed: body.evidenceReviewConfirmed === true,
        note: body.evidenceReviewNote,
      },
    );
    const auditReason = body.evidenceReviewNote?.trim()
      ? `人工审核日报内容与证据确认：${body.evidenceReviewNote.trim().slice(0, 300)}`
      : "人工审核日报内容与证据确认";
    return NextResponse.json(await updateDraft(id, reviewed, {
      stream: "review",
      batchKey: `review:${id}:${Date.now()}`,
      expectedSnapshotId: body.brief.snapshot?.id,
      actor: adminAuditActor(request, auditReason),
      evidenceRetractions,
    }));
  } catch (error) {
    if (error instanceof StaleBriefRevisionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新失败" }, { status: 400 });
  }
}
