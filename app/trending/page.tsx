import { getDisplayBrief } from "@/lib/display-brief";
import { getLiveBriefContextBrief, normalizeLiveBriefContext } from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";
import { TrendingBoard } from "./TrendingBoard";

export const dynamic = "force-dynamic";

export default async function TrendingPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const { refresh } = await searchParams;
  const context = normalizeLiveBriefContext(refresh);
  let brief;

  try {
    brief = await getLiveBriefContextBrief(context.contextKey);
  } catch {
    brief = await localizeBriefContent((await getDisplayBrief()).brief);
  }

  return <TrendingBoard brief={brief} contextBatch={context.contextKey} />;
}
