import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { DEADLINES, LIMITS } from "../config.ts";
import { AgentError } from "../errors.ts";
import researcherPrompt from "../prompts/researcher.md";
import { fill, today } from "../util.ts";
import type { RunContext } from "./context.ts";
import { type ToolCall, extractToolCalls } from "./toolcalls.ts";
import { finishReason, researcherTools, runResearcherTool } from "./tools.ts";

/**
 * Model-driven research loop: the model decides what to search, which pages to read,
 * which claims to record and when to stop. Code only enforces budgets.
 */
export async function research(ctx: RunContext): Promise<void> {
  await ctx.emit("phase", { phase: "research" });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: fill(researcherPrompt, {
        date: today(),
        maxSearches: LIMITS.searches,
        maxNews: LIMITS.newsSearches,
        maxReads: LIMITS.reads,
        maxClaims: LIMITS.claims,
        maxTurns: LIMITS.researchTurns,
      }),
    },
    { role: "user", content: `Research question: ${ctx.question}` },
  ];

  let reason = "Turn limit reached";
  let nudges = 0;

  for (let turn = 1; turn <= LIMITS.researchTurns; turn++) {
    if (ctx.elapsed() > DEADLINES.research) {
      reason = "Time budget for research reached";
      break;
    }
    if (!ctx.canSubrequest(8)) {
      reason = "Request budget reached";
      break;
    }

    const lastTurn = turn === LIMITS.researchTurns || ctx.elapsed() > DEADLINES.research - 15_000;
    if (lastTurn && turn > 1) {
      messages.push({
        role: "user",
        content: "This is your final turn. Record any remaining well-supported claims now in a single record_claim call.",
      });
    }

    let response;
    try {
      response = await ctx.llm("research", messages, { tools: researcherTools, maxTokens: 8192, temperature: 0.4 });
    } catch (err) {
      // Keep what we have if the model fails late in the loop; fail the run if it never started.
      if (err instanceof AgentError || ctx.clientSignal.aborted || ctx.claims.length === 0) throw err;
      reason = "Research model stopped responding; continuing with collected claims";
      await ctx.emit("note", { text: reason });
      break;
    }

    const message = response.choices[0]?.message;
    if (!message) continue;
    const { calls, native } = extractToolCalls(message);

    if (calls.length === 0) {
      messages.push({ role: "assistant", content: message.content ?? "" });
      nudges++;
      if (nudges >= 3 && ctx.claims.length > 0) {
        reason = "Agent stopped calling tools";
        break;
      }
      messages.push({
        role: "user",
        content:
          "Respond with a tool call (plan_areas, web_search, news_search, read_page, record_claim or finish_research). If tool calling is unavailable, reply with only JSON: {\"action\": \"<tool name>\", \"args\": {...}}.",
      });
      continue;
    }

    const outputs: { call: ToolCall; content: string }[] = [];
    let finished: ToolCall | undefined;
    for (const call of calls) {
      if (finished) break;
      const outcome = await runResearcherTool(ctx, call);
      outputs.push({ call, content: outcome.content });
      if (outcome.finish) finished = call;
    }

    if (native) {
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: outputs.map(({ call }) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const { call, content } of outputs) messages.push({ role: "tool", tool_call_id: call.id, content });
    } else {
      messages.push({ role: "assistant", content: message.content ?? "" });
      messages.push({
        role: "user",
        content: outputs.map(({ call, content }) => `Result of ${call.name}:\n${content}`).join("\n\n"),
      });
    }

    if (finished) {
      reason = finishReason(finished);
      break;
    }
  }

  ctx.log({ step: "research_done", reason, claims: ctx.claims.length });
  await ctx.emit("research_done", { reason, claimCount: ctx.claims.length });
}
