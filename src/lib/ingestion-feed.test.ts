import { describe, expect, it } from "vitest";

import {
  describeVerdict,
  formatSize,
  mergeFeedDocuments,
  stageVisuals,
  type FeedDocument,
  type IngestionFeedDocument,
} from "./ingestion-feed";

function feedDoc(
  overrides: Partial<IngestionFeedDocument> = {},
): IngestionFeedDocument {
  return {
    id: "doc-1",
    filename: "labs.pdf",
    status: "uploaded",
    documentType: "unknown",
    provider: null,
    documentDate: null,
    summary: null,
    uploadedAt: "2026-07-18T10:00:00.000Z",
    edited: false,
    stageError: null,
    sizeBytes: null,
    biomarkerCount: 0,
    ...overrides,
  };
}

describe("mergeFeedDocuments", () => {
  it("stamps first-seen statuses and keeps them across polls", () => {
    const t0 = "2026-07-18T10:00:03.000Z";
    const t1 = "2026-07-18T10:00:06.000Z";

    const first = mergeFeedDocuments([], [feedDoc()], t0);
    expect(first[0]?.observedAt).toEqual({
      uploaded: "2026-07-18T10:00:00.000Z",
    });

    const second = mergeFeedDocuments(
      first,
      [feedDoc({ status: "classifying" })],
      t1,
    );
    expect(second[0]?.observedAt).toEqual({
      uploaded: "2026-07-18T10:00:00.000Z",
      classifying: t1,
    });

    // A later poll in the same status must not move the timestamp.
    const third = mergeFeedDocuments(
      second,
      [feedDoc({ status: "classifying" })],
      "2026-07-18T10:00:09.000Z",
    );
    expect(third[0]?.observedAt.classifying).toBe(t1);
  });

  it("a document first observed mid-pipeline gets its current stage stamped", () => {
    const now = "2026-07-18T10:05:00.000Z";
    const [doc] = mergeFeedDocuments(
      [],
      [feedDoc({ status: "extracting" })],
      now,
    );
    expect(doc?.observedAt.extracting).toBe(now);
    expect(doc?.observedAt.uploaded).toBe("2026-07-18T10:00:00.000Z");
  });

  it("follows server order and drops documents that left the feed", () => {
    const previous: FeedDocument[] = mergeFeedDocuments(
      [],
      [feedDoc({ id: "a" }), feedDoc({ id: "b" })],
      "2026-07-18T10:00:03.000Z",
    );
    const next = mergeFeedDocuments(
      previous,
      [feedDoc({ id: "b" })],
      "2026-07-18T10:00:06.000Z",
    );
    expect(next.map((doc) => doc.id)).toEqual(["b"]);
  });
});

describe("describeVerdict", () => {
  it("renders type, biomarker count, and date", () => {
    expect(
      describeVerdict({
        documentType: "lab_report",
        biomarkerCount: 14,
        documentDate: "2026-01-30",
      }),
    ).toBe("Lab report — 14 biomarkers, 2026-01-30");
  });

  it("singularizes one biomarker", () => {
    expect(
      describeVerdict({
        documentType: "lab_report",
        biomarkerCount: 1,
        documentDate: null,
      }),
    ).toBe("Lab report — 1 biomarker");
  });

  it("falls back to details only when the type is unknown", () => {
    expect(
      describeVerdict({
        documentType: "unknown",
        biomarkerCount: 3,
        documentDate: "2026-01-30",
      }),
    ).toBe("3 biomarkers, 2026-01-30");
  });

  it("renders the bare type when there are no details", () => {
    expect(
      describeVerdict({
        documentType: "medical_doc",
        biomarkerCount: 0,
        documentDate: null,
      }),
    ).toBe("Medical doc");
  });

  it("returns null when there is nothing to say", () => {
    expect(
      describeVerdict({
        documentType: "unknown",
        biomarkerCount: 0,
        documentDate: null,
      }),
    ).toBeNull();
  });
});

describe("stageVisuals", () => {
  it("marks stages before the current one done and later ones upcoming", () => {
    expect(stageVisuals({ status: "extracting" })).toEqual({
      uploaded: "done",
      classifying: "done",
      extracting: "current",
      normalizing: "upcoming",
      summarizing: "upcoming",
      done: "upcoming",
    });
  });

  it("marks everything done for a done document", () => {
    const visuals = stageVisuals({ status: "done" });
    expect(Object.values(visuals).every((v) => v === "done")).toBe(true);
  });

  it("points at the failing stage from stage_error", () => {
    expect(
      stageVisuals({
        status: "failed",
        stageError: { stage: "extracting", message: "boom" },
      }),
    ).toEqual({
      uploaded: "done",
      classifying: "done",
      extracting: "failed",
      normalizing: "upcoming",
      summarizing: "upcoming",
      done: "upcoming",
    });
  });

  it("uses review styling for needs_review", () => {
    const visuals = stageVisuals({
      status: "needs_review",
      stageError: { stage: "classifying", message: "low confidence" },
    });
    expect(visuals.classifying).toBe("review");
    expect(visuals.uploaded).toBe("done");
  });

  it("falls back to just-after-upload when the stage is unknown", () => {
    const visuals = stageVisuals({ status: "failed", stageError: null });
    expect(visuals.uploaded).toBe("done");
    expect(visuals.classifying).toBe("failed");
    expect(visuals.extracting).toBe("upcoming");
  });
});

describe("formatSize", () => {
  it("formats bytes, KB, MB, and GB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1_500_000)).toBe("1.4 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("returns null for unknown sizes", () => {
    expect(formatSize(null)).toBeNull();
  });
});
