import type { ClaimPublic, Confidence, ModelNames, SourcePublic, Verdict } from "@worker/types.ts";
import type { List, Nodes, PhrasingContent, RootContent, Table } from "mdast";
import * as pdfMakeModule from "pdfmake/build/pdfmake.js";
import vfs from "pdfmake/build/vfs_fonts.js";
import type { Content, ContentText, CustomTableLayout, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { exportFileName, formatCredits, formatDuration, formatTokens, formatUsd, modelLabel } from "./format.ts";
import type { Run } from "./useResearch.ts";

// The UMD bundle exposes its API on `default` under Vite's CommonJS interop.
const pdfMake = (pdfMakeModule as { default?: typeof pdfMakeModule }).default ?? pdfMakeModule;
pdfMake.addVirtualFileSystem(vfs);

// Light theme tokens from index.css: PDFs are read on paper and white screens.
const C = {
  fg: "#0d0d0f",
  muted: "#6b6b7a",
  subtle: "#a0a0b0",
  accent: "#7c3aed",
  line: "#e6e6ec",
  lineStrong: "#d4d4dc",
  surface: "#f5f5f7",
  pos: "#1f8a3b",
  warn: "#8a6a00",
  neg: "#d70015",
};
const TONE: Record<Confidence, { color: string; bg: string }> = {
  high: { color: C.pos, bg: "#ddeee1" },
  medium: { color: C.warn, bg: "#eee8da" },
  low: { color: C.neg, bg: "#f9d9dc" },
};
const RISK_TONE = { low: TONE.high, medium: TONE.medium, high: TONE.low };
const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "High", medium: "Medium", low: "Low" };
const VERDICT_LABEL: Record<Verdict, string> = { supported: "Supported", contested: "Contested", unverified: "Unverified" };
const ROLE_LABEL: Record<keyof ModelNames, string> = { research: "Research", check: "Fact-check", write: "Writer" };

const A4_WIDTH = 595.28;
const PAGE_MARGIN_X = 48;

interface Refs {
  claims: Record<string, ClaimPublic>;
}

const destination = (claimId: string) => `claim-${claimId}`;

function plainText(node: Nodes | undefined): string {
  if (!node) return "";
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map((child) => plainText(child)).join("");
  return "";
}

type InlineStyle = Omit<ContentText, "text">;

// pdfmake drops the style of a node whose `text` is an array, so styles are pushed down to string leaves.
function inlines(nodes: PhrasingContent[], refs: Refs, style: InlineStyle = {}): ContentText[] {
  return nodes.flatMap((node) => inline(node, refs, style));
}

function inline(node: PhrasingContent, refs: Refs, style: InlineStyle): ContentText[] {
  const leaf = (text: string, extra: InlineStyle = {}): ContentText[] => [{ ...style, ...extra, text }];
  switch (node.type) {
    case "text":
      return leaf(node.value.replace(/[ \t]*\n[ \t]*/g, " "));
    case "strong": {
      const risk = /^overall risk:\s*(low|medium|high)\b/i.exec(plainText(node).trim());
      if (risk) {
        const tone = RISK_TONE[risk[1].toLowerCase() as keyof typeof RISK_TONE];
        const pill = { ...style, bold: true, color: tone.color, background: tone.bg };
        return [{ ...pill, text: " " }, ...inlines(node.children, refs, pill), { ...pill, text: " " }];
      }
      return inlines(node.children, refs, { ...style, bold: true });
    }
    case "emphasis":
      return inlines(node.children, refs, { ...style, italics: true });
    case "delete":
      return inlines(node.children, refs, { ...style, decoration: "lineThrough" });
    case "inlineCode":
      return leaf(node.value, { background: C.surface });
    case "break":
      return leaf("\n");
    case "link": {
      if (node.url.startsWith("#claim-")) {
        const claim = refs.claims[node.url.slice(7)];
        const label = `[${plainText(node)}]`;
        if (!claim) return leaf(label, { sup: true, color: C.subtle });
        return leaf(label, { sup: true, bold: true, color: C.accent, linkToDestination: destination(claim.id) });
      }
      return inlines(node.children, refs, { ...style, link: node.url, color: C.accent });
    }
    case "linkReference":
      return inlines(node.children, refs, style);
    case "image":
    case "imageReference":
      return leaf(node.alt ?? "");
    case "footnoteReference":
      return leaf(`[${node.label ?? node.identifier}]`, { sup: true });
    case "html":
      return [];
  }
}

function blocks(nodes: RootContent[], refs: Refs, tight = false): Content[] {
  return nodes.flatMap((node) => block(node, refs, tight) ?? []);
}

function block(node: RootContent, refs: Refs, tight: boolean): Content | null {
  switch (node.type) {
    case "heading":
      return { text: inlines(node.children, refs), style: node.depth <= 2 ? "h2" : "h3", headlineLevel: 1 };
    case "paragraph":
      return { text: inlines(node.children, refs), style: tight ? "li" : "p" };
    case "list":
      return list(node, refs);
    case "table":
      return table(node, refs);
    case "blockquote":
      return { stack: blocks(node.children, refs), style: "quote" };
    case "code":
      return { text: node.value, style: "p", background: C.surface };
    case "thematicBreak":
      return rule(6);
    default:
      return null;
  }
}

function list(node: List, refs: Refs): Content {
  const items = node.children.map((item) => ({ stack: blocks(item.children, refs, true) }));
  return node.ordered
    ? { ol: items, start: node.start ?? 1, style: "list", markerColor: C.muted }
    : { ul: items, style: "list", markerColor: C.subtle };
}

const tableLayout: CustomTableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.6),
  vLineWidth: () => 0,
  hLineColor: (i) => (i === 1 ? C.lineStrong : C.line),
  fillColor: (row) => (row === 0 ? C.surface : null),
  paddingLeft: () => 6,
  paddingRight: () => 6,
  paddingTop: () => 5,
  paddingBottom: () => 5,
};

function table(node: Table, refs: Refs): Content {
  const cols = Math.max(...node.children.map((row) => row.children.length));
  const body: TableCell[][] = node.children.map((row, r) =>
    Array.from({ length: cols }, (_, c): TableCell => {
      const cell = row.children[c];
      const text = plainText(cell).trim();
      if (r === 0) return { text: text.toUpperCase(), style: "th" };
      const level = text.toLowerCase();
      if (level === "high" || level === "medium" || level === "low") {
        return { text: CONFIDENCE_LABEL[level], bold: true, color: TONE[level].color, style: "td" };
      }
      return { text: cell ? inlines(cell.children, refs) : "", style: "td" };
    }),
  );
  // Short columns (area names, confidence) size to content; prose columns share the rest.
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(...node.children.map((row) => plainText(row.children[c]).length)) <= 26 ? "auto" : "*",
  );
  return { table: { headerRows: 1, dontBreakRows: true, widths, body }, layout: tableLayout, margin: [0, 2, 0, 10] };
}

function rule(margin: number): Content {
  return {
    canvas: [{ type: "line", x1: 0, y1: 0, x2: A4_WIDTH - PAGE_MARGIN_X * 2, y2: 0, lineWidth: 0.6, lineColor: C.line }],
    margin: [0, margin, 0, margin],
  };
}

function sectionTitle(title: string, note: string, newPage = false): Content[] {
  return [
    { text: title, style: "section", headlineLevel: 1, pageBreak: newPage ? "before" : undefined },
    { text: note, style: "sectionNote" },
  ];
}

const quoteLayout: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: (i) => (i === 0 ? 2 : 0),
  vLineColor: () => C.accent,
  paddingLeft: () => 8,
  paddingRight: () => 0,
  paddingTop: () => 1,
  paddingBottom: () => 1,
};

function evidenceEntry(claim: ClaimPublic, sources: Record<number, SourcePublic>): Content {
  const source = sources[claim.sourceId];
  const status: Content[] = [
    claim.quoteVerified
      ? { text: "Quote verified on page", color: C.pos, bold: true }
      : { text: "Quote not found on page", color: C.neg, bold: true },
  ];
  if (claim.adverse) status.push("  ·  ", { text: "Adverse media", color: C.neg, bold: true });
  status.push("  ·  ", { text: "Open source at quote", link: claim.citationUrl, color: C.accent });

  const cite = (ids: number[]) => ids.map((id) => `[${id}]`).join(" ");
  const extra: Content[] = [];
  if (claim.note) extra.push({ text: [{ text: "Fact-check: ", bold: true }, claim.note], style: "evidenceMeta" });
  if (claim.corroboratingSourceIds?.length) {
    extra.push({ text: [{ text: "Corroborated by: ", bold: true }, cite(claim.corroboratingSourceIds)], style: "evidenceMeta" });
  }
  for (const e of claim.counterEvidence ?? []) {
    extra.push({ text: [{ text: `Counter-evidence ${cite([e.sourceId])}: `, bold: true }, e.note], style: "evidenceMeta" });
  }

  return {
    unbreakable: true,
    margin: [0, 0, 0, 12],
    stack: [
      {
        columns: [
          { width: 24, text: `[${claim.sourceId}]`, id: destination(claim.id), bold: true, color: C.accent },
          { width: "*", text: claim.area, color: C.muted },
          {
            width: "auto",
            text: [
              claim.confidence ? { text: CONFIDENCE_LABEL[claim.confidence], bold: true, color: TONE[claim.confidence].color } : "",
              claim.confidence && claim.verdict ? "  ·  " : "",
              claim.verdict ? { text: VERDICT_LABEL[claim.verdict], color: C.muted } : "",
            ],
          },
        ],
        fontSize: 8.5,
        margin: [0, 0, 0, 3],
      },
      { text: claim.text, bold: true, margin: [0, 0, 0, 4] },
      {
        table: { widths: ["*"], body: [[{ text: `“${claim.quote}”`, italics: true, color: C.muted }]] },
        layout: quoteLayout,
        margin: [0, 0, 0, 4],
      },
      {
        text: [
          { text: "Source: ", color: C.muted },
          source ? { text: source.title || source.domain, link: claim.citationUrl, color: C.fg } : "",
          source ? { text: `  ·  ${source.domain}`, color: C.subtle } : "",
        ],
        style: "evidenceMeta",
      },
      { text: status, style: "evidenceMeta" },
      ...extra,
    ],
  };
}

function statGrid(items: { label: string; value: string; hint?: string }[]): Content {
  const cell = (item?: (typeof items)[number]): TableCell =>
    item
      ? {
          stack: [
            { text: item.label, fontSize: 7.5, color: C.muted },
            { text: item.value, fontSize: 13, bold: true, margin: [0, 1, 0, 0] },
            { text: item.hint ?? " ", fontSize: 7, color: C.subtle },
          ],
        }
      : "";
  const rows: TableCell[][] = [];
  for (let i = 0; i < items.length; i += 4) rows.push([0, 1, 2, 3].map((j) => cell(items[i + j])));
  return {
    table: { widths: ["*", "*", "*", "*"], body: rows },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      fillColor: () => C.surface,
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
    margin: [0, 0, 0, 10],
  };
}

function runStats(run: Run): Content[] {
  const final = run.final;
  if (!final) return [];
  const { stats } = final;
  const { usage } = stats;
  const total = usage.llmCostUsd === undefined ? undefined : usage.llmCostUsd + usage.tavilyCostUsd;
  const roles = (Object.keys(ROLE_LABEL) as (keyof ModelNames)[]).filter((role) => usage.byRole[role].calls > 0);
  const checker = modelLabel(usage.byRole.check.model);

  return [
    ...sectionTitle("Methodology", "How this report was produced. Every number below comes from this run."),
    statGrid([
      { label: "Duration", value: formatDuration(stats.durationMs) },
      { label: "Searches", value: String(stats.searches + stats.newsSearches + stats.counterSearches), hint: `${stats.newsSearches} news · ${stats.counterSearches} counter` },
      { label: "Pages read", value: String(stats.pagesRead) },
      { label: "Sources cited", value: String(final.sources.length), hint: `of ${stats.sources} found` },
      { label: "Claims", value: String(stats.claims) },
      { label: "Quotes verified", value: `${stats.verifiedPct}%`, hint: `${stats.verifiedQuotes}/${stats.claims}` },
      { label: "Tokens", value: formatTokens(usage.promptTokens + usage.completionTokens), hint: `${stats.llmCalls} LLM calls` },
      {
        label: "Total cost",
        value: total === undefined ? "–" : formatUsd(total),
        hint: `incl. Tavily ${formatCredits(usage.tavilyCredits)} credits`,
      },
    ]),
    {
      table: {
        widths: ["auto", "*", "auto"],
        body: roles.map((role): TableCell[] => {
          const r = usage.byRole[role];
          const model = modelLabel(r.model);
          return [
            { text: ROLE_LABEL[role], color: C.muted },
            { text: [{ text: model.name, bold: true }, model.lab ? { text: `  ${model.lab}`, color: C.subtle } : ""] },
            {
              text: `${r.calls} calls · ${formatTokens(r.promptTokens + r.completionTokens)} tokens${r.costUsd === undefined ? "" : ` · ${formatUsd(r.costUsd)}`}`,
              color: C.muted,
              alignment: "right",
            },
          ];
        }),
      },
      layout: { ...tableLayout, fillColor: () => null, hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.6) },
      fontSize: 8.5,
      margin: [0, 0, 0, 8],
    },
    {
      text:
        "The research agent searched the live web and recorded each claim with a verbatim quote, which was then checked against the page text. " +
        `${checker.name}${checker.lab ? ` (${checker.lab})` : ""} challenged every claim with its own counter-searches. ` +
        "Confidence follows from its verdict, whether the quote was found on the page, and whether the source is primary or independently corroborated. " +
        "The writer could only use these claims.",
      fontSize: 8,
      color: C.muted,
    },
  ];
}

export function buildReportPdf(run: Run): TDocumentDefinitions {
  const final = run.final;
  if (!final) throw new Error("The report is not finished yet.");
  const refs: Refs = { claims: Object.fromEntries(final.claims.map((c) => [c.id, c])) };
  const sources = Object.fromEntries(final.sources.map((s) => [s.id, s])) as Record<number, SourcePublic>;
  const tree = unified().use(remarkParse).use(remarkGfm).parse(final.report);
  const date = new Date(run.finishedAt ?? Date.now()).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const { stats } = final;
  const claims = [...final.claims].sort((a, b) => a.sourceId - b.sourceId);

  return {
    pageSize: "A4",
    pageMargins: [PAGE_MARGIN_X, 56, PAGE_MARGIN_X, 56],
    info: { title: run.question, subject: "Due diligence report", author: "Citation Needed", creator: "Citation Needed" },
    defaultStyle: { font: "Roboto", fontSize: 9.5, lineHeight: 1.3, color: C.fg },
    header: (page) =>
      page === 1
        ? null
        : { text: run.question, fontSize: 7.5, color: C.subtle, margin: [PAGE_MARGIN_X, 28, PAGE_MARGIN_X, 0], maxHeight: 12 },
    footer: (page, pages) => ({
      columns: [
        { text: "Citation Needed · AI-generated research, verify before relying on it", width: "*" },
        { text: `${page} / ${pages}`, width: "auto" },
      ],
      fontSize: 7.5,
      color: C.subtle,
      margin: [PAGE_MARGIN_X, 24, PAGE_MARGIN_X, 0],
    }),
    // Keep headings off the bottom of a page, away from the content they introduce.
    pageBreakBefore: (node, { getFollowingNodesOnPage }) =>
      node.headlineLevel === 1 && (node.startPosition.verticalRatio > 0.88 || getFollowingNodesOnPage().length === 0),
    styles: {
      h2: { fontSize: 13, bold: true, margin: [0, 14, 0, 6] },
      h3: { fontSize: 11, bold: true, margin: [0, 10, 0, 4] },
      p: { margin: [0, 0, 0, 6] },
      li: { margin: [0, 0, 0, 2] },
      list: { margin: [0, 0, 0, 6] },
      th: { fontSize: 7.5, bold: true, color: C.muted, characterSpacing: 0.4 },
      td: { fontSize: 9 },
      quote: { italics: true, color: C.muted, margin: [12, 0, 0, 6] },
      section: { fontSize: 16, bold: true, margin: [0, 0, 0, 2] },
      sectionNote: { fontSize: 8.5, color: C.muted, margin: [0, 0, 0, 14] },
      evidenceMeta: { fontSize: 8, color: C.muted, margin: [0, 1, 0, 0] },
    },
    content: [
      {
        text: [{ text: "CITATION " }, { text: "[NEEDED]", color: C.accent }, { text: "  ·  DUE DILIGENCE REPORT", color: C.muted }],
        fontSize: 8,
        bold: true,
        characterSpacing: 0.8,
      },
      { text: run.question, fontSize: 20, bold: true, lineHeight: 1.15, margin: [0, 8, 0, 6] },
      {
        text: `${date}  ·  ${stats.claims} claims from ${final.sources.length} sources  ·  ${stats.verifiedPct}% of quotes verified on the page`,
        fontSize: 8.5,
        color: C.muted,
      },
      {
        text: "Each [n] links to the evidence appendix: the verbatim quote, whether it was found on the page, and the fact-checker's verdict.",
        fontSize: 8,
        italics: true,
        color: C.subtle,
        margin: [0, 2, 0, 0],
      },
      rule(10),
      ...blocks(tree.children, refs),

      ...sectionTitle(
        "Evidence",
        "Every claim behind the report, with the quote the agent extracted from the source. “Open source at quote” opens the page scrolled to it.",
        true,
      ),
      ...claims.map((claim) => evidenceEntry(claim, sources)),

      ...sectionTitle("Sources", "Numbered in order of first citation in the report.", true),
      ...final.sources.map(
        (s): Content => ({
          columns: [
            { text: `[${s.id}]`, width: 26, bold: true, color: C.accent },
            {
              width: "*",
              stack: [
                { text: s.title || s.domain, bold: true },
                { text: s.url, link: s.url, fontSize: 7.5, color: C.muted },
              ],
            },
          ],
          margin: [0, 0, 0, 7],
          unbreakable: true,
        }),
      ),
      { text: "", margin: [0, 10, 0, 0] },
      ...runStats(run),
    ],
  };
}

export async function downloadReportPdf(run: Run): Promise<void> {
  await pdfMake.createPdf(buildReportPdf(run)).download(exportFileName(run.question, "pdf"));
}
