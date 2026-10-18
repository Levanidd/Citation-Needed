import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { TavilyError } from "../clients/tavily.ts";
import { DEADLINES, LIMITS } from "../config.ts";
import { AgentError } from "../errors.ts";
import type { ClaimPublic, Source } from "../types.ts";
import { truncate } from "../util.ts";
import { type RunContext, publicSource } from "./context.ts";
import { type ToolCall, type ToolOutcome, parseArgs } from "./toolcalls.ts";
import { citationUrl, preparePage, selectExcerpt, verifyQuote } from "./verifier.ts";

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const reasonProp = {
  type: "string",
  description: "One short sentence (max ~15 words) explaining why you are doing this. Shown to the user as your decision.",
};

const searchTool = fn(
  "web_search",
  "Search the live web (Tavily, advanced depth, top 5 results). Returns titles, URLs and snippets.",
  { query: { type: "string", description: "Specific search query" }, reason: reasonProp },
  ["query", "reason"],
);

// ---------------------------------------------------------------------------
// Researcher tools
// ---------------------------------------------------------------------------

export const researcherTools: ChatCompletionTool[] = [
  fn(
    "plan_areas",
    "Declare the 3–5 risk areas you will cover. Call this first.",
    { areas: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5, description: "Risk area names" } },
    ["areas"],
  ),
  searchTool,
  fn(
    "news_search",
    "Adverse media screening: search news from the last 12 months (Tavily news index) for fines, lawsuits, regulatory actions, data breaches, outages, layoffs or financial trouble. Returns titles, URLs, publication dates and snippets.",
    {
      query: { type: "string", description: "Entity name plus risk terms, e.g. \"Acme fine OR lawsuit OR breach OR investigation\"" },
      reason: reasonProp,
    },
    ["query", "reason"],
  ),
  fn(
    "read_page",
    "Read a web page (Tavily extract). Returns the most relevant ~6k characters of its text. Read a page before quoting it.",
    { url: { type: "string", description: "Exact URL from search results" }, reason: reasonProp },
    ["url", "reason"],
  ),
  fn(
    "record_claim",
    "Record factual claims, each backed by a verbatim quote from a page. Put every relevant fact from a page into one call. Quotes are verified against the page text by code; the result tells you which were found.",
    {
      claims: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        description: "One entry per atomic fact",
        items: {
          type: "object",
          properties: {
            area: { type: "string", description: "One of the planned risk areas" },
            text: { type: "string", description: "One specific, checkable factual statement in your own words" },
            url: { type: "string", description: "URL of the page the quote was copied from" },
            quote: { type: "string", description: "10–40 consecutive words copied verbatim from the page text" },
            fix_claim_id: { type: "string", description: "Only when re-submitting a claim whose quote was not verified" },
          },
          required: ["area", "text", "url", "quote"],
        },
      },
    },
    ["claims"],
  ),
  fn(
    "finish_research",
    "Stop researching. Call when every area has ≥ 2 claims, new searches stop producing evidence, or budgets run out.",
    { reason: reasonProp },
    ["reason"],
  ),
];

const PlanArgs = z.object({
  areas: z.preprocess(
    (v) => (typeof v === "string" ? v.split(/[,;\n]/) : v),
    z.array(z.string().trim().min(2)).min(1),
  ),
});
const SearchArgs = z.object({ query: z.string().trim().min(2).max(400), reason: z.string().trim().default("") });
const ReadArgs = z.object({ url: z.string().trim().min(8), reason: z.string().trim().default("") });
const ClaimArgs = z.object({
  area: z.string().trim().min(1),
  text: z.string().trim().min(5),
  url: z.string().trim().min(8),
  quote: z.string().trim().min(10),
  fix_claim_id: z.string().trim().nullish(),
});
// Also accepts a single flat claim, a bare array, or `claims` serialized as a JSON string.
const ClaimsArgs = z.preprocess(
  (v) => {
    if (Array.isArray(v)) return { claims: v };
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.claims === "string") {
      try {
        return { claims: JSON.parse(o.claims) };
      } catch {
        return v;
      }
    }
    return "claims" in o ? o : { claims: [o] };
  },
  z.object({ claims: z.array(z.unknown()).min(1) }),
);
const FinishArgs = z.object({ reason: z.string().trim().default("") });

export async function runResearcherTool(ctx: RunContext, call: ToolCall): Promise<ToolOutcome> {
  try {
    switch (call.name) {
      case "plan_areas":
        return planAreas(ctx, call.arguments);
      case "web_search":
        return await webSearch(ctx, call.arguments, "research");
      case "news_search":
        return await webSearch(ctx, call.arguments, "news");
      case "read_page":
        return await readPage(ctx, call.arguments);
      case "record_claim":
      case "record_claims":
        return await recordClaims(ctx, call.arguments);
      case "finish_research":
        return finishResearch(ctx);
      default:
        return {
          content: `Unknown tool "${call.name}". Available: plan_areas, web_search, news_search, read_page, record_claim, finish_research.`,
        };
    }
  } catch (err) {
    if (err instanceof AgentError || ctx.signal.aborted) throw err;
    const message = err instanceof TavilyError ? err.message : String(err);
    ctx.log({ step: "tool_error", tool: call.name, error: message });
    return { content: `Tool failed: ${message}` };
  }
}

/** Refuses the first finish if no adverse-media search ran and there is still time for one. */
function finishResearch(ctx: RunContext): ToolOutcome {
  const canScan =
    ctx.counters.newsSearches === 0 && ctx.canSubrequest(4) && ctx.elapsed() < DEADLINES.research - 15_000;
  if (canScan && !ctx.newsReminderSent) {
    ctx.newsReminderSent = true;
    return {
      content:
        "Not finished yet: run news_search once to screen adverse media (fines, lawsuits, breaches, regulatory actions) from the last 12 months, record any incident you find, then call finish_research.",
    };
  }
  return { content: "Research finished.", finish: true };
}

export function finishReason(call: ToolCall): string {
  const args = parseArgs(FinishArgs, call.arguments);
  return args.ok && args.data.reason ? args.data.reason : "Agent decided it has enough evidence";
}

async function planAreas(ctx: RunContext, raw: string): Promise<ToolOutcome> {
  const args = parseArgs(PlanArgs, raw);
  if (!args.ok) return { content: `Invalid arguments: ${args.error}` };
  const areas = [...new Set(args.data.areas.map((a) => a.trim()).filter(Boolean))].slice(0, 5);
  ctx.areas = areas;
  await ctx.emit("plan", { areas });
  ctx.log({ step: "plan", areas });
  return { content: `Planned areas: ${areas.join("; ")}. Now research each area.` };
}

function budgetLine(ctx: RunContext): string {
  return `Budget left: ${LIMITS.searches - ctx.counters.searches} searches, ${LIMITS.newsSearches - ctx.counters.newsSearches} news searches, ${LIMITS.reads - ctx.counters.reads} page reads, ${LIMITS.claims - ctx.claims.length} claims.`;
}

async function webSearch(ctx: RunContext, raw: string, kind: "research" | "news"): Promise<ToolOutcome> {
  const args = parseArgs(SearchArgs, raw);
  if (!args.ok) return { content: `Invalid arguments: ${args.error}` };
  const news = kind === "news";
  const exhausted = news ? ctx.counters.newsSearches >= LIMITS.newsSearches : ctx.counters.searches >= LIMITS.searches;
  if (exhausted || !ctx.canSubrequest(2)) {
    return {
      content: news
        ? "News search budget exhausted. Record claims from what you have found."
        : "Search budget exhausted. Record claims from what you have, then call finish_research.",
    };
  }
  const step = ctx.nextStep();
  await ctx.emit("decision", { step, tool: news ? "news" : "search", input: args.data.query, reason: args.data.reason, phase: "research" });
  const t = Date.now();
  try {
    const hits = await ctx.search(args.data.query, kind);
    const newSources = [];
    const lines: string[] = [];
    for (const hit of hits) {
      const { source, isNew } = ctx.source(hit.url, hit.title, hit.snippet, hit.published);
      if (isNew) newSources.push(publicSource(source));
      const date = hit.published ? `\nPublished: ${hit.published}` : "";
      lines.push(`[${source.id}] ${source.title}\nURL: ${source.url}${date}\n${truncate(hit.snippet.replace(/\s+/g, " "), 500)}`);
    }
    const domains = [...new Set(hits.map((h) => ctx.findSource(h.url)?.domain ?? ""))].filter(Boolean);
    const newest = hits.map((h) => h.published ?? "").sort().at(-1) || undefined;
    if (news) ctx.newsScans.push({ query: args.data.query, results: hits.length, newest });
    const summary = !hits.length
      ? news
        ? "No news in the last 12 months"
        : "No results"
      : news
        ? `${hits.length} news${newest ? ` · newest ${newest}` : ""} · ${domains.slice(0, 3).join(", ")}`
        : `${hits.length} results · ${domains.slice(0, 4).join(", ")}`;
    await ctx.emit("tool_result", { step, summary, newSources, ms: Date.now() - t, ok: true });
    if (!hits.length) return { content: `No results for "${args.data.query}". Try a different query. ${budgetLine(ctx)}` };
    return { content: `Results for "${args.data.query}":\n\n${lines.join("\n\n")}\n\n${budgetLine(ctx)}` };
  } catch (err) {
    if (err instanceof AgentError || ctx.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    await ctx.emit("tool_result", { step, summary: `Search failed: ${message}`, newSources: [], ms: Date.now() - t, ok: false });
    return { content: `Search failed: ${message}. Try again with a different query.` };
  }
}

async function readPage(ctx: RunContext, raw: string): Promise<ToolOutcome> {
  const args = parseArgs(ReadArgs, raw);
  if (!args.ok) return { content: `Invalid arguments: ${args.error}` };
  const { source, isNew } = ctx.source(args.data.url);
  const alreadyRead = Boolean(source.content);
  if (!alreadyRead && (ctx.counters.reads >= LIMITS.reads || !ctx.canSubrequest(2))) {
    return { content: "Page-read budget exhausted. Record claims from pages you have read, then call finish_research." };
  }
  const step = ctx.nextStep();
  await ctx.emit("decision", { step, tool: "read", input: source.url, reason: args.data.reason, phase: "research" });
  const t = Date.now();
  if (!alreadyRead) ctx.counters.reads++;
  try {
    const page = await ctx.extract(source);
    if (!page || page.plain.trim().length < 200) {
      await ctx.emit("tool_result", {
        step,
        summary: `Could not extract text from ${source.domain}`,
        newSources: isNew ? [publicSource(source)] : [],
        ms: Date.now() - t,
        ok: false,
      });
      return { content: `Could not read ${source.url} (blocked, empty or not HTML). Try another result. ${budgetLine(ctx)}` };
    }
    const focus = `${ctx.question} ${args.data.reason} ${ctx.areas.join(" ")}`;
    const excerpt = selectExcerpt(page.plain, focus, LIMITS.readCharsToModel);
    await ctx.emit("tool_result", {
      step,
      summary: `${alreadyRead ? "Re-read" : "Read"} ${source.domain} · ${page.plain.length.toLocaleString("en-US")} chars`,
      newSources: isNew ? [publicSource(source)] : [],
      ms: Date.now() - t,
      ok: true,
    });
    return {
      content: `Page [${source.id}] ${source.title}\nURL: ${source.url}\n(${page.plain.length} chars; most relevant excerpts below — quote them verbatim)\n\n${excerpt}\n\n${budgetLine(ctx)}`,
    };
  } catch (err) {
    if (err instanceof AgentError || ctx.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    await ctx.emit("tool_result", { step, summary: `Read failed: ${message}`, newSources: [], ms: Date.now() - t, ok: false });
    return { content: `Read failed: ${message}. Try another page.` };
  }
}

function matchArea(ctx: RunContext, area: string): string {
  const lower = area.toLowerCase();
  const exact = ctx.areas.find((a) => a.toLowerCase() === lower);
  if (exact) return exact;
  const partial = ctx.areas.find((a) => a.toLowerCase().includes(lower) || lower.includes(a.toLowerCase()));
  if (partial) return partial;
  if (ctx.areas.length < 6) {
    ctx.areas.push(area);
    void ctx.emit("plan", { areas: [...ctx.areas] });
  }
  return area;
}

/** Text to verify the quote against: the extracted page, fetching it once if needed. */
async function verificationCorpus(ctx: RunContext, source: Source) {
  const page = ctx.page(source);
  if (page) return page;
  if (ctx.counters.autoExtracts < LIMITS.autoExtracts && ctx.canSubrequest(2)) {
    ctx.counters.autoExtracts++;
    try {
      const fetched = await ctx.extract(source);
      if (fetched) return fetched;
    } catch (err) {
      if (err instanceof AgentError || ctx.signal.aborted) throw err;
    }
  }
  return source.snippet ? preparePage(source.snippet) : undefined;
}

async function recordClaims(ctx: RunContext, raw: string): Promise<ToolOutcome> {
  const args = parseArgs(ClaimsArgs, raw);
  if (!args.ok) return { content: `Invalid arguments: ${args.error}` };
  const results: Record<string, unknown>[] = [];
  for (const item of args.data.claims) {
    const parsed = ClaimArgs.safeParse(item);
    if (!parsed.success) {
      results.push({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "claim"}: ${i.message}`).join("; ") });
      continue;
    }
    results.push(await recordClaim(ctx, parsed.data));
  }
  const coverage = Object.fromEntries(ctx.areas.map((a) => [a, ctx.claims.filter((c) => c.area === a).length]));
  return { content: JSON.stringify({ results, coverage, claims_left: LIMITS.claims - ctx.claims.length }) };
}

async function recordClaim(ctx: RunContext, args: z.infer<typeof ClaimArgs>): Promise<Record<string, unknown>> {
  const { area, text, url, quote, fix_claim_id } = args;
  const existing = fix_claim_id ? ctx.claims.find((c) => c.id === fix_claim_id) : undefined;
  if (!existing && ctx.claims.length >= LIMITS.claims) {
    return { error: "Claim budget reached. Call finish_research now." };
  }

  const { source } = ctx.source(url);
  const corpus = await verificationCorpus(ctx, source);
  const match = corpus ? verifyQuote(corpus, quote) : { verified: false as const, method: "none" as const, score: 0 };

  const claim: ClaimPublic = {
    id: existing?.id ?? `c${ctx.claims.length + 1}`,
    area: matchArea(ctx, area),
    text,
    sourceId: source.id,
    quote,
    quoteVerified: match.verified,
    citationUrl: citationUrl(source.url, match.matchedText ?? quote),
  };
  if (existing) Object.assign(existing, claim);
  else ctx.claims.push(claim);

  await ctx.emit("claim", { claim, source: publicSource(source), fixed: Boolean(existing) });
  ctx.log({ step: "claim", id: claim.id, verified: match.verified, method: match.method, domain: source.domain });

  const result: Record<string, unknown> = { claim_id: claim.id, verified: match.verified };
  if (!match.verified) {
    result.hint = corpus
      ? `Quote not found verbatim on ${source.url}. Copy 10–40 consecutive words exactly as written on the page and re-submit with fix_claim_id="${claim.id}".`
      : `Could not fetch ${source.url} to verify the quote. Use a URL you have read with read_page and re-submit with fix_claim_id="${claim.id}".`;
  }
  return result;
}
