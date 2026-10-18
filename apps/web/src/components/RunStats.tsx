import type { ModelNames, RunStats as Stats } from "@worker/types.ts";
import { formatCredits, formatDuration, formatTokens, formatUsd, modelLabel } from "../lib/format.ts";

const ROLE_LABEL: Record<keyof ModelNames, string> = { research: "Research", check: "Fact-check", write: "Writer" };

export function RunStats({ stats }: { stats: Stats }) {
  const { usage } = stats;
  const tokens = usage.promptTokens + usage.completionTokens;
  const total = usage.llmCostUsd === undefined ? undefined : usage.llmCostUsd + usage.tavilyCostUsd;
  const searchHint = [stats.newsSearches && `${stats.newsSearches} news`, stats.counterSearches && `${stats.counterSearches} counter`]
    .filter(Boolean)
    .join(" · ");
  const items = [
    { label: "Duration", value: formatDuration(stats.durationMs) },
    {
      label: "Searches",
      value: String(stats.searches + stats.newsSearches + stats.counterSearches),
      hint: searchHint || undefined,
    },
    { label: "Pages read", value: String(stats.pagesRead) },
    { label: "Claims", value: String(stats.claims) },
    {
      label: "Quotes verified",
      value: `${stats.verifiedPct}%`,
      hint: `${stats.verifiedQuotes}/${stats.claims}`,
      tone: stats.verifiedPct >= 80 ? "text-pos" : stats.verifiedPct >= 50 ? "text-warn" : "text-neg",
    },
    {
      label: "Tokens",
      value: formatTokens(tokens),
      hint: `${formatTokens(usage.promptTokens)} in · ${formatTokens(usage.completionTokens)} out`,
    },
    {
      label: "LLM cost",
      value: usage.llmCostUsd === undefined ? "–" : formatUsd(usage.llmCostUsd),
      hint: `${stats.llmCalls} calls`,
    },
    {
      label: "Total cost",
      value: total === undefined ? "–" : formatUsd(total),
      hint: `+ Tavily ${formatCredits(usage.tavilyCredits)} credits`,
      tone: "text-accent",
    },
  ];
  const roles = (Object.keys(ROLE_LABEL) as (keyof ModelNames)[]).filter((role) => usage.byRole[role].calls > 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="rounded-2xl border border-line bg-surface p-3 shadow-card">
            <div className="text-xs font-medium text-muted">{item.label}</div>
            <div className={`mt-1 text-xl font-semibold tracking-tight tabular-nums ${item.tone ?? "text-fg"}`}>{item.value}</div>
            {item.hint && <div className="text-[11px] text-subtle">{item.hint}</div>}
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-line">
        {roles.map((role) => {
          const r = usage.byRole[role];
          const model = modelLabel(r.model);
          return (
            <div
              key={role}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-b border-line px-3 py-2 text-xs last:border-b-0"
            >
              <span className="flex items-center gap-2">
                <span className="w-20 font-medium text-muted">{ROLE_LABEL[role]}</span>
                <span className="font-medium text-fg">{model.name}</span>
                {model.lab && <span className="text-subtle">{model.lab}</span>}
              </span>
              <span className="text-muted tabular-nums">
                {r.calls} calls · {formatTokens(r.promptTokens + r.completionTokens)} tokens
                {r.costUsd !== undefined && <span className="ml-2 font-medium text-fg">{formatUsd(r.costUsd)}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
