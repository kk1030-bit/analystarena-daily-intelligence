import { Dashboard } from "./Dashboard";
import { getDisplayBrief } from "@/lib/display-brief";
import { attachEquityImpacts } from "@/lib/equity-impact";
import { localizeBriefContent } from "@/lib/translation";

export const dynamic = "force-dynamic";

export default async function Home() {
  const selected = await getDisplayBrief();
  // A generated draft is more useful than a date-shifted static demo. Its
  // draft status remains visible in the dashboard until a reviewer publishes.
  const localized = await localizeBriefContent(selected.brief);
  const headlines = await attachEquityImpacts(localized.headlines);
  return <Dashboard initialBrief={{ ...localized, headlines }} />;
}
