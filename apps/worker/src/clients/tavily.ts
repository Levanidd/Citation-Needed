import { z } from "zod";
import { TIMEOUTS } from "../config.ts";
import { AgentError } from "../errors.ts";
import { withTimeout } from "../util.ts";

export interface TavilyConfig {
  apiKey: string;
  baseUrl: string;
}

const SearchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
    }),
  ),
});

const ExtractResponse = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })).default([]),
  failed_results: z.array(z.object({ url: z.string(), error: z.string().nullish() })).default([]),
});

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ExtractedPage {
  url: string;
  content: string;
}

/** Non-fatal Tavily failure: reported back to the model as a tool error. */
export class TavilyError extends Error {
  override name = "TavilyError";
}

async function call(cfg: TavilyConfig, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: withTimeout(signal, TIMEOUTS.tavily),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new TavilyError(`Tavily ${path} timed out or failed to connect`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AgentError(
      "tavily_auth",
      `Tavily rejected the API key (HTTP ${res.status}). Check TAVILY_API_KEY in apps/worker/.dev.vars or run \`wrangler secret put TAVILY_API_KEY\`.`,
      false,
    );
  }
  if (res.status === 432 || res.status === 433) {
    throw new AgentError("tavily_quota", "Tavily plan or credit limit reached. Top up the Tavily account and retry.", false);
  }
  if (res.status === 429) {
    throw new AgentError("tavily_rate_limited", "Tavily is rate limiting requests. Wait a minute and retry.", true);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TavilyError(`Tavily ${path} failed with HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export async function tavilySearch(
  cfg: TavilyConfig,
  query: string,
  signal: AbortSignal,
  maxResults = 5,
): Promise<SearchHit[]> {
  const raw = await call(cfg, "/search", { query, search_depth: "advanced", max_results: maxResults }, signal);
  const parsed = SearchResponse.safeParse(raw);
  if (!parsed.success) throw new TavilyError("Tavily /search returned an unexpected payload");
  return parsed.data.results.map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content ?? "" }));
}

export async function tavilyExtract(
  cfg: TavilyConfig,
  urls: string[],
  signal: AbortSignal,
): Promise<{ pages: ExtractedPage[]; failed: { url: string; error: string }[] }> {
  const raw = await call(cfg, "/extract", { urls, extract_depth: "basic", format: "markdown", timeout: 15 }, signal);
  const parsed = ExtractResponse.safeParse(raw);
  if (!parsed.success) throw new TavilyError("Tavily /extract returned an unexpected payload");
  return {
    pages: parsed.data.results
      .filter((r) => r.raw_content)
      .map((r) => ({ url: r.url, content: r.raw_content as string })),
    failed: parsed.data.failed_results.map((f) => ({ url: f.url, error: f.error ?? "unknown error" })),
  };
}
