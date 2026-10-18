import { AgentError, toErrorPayload } from "../errors.ts";
import { RunContext, type Sink } from "./context.ts";
import { factCheck } from "./factchecker.ts";
import { research } from "./researcher.ts";
import { writeReport } from "./writer.ts";

/** One request = one run: research → quote verification (inline) → fact-check → report. */
export async function runResearch(env: Env, question: string, clientSignal: AbortSignal, sink: Sink): Promise<void> {
  const ctx = new RunContext(env, question, clientSignal, sink);
  ctx.log({ step: "run_started", question, models: ctx.modelNames });
  await ctx.emit("run_started", { runId: ctx.runId, question, models: ctx.modelNames });

  // Never rejects; runs alongside the first research turn.
  const prices = ctx.loadPrices();

  try {
    await research(ctx);
    if (ctx.claims.length === 0) {
      throw new AgentError(
        "no_claims",
        "The agent could not collect any sourced claims for this question. Try a more specific company or product name.",
        true,
      );
    }
    await factCheck(ctx);
    const final = await writeReport(ctx);
    await prices;
    const stats = ctx.stats();
    ctx.log({ step: "done", ...stats });
    await ctx.emit("done", { ...final, stats });
  } catch (err) {
    if (clientSignal.aborted) {
      ctx.log({ step: "client_disconnected" });
      return;
    }
    const payload = toErrorPayload(err);
    ctx.log({ step: "error", ...payload, detail: err instanceof Error ? err.stack : String(err) });
    await ctx.emit("error", payload);
  }
}
