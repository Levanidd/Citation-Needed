import type {
  ClaimPublic,
  Confidence,
  ErrorPayload,
  EventMap,
  ModelNames,
  Phase,
  ResearchEvent,
  SourcePublic,
  Verdict,
} from "@worker/types.ts";
import { useCallback, useReducer, useRef } from "react";
import { StreamError, streamResearch } from "./sse.ts";

export type TraceItem =
  | { kind: "phase"; key: string; at: number; phase: Phase }
  | { kind: "plan"; key: string; at: number; areas: string[] }
  | {
      kind: "decision";
      key: string;
      at: number;
      step: number;
      tool: "search" | "read";
      input: string;
      reason: string;
      phase: Phase;
      claimId?: string;
      result?: { summary: string; ms: number; ok: boolean; newSources: number };
    }
  | { kind: "claim"; key: string; at: number; claimId: string; area: string; text: string; verified: boolean; fixed: boolean }
  | { kind: "factcheck"; key: string; at: number; claimId: string; verdict: Verdict; confidence: Confidence; note: string }
  | { kind: "note"; key: string; at: number; text: string }
  | { kind: "research_done"; key: string; at: number; reason: string; claimCount: number };

export interface Run {
  id: string;
  question: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  runId?: string;
  models?: ModelNames;
  phase?: Phase;
  areas: string[];
  trace: TraceItem[];
  claims: Record<string, ClaimPublic>;
  sources: Record<number, SourcePublic>;
  reportRaw: string;
  final?: EventMap["done"];
  error?: ErrorPayload;
}

type Action =
  | { type: "start"; id: string; question: string }
  | { type: "event"; id: string; event: ResearchEvent };

function applyEvent(run: Run, event: ResearchEvent): Run {
  const at = Date.now();
  const key = `${run.trace.length}-${event.type}`;
  switch (event.type) {
    case "run_started":
      return { ...run, runId: event.data.runId, models: event.data.models };
    case "phase":
      return { ...run, phase: event.data.phase, trace: [...run.trace, { kind: "phase", key, at, phase: event.data.phase }] };
    case "plan": {
      const existing = run.trace.findIndex((t) => t.kind === "plan");
      const item: TraceItem = { kind: "plan", key: existing >= 0 ? run.trace[existing].key : key, at, areas: event.data.areas };
      const trace = existing >= 0 ? run.trace.map((t, i) => (i === existing ? item : t)) : [...run.trace, item];
      return { ...run, areas: event.data.areas, trace };
    }
    case "decision":
      return { ...run, trace: [...run.trace, { kind: "decision", key, at, ...event.data }] };
    case "tool_result": {
      const { step, summary, ms, ok, newSources } = event.data;
      const sources = { ...run.sources };
      for (const s of newSources) sources[s.id] = s;
      const trace = run.trace.map((t) =>
        t.kind === "decision" && t.step === step ? { ...t, result: { summary, ms, ok, newSources: newSources.length } } : t,
      );
      return { ...run, sources, trace };
    }
    case "claim": {
      const { claim, source, fixed } = event.data;
      const item: TraceItem = {
        kind: "claim",
        key,
        at,
        claimId: claim.id,
        area: claim.area,
        text: claim.text,
        verified: claim.quoteVerified,
        fixed,
      };
      const idx = fixed ? run.trace.findIndex((t) => t.kind === "claim" && t.claimId === claim.id) : -1;
      const trace = idx >= 0 ? run.trace.map((t, i) => (i === idx ? { ...item, key: t.key } : t)) : [...run.trace, item];
      return {
        ...run,
        claims: { ...run.claims, [claim.id]: claim },
        sources: { ...run.sources, [source.id]: source },
        trace,
      };
    }
    case "note":
      return { ...run, trace: [...run.trace, { kind: "note", key, at, text: event.data.text }] };
    case "research_done":
      return { ...run, trace: [...run.trace, { kind: "research_done", key, at, ...event.data }] };
    case "factcheck": {
      const { claimId, verdict, confidence, note } = event.data;
      const prev = run.claims[claimId];
      return {
        ...run,
        claims: prev ? { ...run.claims, [claimId]: { ...prev, verdict, confidence, note } } : run.claims,
        trace: [...run.trace, { kind: "factcheck", key, at, ...event.data }],
      };
    }
    case "report_delta":
      return { ...run, reportRaw: run.reportRaw + event.data.text };
    case "done":
      return { ...run, status: "done", finishedAt: at, final: event.data };
    case "error":
      return { ...run, status: "error", finishedAt: at, error: event.data };
  }
}

function reducer(runs: Run[], action: Action): Run[] {
  if (action.type === "start") {
    return [
      ...runs,
      {
        id: action.id,
        question: action.question,
        status: "running",
        startedAt: Date.now(),
        areas: [],
        trace: [],
        claims: {},
        sources: {},
        reportRaw: "",
      },
    ];
  }
  return runs.map((r) => (r.id === action.id && r.status === "running" ? applyEvent(r, action.event) : r));
}

export function useResearch() {
  const [runs, dispatch] = useReducer(reducer, []);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (question: string) => {
    const id = crypto.randomUUID();
    dispatch({ type: "start", id, question });
    const controller = new AbortController();
    abortRef.current = controller;
    const fail = (data: ErrorPayload) => dispatch({ type: "event", id, event: { type: "error", data } });
    let finished = false;
    try {
      await streamResearch(
        question,
        (event) => {
          if (event.type === "done" || event.type === "error") finished = true;
          dispatch({ type: "event", id, event });
        },
        controller.signal,
      );
      if (!finished) fail({ code: "stream_closed", message: "The connection closed before the report was finished.", retryable: true });
    } catch (err) {
      if (controller.signal.aborted) fail({ code: "cancelled", message: "Run cancelled.", retryable: true });
      else if (err instanceof StreamError) fail(err.payload);
      else fail({ code: "network", message: `Network error: ${err instanceof Error ? err.message : String(err)}`, retryable: true });
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { runs, start, stop, running: runs.some((r) => r.status === "running") };
}
