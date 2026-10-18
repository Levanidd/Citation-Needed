import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { orderCitedSources, renderCitations } from "../citations.ts";
import { AgentError } from "../errors.ts";
import writerPrompt from "../prompts/writer.md";
import type { ClaimPublic, Confidence, SourcePublic } from "../types.ts";
import { fill, today } from "../util.ts";
import { type RunContext, publicSource } from "./context.ts";

const LABEL: Record<Confidence, string> = { high: "High", medium: "Medium", low: "Low" };

function gaps(ctx: RunContext): string[] {
  return ctx.areas.filter((a) => ctx.claims.filter((c) => c.area === a).length < 2);
}

function writerInput(ctx: RunContext): string {
  const byArea = new Map<string, ClaimPublic[]>();
  for (const area of ctx.areas) byArea.set(area, []);
  for (const c of ctx.claims) byArea.set(c.area, [...(byArea.get(c.area) ?? []), c]);

  const sections = [...byArea.entries()].map(([area, claims]) => {
    const rows = claims.map((c) => {
      const domain = ctx.sourceById(c.sourceId)?.domain ?? "unknown";
      return `- [c:${c.id}] confidence=${LABEL[c.confidence ?? "low"]} verdict=${c.verdict ?? "unverified"} source=${domain}\n  claim: ${c.text}\n  fact-check note: ${c.note ?? "-"}`;
    });
    return `### ${area}\n${rows.length ? rows.join("\n") : "(no claims found)"}`;
  });

  const missing = gaps(ctx);
  return [
    `Question: ${ctx.question}`,
    `Risk areas in order: ${ctx.areas.join("; ")}`,
    "",
    "Claims (use only these; cite with the [c:ID] marker shown):",
    sections.join("\n\n"),
    "",
    `Areas with fewer than 2 claims: ${missing.length ? missing.join("; ") : "none"}`,
  ].join("\n");
}

/** Code-built report used if the writer model fails, so a run always ends with a result. */
function fallbackReport(ctx: RunContext): string {
  const strong = ctx.claims.filter((c) => c.confidence !== "low");
  const weak = ctx.claims.filter((c) => c.confidence === "low");
  const lines = [
    "## Verdict",
    "**Overall risk: Medium** — the automated summary could not be generated, so this report lists the collected evidence as-is. Review the findings below.",
    "",
    "## Key findings",
    "| Area | Finding | Confidence |",
    "|---|---|---|",
    ...ctx.claims.slice(0, 10).map((c) => `| ${c.area} | ${c.text.replace(/\|/g, "/")} [c:${c.id}] | ${LABEL[c.confidence ?? "low"]} |`),
    "",
  ];
  for (const area of ctx.areas) {
    const claims = strong.filter((c) => c.area === area);
    if (!claims.length) continue;
    lines.push(`## ${area}`, ...claims.map((c) => `- ${c.text} [c:${c.id}]`), "");
  }
  lines.push(
    "## Contested or unverified",
    ...(weak.length ? weak.map((c) => `- ${c.text} — ${c.note ?? "not confirmed"} [c:${c.id}]`) : ["None."]),
    "",
    "## Gaps",
    ...(gaps(ctx).length ? gaps(ctx).map((a) => `- Little or no evidence found for **${a}**.`) : ["- No major gaps detected."]),
  );
  return lines.join("\n");
}

export interface FinalReport {
  report: string;
  claims: ClaimPublic[];
  sources: SourcePublic[];
}

/** Renumber sources by first citation, then turn [c:ID] markers into `[n](#claim-ID)` links. */
export function finalizeReport(ctx: RunContext, raw: string): FinalReport {
  const claimMap = new Map(ctx.claims.map((c) => [c.id, c]));
  const order = orderCitedSources(raw, claimMap);
  const seen = new Set(order);
  for (const c of ctx.claims) {
    for (const id of [c.sourceId, ...(c.corroboratingSourceIds ?? []), ...(c.counterEvidence ?? []).map((e) => e.sourceId)]) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  const renumber = new Map(order.map((oldId, i) => [oldId, i + 1]));
  const n = (id: number) => renumber.get(id) as number;

  const sources = order.flatMap((oldId) => {
    const s = ctx.sourceById(oldId);
    return s ? [{ ...publicSource(s), id: n(oldId) }] : [];
  });
  const claims = ctx.claims.map((c) => ({
    ...c,
    sourceId: n(c.sourceId),
    corroboratingSourceIds: c.corroboratingSourceIds?.map(n),
    counterEvidence: c.counterEvidence?.map((e) => ({ ...e, sourceId: n(e.sourceId) })),
  }));
  const report = renderCitations(raw, claimMap, (oldId) => renumber.get(oldId)).trim();
  return { report, claims, sources };
}

export async function writeReport(ctx: RunContext): Promise<FinalReport> {
  await ctx.emit("phase", { phase: "writing" });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: fill(writerPrompt, { date: today() }) },
    { role: "user", content: writerInput(ctx) },
  ];

  let raw = "";
  const t = Date.now();
  ctx.counters.subrequests++;
  ctx.counters.llmCalls++;
  try {
    for await (const delta of ctx.models.write.stream(messages, { maxTokens: 4000, temperature: 0.3 }, ctx.signal)) {
      raw += delta;
      await ctx.emit("report_delta", { text: delta });
    }
  } catch (err) {
    if (ctx.clientSignal.aborted) throw err;
    if (err instanceof AgentError && !raw && (err.code === "nebius_auth" || err.code === "nebius_model")) throw err;
    ctx.log({ step: "writer_failed", error: String(err), chars: raw.length });
    await ctx.emit("note", {
      text: raw ? "Report generation was interrupted; showing the partial report." : "Writer model failed; showing a code-built report.",
    });
    if (raw) raw += "\n\n_Report generation was interrupted._";
  }
  ctx.log({ step: "writer", ms: Date.now() - t, chars: raw.length });

  if (!raw.trim()) raw = fallbackReport(ctx);
  return finalizeReport(ctx, raw.replace(/<think>[\s\S]*?<\/think>/g, ""));
}
