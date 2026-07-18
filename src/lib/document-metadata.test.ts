import { describe, expect, test } from "vitest";

import { effectiveMetadata, parseMetadataPatch } from "./document-metadata";

const extracted = {
  documentType: "lab_report" as const,
  provider: "UAB Hila",
  documentDate: "2026-07-01",
};

describe("effectiveMetadata", () => {
  test("returns extracted values when there are no overrides", () => {
    const result = effectiveMetadata({ ...extracted, metadataOverrides: null });
    expect(result).toEqual({ ...extracted, edited: false });
  });

  test("overrides win over extracted values and flag the row as edited", () => {
    const result = effectiveMetadata({
      ...extracted,
      metadataOverrides: { documentType: "medical_doc", provider: "Manual" },
    });
    expect(result).toEqual({
      documentType: "medical_doc",
      provider: "Manual",
      documentDate: "2026-07-01",
      edited: true,
    });
  });

  test("an explicit null override clears the field instead of falling back", () => {
    const result = effectiveMetadata({
      ...extracted,
      metadataOverrides: { provider: null, documentDate: null },
    });
    expect(result.provider).toBeNull();
    expect(result.documentDate).toBeNull();
    expect(result.documentType).toBe("lab_report");
    expect(result.edited).toBe(true);
  });
});

describe("parseMetadataPatch", () => {
  test("accepts a full valid patch", () => {
    const result = parseMetadataPatch({
      documentType: "medical_doc",
      provider: "Antea",
      documentDate: "2026-01-15",
    });
    expect(result).toEqual({
      ok: true,
      overrides: {
        documentType: "medical_doc",
        provider: "Antea",
        documentDate: "2026-01-15",
      },
    });
  });

  test("accepts a partial patch and ignores unknown keys", () => {
    const result = parseMetadataPatch({ provider: "Oura", bogus: 1 });
    expect(result).toEqual({ ok: true, overrides: { provider: "Oura" } });
  });

  test("treats empty provider/date as cleared (null)", () => {
    const result = parseMetadataPatch({ provider: "  ", documentDate: "" });
    expect(result).toEqual({
      ok: true,
      overrides: { provider: null, documentDate: null },
    });
  });

  test("trims provider whitespace", () => {
    const result = parseMetadataPatch({ provider: "  UAB Hila  " });
    expect(result).toEqual({ ok: true, overrides: { provider: "UAB Hila" } });
  });

  test("rejects non-object bodies", () => {
    for (const body of [null, "x", 42, []]) {
      expect(parseMetadataPatch(body).ok).toBe(false);
    }
  });

  test("rejects an empty patch", () => {
    const result = parseMetadataPatch({ unrelated: true });
    expect(result.ok).toBe(false);
  });

  test("rejects an unknown documentType", () => {
    const result = parseMetadataPatch({ documentType: "x-ray" });
    expect(result.ok).toBe(false);
  });

  test("rejects malformed dates", () => {
    for (const documentDate of ["2026-13-01", "2026-02-30", "yesterday", 5]) {
      expect(parseMetadataPatch({ documentDate }).ok).toBe(false);
    }
  });

  test("rejects non-string provider", () => {
    expect(parseMetadataPatch({ provider: 42 }).ok).toBe(false);
  });

  test("rejects an over-long provider", () => {
    const result = parseMetadataPatch({ provider: "x".repeat(201) });
    expect(result.ok).toBe(false);
  });
});
