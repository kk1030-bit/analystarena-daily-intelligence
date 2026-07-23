import { NextResponse } from "next/server";
import { adminAuditActor, adminConfigured, isAdminRequest } from "@/lib/auth";
import { safeCollectorNote } from "@/lib/collectors/router";
import { safeRemoteStories } from "@/lib/collectors/remote";
import { getLatestPublished, listEventVersions, saveDraft, storageMode } from "@/lib/db";
import { buildLiveBrief } from "@/lib/pipeline";
import {
  assertSemanticClusterCorrectionVersionsCurrent,
  deriveSemanticClusterCorrectionRetractions,
  SemanticClusterCorrectionError,
} from "@/lib/semantic-cluster-correction";
import type { SemanticClusterCorrectionAuthorization } from "@/lib/semantic-cluster-correction";
import type { CollectorStatus, EvidenceRetractionRequest } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface GenerateCorrectionInput {
  enabled?: boolean;
  confirmed?: boolean;
  reason?: unknown;
  expectedPublishedBriefId?: unknown;
  expectedPublishedSnapshotId?: unknown;
  expectedPublishedPayloadHash?: unknown;
}

function correctionAuthorization(input: GenerateCorrectionInput): SemanticClusterCorrectionAuthorization {
  return {
    confirmed: input.confirmed === true,
    reason: typeof input.reason === "string" ? input.reason : "",
    expectedPublishedBriefId: typeof input.expectedPublishedBriefId === "string"
      ? input.expectedPublishedBriefId
      : "",
    expectedPublishedSnapshotId: typeof input.expectedPublishedSnapshotId === "string"
      ? input.expectedPublishedSnapshotId
      : "",
    expectedPublishedPayloadHash: typeof input.expectedPublishedPayloadHash === "string"
      ? input.expectedPublishedPayloadHash
      : "",
  };
}

function safeCollectorStatuses(value: unknown): CollectorStatus[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((status) => {
    if (!status || typeof status !== "object") return [];
    const item = status as Partial<CollectorStatus>;
    if (typeof item.name !== "string") return [];
    const lastSuccess = item.lastSuccessAt ? new Date(item.lastSuccessAt) : undefined;
    const attempts = Array.isArray(item.attempts) ? item.attempts.slice(0, 6).flatMap((attempt) => {
      if (!attempt || typeof attempt !== "object" || typeof attempt.backend !== "string") return [];
      const completedAt = new Date(String(attempt.completedAt ?? ""));
      return [{
        backend: attempt.backend.slice(0, 100),
        ok: Boolean(attempt.ok),
        count: Math.max(0, Math.min(10_000, Math.trunc(Number(attempt.count) || 0))),
        latencyMs: Math.max(0, Math.min(300_000, Math.trunc(Number(attempt.latencyMs) || 0))),
        completedAt: Number.isNaN(completedAt.valueOf()) ? new Date().toISOString() : completedAt.toISOString(),
        note: typeof attempt.note === "string" ? safeCollectorNote(attempt.note) : undefined,
      }];
    }) : undefined;
    return [{
      name: item.name.slice(0, 100),
      ok: Boolean(item.ok),
      count: Math.max(0, Math.min(10_000, Math.trunc(Number(item.count) || 0))),
      note: typeof item.note === "string" ? safeCollectorNote(item.note) : undefined,
      channel: typeof item.channel === "string" ? item.channel.slice(0, 60) : undefined,
      backend: typeof item.backend === "string" ? item.backend.slice(0, 100) : undefined,
      latencyMs: item.latencyMs === undefined
        ? undefined
        : Math.max(0, Math.min(300_000, Math.trunc(Number(item.latencyMs) || 0))),
      fallbackUsed: item.fallbackUsed === undefined ? undefined : Boolean(item.fallbackUsed),
      lastSuccessAt: lastSuccess && !Number.isNaN(lastSuccess.valueOf()) ? lastSuccess.toISOString() : undefined,
      attempts,
    }];
  });
}

export async function POST(request: Request) {
  if (!adminConfigured()) return NextResponse.json({ error: "管理员密码（ADMIN_TOKEN）尚未设置" }, { status: 503 });
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as {
      useAi?: boolean;
      useBrowserCollectors?: boolean;
      stories?: unknown;
      statuses?: unknown;
      semanticClusterCorrection?: GenerateCorrectionInput;
    };
    const seedStories = safeRemoteStories(body.stories);
    const brief = await buildLiveBrief({
      useAi: body.useAi !== false,
      useBrowserCollectors: process.env.NODE_ENV !== "production" && body.useBrowserCollectors !== false,
      strictTranslation: false,
      seedStories,
      seedCollectorStatuses: safeCollectorStatuses(body.statuses),
    });
    const correction = body.semanticClusterCorrection;
    let evidenceRetractions: EvidenceRetractionRequest[] | undefined;
    let actor: ReturnType<typeof adminAuditActor> | undefined;
    if (correction?.enabled === true) {
      const published = await getLatestPublished();
      if (!published) {
        return NextResponse.json({ error: "当前没有可作为更正基线的正式日报" }, { status: 409 });
      }
      const authorization = correctionAuthorization(correction);
      evidenceRetractions = deriveSemanticClusterCorrectionRetractions(
        published,
        brief,
        authorization,
      );
      const eventIds = [...new Set(evidenceRetractions.map((item) => item.eventId))];
      const latestVersionIdByEvent = new Map(
        await Promise.all(eventIds.map(async (eventId) => {
          const versions = await listEventVersions(eventId);
          return [eventId, versions.at(-1)?.id] as const;
        })),
      );
      assertSemanticClusterCorrectionVersionsCurrent(
        evidenceRetractions,
        latestVersionIdByEvent,
      );
      actor = adminAuditActor(
        request,
        `管理员确认语义聚类证据更正：${authorization.reason.trim().slice(0, 300)}`,
      );
    }
    const record = await saveDraft(
      { ...brief, status: "draft", storageMode: storageMode() },
      {
        stream: "generate",
        batchKey: `generate:${brief.generatedAt}`,
        actor,
        evidenceRetractions,
      },
    );
    return NextResponse.json(record, { status: 201 });
  } catch (error) {
    if (error instanceof SemanticClusterCorrectionError) {
      const stale = error.code.startsWith("STALE_")
        || error.code === "PUBLISHED_AUTHORITY_REQUIRED"
        || error.code === "CORRECTION_DATE_MISMATCH"
        || error.code === "CORRECTION_NO_RETRACTIONS";
      return NextResponse.json({ error: error.message, code: error.code }, { status: stale ? 409 : 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成草稿失败" }, { status: 500 });
  }
}
