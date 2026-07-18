// Unit tests for the vision I/O primitives (worker/vision.ts): poppler
// rasterization (real pdftoppm/pdfinfo — skipped when poppler-utils is not
// installed locally), vision message construction, and filename sniffing.
// The upload/delete wrappers around the Kimi Files API are one-liners whose
// behavior is covered by src/lib/kimi/files.test.ts, so they are not
// re-tested here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildImagePdf } from "../fixtures/health-docs/generate.mjs";

import {
  isImageFilename,
  MAX_VISION_PAGES,
  rasterizePdfPages,
  visionUserContent,
} from "./vision";

const POPPLER_AVAILABLE = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const FIXTURES_DIR = new URL("../fixtures/health-docs/", import.meta.url);

function fixtureBytes(filename: string): Uint8Array {
  const buffer = readFileSync(new URL(filename, FIXTURES_DIR));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function expectJpeg(bytes: Uint8Array): void {
  expect([...bytes.subarray(0, 3)]).toEqual(JPEG_MAGIC);
}

describe("rasterizePdfPages (real poppler)", () => {
  it.skipIf(!POPPLER_AVAILABLE)(
    "rasterizes a scanned single-page lab PDF to one JPEG",
    async () => {
      const result = await rasterizePdfPages(fixtureBytes("scanned-lab.pdf"));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.pageCount).toBe(1);
      expect(result.pages).toHaveLength(1);
      expectJpeg(result.pages[0]);
      // 150 DPI A4 ≈ 1240x1754 px — a real render, not an empty stub.
      expect(result.pages[0].length).toBeGreaterThan(20_000);
    },
  );

  it.skipIf(!POPPLER_AVAILABLE)(
    "rasterizes every page of a multi-page PDF, in order",
    async () => {
      const photo = fixtureBytes("lab-photo.jpg");
      const jpeg = Buffer.from(photo.buffer, photo.byteOffset, photo.length);
      const twoPage = buildImagePdf([jpeg, jpeg]);
      const result = await rasterizePdfPages(new Uint8Array(twoPage));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.pageCount).toBe(2);
      expect(result.pages).toHaveLength(2);
      for (const page of result.pages) expectJpeg(page);
    },
  );

  it.skipIf(!POPPLER_AVAILABLE)(
    `refuses a ${MAX_VISION_PAGES + 1}-page scan without rendering it`,
    async () => {
      const photo = fixtureBytes("lab-photo.jpg");
      const jpeg = Buffer.from(photo.buffer, photo.byteOffset, photo.length);
      const manyPages = buildImagePdf(
        Array.from({ length: MAX_VISION_PAGES + 1 }, () => jpeg),
      );
      const result = await rasterizePdfPages(new Uint8Array(manyPages));
      expect(result).toEqual({
        kind: "too-many-pages",
        pageCount: MAX_VISION_PAGES + 1,
      });
    },
  );

  it.skipIf(!POPPLER_AVAILABLE)("fails cleanly on non-PDF bytes", async () => {
    const result = await rasterizePdfPages(
      new TextEncoder().encode("this is not a PDF at all"),
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.detail).toBeTruthy();
  });
});

describe("visionUserContent", () => {
  it("builds one text part followed by image parts in page order", () => {
    const content = visionUserContent("Extract everything.", [
      "ms://file-a",
      "ms://file-b",
    ]);
    expect(content).toEqual([
      { type: "text", text: "Extract everything." },
      { type: "image_url", image_url: { url: "ms://file-a" } },
      { type: "image_url", image_url: { url: "ms://file-b" } },
    ]);
  });
});

describe("isImageFilename", () => {
  it("accepts the image extensions Kimi vision takes", () => {
    for (const name of [
      "photo.jpg",
      "photo.jpeg",
      "scan.png",
      "scan.webp",
      "scan.tiff",
      "scan.tif",
      "UPPER.JPG",
    ]) {
      expect(isImageFilename(name), name).toBe(true);
    }
  });

  it("rejects non-image files", () => {
    for (const name of ["report.pdf", "export.csv", "notes.txt", "noext"]) {
      expect(isImageFilename(name), name).toBe(false);
    }
  });
});
