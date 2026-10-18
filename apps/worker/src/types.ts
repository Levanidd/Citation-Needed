// Shared data + SSE event types. Imported (type-only) by apps/web, so keep this file
// free of runtime code and Worker-specific globals.

export type Verdict = "supported" | "contested" | "unverified";
export type Confidence = "high" | "medium" | "low";
export type Phase = "research" | "factcheck" | "writing";

export interface SourcePublic {
  id: number; // [n] in the report
  url: string;
  title: string;
  domain: string;
}

export interface Source extends SourcePublic {
  content?: string; // extracted page text, server-only
  snippet?: string; // search snippet, server-only
  published?: string; // YYYY-MM-DD for news results, server-only
}

export interface Claim {
  id: string;
  area: string;
  text: string;
  sourceId: number;
  quote: string; // verbatim excerpt from the source, 10–40 words
  quoteVerified: boolean;
  verdict?: Verdict;
  confidence?: Confidence;
  note?: string; // fact-checker note
  adverse?: boolean; // negative event (fine, lawsuit, breach, outage…), flagged by the fact-checker
  primarySource?: boolean;
  corroboratingSourceIds?: number[];
  counterEvidence?: { sourceId: number; note: string }[];
}

export interface ClaimPublic extends Claim {
  citationUrl: string; // source URL with a #:~:text= fragment pointing at the quote
}

export interface ModelNames {
  research: string;
  check: string;
  write: string;
}

export interface RoleUsage {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number; // undefined while the model's price is unknown
}

export interface Usage {
  byRole: Record<keyof ModelNames, RoleUsage>;
  promptTokens: number;
  completionTokens: number;
  llmCostUsd?: number;
  tavilyCredits: number;
  tavilyCostUsd: number;
}

export interface RunStats {
  durationMs: number;
  searches: number;
  newsSearches: number;
  counterSearches: number;
  pagesRead: number;
  claims: number;
  verifiedQuotes: number;
  verifiedPct: number;
  sources: number;
  llmCalls: number;
  usage: Usage;
}

export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export interface EventMap {
  run_started: { runId: string; question: string; models: ModelNames };
  phase: { phase: Phase };
  plan: { areas: string[] };
  decision: {
    step: number;
    tool: "search" | "news" | "read";
    input: string;
    reason: string;
    phase: Phase;
    claimId?: string;
  };
  tool_result: { step: number; summary: string; newSources: SourcePublic[]; ms: number; ok: boolean };
  claim: { claim: ClaimPublic; source: SourcePublic; fixed: boolean };
  note: { text: string };
  research_done: { reason: string; claimCount: number };
  factcheck: { claimId: string; verdict: Verdict; confidence: Confidence; note: string };
  report_delta: { text: string };
  usage: Usage;
  done: { report: string; claims: ClaimPublic[]; sources: SourcePublic[]; stats: RunStats };
  error: ErrorPayload;
}

export type EventType = keyof EventMap;

export type ResearchEvent = { [K in EventType]: { type: K; data: EventMap[K] } }[EventType];
