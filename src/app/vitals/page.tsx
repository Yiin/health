import { VitalsClient } from "@/components/vitals/vitals-client";

export default function VitalsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Vitals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily wearable metrics and workouts — steps, HRV, resting heart rate,
          and sleep. The last ~90 days render at full resolution; older history
          is rolled up to weekly or monthly averages. The dashed line is the
          7-day rolling average.
        </p>
      </div>

      <VitalsClient />
    </div>
  );
}
