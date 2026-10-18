import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { type CompleteOptions, type Llm, createModels } from "../clients/nebius.ts";
import { type SearchHit, type TavilyConfig, tavilyExtract, tavilySearch } from "../clients/tavily.ts";
import { DEADLINES, LIMITS, type Role, modelNames } from "../config.ts";
import type { ClaimPublic, EventMap, EventType, RunStats, Source, SourcePublic } from "../types.ts";
import { canonicalUrl, domainOf } from "../util.ts";
import { type PreparedPage, preparePage } from "./verifier.ts";

export type Sink = <K extends EventType>(type: K, data: EventMap[K]) => Promise<void>;

/** All state of one research run. Lives for the duration of the request only. */
export class RunContext {
  readonly runId = crypto.randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  readonly models: Record<Role, Llm>;
  /** Client disconnect OR the whole-run soft cap. */
  readonly signal: AbortSignal;

  areas: string[] = [];
  readonly sources: Source[] = [];
  readonly claims: ClaimPublic[] = [];
  private readonly byUrl = new Map<string, Source>();
  private readonly pages = new Map<number, PreparedPage>();

  readonly counters = {
    step: 0,
    searches: 0,
    counterSearches: 0,
    reads: 0,
    autoExtracts: 0,
    llmCalls: 0,
    subrequests: 0,
  };

  private closed = false;

  constructor(
    readonly env: Env,
    readonly question: string,
    readonly clientSignal: AbortSignal,
    private readonly sink: Sink,
  ) {
    this.models = createModels(env);
    this.signal = AbortSignal.any([clientSignal, AbortSignal.timeout(DEADLINES.run)]);
  }

  get modelNames() {
    return modelNames(this.env);
  }

  private get tavily(): TavilyConfig {
    return { apiKey: this.env.TAVILY_API_KEY, baseUrl: this.env.TAVILY_BASE_URL || "https://api.tavily.com" };
  }

  async emit<K extends EventType>(type: K, data: EventMap[K]): Promise<void> {
    if (this.closed) return;
    try {
      await this.sink(type, data);
    } catch {
      this.closed = true;
    }
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  nextStep(): number {
    return ++this.counters.step;
  }

  log(fields: Record<string, unknown>): void {
    console.log(JSON.stringify({ runId: this.runId, t: this.elapsed(), ...fields }));
  }

  canSubrequest(n = 1): boolean {
    return this.counters.subrequests + n <= LIMITS.subrequests;
  }

  async llm(role: Role, messages: ChatCompletionMessageParam[], opts: CompleteOptions): Promise<ChatCompletion> {
    this.counters.subrequests++;
    this.counters.llmCalls++;
    const t = Date.now();
    try {
      return await this.models[role].complete(messages, opts, this.signal);
    } finally {
      this.log({ step: "llm", role, ms: Date.now() - t });
    }
  }

  async search(query: string, kind: "research" | "counter"): Promise<SearchHit[]> {
    this.counters.subrequests++;
    if (kind === "research") this.counters.searches++;
    else this.counters.counterSearches++;
    const t = Date.now();
    try {
      return await tavilySearch(this.tavily, query, this.signal);
    } finally {
      this.log({ step: "search", kind, query, ms: Date.now() - t });
    }
  }

  /** Fetch page text via Tavily /extract and cache it on the source. */
  async extract(source: Source): Promise<PreparedPage | undefined> {
    const cached = this.page(source);
    if (cached) return cached;
    this.counters.subrequests++;
    const t = Date.now();
    try {
      const { pages, failed } = await tavilyExtract(this.tavily, [source.url], this.signal);
      const page = pages[0];
      if (!page) {
        this.log({ step: "extract", url: source.url, ok: false, error: failed[0]?.error, ms: Date.now() - t });
        return undefined;
      }
      source.content = page.content.slice(0, LIMITS.storedPageChars);
      this.log({ step: "extract", url: source.url, ok: true, chars: source.content.length, ms: Date.now() - t });
      return this.page(source);
    } catch (err) {
      this.log({ step: "extract", url: source.url, ok: false, error: String(err), ms: Date.now() - t });
      throw err;
    }
  }

  page(source: Source): PreparedPage | undefined {
    if (!source.content) return undefined;
    let page = this.pages.get(source.id);
    if (!page) {
      page = preparePage(source.content);
      this.pages.set(source.id, page);
    }
    return page;
  }

  source(url: string, title?: string, snippet?: string): { source: Source; isNew: boolean } {
    const key = canonicalUrl(url);
    const existing = this.byUrl.get(key);
    if (existing) {
      if (title && existing.title === existing.domain) existing.title = title.trim();
      if (snippet && !existing.snippet) existing.snippet = snippet;
      return { source: existing, isNew: false };
    }
    const domain = domainOf(url);
    const source: Source = { id: this.sources.length + 1, url, title: title?.trim() || domain, domain, snippet };
    this.sources.push(source);
    this.byUrl.set(key, source);
    return { source, isNew: true };
  }

  findSource(url: string): Source | undefined {
    return this.byUrl.get(canonicalUrl(url));
  }

  sourceById(id: number): Source | undefined {
    return this.sources[id - 1];
  }

  stats(): RunStats {
    const verified = this.claims.filter((c) => c.quoteVerified).length;
    return {
      durationMs: this.elapsed(),
      searches: this.counters.searches,
      counterSearches: this.counters.counterSearches,
      pagesRead: this.sources.filter((s) => s.content).length,
      claims: this.claims.length,
      verifiedQuotes: verified,
      verifiedPct: this.claims.length ? Math.round((verified / this.claims.length) * 100) : 0,
      sources: this.sources.length,
      llmCalls: this.counters.llmCalls,
    };
  }
}

export function publicSource(s: Source): SourcePublic {
  return { id: s.id, url: s.url, title: s.title, domain: s.domain };
}
