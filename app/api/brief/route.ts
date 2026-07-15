import { NextResponse } from "next/server";
import { demoBrief } from "@/lib/demo-data";
import { buildLiveBrief } from "@/lib/pipeline";
import { getLatestPublished } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth";
import { localizeBriefContent } from "@/lib/translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const published = await getLatestPublished().catch(() => null);
  return NextResponse.json(await localizeBriefContent(published?.brief ?? demoBrief));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { live?: boolean; useAi?: boolean; useBrowserCollectors?: boolean };
    if (!body.live) return NextResponse.json(await localizeBriefContent(demoBrief));
    const admin = isAdminRequest(request);
    return NextResponse.json(await buildLiveBrief({
      useAi: admin && body.useAi !== false,
      useBrowserCollectors: admin && body.useBrowserCollectors === true,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json(
      {
        ...(await localizeBriefContent(demoBrief)),
        warning: `实时来源更新失败，已保留示范日报。${message}`,
      },
      { status: 200 },
    );
  }
}
