import { IngestionStatusStrip } from "@/components/ingestion-status-strip";
import { OverviewView } from "@/components/overview-view";
import { db } from "@/db";
import { loadOverviewData } from "@/lib/overview";

// Reads the database per request; never prerendered at build time.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const data = await loadOverviewData(db);
  return (
    <div className="flex flex-col gap-4">
      <IngestionStatusStrip />
      <OverviewView data={data} />
    </div>
  );
}
