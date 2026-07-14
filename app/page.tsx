import { Dashboard } from "./Dashboard";
import { demoBrief } from "@/lib/demo-data";

export default function Home() {
  return <Dashboard initialBrief={demoBrief} />;
}
