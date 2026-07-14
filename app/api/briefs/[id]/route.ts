import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getBrief, updateDraft } from "@/lib/db";
import type { DailyBrief } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const record = await getBrief(id);
  if (!record) return NextResponse.json({ error: "找不到日報" }, { status: 404 });
  if (record.status !== "published" && !isAdminRequest(request)) return NextResponse.json({ error: "未授權" }, { status: 401 });
  return NextResponse.json(record);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "未授權" }, { status: 401 });
  const { id } = await context.params;
  try {
    const body = await request.json() as { brief?: DailyBrief };
    if (!body.brief?.headlines?.length) return NextResponse.json({ error: "日報內容不完整" }, { status: 400 });
    return NextResponse.json(await updateDraft(id, body.brief));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新失敗" }, { status: 400 });
  }
}
