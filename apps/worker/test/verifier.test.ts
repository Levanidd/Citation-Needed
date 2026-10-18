import assert from "node:assert/strict";
import { test } from "node:test";
import { citationUrl, preparePage, selectExcerpt, stripMarkdown, verifyQuote } from "../src/agent/verifier.ts";

const PAGE = `# Trade Republic Bank GmbH

Trade Republic is **supervised** by the [Federal Financial Supervisory Authority (BaFin)](https://www.bafin.de) and the Deutsche Bundesbank.
The company holds a full banking licence since 2023 — it’s one of Europe’s largest savings platforms.

| Year | Customers |
|------|-----------|
| 2024 | 8 million |
`;

test("exact match survives markdown, curly quotes and dashes", () => {
  const page = preparePage(PAGE);
  const r = verifyQuote(page, `"The company holds a full banking licence since 2023 - it's one of Europe's largest savings platforms."`);
  assert.equal(r.verified, true);
  assert.equal(r.method, "exact");
  assert.match(r.matchedText ?? "", /it’s one of Europe’s largest/);
});

test("quote copied with markdown link syntax still verifies", () => {
  const page = preparePage(PAGE);
  const r = verifyQuote(page, "Trade Republic is **supervised** by the [Federal Financial Supervisory Authority (BaFin)](https://www.bafin.de) and the Deutsche Bundesbank");
  assert.equal(r.verified, true);
});

test("fuzzy match tolerates a dropped word", () => {
  const page = preparePage(PAGE);
  const r = verifyQuote(page, "Trade Republic is supervised by the Federal Financial Supervisory Authority BaFin and Deutsche Bundesbank");
  assert.equal(r.verified, true);
});

test("paraphrase is rejected", () => {
  const page = preparePage(PAGE);
  const r = verifyQuote(page, "Trade Republic received its banking license from regulators in Germany in 2021");
  assert.equal(r.verified, false);
});

test("ellipsis quotes verify each segment", () => {
  const page = preparePage(PAGE);
  assert.equal(verifyQuote(page, "Trade Republic is supervised by the Federal ... holds a full banking licence since 2023").verified, true);
  assert.equal(verifyQuote(page, "Trade Republic is supervised by the Federal ... holds no banking licence at all").verified, false);
});

test("too-short quotes are not verified", () => {
  assert.equal(verifyQuote(preparePage(PAGE), "banking licence").verified, false);
});

test("stripMarkdown removes links, images and table pipes", () => {
  const s = stripMarkdown("![logo](a.png) See [docs](https://x.y/(a)) | **bold** |");
  assert.equal(s.replace(/\s+/g, " ").trim(), "See docs bold");
});

test("citationUrl builds an encoded text fragment and drops existing hashes", () => {
  const short = citationUrl("https://example.com/a#top", "full banking licence - since 2023");
  assert.equal(short, "https://example.com/a#:~:text=full%20banking%20licence%20%2D%20since%202023");
  const long = citationUrl("https://example.com/a", "one two three four five six seven eight nine ten eleven twelve thirteen");
  assert.equal(long, "https://example.com/a#:~:text=one%20two%20three%20four%20five%20six,nine%20ten%20eleven%20twelve%20thirteen");
});

test("selectExcerpt keeps relevant paragraphs within budget", () => {
  const filler = Array.from({ length: 50 }, (_, i) => `Navigation paragraph number ${i} about unrelated menu items and cookie banners.`).join("\n");
  const plain = `${filler}\nThe BaFin licence register lists Trade Republic Bank GmbH with a full banking licence.\n${filler}`;
  const out = selectExcerpt(plain, "BaFin licence register", 1200);
  assert.ok(out.length <= 1200);
  assert.match(out, /BaFin licence register lists/);
});
