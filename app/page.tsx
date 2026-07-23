import { Dashboard } from "./Dashboard";
import { getDisplayBrief } from "@/lib/display-brief";

export const dynamic = "force-dynamic";

export default async function Home() {
  const selected = await getDisplayBrief();
  // Published JSON, the market-headline view, and the PDF must all render the
  // same frozen payload. Dynamic translation/mapping belongs to collection or
  // an explicit live context, never to a published read.
  return <Dashboard initialBrief={selected.brief} />;
}
