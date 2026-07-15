import { Dashboard } from "./Dashboard";
import { demoBrief } from "@/lib/demo-data";
import { getLatestPublished } from "@/lib/db";
import { localizeBriefContent } from "@/lib/translation";

export const dynamic = "force-dynamic";

export default async function Home() {
  const latest = await getLatestPublished().catch(() => null);
  const localized = await localizeBriefContent(latest?.brief ?? demoBrief);
  return <Dashboard initialBrief={localized} />;
}
