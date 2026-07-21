import { NextResponse } from "next/server";
import { demoBrief } from "@/lib/demo-data";
import { getDisplayBrief } from "@/lib/display-brief";
import { isAdminRequest } from "@/lib/auth";
import {
  buildFreshLiveBrief,
  getCachedHotSearchResult,
  getForcedHotSearchResult,
  hotSearchBatchKey,
  manualRefreshContextKey,
  MANUAL_REFRESH_WINDOW_MS,
  type LiveBriefResult,
} from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function liveHeaders(
  result: LiveBriefResult,
  batchKey: string | undefined,
  refreshMode: "shared" | "forced" | "privileged",
): Record<string, string> {
  const stale = result.fallback !== "none";
  return {
    "Cache-Control": "no-store",
    ...(batchKey ? { "X-AnalystArena-Batch": batchKey } : {}),
    "X-AnalystArena-Generated-At": result.brief.generatedAt,
    "X-AnalystArena-Fallback": result.fallback,
    "X-AnalystArena-Stale": stale ? "1" : "0",
    "X-AnalystArena-Error-Code": result.errorCode ?? "none",
    "X-AnalystArena-Refresh-Mode": refreshMode,
    "X-AnalystArena-Refresh-Window": refreshMode === "forced" ? String(MANUAL_REFRESH_WINDOW_MS / 1_000) : "0",
  };
}

export async function GET() {
  const selected = await getDisplayBrief();
  return NextResponse.json(await localizeBriefContent(selected.brief), {
    headers: {
      "Cache-Control": "no-store",
      "X-AnalystArena-Origin": selected.origin,
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      live?: boolean;
      force?: boolean;
      useAi?: boolean;
      useBrowserCollectors?: boolean;
    };
    if (!body.live) return NextResponse.json(await localizeBriefContent(demoBrief, { strict: true }), {
      headers: { "Cache-Control": "no-store" },
    });

    const admin = isAdminRequest(request);
    const privilegedBuild = admin && (body.useAi !== false || body.useBrowserCollectors === true);
    const sharedBatchKey = hotSearchBatchKey();

    if (privilegedBuild) {
      const result = await buildFreshLiveBrief({
        useAi: body.useAi !== false,
        useBrowserCollectors: body.useBrowserCollectors === true,
      }, {
        stream: "privileged",
        batchKey: `privileged:${sharedBatchKey}:${Date.now()}`,
      });
      return NextResponse.json(result.brief, {
        headers: liveHeaders(result, undefined, "privileged"),
      });
    }

    // Anonymous automatic refreshes use the shared ten-minute snapshot. A
    // deliberate button click may bypass it, but forced refreshes are globally
    // coalesced into a bounded two-minute cache window on the server.
    const forced = body.force === true;
    const forcedAt = Date.now();
    const forcedContext = forced ? manualRefreshContextKey(forcedAt) : undefined;
    const result = forced
      ? await getForcedHotSearchResult(forcedAt)
      : await getCachedHotSearchResult(sharedBatchKey);
    return NextResponse.json(result.brief, {
      headers: liveHeaders(result, forcedContext ?? sharedBatchKey, forced ? "forced" : "shared"),
    });
  } catch (error) {
    console.error("Live brief refresh failed", error);
    return NextResponse.json({
      error: "实时资讯更新失败，且数据库中没有可用日报，请稍后重试。",
      code: "LIVE_BRIEF_UPDATE_FAILED",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-AnalystArena-Fallback": "none",
        "X-AnalystArena-Stale": "0",
        "X-AnalystArena-Error-Code": "LIVE_BRIEF_UPDATE_FAILED",
      },
    });
  }
}
