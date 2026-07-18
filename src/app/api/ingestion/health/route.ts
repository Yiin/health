import { NextResponse } from "next/server";

import { getSqlClient } from "@/db";
import { getIngestionHealth } from "@/lib/ingestion-health";

// Counts change with every job/status transition — never cache.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await getIngestionHealth(getSqlClient());
    return NextResponse.json({ ok: true, ...health });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
