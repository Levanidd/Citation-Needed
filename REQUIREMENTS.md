# Due Diligence Research Agent — Requirements (v2)

Nebius Build Week Hackathon · Challenge: **Agentic Deep Research with Token Factory and Tavily**
Hard deadline: **2-minute demo video submitted on the hackathon platform by 18:30**. Code freeze 17:30.

Based on the official brief and the Nebius cookbook:
https://dev.nebius.com/cookbook/deep-research-agent-tavily
Token Factory API reference for coding agents: https://docs.tokenfactory.nebius.com/llms.txt

---

## 0. Challenge rules → design decisions

| Rule / judging signal | How we satisfy it |
|---|---|
| Primary inference on Nebius Token Factory | All LLM calls go to `https://api.tokenfactory.nebius.com/v1` (OpenAI-compatible) |
| Web retrieval uses Tavily | Only Tavily `/search` and `/extract` for retrieval |
| Public GitHub repo with a README a judge can run | One repo, `pnpm i && pnpm dev`, `.dev.vars.example`, tested from a clean clone |
| 2-min demo video by 18:30 | Recorded from the deployed URL, one full uncut run |
| "A judge clicks three citations at random and they hold up" | Every claim stores a **verbatim quote**; server checks the quote exists in the page text; citation links open the page **scrolled to the highlighted quote** (text fragment URL) |
| "Demo shows one complete run with no cuts around the hard part" | Run fits in < 2 min; trace streams live; no hidden steps |
| "Trace shows the agent making decisions, not following a script" | Model-driven **tool-calling loop** (model chooses next search, when to read a page, when to stop) + a fact-checker that can reject claims. Each decision is shown with its one-line reason |
| "Take it somewhere the tutorial doesn't go" | Due diligence focus + per-claim confidence + adversarial fact-checker + quote verification |

**Why not the cookbook code directly:** the cookbook is Python (`deepagents` + LangChain), which does not run on Cloudflare Workers. We keep its defaults (Token Factory base URL, Tavily `search_depth="advanced"`, `max_results=5`) and re-implement the planning loop in TypeScript. README credits the cookbook as the starting point.

---

## 1. Product

A web app with a chat. The user names a company / vendor / startup (or asks any research question). The agent researches it on the live web and returns a **due diligence report where every claim has a source, a verbatim quote, and a confidence rating**.

Primary use case: *"Should we work with / invest in / onboard vendor X?"*
Example inputs (shown as clickable chips in the empty state):
- "Due diligence on Mistral AI as an LLM vendor for a European bank"
- "Is Trade Republic financially stable and properly licensed in Germany?"
- "Risks of choosing Supabase as our primary database provider"

Generic research questions still work; the report template adapts.

---

## 2. Scope

### MVP (must work by 16:30)
- Chat UI, one research run per message.
- Live **agent trace** panel: every tool call with the model's stated reason.
- Researcher agent (tool-calling loop) → claims with quotes.
- Fact-checker pass → verdict per claim → confidence High / Medium / Low.
- Report rendered as Markdown with claim-level citations, confidence badges, sources list.
- Quote verification + text-fragment links.
- Backend on Cloudflare Workers, frontend served by the same Worker.
- Public GitHub repo, README, deployed URL.

### Nice to have (only after MVP)
- Two models: Nemotron for research, **Reflection Beam** for the fact-checker (eligible for Reflection credits).
- Parallel researchers (one per risk area) instead of one sequential loop.
- Save runs in D1 + shareable run URL.
- Export report as Markdown.

### Out of scope
Auth, accounts, file upload, multi-turn follow-ups inside one run, scheduling/monitoring.

---

## 3. User flow

1. Empty state: title, one-line value prop, 3 example chips.
2. User submits a question.
3. Trace panel streams live:
   - **Plan** — risk areas the agent decided to cover (e.g. Company & funding, Licensing & regulation, Security & incidents, Customers & reputation, Financial health).
   - **Decisions** — each tool call: `🔎 search "…"` / `📄 read example.com/…` with the model's reason ("need the licence number from BaFin register").
   - **Claims collected** — counter, grows live.
   - **Fact-check** — per claim: ✅ supported / ⚠️ contested / ❌ unverified, with counter-search queries.
   - **Writing report**.
4. Final message: report + sources + run stats (duration, searches, pages read, claims, verified quotes %).
5. Clicking a citation opens the source in a new tab, scrolled to the highlighted quote.
6. Errors: inline message + Retry.

---

## 4. Architecture

```
Browser (React SPA)
  │ POST /api/research {question}
  ▼
Cloudflare Worker (Hono) ── SSE events ──▶ Browser
  ├─ Researcher loop ── Token Factory (Nemotron, tool calling)
  │     tools: web_search, read_page, record_claim, finish_research
  │     ├─ Tavily /search
  │     └─ Tavily /extract
  ├─ Quote verifier (string match vs extracted page text)
  ├─ Fact-checker ── Token Factory (Nemotron or Beam) + Tavily /search
  └─ Report writer ── Token Factory (streaming)
```

One request = one run; state lives in memory for the duration of the request.

---

## 5. Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind |
| Markdown | `react-markdown` + `remark-gfm`, custom renderer for citations and confidence badges |
| Backend | Cloudflare Workers + Hono + TypeScript |
| LLM client | `openai` npm SDK, `baseURL = NEBIUS_BASE_URL` |
| Search | Tavily REST (`fetch`, no SDK needed) |
| Validation | `zod` |
| Deploy | Wrangler, GitHub Actions (`cloudflare/wrangler-action`) |
| Package mgr | pnpm workspaces |

---

## 6. Repo structure

```
dd-research-agent/
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── components/  Chat, ChatInput, TracePanel, TraceStep, Report,
│   │       │                ClaimCitation, ConfidenceBadge, SourceCard, RunStats
│   │       ├── lib/sse.ts   POST + ReadableStream SSE parser
│   │       └── App.tsx
│   └── worker/
│       ├── src/
│       │   ├── index.ts           Hono routes, static assets
│       │   ├── agent/
│       │   │   ├── researcher.ts  tool-calling loop
│       │   │   ├── tools.ts       tool schemas + executors
│       │   │   ├── verifier.ts    quote verification
│       │   │   ├── factchecker.ts
│       │   │   └── writer.ts
│       │   ├── clients/ nebius.ts, tavily.ts
│       │   ├── prompts/ researcher.md, factchecker.md, writer.md
│       │   ├── sse.ts
│       │   └── types.ts           shared event + data types
│       └── wrangler.toml
├── .github/workflows/deploy.yml
├── .dev.vars.example
├── README.md
└── REQUIREMENTS.md
```

---

## 7. Data model

```ts
type Source = {
  id: number;            // [n] in the report
  url: string;
  title: string;
  domain: string;
  content?: string;      // extracted text, server-only, never sent to the browser in full
};

type Claim = {
  id: string;
  area: string;          // risk area, e.g. "Licensing & regulation"
  text: string;          // one factual statement
  sourceId: number;
  quote: string;         // verbatim excerpt from the source, 10–40 words
  quoteVerified: boolean;// set by verifier
  verdict?: "supported" | "contested" | "unverified";
  confidence?: "high" | "medium" | "low";
  counterEvidence?: { sourceId: number; note: string }[];
};
```

Confidence rule (deterministic, computed in code, not by the model):
- **high** — quote verified AND verdict supported AND (≥ 2 independent domains OR primary source such as regulator / company filing).
- **medium** — quote verified AND verdict supported, single source.
- **low** — quote not verified OR verdict contested / unverified.

---

## 8. Agent logic

### 8.1 Researcher (model-driven loop)

System prompt: due diligence analyst; first decide risk areas; prefer primary sources (regulators, registries, company filings, official docs) over aggregators; every fact must be recorded with `record_claim` including a verbatim quote copied from page text; stop when each area has ≥ 2 claims or no new evidence appears.

Tools (OpenAI function-calling format):

| Tool | Args | Executor |
|---|---|---|
| `plan_areas` | `areas: string[]` (3–5) | emits `plan` event |
| `web_search` | `query: string`, `reason: string` | Tavily `/search`, `search_depth:"advanced"`, `max_results:5`; returns titles, urls, snippets |
| `read_page` | `url: string`, `reason: string` | Tavily `/extract`; stores full text in `Source.content`; returns first ~6k chars to the model |
| `record_claim` | `area, text, url, quote` | creates Claim, runs verifier immediately, returns `verified: true/false` so the model can fix bad quotes |
| `finish_research` | `reason: string` | ends the loop |

`reason` is required on search/read/finish — it is what the trace shows as "the agent's decision".

Loop limits: max 14 model turns, max 8 searches, max 6 page reads, max 20 claims. On hitting a limit the loop forces `finish_research`.

Fallback if tool calling misbehaves on the chosen model: same tools expressed as a JSON action schema (`{"action": "...", "args": {...}}`), parsed with zod, one retry on invalid JSON.

### 8.2 Quote verifier (code, no LLM)

- Normalize both strings: lowercase, collapse whitespace, unify quotes/dashes, strip markdown.
- `verified = normalizedPage.includes(normalizedQuote)`; if not, try a fuzzy window match (≥ 90% token overlap over a sliding window).
- If the page was never read via `read_page`, call `/extract` once before verifying.
- Build citation URL with text fragment: `${url}#:~:text=${encodeURIComponent(first 8–10 words of quote)}`.

### 8.3 Fact-checker

Input: list of claims (text + quote + domain). Task: try to **break** each claim.
- For each claim with confidence potential (verified quotes), the model may run up to 1 counter-search via `web_search` (total cap: 6 searches).
- Output per claim: `verdict` + short note + optional counter-evidence source.
- Emits `factcheck` event per claim.

### 8.4 Writer

Input: verified, fact-checked claims grouped by area + sources list. Streamed Markdown:
1. **Verdict** — 2–3 sentences, overall risk level (Low / Medium / High) with justification.
2. **Key findings** — table: Area · Finding · Confidence.
3. **Section per area** — each sentence ends with `[c:CLAIM_ID]` markers.
4. **Contested or unverified** — what the fact-checker could not confirm.
5. **Gaps** — what the agent did not find.

Writer may only use provided claims; no new facts. Post-processing replaces `[c:ID]` with `[n]` + confidence badge and drops markers with unknown IDs.

### 8.5 Models (env-configurable)

- `NEBIUS_MODEL_RESEARCH` — Nemotron 3 Super (tool calling; per brief, live and good at tool calling).
- `NEBIUS_MODEL_CHECK` — Nemotron 3 Super by default; Reflection **Beam 1.0** if time allows.
- `NEBIUS_MODEL_WRITE` — same as research, or a faster model (Nemotron 3 Nano) if latency is an issue.
- Exact model IDs: copy from the Token Factory catalog; do not hardcode in code, only in `wrangler.toml` vars.

---

## 9. API contract

### `POST /api/research`
Request: `{ "question": string (5–500 chars) }`
Response: `text/event-stream`, events `event: <type>\ndata: <json>\n\n`:

| Event | Payload |
|---|---|
| `run_started` | `{ runId, question, models }` |
| `plan` | `{ areas: string[] }` |
| `decision` | `{ step, tool: "search" \| "read", input, reason }` |
| `tool_result` | `{ step, summary, newSources: SourcePublic[] }` |
| `claim` | `{ claim: ClaimPublic }` |
| `research_done` | `{ reason, claimCount }` |
| `factcheck` | `{ claimId, verdict, confidence, note }` |
| `report_delta` | `{ text }` |
| `done` | `{ report, claims, sources, stats }` |
| `error` | `{ code, message, retryable }` |

`SourcePublic` = Source without `content`. `ClaimPublic` = Claim + `citationUrl`.

### `GET /api/health`
`{ ok, models, tavily }` — checks env vars are set (no live calls).

---

## 10. UI requirements

Layout: desktop two columns (report left ~60%, trace right ~40%); mobile stacked with trace collapsible.

- **ChatInput** — Enter sends, Shift+Enter newline, disabled during a run.
- **TracePanel** — vertical timeline; each `decision` row shows icon, query or domain, and the reason in muted text; rows animate in; step durations.
- **Report** — Markdown, GFM tables; citation `[n]` as superscript link; hover card shows source title, domain, the **verbatim quote**, ✓ verified / ✗ not verified.
- **ConfidenceBadge** — High (green) / Medium (amber) / Low (red), on every sentence with a claim and in the findings table.
- **SourceCard** — number, favicon (`https://www.google.com/s2/favicons?domain=`), title, domain.
- **RunStats** — duration, searches, pages read, claims, % quotes verified.
- States: idle, running, done, error. Dark/light via `prefers-color-scheme`. Report text width ≤ 760px.

---

## 11. Non-functional

- First SSE event < 1s; first `decision` < 10s; full run ≤ 120s.
- Timeouts: LLM call 60s, Tavily 20s; whole run 150s soft cap → force finish and write with what exists.
- Subrequests per run stay < 50 (Workers free plan limit): ~14 LLM + 8 search + 6 extract + 6 counter-search + 2 writer ≈ 36.
- Every external call wrapped; failures become SSE `error`, stream always closes.
- zod validation of request body and all model JSON.
- Rate limit 5 runs/min per IP (KV counter).
- Keys only on the server: `.dev.vars` locally, `wrangler secret put` in prod. `.gitignore`: `.dev.vars`, `node_modules`, `dist`.
- Structured logs per step (`runId`, step, tool, ms) for `wrangler tail`.

---

## 12. Config

`.dev.vars.example`
```
NEBIUS_API_KEY=
TAVILY_API_KEY=
```

`wrangler.toml` vars
```
NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1"
NEBIUS_MODEL_RESEARCH = "<Nemotron 3 Super id from catalog>"
NEBIUS_MODEL_CHECK    = "<same or Beam id>"
NEBIUS_MODEL_WRITE    = "<same or Nemotron 3 Nano id>"
```

GitHub Actions secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

---

## 13. README (judge must be able to run it)

1. One-paragraph pitch + screenshot/GIF + deployed URL + demo video link.
2. What's beyond the cookbook: claim-level quotes, verification, fact-checker, confidence rule.
3. Architecture diagram (section 4).
4. Run locally: prerequisites (Node 20+, pnpm), `cp .dev.vars.example apps/worker/.dev.vars`, `pnpm i`, `pnpm dev`, open `http://localhost:8787`.
5. Deploy: `wrangler secret put …`, `pnpm deploy`.
6. Models used and why; tools used (Token Factory, Tavily, Nemotron, optionally Beam).
7. Credits: Nebius cookbook as the starting point.

Verify by cloning into a fresh folder and following the README literally before 17:30.

---

## 14. Acceptance criteria

1. Deployed URL: one question → full report in ≤ 2 minutes.
2. Trace shows plan, ≥ 5 search/read decisions with reasons, fact-check verdicts — before the report finishes.
3. Pick 3 citations at random: each opens the right page and the quote is highlighted or findable on the page.
4. ≥ 80% of claims in the final report have `quoteVerified = true`; unverified ones are visibly marked Low.
5. At least one claim in the demo run is downgraded by the fact-checker (shows real decisions).
6. Invalid Tavily key → readable error in UI, no hanging spinner.
7. Fresh clone + README steps run locally in < 5 minutes.

---

## 15. Demo video (2 min, by 18:30)

- 0:00–0:15 Problem: due diligence takes analysts days, AI answers can't be trusted without sources.
- 0:15–1:25 One live, uncut run on the deployed site: plan → decisions with reasons → claims → fact-checker downgrades something → report.
- 1:25–1:50 Click 2–3 citations: page opens on the highlighted quote. Show confidence table.
- 1:50–2:00 Stack (Token Factory + Nemotron + Tavily + Cloudflare) and repo link.

Pre-test 3 questions; pick the one with the best fact-checker moment.

---

## 16. Time plan

| Time | Task |
|---|---|
| 11:45–12:15 | Keys working (Token Factory promo code, Tavily). Run the Python cookbook once end to end. Scaffold repo, `/api/health`, first Token Factory call from the Worker |
| 12:15–13:45 | Researcher loop with tools + SSE events (check in terminal with `curl -N`) |
| 13:45–14:30 | Quote verifier + text-fragment links + fact-checker |
| 14:30–15:45 | UI: chat, trace panel, report with citations and badges |
| 15:45–16:30 | Writer, deploy, error states, tune prompts on 3 test questions |
| 16:30–17:30 | README, fresh-clone test, code freeze |
| 17:30–18:15 | Record and edit demo video |
| 18:15–18:30 | Submit video + repo link on the hackathon platform |
