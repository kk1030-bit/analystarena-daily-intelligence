import { NextResponse } from "next/server";
import { demoBrief } from "@/lib/demo-data";
import { buildLiveBrief } from "@/lib/pipeline";
import { getLatestPublished } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth";
import { getCachedHotSearchBrief, hotSearchBatchKey, STALE_LIVE_BRIEF_WARNING } from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const published = await getLatestPublished().catch(() => null);
  return NextResponse.json(await localizeBriefContent(published?.brief ?? demoBrief), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { live?: boolean; useAi?: boolean; useBrowserCollectors?: boolean };
    if (!body.live) return NextResponse.json(await localizeBriefContent(demoBrief, { strict: true }), {
      headers: { "Cache-Control": "no-store" },
    });
    const admin = isAdminRequest(request);

    // Anonymous dashboard refreshes reuse the same bounded ten-minute snapshot
    // as the hot-search and research pages, so detail links cannot drift to a
    // different brief and repeated requests do not amplify collector traffic.
    const privilegedBuild = admin && (body.useAi !== false || body.useBrowserCollectors === true);
    if (!privilegedBuild) {
      const batchKey = hotSearchBatchKey();
      const brief = await getCachedHotSearchBrief(batchKey);
      return NextResponse.json(brief, { headers: {
        "Cache-Control": "no-store",
        "X-AnalystArena-Batch": batchKey,
        "X-AnalystArena-Generated-At": brief.generatedAt,
        "X-AnalystArena-Stale": brief.warning === STALE_LIVE_BRIEF_WARNING ? "1" : "0",
      } });
    }

    const brief = await buildLiveBrief({
      useAi: body.useAi !== false,
      useBrowserCollectors: body.useBrowserCollectors === true,
    });
    return NextResponse.json(brief, { headers: {
      "Cache-Control": "no-store",
      "X-AnalystArena-Generated-At": brief.generatedAt,
    } });
  } catch (error) {
    console.error("Live brief refresh failed", error);
    return NextResponse.json({
      error: "实时简报更新失败，页面将保留上一份可用的简体中文内容。",
      code: "LIVE_BRIEF_UPDATE_FAILED",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
