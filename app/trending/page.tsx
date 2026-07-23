import { getDisplayBrief } from "@/lib/display-brief";
import { getLiveBriefContextResult, normalizeLiveBriefContext } from "@/lib/live-brief";
import { TrendingBoard } from "./TrendingBoard";
import type { LiveBriefResult } from "@/lib/live-brief";

export const dynamic = "force-dynamic";

export default async function TrendingPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const { refresh } = await searchParams;
  const context = normalizeLiveBriefContext(refresh);
  let result: LiveBriefResult;

  try {
    result = await getLiveBriefContextResult(context.contextKey);
  } catch {
    result = {
      brief: (await getDisplayBrief()).brief,
      fallback: "published",
      errorCode: "LIVE_BRIEF_COLLECTION_FAILED",
    };
  }

  return <TrendingBoard
    brief={result.brief}
    contextBatch={context.contextKey}
    fallback={result.fallback}
    errorCode={result.errorCode}
  />;
}
