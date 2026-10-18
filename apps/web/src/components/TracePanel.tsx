import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../lib/format.ts";
import type { Run } from "../lib/useResearch.ts";
import { TraceStep } from "./TraceStep.tsx";

const PHASE_STATUS = { research: "Researching", factcheck: "Fact-checking", writing: "Writing report" } as const;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function TracePanel({ run }: { run: Run }) {
  const live = run.status === "running";
  const now = useNow(live);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);

  const claims = Object.values(run.claims);
  const verified = claims.filter((c) => c.quoteVerified).length;
  const checked = run.trace.filter((t) => t.kind === "factcheck").length;
  const downgraded = run.trace.filter((t) => t.kind === "factcheck" && t.verdict !== "supported").length;
  const decisions = run.trace.filter((t) => t.kind === "decision").length;

  useEffect(() => {
    const el = listRef.current;
    if (!el || !live) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [run.trace.length, live]);

  const status =
    run.status === "running"
      ? `${run.phase ? PHASE_STATUS[run.phase] : "Starting"}…`
      : run.status === "done"
        ? "Completed"
        : "Stopped";

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 text-sm font-semibold lg:pointer-events-none"
            aria-expanded={open}
          >
            Agent trace
            <span className="text-xs text-muted lg:hidden">{open ? "▲" : `▼ ${decisions} decisions`}</span>
          </button>
          <div className="flex items-center gap-2 text-xs text-muted">
            {live && <span className="size-2 animate-pulse rounded-full bg-accent" />}
            <span>{status}</span>
            <span className="tabular-nums">{formatDuration((run.finishedAt ?? now) - run.startedAt)}</span>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-center">
          {[
            { label: "Decisions", value: decisions },
            { label: "Claims", value: claims.length },
            { label: "Verified", value: claims.length ? `${verified}/${claims.length}` : "–" },
            { label: "Downgraded", value: checked ? `${downgraded}/${checked}` : "–" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-surface-2/60 px-1 py-1.5">
              <div className="text-base font-semibold tabular-nums">{s.value}</div>
              <div className="text-[10px] tracking-wide text-muted uppercase">{s.label}</div>
            </div>
          ))}
        </div>
      </header>
      <div
        ref={listRef}
        className={`${open ? "block" : "hidden"} max-h-[45vh] min-h-0 flex-1 overflow-y-auto px-3 py-2 lg:block lg:max-h-none`}
      >
        {run.trace.length === 0 ? (
          <div className="space-y-3 p-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-10 rounded-xl" />
            ))}
          </div>
        ) : (
          <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-[18px] before:w-px before:bg-line">
            {run.trace.map((item) => (
              <TraceStep key={item.key} item={item} claims={run.claims} live={live} />
            ))}
          </ol>
        )}
        {run.models && (
          <p className="px-2 pt-2 pb-1 text-[11px] text-subtle">
            Models: research {run.models.research} · check {run.models.check} · write {run.models.write}
          </p>
        )}
      </div>
    </section>
  );
}
