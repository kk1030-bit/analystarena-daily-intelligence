import { demoBrief } from "@/lib/demo-data";
import { getLatestPublished } from "@/lib/db";
import { getCachedHotSearchBrief, normalizeHotSearchBatchKey } from "@/lib/live-brief";
import { localizeBriefContent } from "@/lib/translation";
import { TrendingBoard } from "./TrendingBoard";

export const dynamic = "force-dynamic";

export default async function TrendingPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const { refresh } = await searchParams;
  const batchKey = normalizeHotSearchBatchKey(refresh);
  let brief;

  try {
    brief = await getCachedHotSearchBrief(batchKey);
  } catch {
    const latest = await getLatestPublished().catch(() => null);
    brief = await localizeBriefContent(latest?.brief ?? demoBrief);
  }

  return <TrendingBoard brief={brief} contextBatch={batchKey} />;
}
