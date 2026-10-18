import assert from "node:assert/strict";
import { test } from "node:test";
import { orderCitedSources, plainCitations, renderCitations, trimPartialMarker } from "../src/citations.ts";
import { computeConfidence, isPrimaryDomain } from "../src/agent/confidence.ts";

test("confidence rule", () => {
  const base = { quoteVerified: true, verdict: "supported" as const, independentDomains: 1, primarySource: false };
  assert.equal(computeConfidence(base), "medium");
  assert.equal(computeConfidence({ ...base, independentDomains: 2 }), "high");
  assert.equal(computeConfidence({ ...base, primarySource: true }), "high");
  assert.equal(computeConfidence({ ...base, quoteVerified: false, primarySource: true }), "low");
  assert.equal(computeConfidence({ ...base, verdict: "contested", independentDomains: 3 }), "low");
  assert.equal(computeConfidence({ ...base, verdict: undefined }), "low");
});

test("primary domains", () => {
  assert.ok(isPrimaryDomain("bafin.de"));
  assert.ok(isPrimaryDomain("www.sec.gov"));
  assert.ok(isPrimaryDomain("portal.mvp.bafin.de"));
  assert.ok(isPrimaryDomain("esma.europa.eu"));
  assert.ok(!isPrimaryDomain("techcrunch.com"));
  assert.ok(!isPrimaryDomain("notgov.com"));
});

test("citation markers are numbered by first appearance and unknown ids dropped", () => {
  const claims = new Map([
    ["c1", { sourceId: 7 }],
    ["c2", { sourceId: 3 }],
    ["c3", { sourceId: 7 }],
  ]);
  const text = "A [c:c2]. B [c:c1][c:c3]. C [c:c1, c:c2]. D [c:c99].";
  const order = orderCitedSources(text, claims);
  assert.deepEqual(order, [3, 7]);
  const n = new Map(order.map((id, i) => [id, i + 1]));
  const out = renderCitations(text, claims, (id) => n.get(id));
  assert.equal(out, "A [1](#claim-c2). B [2](#claim-c1)[2](#claim-c3). C [2](#claim-c1)[1](#claim-c2). D .");
  assert.equal(plainCitations(out), "A [1]. B [2][2]. C [2][1]. D .");
});

test("partial markers at the end of a stream are hidden", () => {
  assert.equal(trimPartialMarker("Risk is low [c:c1"), "Risk is low ");
  assert.equal(trimPartialMarker("Risk is low ["), "Risk is low ");
  assert.equal(trimPartialMarker("Risk is low [c:c1]"), "Risk is low [c:c1]");
});
