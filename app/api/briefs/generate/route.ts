import { NextResponse } from "next/server";
import { adminConfigured, isAdminRequest } from "@/lib/auth";
import { saveDraft, storageMode } from "@/lib/db";
import { buildLiveBrief } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!adminConfigured()) return NextResponse.json({ error: "ADMIN_TOKEN 尚未設定" }, { status: 503 });
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授權" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { useAi?: boolean; useBrowserCollectors?: boolean };
    const brief = await buildLiveBrief({
      useAi: body.useAi !== false,
      useBrowserCollectors: process.env.NODE_ENV !== "production" && body.useBrowserCollectors !== false,
    });
    const record = await saveDraft({ ...brief, status: "draft", storageMode: storageMode() });
    return NextResponse.json(record, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "產生草稿失敗" }, { status: 500 });
  }
}
