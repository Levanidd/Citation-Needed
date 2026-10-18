import { z } from "zod";
import { NEWS_TIME_RANGE, TIMEOUTS } from "../config.ts";
import { AgentError } from "../errors.ts";
import { withTimeout } from "../util.ts";

export interface TavilyConfig {
  apiKey: string;
  baseUrl: string;
}

const Usage = z.object({ credits: z.number() }).nullish().catch(undefined);

const SearchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
  usage: Usage,
});

const ExtractResponse = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })).default([]),
  failed_results: z.array(z.object({ url: z.string(), error: z.string().nullish() })).default([]),
  usage: Usage,
});

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  published?: string; // YYYY-MM-DD, news results only
}

function isoDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
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

/** `news` searches Tavily's news index over the last NEWS_TIME_RANGE and returns publication dates. */
export async function tavilySearch(
  cfg: TavilyConfig,
  query: string,
  signal: AbortSignal,
  opts: { news?: boolean; maxResults?: number } = {},
): Promise<{ hits: SearchHit[]; credits: number }> {
  const body = {
    query,
    search_depth: "advanced",
    max_results: opts.maxResults ?? 5,
    include_usage: true,
    ...(opts.news ? { topic: "news", time_range: NEWS_TIME_RANGE } : {}),
  };
  const raw = await call(cfg, "/search", body, signal);
  const parsed = SearchResponse.safeParse(raw);
  if (!parsed.success) throw new TavilyError("Tavily /search returned an unexpected payload");
  return {
    hits: parsed.data.results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.content ?? "",
      published: isoDate(r.published_date),
    })),
    // Advanced search costs 2 credits when Tavily does not report usage.
    credits: parsed.data.usage?.credits ?? 2,
  };
}

export async function tavilyExtract(
  cfg: TavilyConfig,
  urls: string[],
  signal: AbortSignal,
): Promise<{ pages: ExtractedPage[]; failed: { url: string; error: string }[]; credits: number }> {
  const raw = await call(
    cfg,
    "/extract",
    { urls, extract_depth: "basic", format: "markdown", timeout: 15, include_usage: true },
    signal,
  );
  const parsed = ExtractResponse.safeParse(raw);
  if (!parsed.success) throw new TavilyError("Tavily /extract returned an unexpected payload");
  const pages = parsed.data.results
    .filter((r) => r.raw_content)
    .map((r) => ({ url: r.url, content: r.raw_content as string }));
  return {
    pages,
    failed: parsed.data.failed_results.map((f) => ({ url: f.url, error: f.error ?? "unknown error" })),
    // Basic extract costs 1 credit per 5 successful URLs.
    credits: parsed.data.usage?.credits ?? pages.length / 5,
  };
}
