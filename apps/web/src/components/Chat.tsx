import { plainCitations } from "@worker/citations.ts";
import { formatDuration } from "../lib/format.ts";
import type { Run } from "../lib/useResearch.ts";
import { Report } from "./Report.tsx";
import { RunStats } from "./RunStats.tsx";
import { SourceCard } from "./SourceCard.tsx";

const PHASE_STATUS = {
  research: "Researching the live web",
  factcheck: "Fact-checking claims",
  writing: "Writing the report",
} as const;

function downloadMarkdown(run: Run) {
  if (!run.final) return;
  const sources = run.final.sources.map((s) => `${s.id}. [${s.title}](${s.url}) — ${s.domain}`).join("\n");
  const md = `# ${run.question}\n\n${plainCitations(run.final.report)}\n\n## Sources\n\n${sources}\n`;
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `due-diligence-${(run.runId ?? "report").slice(0, 8)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function RunMessage({
  run,
  selected,
  fillViewport,
  onSelect,
  onRetry,
}: {
  run: Run;
  selected: boolean;
  fillViewport: boolean;
  onSelect: () => void;
  onRetry: (q: string) => void;
}) {
  const hasReport = Boolean(run.final || run.reportRaw);
  return (
    // fillViewport lets a freshly started run scroll to the top even while it is still a short skeleton.
    <div id={`run-${run.id}`} className={`scroll-mt-20 space-y-4 ${fillViewport ? "min-h-[calc(100dvh-15rem)]" : ""}`}>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-accent px-4 py-2.5 text-[15px] text-white shadow-card">{run.question}</div>
      </div>

      <div
        onClick={onSelect}
        className={`rounded-[var(--radius-card)] border bg-surface p-5 shadow-card transition sm:p-6 ${
          selected ? "border-accent/40" : "border-line"
        }`}
      >
        <div className="mb-4 flex items-center justify-between gap-3 text-xs text-muted">
          <span className="flex items-center gap-2">
            {run.status === "running" && <span className="size-2 animate-pulse rounded-full bg-accent" />}
            {run.status === "running" && `${run.phase ? PHASE_STATUS[run.phase] : "Starting"}…`}
            {run.status === "done" && `Due diligence report · ${formatDuration((run.finishedAt ?? 0) - run.startedAt)}`}
            {run.status === "error" && "Run failed"}
          </span>
          {run.final && (
            <button
              type="button"
              onClick={() => downloadMarkdown(run)}
              className="rounded-lg border border-line px-2.5 py-1 font-medium text-fg transition hover:border-line-strong"
            >
              Export .md
            </button>
          )}
        </div>

        {hasReport && (
          <div className="max-w-[760px]">
            <Report run={run} />
          </div>
        )}

        {!hasReport && run.status === "running" && (
          <div className="space-y-3">
            <div className="skeleton h-5 w-2/3 rounded-lg" />
            <div className="skeleton h-4 w-full rounded-lg" />
            <div className="skeleton h-4 w-5/6 rounded-lg" />
            <p className="pt-2 text-sm text-muted">
              The agent is planning, searching and recording quoted claims. Follow its decisions in the trace.
            </p>
          </div>
        )}

        {run.status === "error" && run.error && (
          <div className="mt-2 rounded-2xl border border-neg/30 bg-neg/10 p-4 text-sm">
            <div className="font-semibold text-neg">Something went wrong</div>
            <p className="mt-1 text-fg">{run.error.message}</p>
            <div className="mt-3 flex items-center gap-3">
              {run.error.retryable && (
                <button
                  type="button"
                  onClick={() => onRetry(run.question)}
                  className="rounded-[14px] bg-gradient-to-br from-[#935CFF] to-[#6D28D9] px-4 py-2 text-sm font-semibold text-white active:scale-[0.97]"
                >
                  Retry
                </button>
              )}
              <span className="font-mono text-xs text-muted">{run.error.code}</span>
            </div>
          </div>
        )}

        {run.final && (
          <div className="mt-8 space-y-6 border-t border-line pt-6">
            <section>
              <h3 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Sources</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {run.final.sources.map((s) => (
                  <SourceCard key={s.id} source={s} />
                ))}
              </div>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Run stats</h3>
              <RunStats stats={run.final.stats} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export function Chat({
  runs,
  selectedId,
  onSelect,
  onRetry,
}: {
  runs: Run[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onRetry: (q: string) => void;
}) {
  return (
    <div className="space-y-10">
      {runs.map((run, i) => (
        <RunMessage
          key={run.id}
          run={run}
          selected={run.id === selectedId && runs.length > 1}
          fillViewport={runs.length > 1 && i === runs.length - 1}
          onSelect={() => onSelect(run.id)}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
