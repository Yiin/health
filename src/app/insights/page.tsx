import { InsightsView } from "@/components/insights-view";
import { db } from "@/db";
import { loadInsightsData } from "@/lib/insights";

// Reads the database per request; never prerendered at build time.
export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const data = await loadInsightsData(db);
  return <InsightsView data={data} />;
}
