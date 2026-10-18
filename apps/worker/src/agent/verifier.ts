// Quote verification without an LLM: a claim's quote must appear in the extracted page text.
// Exact match on normalized text first, then a fuzzy sliding window (≥ 90% token overlap).

export interface PreparedPage {
  /** Page text with Markdown removed; original casing and punctuation (used for text fragments). */
  plain: string;
  /** Lowercased, whitespace-collapsed, quote/dash-unified version of `plain`. */
  norm: string;
  /** norm index -> plain index */
  map: number[];
  tokens?: { words: string[]; starts: number[]; ends: number[] };
}

export interface QuoteMatch {
  verified: boolean;
  method: "exact" | "fuzzy" | "none";
  score: number;
  /** The matching passage as it appears on the page. */
  matchedText?: string;
}

const FUZZY_THRESHOLD = 0.9;
const MIN_QUOTE_WORDS = 4;

const CHAR_MAP: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'", "\u2032": "'", "\u00B4": "'", "`": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"', "\u2033": '"', "\u00AB": '"', "\u00BB": '"',
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
  "\u2026": "...",
};

const INVISIBLE = new Set(["\u200B", "\u200C", "\u200D", "\uFEFF", "\u00AD"]);

function isSpace(code: number): boolean {
  return (
    code <= 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g, " ")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/`+/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
}

function normalize(text: string, withMap: boolean): { norm: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (INVISIBLE.has(ch)) continue;
    if (isSpace(ch.charCodeAt(0))) {
      if (!lastSpace) {
        out.push(" ");
        if (withMap) map.push(i);
        lastSpace = true;
      }
      continue;
    }
    const rep = CHAR_MAP[ch] ?? ch.toLowerCase();
    for (const r of rep) {
      out.push(r);
      if (withMap) map.push(i);
    }
    lastSpace = false;
  }
  if (out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { norm: out.join(""), map };
}

export function normalizeText(text: string): string {
  return normalize(stripMarkdown(text), false).norm;
}

export function preparePage(content: string): PreparedPage {
  const plain = stripMarkdown(content);
  const { norm, map } = normalize(plain, true);
  return { plain, norm, map };
}

function tokenize(text: string): { words: string[]; starts: number[]; ends: number[] } {
  const words: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    words.push(m[0].toLowerCase());
    starts.push(m.index);
    ends.push(m.index + m[0].length);
  }
  return { words, starts, ends };
}

export function words(text: string): string[] {
  return tokenize(text).words;
}

function cleanQuote(quote: string): string {
  return normalizeText(quote)
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^\.{3}\s*|\s*\.{3}$/g, "")
    .trim();
}

function fuzzyFind(page: PreparedPage, segment: string): { score: number; start: number; end: number } | null {
  const q = words(segment);
  const m = q.length;
  if (m < MIN_QUOTE_WORDS) return null;
  page.tokens ??= tokenize(page.plain);
  const { words: tokens, starts, ends } = page.tokens;
  if (tokens.length < m) return null;

  const need = new Map<string, number>();
  for (const t of q) need.set(t, (need.get(t) ?? 0) + 1);
  const win = new Map<string, number>();
  let matches = 0;
  let best = -1;
  let bestAt = 0;
  for (let i = 0; i < tokens.length; i++) {
    const add = tokens[i];
    const limitAdd = need.get(add);
    if (limitAdd !== undefined) {
      const c = (win.get(add) ?? 0) + 1;
      win.set(add, c);
      if (c <= limitAdd) matches++;
    }
    if (i >= m) {
      const drop = tokens[i - m];
      const limitDrop = need.get(drop);
      if (limitDrop !== undefined) {
        const c = win.get(drop) ?? 0;
        if (c <= limitDrop) matches--;
        win.set(drop, c - 1);
      }
    }
    if (i >= m - 1 && matches > best) {
      best = matches;
      bestAt = i - m + 1;
      if (best === m) break;
    }
  }
  const score = best / m;
  if (score < FUZZY_THRESHOLD) return null;
  return { score, start: starts[bestAt], end: ends[bestAt + m - 1] };
}

export function verifyQuote(page: PreparedPage, quote: string): QuoteMatch {
  const cleaned = cleanQuote(quote);
  if (words(cleaned).length < MIN_QUOTE_WORDS) return { verified: false, method: "none", score: 0 };

  // A quote with an ellipsis is verified segment by segment.
  const segments = cleaned
    .split(/\s*\.{3,}\s*/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
  if (segments.length === 0) return { verified: false, method: "none", score: 0 };

  let method: QuoteMatch["method"] = "exact";
  let minScore = 1;
  let first: { start: number; end: number } | undefined;
  for (const seg of segments) {
    const idx = page.norm.indexOf(seg);
    let span: { start: number; end: number };
    if (idx >= 0) {
      span = { start: page.map[idx], end: page.map[idx + seg.length - 1] + 1 };
    } else {
      const fuzzy = fuzzyFind(page, seg);
      if (!fuzzy) return { verified: false, method: "none", score: 0 };
      method = "fuzzy";
      minScore = Math.min(minScore, fuzzy.score);
      span = fuzzy;
    }
    first ??= span;
  }
  return {
    verified: true,
    method,
    score: minScore,
    matchedText: first ? page.plain.slice(first.start, first.end) : undefined,
  };
}

function encodeFragmentPart(s: string): string {
  return encodeURIComponent(s).replace(/-/g, "%2D");
}

/** `url#:~:text=start,end` so the browser scrolls to and highlights the quote. */
export function citationUrl(url: string, passage: string): string {
  const base = url.split("#")[0];
  const parts = passage
    .replace(/[*`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (parts.length === 0) return base;
  if (parts.length <= 12) return `${base}#:~:text=${encodeFragmentPart(parts.join(" "))}`;
  const start = encodeFragmentPart(parts.slice(0, 6).join(" "));
  const end = encodeFragmentPart(parts.slice(-5).join(" "));
  return `${base}#:~:text=${start},${end}`;
}

const STOPWORDS = new Set(
  "the and for with that this from have has had was were are been being which their there about into than then they them what when where while will would could should also more most such only other over under very just like your our its it's not but can may".split(
    " ",
  ),
);

/** Pick the paragraphs most relevant to `focus`, in page order, within `maxChars`. */
export function selectExcerpt(plain: string, focus: string, maxChars: number): string {
  const text = plain.replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= maxChars) return text;
  const keywords = new Set(words(focus).filter((w) => w.length > 3 && !STOPWORDS.has(w)));
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40);
  const scored = paras.map((p, i) => {
    let hits = 0;
    for (const w of words(p)) if (keywords.has(w)) hits++;
    const lead = i < 3 ? 1 : 0;
    return { i, p, score: hits / Math.sqrt(p.length / 200 + 1) + lead };
  });
  const chosen = new Set<number>();
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (used + s.p.length + 2 > maxChars) continue;
    chosen.add(s.i);
    used += s.p.length + 2;
    if (used > maxChars - 200) break;
  }
  return scored
    .filter((s) => chosen.has(s.i))
    .map((s) => s.p)
    .join("\n\n");
}
