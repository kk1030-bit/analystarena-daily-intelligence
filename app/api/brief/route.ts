import { NextResponse } from "next/server";
import { demoBrief } from "@/lib/demo-data";
import { buildLiveBrief } from "@/lib/pipeline";
import { getLatestPublished } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth";
import { getCachedHotSearchBrief, hotSearchBatchKey } from "@/lib/live-brief";
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

    // Anonymous dashboard refreshes reuse the same bounded ten-minute snapshot
    // as the hot-search and research pages, so detail links cannot drift to a
    // different brief and repeated requests do not amplify collector traffic.
    const privilegedBuild = admin && (body.useAi !== false || body.useBrowserCollectors === true);
    if (!privilegedBuild) {
      const batchKey = hotSearchBatchKey();
      const brief = await getCachedHotSearchBrief(batchKey);
      return NextResponse.json(brief, { headers: { "X-AnalystArena-Batch": batchKey } });
    }

    return NextResponse.json(await buildLiveBrief({
      useAi: body.useAi !== false,
      useBrowserCollectors: body.useBrowserCollectors === true,
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
