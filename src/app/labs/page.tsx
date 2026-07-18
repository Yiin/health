import { LabsClient } from "@/components/labs/labs-client";

export default function LabsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Labs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Biomarker results across all your lab reports, grouped by category.
          The band on each sparkline is the latest reference range; red points
          are out of range. Click a biomarker for the full trend and every draw.
        </p>
      </div>

      <LabsClient />
    </div>
  );
}
