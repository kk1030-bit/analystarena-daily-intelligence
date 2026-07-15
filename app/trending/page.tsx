import { unstable_cache } from "next/cache";
import { demoBrief } from "@/lib/demo-data";
import { getLatestPublished } from "@/lib/db";
import { buildLiveBrief } from "@/lib/pipeline";
import { localizeBriefContent } from "@/lib/translation";
import { TrendingBoard } from "./TrendingBoard";

export const dynamic = "force-dynamic";

const getCachedLiveBrief = unstable_cache(
  () => buildLiveBrief({ useAi: false, useBrowserCollectors: false }),
  ["analystarena-hot-search-v1"],
  { revalidate: 600 },
);

export default async function TrendingPage({ searchParams }: { searchParams: Promise<{ refresh?: string }> }) {
  const { refresh } = await searchParams;
  let brief;

  try {
    brief = refresh
      ? await buildLiveBrief({ useAi: false, useBrowserCollectors: false })
      : await getCachedLiveBrief();
  } catch {
    const latest = await getLatestPublished().catch(() => null);
    brief = await localizeBriefContent(latest?.brief ?? demoBrief);
  }

  return <TrendingBoard brief={brief} />;
}
