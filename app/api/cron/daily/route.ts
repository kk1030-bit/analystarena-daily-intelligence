import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { saveDraft, storageMode } from "@/lib/db";
import { buildLiveBrief } from "@/lib/pipeline";
import { safeCollectorNote } from "@/lib/collectors/router";
import { safeRemoteStories } from "@/lib/collectors/remote";
import type { CollectorStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function safeStatuses(value: unknown): CollectorStatus[] {
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
      latencyMs: item.latencyMs === undefined ? undefined : Math.max(0, Math.min(300_000, Math.trunc(Number(item.latencyMs) || 0))),
      fallbackUsed: item.fallbackUsed === undefined ? undefined : Boolean(item.fallbackUsed),
      lastSuccessAt: lastSuccess && !Number.isNaN(lastSuccess.valueOf()) ? lastSuccess.toISOString() : undefined,
      attempts,
    }];
  });
}

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "排程密钥（CRON_SECRET）尚未设置" }, { status: 503 });
  if (!isCronRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({})) as { stories?: unknown; statuses?: unknown; batchKey?: unknown };
    const seedStories = safeRemoteStories(body.stories);
    const brief = await buildLiveBrief({
      useAi: true,
      useBrowserCollectors: false,
      strictTranslation: false,
      seedStories,
      seedCollectorStatuses: safeStatuses(body.statuses),
    });
    const batchKey = typeof body.batchKey === "string" && body.batchKey.trim()
      ? body.batchKey.slice(0, 180)
      : `cron:${brief.generatedAt}`;
    const record = await saveDraft(
      { ...brief, status: "draft", storageMode: storageMode() },
      { stream: "cron", batchKey },
    );
    return NextResponse.json({ ok: true, id: record.id, date: record.date, status: record.status, storageMode: storageMode() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "排程生成失败" }, { status: 500 });
  }
}
