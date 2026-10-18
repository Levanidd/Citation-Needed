import type { ChatCompletionMessage } from "openai/resources/chat/completions";
import { z } from "zod";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolOutcome {
  content: string;
  finish?: boolean;
}

const FallbackAction = z.object({ action: z.string(), args: z.record(z.string(), z.unknown()).default({}) });
const FallbackCall = z.object({
  name: z.string(),
  arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).default({}),
});

/** Native tool calls, or — if the model wrote them as text — calls parsed from JSON in the content. */
export function extractToolCalls(message: ChatCompletionMessage): { calls: ToolCall[]; native: boolean } {
  const native = (message.tool_calls ?? [])
    .filter((c) => c.type === "function")
    .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments || "{}" }));
  if (native.length) return { calls: native, native: true };
  return { calls: parseTextToolCalls(message.content ?? ""), native: false };
}

/** JSON action fallback: `{"action": ..., "args": ...}`, `<tool_call>` blocks or fenced JSON. */
export function parseTextToolCalls(content: string): ToolCall[] {
  if (!content.includes("{")) return [];
  const blobs: string[] = [];
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) blobs.push(m[1]);
  if (!blobs.length) for (const m of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) blobs.push(m[1]);
  if (!blobs.length) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (end > start) blobs.push(content.slice(start, end + 1));
  }
  const calls: ToolCall[] = [];
  for (const blob of blobs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const action = FallbackAction.safeParse(item);
      if (action.success) {
        calls.push({ id: `text-${calls.length}`, name: action.data.action, arguments: JSON.stringify(action.data.args) });
        continue;
      }
      const call = FallbackCall.safeParse(item);
      if (call.success) {
        const args = call.data.arguments;
        calls.push({
          id: `text-${calls.length}`,
          name: call.data.name,
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        });
      }
    }
  }
  return calls;
}

export function parseArgs<T extends z.ZodType>(
  schema: T,
  raw: string,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw.trim().replace(/^```(?:json)?|```$/g, "") || "{}");
  } catch {
    return { ok: false, error: "Arguments are not valid JSON." };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  }
  return { ok: true, data: parsed.data };
}
