import type { Confidence } from "@worker/types.ts";
import type { ReactNode } from "react";

const STYLES: Record<Confidence, { label: string; className: string }> = {
  high: { label: "High", className: "bg-pos/15 text-pos" },
  medium: { label: "Medium", className: "bg-warn/15 text-warn" },
  low: { label: "Low", className: "bg-neg/15 text-neg" },
};

export function ConfidenceBadge({ level, compact = false }: { level: Confidence; compact?: boolean }) {
  const s = STYLES[level];
  return (
    <span
      className={`inline-flex items-center rounded-md font-semibold tracking-wide whitespace-nowrap align-middle ${s.className} ${
        compact ? "ml-0.5 px-1 py-px text-[10px] leading-none" : "px-1.5 py-0.5 text-xs"
      }`}
      title={`${s.label} confidence`}
    >
      {s.label}
    </span>
  );
}

export function RiskPill({ level, children }: { level: "low" | "medium" | "high"; children: ReactNode }) {
  // Risk is the inverse of confidence colours: high risk is red.
  const className = { low: "bg-pos/15 text-pos", medium: "bg-warn/15 text-warn", high: "bg-neg/15 text-neg" }[level];
  return <strong className={`inline-block rounded-lg px-2 py-0.5 ${className}`}>{children}</strong>;
}
