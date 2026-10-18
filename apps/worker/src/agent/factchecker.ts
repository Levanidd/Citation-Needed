import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { DEADLINES, LIMITS } from "../config.ts";
import { AgentError } from "../errors.ts";
import factcheckerPrompt from "../prompts/factchecker.md";
import type { ClaimPublic, Verdict } from "../types.ts";
import { fill, today, truncate } from "../util.ts";
import { computeConfidence, isPrimaryDomain } from "./confidence.ts";
import { type RunContext, publicSource } from "./context.ts";
import { extractToolCalls, parseArgs } from "./toolcalls.ts";

const submitTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_verdicts",
    description: "Submit a verdict for EVERY claim. Call once, after your counter-searches.",
    parameters: {
      type: "object",
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim_id: { type: "string" },
              verdict: { type: "string", enum: ["supported", "contested", "unverified"] },
              note: { type: "string", description: "≤ 20 words: why" },
              source_type: { type: "string", enum: ["primary", "secondary"] },
              corroborating_url: {
                type: "string",
                description: "URL from your counter-search results, on a different domain, that confirms the claim. Provide whenever one exists.",
              },
              counter_evidence_url: { type: "string", description: "Optional: URL that contradicts the claim" },
              adverse_event: {
                type: "boolean",
                description:
                  "true if the claim describes a negative event: fine, lawsuit, regulatory investigation or action, data breach or security incident, outage, layoffs or losses",
              },
            },
            required: ["claim_id", "verdict", "note", "source_type"],
          },
        },
      },
      required: ["verdicts"],
    },
  },
};

const counterSearchTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Run counter-searches on the live web (Tavily, top 5 results each), one per claim you want to break. Put all of them into this single call; they run in parallel.",
    parameters: {
      type: "object",
      properties: {
        searches: {
          type: "array",
          minItems: 1,
          maxItems: LIMITS.counterSearches,
          items: {
            type: "object",
            properties: {
              claim_id: { type: "string", description: "The claim this counter-search tries to break" },
              query: { type: "string", description: "Specific search query" },
              reason: { type: "string", description: "One short sentence (max ~15 words). Shown to the user as your decision." },
            },
            required: ["claim_id", "query", "reason"],
          },
        },
      },
      required: ["searches"],
    },
  },
};

const checkerTools: ChatCompletionTool[] = [counterSearchTool, submitTool];

const CounterSearchItem = z.object({
  query: z.string().trim().min(2).max(400),
  reason: z.string().trim().default(""),
  claim_id: z.string().trim().default(""),
});
// Also accepts a single flat search or a bare array.
const CounterSearchArgs = z.preprocess(
  (v) => (Array.isArray(v) ? { searches: v } : v && typeof v === "object" && !("searches" in v) ? { searches: [v] } : v),
  z.object({ searches: z.array(z.unknown()).min(1) }),
);

const VERDICT_SYNONYMS: Record<string, Verdict> = {
  confirmed: "supported",
  verified: "supported",
  true: "supported",
  disputed: "contested",
  refuted: "contested",
  contradicted: "contested",
  false: "contested",
  unverifiable: "unverified",
  unclear: "unverified",
  insufficient: "unverified",
};

/** "c3", "C3", "c:c3" and "3" all mean claim c3. */
function normalizeClaimId(raw: string): string {
  const id = raw.trim().toLowerCase().replace(/^c:/, "");
  return /^\d+$/.test(id) ? `c${id}` : id;
}

const VerdictItem = z.object({
  claim_id: z.union([z.string(), z.number()]).transform((v) => normalizeClaimId(String(v))),
  verdict: z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const key = v.toLowerCase().trim();
    return VERDICT_SYNONYMS[key] ?? key;
  }, z.enum(["supported", "contested", "unverified"])),
  note: z.string().trim().default(""),
  source_type: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase().trim() : v), z.enum(["primary", "secondary"])).catch("secondary"),
  corroborating_url: z.string().trim().nullish(),
  counter_evidence_url: z.string().trim().nullish(),
  adverse_event: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() === "true" : v), z.boolean()).catch(false),
});
const SubmitArgs = z.object({ verdicts: z.array(z.unknown()) });

type VerdictInput = z.infer<typeof VerdictItem>;

/** Reasoning models such as Reflection Beam reject follow-up turns whose earlier assistant messages lack their reasoning_content. */
function assistantTurn(message: ChatCompletionMessage, toolCalls?: ChatCompletionMessageToolCall[]): ChatCompletionAssistantMessageParam {
  const reasoning = (message as { reasoning_content?: unknown }).reasoning_content;
  return {
    role: "assistant",
    content: message.content ?? "",
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(typeof reasoning === "string" && reasoning ? { reasoning_content: reasoning } : {}),
  } as ChatCompletionAssistantMessageParam;
}

function describeClaims(ctx: RunContext): string {
  const lines = ctx.claims.map((c) => {
    const source = ctx.sourceById(c.sourceId);
    return [
      `- id: ${c.id}`,
      `  area: ${c.area}`,
      `  claim: ${c.text}`,
      `  quote: "${truncate(c.quote, 400)}"`,
      `  source: ${source?.domain ?? "unknown"} (${source?.url ?? ""})`,
      `  quote_verified_on_page: ${c.quoteVerified ? "yes" : "NO"}`,
    ].join("\n");
  });
  return `Question under research: ${ctx.question}\n\nClaims to check (${ctx.claims.length}):\n${lines.join("\n")}`;
}

async function counterSearches(ctx: RunContext, raw: string, searched: Set<string>): Promise<string> {
  const args = parseArgs(CounterSearchArgs, raw);
  if (!args.ok) return `Invalid arguments: ${args.error}`;
  const results: string[] = [];
  const items: z.infer<typeof CounterSearchItem>[] = [];
  for (const entry of args.data.searches) {
    const item = CounterSearchItem.safeParse(entry);
    if (!item.success) {
      results.push(`Invalid search: ${item.error.issues.map((i) => `${i.path.join(".") || "search"}: ${i.message}`).join("; ")}`);
      continue;
    }
    const claimId = item.data.claim_id ? normalizeClaimId(item.data.claim_id) : "";
    if (claimId && searched.has(claimId)) {
      results.push(`Already counter-searched claim ${claimId}; one search per claim.`);
      continue;
    }
    if (claimId) searched.add(claimId);
    items.push({ ...item.data, claim_id: claimId });
  }
  // Searches run in parallel, so cut to the remaining budget before starting any of them.
  let allowed = Math.max(0, LIMITS.counterSearches - ctx.counters.counterSearches);
  while (allowed > 0 && !ctx.canSubrequest(allowed + 2)) allowed--;
  if (items.length > allowed) results.push(`Counter-search budget exhausted; skipped ${items.length - allowed} search(es).`);
  results.push(...(await Promise.all(items.slice(0, allowed).map((item) => counterSearch(ctx, item)))));
  return `${results.join("\n\n")}\n\nNow call submit_verdicts with a verdict for every claim.`;
}

async function counterSearch(ctx: RunContext, args: z.infer<typeof CounterSearchItem>): Promise<string> {
  const claimId = args.claim_id;
  const step = ctx.nextStep();
  await ctx.emit("decision", {
    step,
    tool: "search",
    input: args.query,
    reason: args.reason,
    phase: "factcheck",
    claimId: claimId || undefined,
  });
  const t = Date.now();
  try {
    const hits = await ctx.search(args.query, "counter");
    const newSources = [];
    const lines: string[] = [];
    for (const hit of hits) {
      const { source, isNew } = ctx.source(hit.url, hit.title, hit.snippet);
      if (isNew) newSources.push(publicSource(source));
      lines.push(`- ${source.title}\n  URL: ${source.url}\n  ${truncate(hit.snippet.replace(/\s+/g, " "), 450)}`);
    }
    await ctx.emit("tool_result", {
      step,
      summary: hits.length ? `${hits.length} results to test ${claimId || "claim"}` : "No results",
      newSources,
      ms: Date.now() - t,
      ok: true,
    });
    return hits.length
      ? `Counter-search results for ${claimId || "claim"} ("${args.query}"):\n${lines.join("\n")}`
      : `No results for ${claimId || "claim"} ("${args.query}").`;
  } catch (err) {
    if (err instanceof AgentError || ctx.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    await ctx.emit("tool_result", { step, summary: `Search failed: ${message}`, newSources: [], ms: Date.now() - t, ok: false });
    return `Search failed: ${message}`;
  }
}

function collectVerdicts(raw: string, into: Map<string, VerdictInput>): string {
  const args = parseArgs(SubmitArgs, raw);
  if (!args.ok) return `Invalid arguments: ${args.error}`;
  let accepted = 0;
  for (const item of args.data.verdicts) {
    const v = VerdictItem.safeParse(item);
    if (v.success) {
      into.set(v.data.claim_id, v.data);
      accepted++;
    }
  }
  return `Accepted ${accepted} verdicts.`;
}

/** Adversarial pass: try to break each claim, then compute confidence deterministically. */
export async function factCheck(ctx: RunContext): Promise<void> {
  await ctx.emit("phase", { phase: "factcheck" });
  const verdicts = new Map<string, VerdictInput>();
  let failure: string | undefined;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: fill(factcheckerPrompt, { date: today(), maxSearches: LIMITS.counterSearches }),
    },
    { role: "user", content: describeClaims(ctx) },
  ];
  const searched = new Set<string>();
  const missing = () => ctx.claims.filter((c) => !verdicts.has(c.id)).map((c) => c.id);

  try {
    for (let turn = 1; turn <= LIMITS.checkerTurns && missing().length > 0; turn++) {
      // Turn 1 is for counter-searches; later turns only collect (missing) verdicts.
      const force = turn > 1 || ctx.elapsed() > DEADLINES.factcheck - 15_000 || !ctx.canSubrequest(3);
      const response = await ctx.llm("check", messages, {
        tools: force ? [submitTool] : checkerTools,
        toolChoice: force ? { type: "function", function: { name: "submit_verdicts" } } : "auto",
        maxTokens: 10_000,
        temperature: 0.2,
      });
      const message = response.choices[0]?.message;
      if (!message) continue;
      const { calls, native } = extractToolCalls(message);
      if (calls.length === 0) {
        messages.push(assistantTurn(message));
        messages.push({
          role: "user",
          content: force
            ? "Call submit_verdicts with a verdict for every claim."
            : "Run your counter-searches in one web_search call, then call submit_verdicts.",
        });
        continue;
      }

      const outputs = new Map<string, string>();
      for (const call of calls) {
        if (call.name === "web_search") {
          outputs.set(call.id, await counterSearches(ctx, call.arguments, searched));
        } else if (call.name === "submit_verdicts") {
          const accepted = collectVerdicts(call.arguments, verdicts);
          const left = missing();
          outputs.set(
            call.id,
            left.length
              ? `${accepted} Still missing verdicts for: ${left.join(", ")}. Call submit_verdicts again with verdicts for exactly these claims.`
              : accepted,
          );
        } else {
          outputs.set(call.id, `Unknown tool "${call.name}".`);
        }
      }

      if (native) {
        messages.push(
          assistantTurn(
            message,
            calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
          ),
        );
        for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: outputs.get(call.id) ?? "" });
      } else {
        messages.push(assistantTurn(message));
        messages.push({
          role: "user",
          content: calls.map((c) => `Result of ${c.name}:\n${outputs.get(c.id)}`).join("\n\n"),
        });
      }
    }
  } catch (err) {
    if (err instanceof AgentError || ctx.clientSignal.aborted) throw err;
    failure = err instanceof Error ? err.message : String(err);
    ctx.log({ step: "factcheck_failed", error: failure });
    await ctx.emit("note", { text: `Fact-checker failed (${truncate(failure, 120)}); unchecked claims are marked unverified.` });
  }

  for (const claim of ctx.claims) {
    applyVerdict(ctx, claim, verdicts.get(claim.id), failure);
    await ctx.emit("factcheck", {
      claimId: claim.id,
      verdict: claim.verdict as Verdict,
      confidence: claim.confidence ?? "low",
      note: claim.note ?? "",
    });
  }
  ctx.log({ step: "factcheck_done", verdicts: verdicts.size, claims: ctx.claims.length });
}

function applyVerdict(ctx: RunContext, claim: ClaimPublic, v: VerdictInput | undefined, failure?: string): void {
  const source = ctx.sourceById(claim.sourceId);
  const domain = source?.domain ?? "";

  let verdict: Verdict = v?.verdict ?? "unverified";
  let note = v?.note || (failure ? "Fact-check unavailable" : "No verdict returned by the fact-checker");
  if (!claim.quoteVerified && verdict === "supported") {
    verdict = "unverified";
    note = `Quote not found on the page. ${note}`;
  }

  const corroborating = v?.corroborating_url ? ctx.findSource(v.corroborating_url) : undefined;
  if (corroborating && corroborating.domain !== domain) claim.corroboratingSourceIds = [corroborating.id];

  const counter = v?.counter_evidence_url ? ctx.findSource(v.counter_evidence_url) : undefined;
  if (counter && counter.id !== claim.sourceId) claim.counterEvidence = [{ sourceId: counter.id, note }];

  claim.primarySource = isPrimaryDomain(domain) || v?.source_type === "primary";
  if (v?.adverse_event) claim.adverse = true;
  claim.verdict = verdict;
  claim.note = note;
  claim.confidence = computeConfidence({
    quoteVerified: claim.quoteVerified,
    verdict,
    independentDomains: new Set([domain, ...(claim.corroboratingSourceIds ?? []).map((id) => ctx.sourceById(id)?.domain)]).size,
    primarySource: claim.primarySource,
  });
}
