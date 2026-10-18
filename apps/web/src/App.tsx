import { useEffect, useState } from "react";
import { Chat } from "./components/Chat.tsx";
import { ChatInput } from "./components/ChatInput.tsx";
import { TracePanel } from "./components/TracePanel.tsx";
import { useResearch } from "./lib/useResearch.ts";

const EXAMPLES = [
  "Due diligence on Mistral AI as an LLM vendor for a European bank",
  "Is Trade Republic financially stable and properly licensed in Germany?",
  "Risks of choosing Supabase as our primary database provider",
];

const REPO_URL = "https://github.com/Levanidd/Citation-Needed";

function Logo() {
  return (
    <span className="font-semibold tracking-tight">
      Citation <span className="text-accent">[needed]</span>
    </span>
  );
}

export default function App() {
  const { runs, start, stop, running } = useResearch();
  const [selectedId, setSelectedId] = useState<string>();

  const latest = runs[runs.length - 1];
  const selected = runs.find((r) => r.id === selectedId) ?? latest;

  useEffect(() => {
    setSelectedId(latest?.id);
    if (!latest) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(`run-${latest.id}`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, [latest?.id]);

  const ask = (question: string) => {
    if (!running) void start(question);
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="flex items-center gap-4 text-xs text-muted">
            <span className="hidden sm:inline">Nebius Token Factory · Nemotron · Tavily</span>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="font-medium text-fg hover:text-accent">
              GitHub
            </a>
          </nav>
        </div>
      </header>

      {!latest ? (
        <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-3xl flex-col justify-center px-4 py-12 sm:px-6">
          <div className="text-center">
            <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted shadow-card">
              <span className="size-1.5 rounded-full bg-pos" /> Agentic deep research · every claim has a receipt
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
              Due diligence you can <span className="text-accent">click through</span>.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-[17px] leading-relaxed text-muted">
              Name a company, vendor or startup. The agent researches the live web and returns a report where every claim has a source, a
              verbatim quote and a confidence rating — challenged by an adversarial fact-checker.
            </p>
          </div>
          <div className="mt-10">
            <ChatInput disabled={running} onSubmit={ask} autoFocus />
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                className="rounded-[10px] border border-line bg-surface px-3 py-2 text-left text-[13px] font-medium text-fg shadow-card transition hover:border-accent/50 hover:text-accent active:scale-[0.97]"
              >
                {q}
              </button>
            ))}
          </div>
        </main>
      ) : (
        <main className="mx-auto grid max-w-[1440px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section className="order-2 flex min-w-0 flex-col lg:order-1">
            <Chat runs={runs} selectedId={selected?.id} onSelect={setSelectedId} onRetry={ask} />
            <div className="sticky bottom-0 z-20 mt-6 bg-gradient-to-t from-bg via-bg/95 to-transparent pt-6 pb-4">
              <ChatInput disabled={running} onSubmit={ask} onStop={stop} />
            </div>
          </section>
          <aside className="order-1 min-w-0 lg:order-2 lg:sticky lg:top-20 lg:h-[calc(100dvh-6.5rem)]">
            {selected && <TracePanel run={selected} />}
          </aside>
        </main>
      )}
    </div>
  );
}
