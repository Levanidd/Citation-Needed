import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { DEADLINES, LIMITS } from "../config.ts";
import { AgentError } from "../errors.ts";
import factcheckerPrompt from "../prompts/factchecker.md";
import type { ClaimPublic, Verdict } from "../types.ts";
import { fill, today, truncate } from "../util.ts";
import { computeConfidence, isPrimaryDomain } from "./confidence.ts";
import { type RunContext, publicSource } from "./context.ts";
import { type ToolCall, extractToolCalls, parseArgs } from "./toolcalls.ts";
import { searchToolSchema } from "./tools.ts";

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
              corroborating_url: { type: "string", description: "Optional: URL on a different domain that confirms the claim" },
              counter_evidence_url: { type: "string", description: "Optional: URL that contradicts the claim" },
            },
            required: ["claim_id", "verdict", "note", "source_type"],
          },
        },
      },
      required: ["verdicts"],
    },
  },
};

const checkerTools: ChatCompletionTool[] = [
  searchToolSchema({ claim_id: { type: "string", description: "The claim this counter-search tries to break" } }, ["claim_id"]),
  submitTool,
];

const CounterSearchArgs = z.object({
  query: z.string().trim().min(2).max(400),
  reason: z.string().trim().default(""),
  claim_id: z.string().trim().default(""),
});

const VerdictItem = z.object({
  claim_id: z.string().trim(),
  verdict: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase().trim() : v), z.enum(["supported", "contested", "unverified"])),
  note: z.string().trim().default(""),
  source_type: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase().trim() : v), z.enum(["primary", "secondary"])).catch("secondary"),
  corroborating_url: z.string().trim().nullish(),
  counter_evidence_url: z.string().trim().nullish(),
});
const SubmitArgs = z.object({ verdicts: z.array(z.unknown()) });

type VerdictInput = z.infer<typeof VerdictItem>;

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

async function counterSearch(ctx: RunContext, call: ToolCall, searched: Set<string>): Promise<string> {
  const args = parseArgs(CounterSearchArgs, call.arguments);
  if (!args.ok) return `Invalid arguments: ${args.error}`;
  const claimId = args.data.claim_id;
  if (claimId && searched.has(claimId)) return `Already counter-searched claim ${claimId}; one search per claim.`;
  if (ctx.counters.counterSearches >= LIMITS.counterSearches || !ctx.canSubrequest(3)) {
    return "Counter-search budget exhausted. Submit verdicts now.";
  }
  if (claimId) searched.add(claimId);
  const step = ctx.nextStep();
  await ctx.emit("decision", {
    step,
    tool: "search",
    input: args.data.query,
    reason: args.data.reason,
    phase: "factcheck",
    claimId: claimId || undefined,
  });
  const t = Date.now();
  try {
    const hits = await ctx.search(args.data.query, "counter");
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
    return hits.length ? `Counter-search results for "${args.data.query}":\n${lines.join("\n")}` : "No results.";
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
      into.set(v.data.claim_id.replace(/^c:/, ""), v.data);
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

  try {
    for (let turn = 1; turn <= LIMITS.checkerTurns && verdicts.size === 0; turn++) {
      const force = turn === LIMITS.checkerTurns || ctx.elapsed() > DEADLINES.factcheck - 15_000 || !ctx.canSubrequest(3);
      const response = await ctx.llm("check", messages, {
        tools: force ? [submitTool] : checkerTools,
        toolChoice: force ? { type: "function", function: { name: "submit_verdicts" } } : "auto",
        maxTokens: 6000,
        temperature: 0.2,
      });
      const message = response.choices[0]?.message;
      if (!message) continue;
      const { calls, native } = extractToolCalls(message);
      if (calls.length === 0) {
        messages.push({ role: "assistant", content: message.content ?? "" });
        messages.push({ role: "user", content: "Run your counter-searches with web_search, then call submit_verdicts." });
        continue;
      }

      const searches = calls.filter((c) => c.name === "web_search");
      const results = await Promise.all(searches.map((c) => counterSearch(ctx, c, searched)));
      const outputs = new Map<string, string>(searches.map((c, i) => [c.id, results[i]]));
      for (const call of calls) {
        if (call.name === "submit_verdicts") outputs.set(call.id, collectVerdicts(call.arguments, verdicts));
        else if (!outputs.has(call.id)) outputs.set(call.id, `Unknown tool "${call.name}".`);
      }

      if (native) {
        messages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: outputs.get(call.id) ?? "" });
      } else {
        messages.push({ role: "assistant", content: message.content ?? "" });
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
  claim.verdict = verdict;
  claim.note = note;
  claim.confidence = computeConfidence({
    quoteVerified: claim.quoteVerified,
    verdict,
    independentDomains: new Set([domain, ...(claim.corroboratingSourceIds ?? []).map((id) => ctx.sourceById(id)?.domain)]).size,
    primarySource: claim.primarySource,
  });
}
