import { getDisplayBrief } from "@/lib/display-brief";
import { getLiveBriefContextBrief, normalizeLiveBriefContext } from "@/lib/live-brief";
import { HeadlineExplorer } from "./HeadlineExplorer";

export const dynamic = "force-dynamic";

export default async function HeadlinesPage({ searchParams }: { searchParams: Promise<{ event?: string; context?: string; batch?: string }> }) {
  const { event, context, batch } = await searchParams;
  const isTrendingContext = context === "trending";
  const contextBatch = isTrendingContext ? normalizeLiveBriefContext(batch).contextKey : undefined;
  let brief;
  if (isTrendingContext) {
    try {
      brief = await getLiveBriefContextBrief(contextBatch);
    } catch {
      brief = (await getDisplayBrief()).brief;
    }
  } else {
    brief = (await getDisplayBrief()).brief;
  }
  return <HeadlineExplorer brief={brief} initialEvent={event} context={isTrendingContext ? "trending" : undefined} contextBatch={contextBatch} />;
}
