/**
 * Server-only Kimi (Moonshot AI) API client.
 *
 * Every Kimi call in web and worker must go through this module: calls are
 * serialized through `kimiQueue` (a fresh Moonshot account is Tier0: 3 RPM, 1
 * concurrency) and retried with exponential backoff on 429/5xx/timeouts.
 *
 * Live-API caveats baked in (from the k2.6 smoke eval on real LT lab reports):
 * - temperature is never sent: kimi-k2.6 rejects any value other than 1.
 * - read timeout is 600s and timeouts are retried: k2.6 burns most of its
 *   output tokens on reasoning, so document extractions can run 4+ minutes.
 */

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/kimi is server-only; never import it from client code",
  );
}

/**
 * Overridable for tests and the compose e2e stack (docker-compose.e2e.yml
 * points it at the kimi-mock service); production leaves it unset.
 */
export const KIMI_API_BASE_URL =
  process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";

/** Read timeout for every Kimi call; document extractions can run 4+ minutes. */
export const KIMI_TIMEOUT_MS = 600_000;

/**
 * Model IDs live behind this config — they move fast. Callers pass
 * KIMI_MODELS.expert for escalations; routing decisions live in the pipeline
 * stages, not here.
 */
export const KIMI_MODELS = {
  chat: process.env.KIMI_MODEL_CHAT ?? "kimi-k2.6",
  expert: "kimi-k3",
} as const;

export type KimiErrorKind =
  | "auth" // 401/403, or MOONSHOT_API_KEY missing
  | "rate-limit" // 429 — retried
  | "server" // 5xx — retried
  | "timeout" // read/connect timeout — retried
  | "network" // connection failed (DNS, refused, reset) — retried
  | "context-overflow" // prompt or completion exceeds the model's context/output window
  | "invalid-file" // client-side file validation (extension/size)
  | "api" // any other non-OK API response
  | "unknown"; // parse failures, malformed completions

const RETRYABLE_KINDS: ReadonlySet<KimiErrorKind> = new Set([
  "rate-limit",
  "server",
  "timeout",
  "network",
]);

/** Never wait longer than this on a server-provided Retry-After. */
const MAX_RETRY_AFTER_MS = 120_000;

export class KimiError extends Error {
  readonly kind: KimiErrorKind;
  readonly status?: number;
  /** Server-provided Retry-After hint, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(
    kind: KimiErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "KimiError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

/**
 * A promise queue running tasks one at a time. A rejecting task rejects its
 * own caller but never blocks the queue.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** The shared queue every Kimi call (web and worker) must go through. */
export const kimiQueue = createSerialQueue();

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

export interface BackoffOptions {
  /** Total attempts including the first call. Default 3. */
  maxAttempts?: number;
  /** Delay before the first retry; doubles each attempt. Default 1000ms. */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying retryable KimiErrors (429/5xx/timeout) with exponential
 * backoff. A server-provided Retry-After overrides the computed delay. Any
 * thrown value is first mapped through `toKimiError`.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = defaultSleep,
  } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const kimiError = toKimiError(error);
      if (attempt >= maxAttempts || !kimiError.retryable) {
        throw kimiError;
      }
      await sleep(kimiError.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

const CONTEXT_OVERFLOW_PATTERNS = [
  /context[_ ]length/i,
  /context window/i,
  /too many tokens/i,
  /maximum.*tokens/i,
];

function isContextOverflow(
  code: string | undefined,
  message: string | undefined,
): boolean {
  const haystack = `${code ?? ""} ${message ?? ""}`;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(haystack));
}

function parseRetryAfter(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function kimiErrorFromStatus(
  status: number | undefined,
  code: string | undefined,
  message: string,
  headers: Headers | undefined,
  cause?: unknown,
): KimiError {
  const retryAfterMs = parseRetryAfter(headers);
  if (status === 401 || status === 403) {
    return new KimiError("auth", `Kimi authentication failed: ${message}`, {
      status,
      cause,
    });
  }
  if (status === 429) {
    return new KimiError("rate-limit", `Kimi rate limit hit: ${message}`, {
      status,
      retryAfterMs,
      cause,
    });
  }
  if (status !== undefined && status >= 500) {
    return new KimiError(
      "server",
      `Kimi server error (${status}): ${message}`,
      {
        status,
        retryAfterMs,
        cause,
      },
    );
  }
  if (status === 400 && isContextOverflow(code, message)) {
    return new KimiError(
      "context-overflow",
      `Kimi context overflow: ${message}`,
      {
        status,
        cause,
      },
    );
  }
  return new KimiError(
    "api",
    `Kimi API error (${status ?? "no status"}): ${message}`,
    {
      status,
      cause,
    },
  );
}

/** Map any thrown value to a typed KimiError. */
export function toKimiError(error: unknown): KimiError {
  if (error instanceof KimiError) return error;
  if (error instanceof APIConnectionTimeoutError) {
    return new KimiError(
      "timeout",
      `Kimi request timed out after ${KIMI_TIMEOUT_MS}ms`,
      { cause: error },
    );
  }
  if (error instanceof APIConnectionError) {
    return new KimiError(
      "network",
      `Kimi connection failed: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (error instanceof APIError) {
    return kimiErrorFromStatus(
      error.status,
      error.code ?? undefined,
      error.message,
      error.headers,
      error,
    );
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new KimiError(
      "timeout",
      `Kimi request timed out after ${KIMI_TIMEOUT_MS}ms`,
      { cause: error },
    );
  }
  // Plain fetch (kimiFetch) surfaces connection failures as TypeError
  // "fetch failed" with the socket error as its cause.
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    const cause =
      error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return new KimiError(
      "network",
      `Kimi connection failed${cause || `: ${error.message}`}`,
      { cause: error },
    );
  }
  if (error instanceof Error) {
    return new KimiError("unknown", error.message, { cause: error });
  }
  return new KimiError("unknown", String(error));
}

function getApiKey(): string {
  const key = process.env.MOONSHOT_API_KEY;
  if (!key) {
    throw new KimiError("auth", "MOONSHOT_API_KEY is not set");
  }
  return key;
}

let openaiClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      baseURL: KIMI_API_BASE_URL,
      apiKey: getApiKey(),
      timeout: KIMI_TIMEOUT_MS,
      maxRetries: 0, // retries live in withBackoff, not in the SDK
      // Forward to the *current* global fetch so tests can stub it at any time.
      fetch: (url, init) => globalThis.fetch(url, init),
    });
  }
  return openaiClient;
}

export interface JsonSchemaDefinition {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

/** Token usage of one completion, as reported by the API. */
export interface KimiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatStructuredParams {
  /** Passed through as response_format.json_schema. */
  schema: JsonSchemaDefinition;
  messages: ChatCompletionMessageParam[];
  /** Defaults to KIMI_MODELS.chat; pass KIMI_MODELS.expert for escalations. */
  model?: string;
  /**
   * Observer fired once per successful completion with its token usage
   * (eval/telemetry). Also fires for completions that are then rejected
   * (empty content, finish_reason 'length') — those tokens were spent.
   */
  onUsage?: (usage: KimiUsage) => void;
}

/**
 * Call Kimi chat completions with a JSON Schema response format and return the
 * raw JSON string. NO validation happens here — callers validate (zod) and own
 * retry/escalation decisions.
 */
export async function chatStructured(
  params: ChatStructuredParams,
): Promise<string> {
  const model = params.model ?? KIMI_MODELS.chat;
  return kimiQueue(() =>
    withBackoff(async () => {
      const completion = await getOpenAIClient().chat.completions.create({
        model,
        messages: params.messages,
        response_format: { type: "json_schema", json_schema: params.schema },
      });
      if (params.onUsage && completion.usage) {
        params.onUsage({
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        });
      }
      const choice = completion.choices[0];
      if (!choice) {
        throw new KimiError(
          "unknown",
          "Kimi returned a completion with no choices",
        );
      }
      if (choice.finish_reason === "length") {
        throw new KimiError(
          "context-overflow",
          `Kimi completion hit the output token limit (model ${model})`,
        );
      }
      const content = choice.message.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new KimiError("unknown", "Kimi returned an empty completion");
      }
      return content;
    }),
  );
}

/**
 * Low-level authenticated fetch against the Kimi REST API (used by the Files
 * API wrapper; chat goes through the OpenAI SDK). Adds the bearer token and a
 * 600s timeout, and maps non-OK responses to typed KimiErrors. Does NOT queue
 * or retry — callers wrap with kimiQueue/withBackoff.
 */
export async function kimiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getApiKey()}`);
  let response: Response;
  try {
    response = await globalThis.fetch(`${KIMI_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });
  } catch (error) {
    throw toKimiError(error);
  }
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response;
}

async function errorFromResponse(response: Response): Promise<KimiError> {
  let message = response.statusText || "request failed";
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const apiError = (
        body as { error?: { message?: unknown; code?: unknown } }
      ).error;
      if (apiError && typeof apiError === "object") {
        if (typeof apiError.message === "string") message = apiError.message;
        if (typeof apiError.code === "string") code = apiError.code;
      }
    }
  } catch {
    // Body wasn't JSON — keep the status text.
  }
  return kimiErrorFromStatus(response.status, code, message, response.headers);
}
