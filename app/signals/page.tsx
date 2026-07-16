import { demoBrief } from "@/lib/demo-data";
import { getLatestPublished } from "@/lib/db";
import { getCachedHotSearchBrief, normalizeHotSearchBatchKey } from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";
import { SignalExplorer } from "./SignalExplorer";

export const dynamic = "force-dynamic";

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ platform?: string; filter?: string; evidence?: string; signal?: string; context?: string; batch?: string }> }) {
  const { platform, filter, evidence, signal, context, batch } = await searchParams;
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
  const legacyFilter = !signal && !filter && (platform === "reddit" || platform === "x") ? platform : undefined;
  return <SignalExplorer brief={brief} initialPlatform={platform} initialFilter={filter ?? legacyFilter} initialEvidence={evidence} initialSignal={signal} context={isTrendingContext ? "trending" : undefined} contextBatch={contextBatch} />;
}
