// Chat-completions wrapper for the /chat assistant: Kimi with OpenAI-style
// tool calling. Reuses the shared serial queue + backoff from
// src/lib/kimi/client.ts (Tier0: 3 RPM, 1 concurrency) but needs the full
// message object back (tool_calls, reasoning_content), which chatStructured
// does not expose — hence this module instead.

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import {
  KIMI_API_BASE_URL,
  KIMI_MODELS,
  KIMI_TIMEOUT_MS,
  KimiError,
  kimiQueue,
  withBackoff,
} from "../kimi/client";

if (typeof window !== "undefined") {
  throw new Error("src/lib/chat is server-only; never import it from client code");
}

let openaiClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new KimiError("auth", "MOONSHOT_API_KEY is not set");
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      baseURL: KIMI_API_BASE_URL,
      apiKey,
      timeout: KIMI_TIMEOUT_MS,
      maxRetries: 0, // retries live in withBackoff, not in the SDK
      // Forward to the *current* global fetch so tests can stub it at any time.
      fetch: (url, init) => globalThis.fetch(url, init),
    });
  }
  return openaiClient;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string of the arguments, as returned by the model. */
  argumentsJson: string;
}

export interface ChatCompletionResult {
  content: string | null;
  /**
   * Kimi thinking models return reasoning_content and REQUIRE it echoed back
   * on the assistant message in the next request of a multi-turn exchange.
   */
  reasoningContent?: string;
  toolCalls: ToolCallRequest[];
  finishReason: string | null;
}

/**
 * One non-streaming chat completion with tools. Serialized through kimiQueue
 * and retried via withBackoff like every other Kimi call. No temperature:
 * kimi-k2.6 rejects any value other than 1.
 */
export async function chatCompletionWithTools(params: {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  model?: string;
}): Promise<ChatCompletionResult> {
  const model = params.model ?? KIMI_MODELS.chat;
  return kimiQueue(() =>
    withBackoff(async () => {
      const completion = await getOpenAIClient().chat.completions.create({
        model,
        messages: params.messages,
        tools: params.tools,
      });
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
      const message = choice.message;
      const toolCalls: ToolCallRequest[] = (message.tool_calls ?? [])
        // The SDK union includes custom tool calls; Moonshot only emits
        // function calls, and anything else has no dispatch target here.
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          argumentsJson: call.function.arguments,
        }));
      return {
        content: message.content,
        reasoningContent: (
          message as { reasoning_content?: string }
        ).reasoning_content,
        toolCalls,
        finishReason: choice.finish_reason,
      };
    }),
  );
}
