export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function formatCredits(credits: number): string {
  return Number.isInteger(credits) ? String(credits) : credits.toFixed(1);
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

const LABS: Record<string, string> = {
  nvidia: "NVIDIA",
  reflection: "Reflection AI",
  "deepseek-ai": "DeepSeek",
  qwen: "Qwen",
  "meta-llama": "Meta",
  mistralai: "Mistral AI",
  moonshotai: "Moonshot AI",
  "zai-org": "Z.ai",
  openai: "OpenAI",
  google: "Google",
};

const MODEL_NAMES: Record<string, string> = {
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super",
  "nvidia/nvidia-nemotron-3-nano-30b-a3b": "Nemotron 3 Nano",
  "reflection/beam": "Beam 1.0",
};

/** "reflection/beam" → { name: "Beam 1.0", lab: "Reflection AI" }. */
export function modelLabel(id: string): { name: string; lab: string } {
  const [org = "", ...rest] = id.split("/");
  if (!rest.length) return { name: id, lab: "" };
  return { name: MODEL_NAMES[id.toLowerCase()] ?? rest.join("/"), lab: LABS[org.toLowerCase()] ?? org };
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 32 ? `${u.pathname.slice(0, 31)}…` : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${path === "/" ? "" : path}`;
  } catch {
    return url;
  }
}

export function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}
