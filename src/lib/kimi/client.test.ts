import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatStructured,
  createSerialQueue,
  KIMI_MODELS,
  KimiError,
  toKimiError,
  withBackoff,
} from "./client";

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

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function chatCompletion(content: string | null, finishReason = "stop") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "kimi-k2.6",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const minimalParams = {
  schema: { name: "test", schema: { type: "object" }, strict: true },
  messages: [{ role: "user" as const, content: "extract" }],
};

describe("KIMI_MODELS", () => {
  it("defaults to kimi-k2.6 / kimi-k3", async () => {
    vi.stubEnv("KIMI_MODEL_CHAT", undefined);
    vi.resetModules();
    const mod = await import("./client");
    expect(mod.KIMI_MODELS).toEqual({ chat: "kimi-k2.6", expert: "kimi-k3" });
  });

  it("honors the KIMI_MODEL_CHAT override", async () => {
    vi.stubEnv("KIMI_MODEL_CHAT", "kimi-custom");
    vi.resetModules();
    const mod = await import("./client");
    expect(mod.KIMI_MODELS.chat).toBe("kimi-custom");
    expect(mod.KIMI_MODELS.expert).toBe("kimi-k3");
  });
});

describe("createSerialQueue", () => {
  it("runs tasks one at a time, in order", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const first = queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first");
      return 1;
    });
    const second = queue(async () => {
      order.push("second");
      return 2;
    });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps running after a task rejects", async () => {
    const queue = createSerialQueue();
    const failing = queue(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(queue(async () => "ok")).resolves.toBe("ok");
  });
});

describe("withBackoff", () => {
  const sleepRecorder = (sleeps: number[]) => async (ms: number) => {
    sleeps.push(ms);
  };

  it("returns immediately on success", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockResolvedValue("done");
    await expect(
      withBackoff(fn, { sleep: sleepRecorder(sleeps) }),
    ).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("retries retryable errors with exponential backoff", async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new KimiError("rate-limit", "x"))
      .mockRejectedValueOnce(new KimiError("server", "x"))
      .mockResolvedValueOnce("done");
    await expect(
      withBackoff(fn, { sleep: sleepRecorder(sleeps) }),
    ).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("prefers the server-provided Retry-After over the computed delay", async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new KimiError("rate-limit", "x", { retryAfterMs: 30_000 }),
      )
      .mockResolvedValueOnce("done");
    await withBackoff(fn, { sleep: sleepRecorder(sleeps) });
    expect(sleeps).toEqual([30_000]);
  });

  it("does not retry non-retryable errors", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValue(new KimiError("auth", "x"));
    await expect(
      withBackoff(fn, { sleep: sleepRecorder(sleeps) }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("throws the last error after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new KimiError("server", "x"));
    await expect(
      withBackoff(fn, { sleep: sleepRecorder([]) }),
    ).rejects.toMatchObject({ kind: "server" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("maps raw SDK errors before deciding to retry", async () => {
    const fn = vi.fn().mockRejectedValue(new APIConnectionTimeoutError());
    await expect(
      withBackoff(fn, { sleep: sleepRecorder([]) }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("toKimiError", () => {
  it("passes KimiError through unchanged", () => {
    const error = new KimiError("auth", "x");
    expect(toKimiError(error)).toBe(error);
  });

  it("maps SDK status errors to kinds", () => {
    expect(
      toKimiError(new APIError(401, {}, "bad key", new Headers())),
    ).toMatchObject({
      kind: "auth",
      status: 401,
    });
    expect(
      toKimiError(new APIError(403, {}, "forbidden", new Headers())),
    ).toMatchObject({
      kind: "auth",
      status: 403,
    });
    expect(
      toKimiError(
        new APIError(429, {}, "rpm", new Headers({ "retry-after": "30" })),
      ),
    ).toMatchObject({ kind: "rate-limit", retryAfterMs: 30_000 });
    expect(
      toKimiError(new APIError(503, {}, "down", new Headers())),
    ).toMatchObject({
      kind: "server",
      status: 503,
    });
    expect(
      toKimiError(
        new APIError(
          400,
          { code: "context_length_exceeded" },
          "This model's maximum context length is 262144 tokens",
          new Headers(),
        ),
      ),
    ).toMatchObject({ kind: "context-overflow", status: 400 });
    expect(
      toKimiError(new APIError(400, {}, "bad request", new Headers())),
    ).toMatchObject({
      kind: "api",
      status: 400,
    });
  });

  it("maps timeouts and failures", () => {
    expect(toKimiError(new APIConnectionTimeoutError())).toMatchObject({
      kind: "timeout",
    });
    expect(
      toKimiError(new DOMException("The operation timed out", "TimeoutError")),
    ).toMatchObject({ kind: "timeout" });
    expect(toKimiError(new Error("socket hangup"))).toMatchObject({
      kind: "unknown",
    });
    expect(toKimiError("weird")).toMatchObject({ kind: "unknown" });
  });

  it("maps connection failures to the retryable network kind", () => {
    const sdkFailure = toKimiError(
      new APIConnectionError({ message: "Connection error." }),
    );
    expect(sdkFailure).toMatchObject({ kind: "network" });
    expect(sdkFailure.retryable).toBe(true);

    // Plain fetch (kimiFetch) surfaces refused/reset connections this way.
    const fetchFailure = toKimiError(
      new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
      }),
    );
    expect(fetchFailure).toMatchObject({ kind: "network" });
    expect(fetchFailure.retryable).toBe(true);
    expect(fetchFailure.message).toContain("ECONNREFUSED");
  });
});

describe("chatStructured", () => {
  it("sends a json_schema completion without temperature and returns raw content", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(chatCompletion('{"a":1}')));

    const result = await chatStructured(minimalParams);

    expect(result).toBe('{"a":1}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("kimi-k2.6");
    expect(body).not.toHaveProperty("temperature");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "test", schema: { type: "object" }, strict: true },
    });
  });

  it("uses the model override (expert escalation)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(chatCompletion("{}")));

    await chatStructured({ ...minimalParams, model: KIMI_MODELS.expert });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("kimi-k3");
  });

  it("reports token usage to onUsage", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(chatCompletion('{"a":1}')));

    const seen: unknown[] = [];
    await chatStructured({
      ...minimalParams,
      onUsage: (usage) => seen.push(usage),
    });

    expect(seen).toEqual([
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    ]);
  });

  it("maps 401 to an auth error without retrying", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid Authentication" } }, 401),
    );

    await expect(chatStructured(minimalParams)).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 400 context_length_exceeded to context-overflow without retrying", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            message:
              "This model's maximum context length is 262144 tokens. However, your messages resulted in 300000 tokens.",
            code: "context_length_exceeded",
          },
        },
        400,
      ),
    );

    await expect(chatStructured(minimalParams)).rejects.toMatchObject({
      kind: "context-overflow",
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 with backoff and then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "slow down" } }, 429),
      )
      .mockResolvedValueOnce(jsonResponse(chatCompletion('{"ok":true}')));

    const promise = chatStructured(minimalParams);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts on persistent 429", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "slow down" } }, 429),
    );

    const promise = chatStructured(minimalParams);
    const assertion = expect(promise).rejects.toMatchObject({
      kind: "rate-limit",
      status: 429,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats finish_reason 'length' as context-overflow", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(chatCompletion('{"truncated":', "length")),
    );

    await expect(chatStructured(minimalParams)).rejects.toMatchObject({
      kind: "context-overflow",
    });
  });

  it("rejects on a completion with no choices", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...chatCompletion(null), choices: [] }),
    );

    await expect(chatStructured(minimalParams)).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  it("rejects on an empty completion content", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(chatCompletion(null)));

    await expect(chatStructured(minimalParams)).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  it("fails fast when MOONSHOT_API_KEY is unset, without calling fetch", async () => {
    vi.stubEnv("MOONSHOT_API_KEY", undefined);
    vi.resetModules();
    const fresh = await import("./client");

    await expect(fresh.chatStructured(minimalParams)).rejects.toMatchObject({
      kind: "auth",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
