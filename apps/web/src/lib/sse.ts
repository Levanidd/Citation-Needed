import type { ErrorPayload, EventType, ResearchEvent } from "@worker/types.ts";

export class StreamError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.message);
  }
}

function parseBlock(block: string): ResearchEvent | null {
  let type = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  try {
    return { type: type as EventType, data: JSON.parse(data.join("\n")) } as ResearchEvent;
  } catch {
    return null;
  }
}

/** POST /api/research and parse the SSE response body as it streams in. */
export async function streamResearch(
  question: string,
  onEvent: (event: ResearchEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: ErrorPayload } | null;
    throw new StreamError(
      body?.error ?? { code: `http_${res.status}`, message: `Request failed with HTTP ${res.status}.`, retryable: true },
    );
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value.replace(/\r\n/g, "\n");
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const event = parseBlock(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (event) onEvent(event);
      idx = buffer.indexOf("\n\n");
    }
  }
}
