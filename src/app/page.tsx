import { IngestionStatusStrip } from "@/components/ingestion-status-strip";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function OverviewPage() {
  return (
    <div className="flex flex-col gap-4">
      <IngestionStatusStrip />
      <PlaceholderPage
        title="Overview"
        description="A high-level summary of your health data — recent labs, vitals, and AI insights."
      />
    </div>
  );
}
