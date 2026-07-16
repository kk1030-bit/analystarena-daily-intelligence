import { demoBrief } from "@/lib/demo-data";
import { getLatestPublished } from "@/lib/db";
import { getCachedHotSearchBrief, normalizeHotSearchBatchKey } from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";
import { HeadlineExplorer } from "./HeadlineExplorer";

export const dynamic = "force-dynamic";

export default async function HeadlinesPage({ searchParams }: { searchParams: Promise<{ event?: string; context?: string; batch?: string }> }) {
  const { event, context, batch } = await searchParams;
  const isTrendingContext = context === "trending";
  const contextBatch = isTrendingContext ? normalizeHotSearchBatchKey(batch) : undefined;
  let brief;
  if (isTrendingContext) {
    try {
      brief = await getCachedHotSearchBrief(contextBatch);
    } catch {
      const latest = await getLatestPublished().catch(() => null);
      brief = await localizeBriefContent(latest?.brief ?? demoBrief);
    }
  } else {
    const latest = await getLatestPublished().catch(() => null);
    brief = await localizeBriefContent(latest?.brief ?? demoBrief);
  }
  return <HeadlineExplorer brief={brief} initialEvent={event} context={isTrendingContext ? "trending" : undefined} contextBatch={contextBatch} />;
}
