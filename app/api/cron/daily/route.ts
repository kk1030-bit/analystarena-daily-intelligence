import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { saveDraft, storageMode } from "@/lib/db";
import { buildLiveBrief } from "@/lib/pipeline";
import type { CollectorStatus, RawStory } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function safeRemoteStories(value: unknown): RawStory[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).flatMap((story) => {
    if (!story || typeof story !== "object") return [];
    const item = story as Partial<RawStory>;
    if ((item.sourceType !== "Reddit" && item.sourceType !== "X") || typeof item.title !== "string" || typeof item.url !== "string" || !/^https?:\/\//.test(item.url)) return [];
    const publishedAt = new Date(String(item.publishedAt ?? ""));
    return [{
      id: String(item.id ?? crypto.randomUUID()).slice(0, 120),
      title: item.title.slice(0, 240),
      description: String(item.description ?? "").slice(0, 900),
      url: item.url.slice(0, 1_500),
      publishedAt: Number.isNaN(publishedAt.valueOf()) ? new Date().toISOString() : publishedAt.toISOString(),
      source: String(item.source ?? item.sourceType).slice(0, 100),
      sourceType: item.sourceType,
      engagement: Math.max(0, Math.min(10_000_000, Number(item.engagement) || 0)),
      collectedAt: new Date().toISOString(),
    }];
  });
}

function safeStatuses(value: unknown): CollectorStatus[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((status) => {
    if (!status || typeof status !== "object") return [];
    const item = status as Partial<CollectorStatus>;
    if (typeof item.name !== "string") return [];
    return [{ name: item.name.slice(0, 100), ok: Boolean(item.ok), count: Math.max(0, Number(item.count) || 0), note: item.note?.slice(0, 240) }];
  });
}

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "排程密钥（CRON_SECRET）尚未设置" }, { status: 503 });
  if (!isCronRequest(request)) return NextResponse.json({ error: "未授权" }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({})) as { stories?: unknown; statuses?: unknown };
    const seedStories = safeRemoteStories(body.stories);
    const brief = await buildLiveBrief({
      useAi: true,
      useBrowserCollectors: false,
      seedStories,
      seedCollectorStatuses: safeStatuses(body.statuses),
    });
    const record = await saveDraft({ ...brief, status: "draft", storageMode: storageMode() });
    return NextResponse.json({ ok: true, id: record.id, date: record.date, status: record.status, storageMode: storageMode() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "排程生成失败" }, { status: 500 });
  }
}
