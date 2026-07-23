import { getDisplayBrief } from "@/lib/display-brief";
import { getLiveBriefContextBrief, normalizeLiveBriefContext } from "@/lib/live-brief";
import { SignalExplorer } from "./SignalExplorer";

export const dynamic = "force-dynamic";

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ platform?: string; filter?: string; evidence?: string; signal?: string; context?: string; batch?: string }> }) {
  const { platform, filter, evidence, signal, context, batch } = await searchParams;
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
  const legacyFilter = !signal && !filter && (platform === "reddit" || platform === "x") ? platform : undefined;
  return <SignalExplorer brief={brief} initialPlatform={platform} initialFilter={filter ?? legacyFilter} initialEvidence={evidence} initialSignal={signal} context={isTrendingContext ? "trending" : undefined} contextBatch={contextBatch} />;
}
