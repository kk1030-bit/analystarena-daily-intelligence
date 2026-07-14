import { NextResponse } from "next/server";
import { demoBrief } from "@/lib/demo-data";
import { buildLiveBrief } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(demoBrief);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { live?: boolean; useAi?: boolean };
    if (!body.live) return NextResponse.json(demoBrief);
    return NextResponse.json(await buildLiveBrief(body.useAi !== false));
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知錯誤";
    return NextResponse.json(
      {
        ...demoBrief,
        warning: `即時來源更新失敗，已保留示範日報。${message}`,
      },
      { status: 200 },
    );
  }
}
