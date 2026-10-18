import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runResearch } from "./agent/run.ts";
import { modelNames } from "./config.ts";
import { toErrorPayload } from "./errors.ts";
import type { ErrorPayload } from "./types.ts";

const app = new Hono<{ Bindings: Env }>();

const ResearchBody = z.object({ question: z.string().trim().min(5).max(500) });

const errorJson = (error: ErrorPayload) => ({ error });

app.get("/api/health", (c) => {
  const nebius = Boolean(c.env.NEBIUS_API_KEY);
  const tavily = Boolean(c.env.TAVILY_API_KEY);
  return c.json({ ok: nebius && tavily, models: modelNames(c.env), nebius, tavily });
});

app.post("/api/research", async (c) => {
  const body = ResearchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json(errorJson({ code: "bad_request", message: "Question must be 5–500 characters.", retryable: false }), 400);
  }
  if (!c.env.NEBIUS_API_KEY || !c.env.TAVILY_API_KEY) {
    return c.json(
      errorJson({
        code: "config_missing",
        message: "Server is missing NEBIUS_API_KEY or TAVILY_API_KEY. See README → Run locally.",
        retryable: false,
      }),
      500,
    );
  }

  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json(
      errorJson({ code: "rate_limited", message: "Rate limit: max 5 research runs per minute. Try again shortly.", retryable: true }),
      429,
    );
  }

  const dailyLimit = Number(c.env.DAILY_RUN_LIMIT) || 0;
  if (dailyLimit > 0 && !(await c.env.DAILY_QUOTA.getByName("global").take(dailyLimit))) {
    return c.json(
      errorJson({
        code: "daily_limit",
        message: `This demo allows ${dailyLimit} research runs per day and today's are used up. Try again after 00:00 UTC.`,
        retryable: false,
      }),
      429,
    );
  }

  return streamSSE(
    c,
    async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      await runResearch(c.env, body.data.question, abort.signal, (type, data) =>
        stream.writeSSE({ event: type, data: JSON.stringify(data) }),
      );
    },
    async (err, stream) => {
      await stream.writeSSE({ event: "error", data: JSON.stringify(toErrorPayload(err)) });
    },
  );
});

app.all("/api/*", (c) => c.json(errorJson({ code: "not_found", message: "Unknown API route.", retryable: false }), 404));

export { DailyQuota } from "./quota.ts";
export default app satisfies ExportedHandler<Env>;
