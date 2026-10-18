import type { RunStats as Stats } from "@worker/types.ts";
import { formatDuration } from "../lib/format.ts";

export function RunStats({ stats }: { stats: Stats }) {
  const items = [
    { label: "Duration", value: formatDuration(stats.durationMs) },
    {
      label: "Searches",
      value: String(stats.searches + stats.counterSearches),
      hint: stats.counterSearches ? `${stats.counterSearches} counter` : undefined,
    },
    { label: "Pages read", value: String(stats.pagesRead) },
    { label: "Claims", value: String(stats.claims) },
    {
      label: "Quotes verified",
      value: `${stats.verifiedPct}%`,
      hint: `${stats.verifiedQuotes}/${stats.claims}`,
      tone: stats.verifiedPct >= 80 ? "text-pos" : stats.verifiedPct >= 50 ? "text-warn" : "text-neg",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-line bg-surface p-3 shadow-card">
          <div className="text-xs font-medium text-muted">{item.label}</div>
          <div className={`mt-1 text-xl font-semibold tracking-tight tabular-nums ${item.tone ?? "text-fg"}`}>{item.value}</div>
          {item.hint && <div className="text-[11px] text-subtle">{item.hint}</div>}
        </div>
      ))}
    </div>
  );
}
