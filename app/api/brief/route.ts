import { NextResponse } from "next/server";
import { demoBrief } from "@/lib/demo-data";
import { buildLiveBrief } from "@/lib/pipeline";
import { getLatestPublished } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const published = await getLatestPublished().catch(() => null);
  return NextResponse.json(published?.brief ?? demoBrief);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { live?: boolean; useAi?: boolean; useBrowserCollectors?: boolean };
    if (!body.live) return NextResponse.json(demoBrief);
    const admin = isAdminRequest(request);
    return NextResponse.json(await buildLiveBrief({
      useAi: admin && body.useAi !== false,
      useBrowserCollectors: admin && body.useBrowserCollectors === true,
    }));
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
