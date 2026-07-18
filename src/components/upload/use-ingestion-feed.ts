"use client";

import { useCallback, useEffect, useState } from "react";

import {
  mergeFeedDocuments,
  type FeedDocument,
  type IngestionFeedResponse,
} from "@/lib/ingestion-feed";

const POLL_ACTIVE_MS = 3_000;
const POLL_ERROR_MS = 10_000;

export interface IngestionFeed {
  documents: FeedDocument[];
  hasActive: boolean;
  /** False until the first fetch settles (avoid flashing the empty state). */
  loaded: boolean;
  error: string | null;
  /** Fetch immediately and resume polling (after an upload or an action). */
  refresh: () => void;
}

/**
 * Polls GET /api/documents?status=active: every 3 s while any document is
 * non-terminal (per the epic), backing off to 10 s on errors, and pausing
 * entirely once the pipeline is idle. Poll timestamps come from the server
 * (polledAt) so stage times don't depend on the browser clock.
 */
export function useIngestionFeed(): IngestionFeed {
  const [documents, setDocuments] = useState<FeedDocument[]>([]);
  const [hasActive, setHasActive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const response = await fetch("/api/documents?status=active", {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`status feed failed (${response.status})`);
        }
        const data = (await response.json()) as IngestionFeedResponse;
        if (stopped) return;
        setDocuments((previous) =>
          mergeFeedDocuments(previous, data.documents, data.polledAt),
        );
        setHasActive(data.hasActive);
        setError(null);
        setLoaded(true);
        if (data.hasActive) {
          timer = setTimeout(tick, POLL_ACTIVE_MS);
        }
      } catch (cause) {
        if (stopped) return;
        setError(
          cause instanceof Error ? cause.message : "status feed failed",
        );
        setLoaded(true);
        timer = setTimeout(tick, POLL_ERROR_MS);
      }
    }

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  return { documents, hasActive, loaded, error, refresh };
}
