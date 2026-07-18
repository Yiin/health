import { describe, expect, it } from "vitest";

import {
  contentTypeForFilename,
  formatBytes,
  maxUploadBytes,
  UPLOAD_MAX_BYTES_DEFAULT,
} from "./uploads";

describe("contentTypeForFilename", () => {
  it("maps every allowed top-level type", () => {
    expect(contentTypeForFilename("labs.pdf")).toBe("application/pdf");
    expect(contentTypeForFilename("fit.csv")).toBe("text/csv");
    expect(contentTypeForFilename("export.xml")).toBe("application/xml");
    expect(contentTypeForFilename("takeout.zip")).toBe("application/zip");
    expect(contentTypeForFilename("scan.png")).toBe("image/png");
    expect(contentTypeForFilename("scan.jpg")).toBe("image/jpeg");
    expect(contentTypeForFilename("scan.jpeg")).toBe("image/jpeg");
    expect(contentTypeForFilename("scan.webp")).toBe("image/webp");
    expect(contentTypeForFilename("notes.txt")).toBe("text/plain");
    expect(contentTypeForFilename("data.json")).toBe("application/json");
  });

  it("is case-insensitive and uses the last extension", () => {
    expect(contentTypeForFilename("LABS.PDF")).toBe("application/pdf");
    expect(contentTypeForFilename("archive.tar.zip")).toBe("application/zip");
  });

  it("rejects everything else", () => {
    expect(contentTypeForFilename("evil.exe")).toBeNull();
    expect(contentTypeForFilename("archive.tar.gz")).toBeNull();
    expect(contentTypeForFilename("no-extension")).toBeNull();
    expect(contentTypeForFilename(".pdf")).toBe("application/pdf");
  });
});

describe("maxUploadBytes", () => {
  it("defaults to 2 GiB and honors the env override", () => {
    delete process.env.UPLOAD_MAX_BYTES;
    expect(maxUploadBytes()).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    expect(UPLOAD_MAX_BYTES_DEFAULT).toBe(2 * 1024 ** 3);

    process.env.UPLOAD_MAX_BYTES = "1024";
    expect(maxUploadBytes()).toBe(1024);

    process.env.UPLOAD_MAX_BYTES = "garbage";
    expect(maxUploadBytes()).toBe(UPLOAD_MAX_BYTES_DEFAULT);
    delete process.env.UPLOAD_MAX_BYTES;
  });
});

describe("formatBytes", () => {
  it("renders the limit in human units", () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe("2 GB");
    expect(formatBytes(1024)).toBe("1 KB");
  });
});
