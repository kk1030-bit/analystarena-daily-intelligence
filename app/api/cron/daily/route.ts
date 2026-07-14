import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { saveDraft, storageMode } from "@/lib/db";
import { buildLiveBrief } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "CRON_SECRET 尚未設定" }, { status: 503 });
  if (!isCronRequest(request)) return NextResponse.json({ error: "未授權" }, { status: 401 });
  try {
    const brief = await buildLiveBrief({ useAi: true, useBrowserCollectors: true });
    const record = await saveDraft({ ...brief, status: "draft", storageMode: storageMode() });
    return NextResponse.json({ ok: true, id: record.id, date: record.date, status: record.status, storageMode: storageMode() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "排程產生失敗" }, { status: 500 });
  }
}
