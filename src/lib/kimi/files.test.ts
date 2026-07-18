import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteFile,
  getExtractedText,
  MAX_FILE_BYTES,
  uploadForExtract,
  uploadImage,
} from "./files";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubEnv("MOONSHOT_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("uploadForExtract", () => {
  it("posts multipart with purpose=file-extract and returns the file id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "file-abc", object: "file", purpose: "file-extract" }),
    );

    const result = await uploadForExtract(
      new Uint8Array([1, 2, 3]),
      "labs.pdf",
    );

    expect(result).toEqual({ fileId: "file-abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.moonshot.ai/v1/files");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    const form = init?.body as FormData;
    expect(form.get("purpose")).toBe("file-extract");
    const file = form.get("file") as File;
    expect(file.name).toBe("labs.pdf");
    expect(file.size).toBe(3);
  });

  it("rejects disallowed extensions without calling fetch", async () => {
    await expect(
      uploadForExtract(new Uint8Array([1]), "virus.exe"),
    ).rejects.toMatchObject({ kind: "invalid-file" });
    await expect(
      uploadForExtract(new Uint8Array([1]), "noextension"),
    ).rejects.toMatchObject({ kind: "invalid-file" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts extensions case-insensitively", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "file-1" }));

    await expect(
      uploadForExtract(new Uint8Array([1]), "SCAN.PDF"),
    ).resolves.toEqual({ fileId: "file-1" });
  });

  it("rejects empty files without calling fetch", async () => {
    await expect(
      uploadForExtract(new Uint8Array(0), "a.pdf"),
    ).rejects.toMatchObject({ kind: "invalid-file" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects files over 100 MB without calling fetch", async () => {
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);

    await expect(uploadForExtract(oversized, "huge.pdf")).rejects.toMatchObject(
      {
        kind: "invalid-file",
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the API returns no file id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ object: "file" }));

    await expect(
      uploadForExtract(new Uint8Array([1]), "labs.pdf"),
    ).rejects.toMatchObject({ kind: "unknown" });
  });
});

describe("uploadImage", () => {
  it("posts with purpose=image and returns an ms:// image reference", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "img-9" }));

    const result = await uploadImage(new Uint8Array([1, 2]), "scan.png");

    expect(result).toEqual({ kind: "image-ref", fileId: "img-9" });
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("purpose")).toBe("image");
  });
});

describe("getExtractedText", () => {
  it("returns extracted text from the JSON content field", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        content: "Hemoglobinas 150 g/L",
        file_type: "pdf",
        status: "ok",
      }),
    );

    const result = await getExtractedText("file-123");

    expect(result).toEqual({ kind: "text", text: "Hemoglobinas 150 g/L" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.moonshot.ai/v1/files/file-123/content",
    );
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("detects empty extraction (scanned PDF) as kind=empty", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ content: "  \n ", file_type: "pdf", status: "ok" }),
    );

    await expect(getExtractedText("file-123")).resolves.toEqual({
      kind: "empty",
    });
  });

  it("falls back to treating a non-JSON body as plain text", async () => {
    fetchMock.mockResolvedValueOnce(new Response("raw text", { status: 200 }));

    await expect(getExtractedText("file-123")).resolves.toEqual({
      kind: "text",
      text: "raw text",
    });
  });

  it("retries transient server errors and then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: "boom" } }, 500))
      .mockResolvedValueOnce(jsonResponse({ content: "text" }));

    const promise = getExtractedText("file-123");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toEqual({ kind: "text", text: "text" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps fetch timeouts to a retryable timeout error", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    const promise = getExtractedText("file-123");
    const assertion = expect(promise).rejects.toMatchObject({
      kind: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("deleteFile", () => {
  it("issues a DELETE against the file resource", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: true }));

    await expect(deleteFile("file-123")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.moonshot.ai/v1/files/file-123");
    expect(init?.method).toBe("DELETE");
  });

  it("surfaces non-OK responses as typed errors without retrying", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "not found" } }, 404),
    );

    await expect(deleteFile("file-123")).rejects.toMatchObject({
      kind: "api",
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
