export interface WorkoutItem {
  id: string;
  startedAt: string;
  endedAt: string | null;
  type: string;
  durationS: number | null;
  distanceM: number | null;
  calories: number | null;
  avgHr: number | null;
  maxHr: number | null;
  source: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 2700 → "45:00", 3661 → "1:01:01". */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

/**
 * The workouts table on /vitals: type, date, duration, distance, and average
 * heart rate per session, most recent first.
 */
export function WorkoutsTable({ workouts }: { workouts: WorkoutItem[] }) {
  if (workouts.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        No workouts yet — they appear here once a wearable export with
        activities is ingested.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-left font-medium">Date</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="px-3 py-2 text-right font-medium">Distance</th>
            <th className="px-3 py-2 text-right font-medium">Avg HR</th>
            <th className="px-3 py-2 text-left font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {workouts.map((workout) => (
            <tr key={workout.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium capitalize">
                {workout.type.replaceAll("_", " ")}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {formatDate(workout.startedAt)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {workout.durationS === null
                  ? "—"
                  : formatDuration(workout.durationS)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {workout.distanceM === null
                  ? "—"
                  : formatDistance(workout.distanceM)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {workout.avgHr === null ? "—" : `${workout.avgHr} bpm`}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {workout.source}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
