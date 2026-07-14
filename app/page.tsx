import { Dashboard } from "./Dashboard";
import { demoBrief } from "@/lib/demo-data";
import { getLatestPublished } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const latest = await getLatestPublished().catch(() => null);
  return <Dashboard initialBrief={latest?.brief ?? demoBrief} />;
}
