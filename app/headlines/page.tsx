import { getDisplayBrief } from "@/lib/display-brief";
import { attachEquityImpacts } from "@/lib/equity-impact";
import { getLiveBriefContextBrief, normalizeLiveBriefContext } from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";
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
      brief = await localizeBriefContent((await getDisplayBrief()).brief);
    }
  } else {
    brief = await localizeBriefContent((await getDisplayBrief()).brief);
  }
  brief = { ...brief, headlines: await attachEquityImpacts(brief.headlines) };
  return <HeadlineExplorer brief={brief} initialEvent={event} context={isTrendingContext ? "trending" : undefined} contextBatch={contextBatch} />;
}
