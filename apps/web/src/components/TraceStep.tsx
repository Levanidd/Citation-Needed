import type { ClaimPublic, Phase } from "@worker/types.ts";
import type { ReactNode } from "react";
import { formatMs, shortUrl } from "../lib/format.ts";
import type { TraceItem } from "../lib/useResearch.ts";
import { ConfidenceBadge } from "./ConfidenceBadge.tsx";

const PHASE_LABEL: Record<Phase, { icon: string; label: string }> = {
  research: { icon: "🧭", label: "Research" },
  factcheck: { icon: "🛡️", label: "Fact-check" },
  writing: { icon: "✍️", label: "Writing report" },
};

const VERDICT_ICON = { supported: "✅", contested: "⚠️", unverified: "❌" } as const;

function Spinner() {
  return <span className="inline-block size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}

function Row({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <li className="relative flex gap-3 pl-1 animate-step-in">
      <span className="z-10 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-sm">
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5 pb-3">{children}</div>
    </li>
  );
}

export function TraceStep({ item, claims, live }: { item: TraceItem; claims: Record<string, ClaimPublic>; live: boolean }) {
  switch (item.kind) {
    case "phase": {
      const p = PHASE_LABEL[item.phase];
      return (
        <li className="relative flex items-center gap-2 pt-3 pb-2 pl-1 text-xs font-semibold tracking-wider text-muted uppercase animate-step-in">
          <span className="z-10 flex size-7 items-center justify-center rounded-full bg-accent/15 text-sm">{p.icon}</span>
          {p.label}
        </li>
      );
    }
    case "plan":
      return (
        <Row icon="🗺️">
          <div className="text-sm font-medium">Plan — risk areas to cover</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {item.areas.map((a) => (
              <span key={a} className="rounded-lg bg-accent/12 px-2 py-0.5 text-xs font-medium text-accent">
                {a}
              </span>
            ))}
          </div>
        </Row>
      );
    case "decision": {
      const counter = item.phase === "factcheck";
      return (
        <Row icon={item.tool === "search" ? "🔎" : "📄"}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 text-sm">
              <span className="font-medium text-muted">{counter ? "counter-search" : item.tool}</span>{" "}
              {item.tool === "search" ? (
                <span className="font-medium break-words text-fg">“{item.input}”</span>
              ) : (
                <a href={item.input} target="_blank" rel="noreferrer" className="font-medium break-all text-fg hover:text-accent">
                  {shortUrl(item.input)}
                </a>
              )}
              {item.claimId && <span className="ml-1.5 rounded bg-surface-2 px-1 font-mono text-[10px] text-muted">{item.claimId}</span>}
            </div>
            <span className="shrink-0 pt-0.5 text-[11px] text-subtle tabular-nums">
              {item.result ? formatMs(item.result.ms) : live ? <Spinner /> : null}
            </span>
          </div>
          {item.reason && <div className="mt-0.5 text-[13px] text-muted italic">→ {item.reason}</div>}
          {item.result && (
            <div className={`mt-0.5 text-xs ${item.result.ok ? "text-subtle" : "text-neg"}`}>{item.result.summary}</div>
          )}
        </Row>
      );
    }
    case "claim":
      return (
        <Row icon="📝">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="font-mono">{item.claimId}</span>·<span className="truncate">{item.area}</span>
            <span className={item.verified ? "text-pos" : "text-neg"}>{item.verified ? "✓ quote verified" : "✗ quote not found"}</span>
            {item.fixed && <span className="rounded bg-surface-2 px-1 text-[10px]">fixed</span>}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[13px] text-fg">{item.text}</div>
        </Row>
      );
    case "factcheck": {
      const claim = claims[item.claimId];
      return (
        <Row icon={VERDICT_ICON[item.verdict]}>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-muted">{item.claimId}</span>
            <span className="font-semibold text-fg capitalize">{item.verdict}</span>
            <ConfidenceBadge level={item.confidence} />
          </div>
          {claim && <div className="mt-0.5 line-clamp-1 text-[13px] text-fg">{claim.text}</div>}
          {item.note && <div className="mt-0.5 text-xs text-muted italic">{item.note}</div>}
        </Row>
      );
    }
    case "note":
      return (
        <Row icon="ℹ️">
          <div className="text-[13px] text-muted">{item.text}</div>
        </Row>
      );
    case "research_done":
      return (
        <Row icon="🏁">
          <div className="text-sm font-medium">Research done · {item.claimCount} claims</div>
          <div className="text-[13px] text-muted italic">→ {item.reason}</div>
        </Row>
      );
  }
}
