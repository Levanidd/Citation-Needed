import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTextToolCalls } from "../src/agent/toolcalls.ts";

test("parses JSON action fallback", () => {
  const calls = parseTextToolCalls('Sure.\n{"action": "web_search", "args": {"query": "Mistral AI funding", "reason": "funding"}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "web_search");
  assert.deepEqual(JSON.parse(calls[0].arguments), { query: "Mistral AI funding", reason: "funding" });
});

test("parses <tool_call> blocks", () => {
  const calls = parseTextToolCalls(
    '<tool_call>{"name": "read_page", "arguments": {"url": "https://a.b", "reason": "r"}}</tool_call><tool_call>{"name": "finish_research", "arguments": "{\\"reason\\": \\"done\\"}"}</tool_call>',
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    ["read_page", "finish_research"],
  );
  assert.equal(JSON.parse(calls[1].arguments).reason, "done");
});

test("ignores prose without JSON", () => {
  assert.deepEqual(parseTextToolCalls("I will now search the web."), []);
});
