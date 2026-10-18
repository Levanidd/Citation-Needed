import OpenAI from "openai";
import type { CompletionUsage } from "openai/resources/completions";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { DEFAULT_NEBIUS_BASE_URL, type Role, TIMEOUTS, roleConfigs, roleExtraBody } from "../config.ts";
import { AgentError } from "../errors.ts";
import { withTimeout } from "../util.ts";

export interface CompleteOptions {
  tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
  maxTokens?: number;
  temperature?: number;
}

/** One Token Factory model bound to a role (research / check / write). */
export class Llm {
  private readonly client: OpenAI;

  constructor(
    readonly role: Role,
    readonly model: string,
    baseURL: string,
    apiKey: string,
    private readonly extra: Record<string, unknown>,
  ) {
    this.client = new OpenAI({ apiKey, baseURL, timeout: TIMEOUTS.llm, maxRetries: 1 });
  }

  async complete(
    messages: ChatCompletionMessageParam[],
    opts: CompleteOptions,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    const body = {
      ...this.extra,
      model: this.model,
      messages,
      tools: opts.tools,
      tool_choice: opts.tools ? (opts.toolChoice ?? "auto") : undefined,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.4,
    } as ChatCompletionCreateParamsNonStreaming;
    try {
      return await this.client.chat.completions.create(body, { signal: withTimeout(signal, TIMEOUTS.llm) });
    } catch (err) {
      throw this.mapError(err, signal);
    }
  }

  /** Streams visible content deltas, skipping any inline <think> blocks. */
  async *stream(
    messages: ChatCompletionMessageParam[],
    opts: Omit<CompleteOptions, "tools" | "toolChoice">,
    signal: AbortSignal,
    onUsage?: (usage: CompletionUsage) => void,
  ): AsyncGenerator<string> {
    const body = {
      ...this.extra,
      model: this.model,
      messages,
      max_tokens: opts.maxTokens ?? 3000,
      temperature: opts.temperature ?? 0.3,
      stream: true,
      stream_options: { include_usage: true },
    } as ChatCompletionCreateParamsStreaming;
    let thinking = false;
    let pending = "";
    try {
      const stream = await this.client.chat.completions.create(body, { signal });
      for await (const chunk of stream) {
        if (chunk.usage) onUsage?.(chunk.usage);
        pending += chunk.choices[0]?.delta?.content ?? "";
        let out = "";
        while (pending) {
          if (thinking) {
            const end = pending.indexOf("</think>");
            if (end < 0) {
              pending = pending.slice(-8);
              break;
            }
            pending = pending.slice(end + 8);
            thinking = false;
          } else {
            const start = pending.indexOf("<think>");
            if (start < 0) {
              // Keep a short tail in case "<think>" is split across chunks.
              const safe = pending.lastIndexOf("<") > pending.length - 7 ? pending.lastIndexOf("<") : pending.length;
              out += pending.slice(0, safe);
              pending = pending.slice(safe);
              break;
            }
            out += pending.slice(0, start);
            pending = pending.slice(start + 7);
            thinking = true;
          }
        }
        if (out) yield out;
      }
      if (!thinking && pending) yield pending;
    } catch (err) {
      throw this.mapError(err, signal);
    }
  }

  private mapError(err: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return err;
    if (err instanceof OpenAI.APIError) {
      if (err.status === 401 || err.status === 403) {
        return new AgentError(
          "nebius_auth",
          `Token Factory rejected the API key (HTTP ${err.status}). Check NEBIUS_API_KEY.`,
          false,
        );
      }
      if (err.status === 404) {
        return new AgentError(
          "nebius_model",
          `Model "${this.model}" was not found at the configured Token Factory endpoint. Check NEBIUS_MODEL_* and NEBIUS_BASE_URL* (regional models may need e.g. https://api.tokenfactory.us-central1.nebius.com/v1).`,
          false,
        );
      }
      if (err.status === 429) {
        return new AgentError("nebius_rate_limited", "Token Factory is rate limiting requests. Wait a moment and retry.", true);
      }
    }
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      return new AgentError("nebius_timeout", `The ${this.role} model did not answer within 60s.`, true);
    }
    return err;
  }
}

/** USD per token. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

const ModelList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      pricing: z.object({ prompt: z.coerce.number(), completion: z.coerce.number() }).nullish().catch(undefined),
    }),
  ),
});

let priceCache: Map<string, ModelPrice> | undefined;

/** Per-token prices from the Token Factory model list, cached per isolate. `fetched` = a request was made. */
export async function modelPrices(env: Env, signal: AbortSignal): Promise<{ prices: Map<string, ModelPrice>; fetched: boolean }> {
  if (priceCache) return { prices: priceCache, fetched: false };
  try {
    const base = (env.NEBIUS_BASE_URL || DEFAULT_NEBIUS_BASE_URL).replace(/\/$/, "");
    const res = await fetch(`${base}/models?verbose=true`, {
      headers: { authorization: `Bearer ${env.NEBIUS_API_KEY}` },
      signal: withTimeout(signal, TIMEOUTS.prices),
    });
    const parsed = res.ok ? ModelList.safeParse(await res.json()) : undefined;
    if (!parsed?.success) return { prices: new Map(), fetched: true };
    priceCache = new Map(parsed.data.data.flatMap((m) => (m.pricing ? [[m.id, m.pricing] as const] : [])));
    return { prices: priceCache, fetched: true };
  } catch {
    return { prices: new Map(), fetched: true };
  }
}

export function createModels(env: Env): Record<Role, Llm> {
  const cfg = roleConfigs(env);
  const make = (role: Role) => new Llm(role, cfg[role].model, cfg[role].baseURL, env.NEBIUS_API_KEY, roleExtraBody(env, role));
  return { research: make("research"), check: make("check"), write: make("write") };
}
