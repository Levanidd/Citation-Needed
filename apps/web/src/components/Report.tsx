import { orderCitedSources, renderCitations, trimPartialMarker } from "@worker/citations.ts";
import type { ClaimPublic, Confidence, SourcePublic } from "@worker/types.ts";
import { Children, type ReactNode, isValidElement, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Run } from "../lib/useResearch.ts";
import { ClaimCitation } from "./ClaimCitation.tsx";
import { ConfidenceBadge, RiskPill } from "./ConfidenceBadge.tsx";

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textOf(child.props.children);
      return "";
    })
    .join("");
}

/** Report markdown with citations rendered; while streaming, markers are numbered client-side. */
export function useReportView(run: Run) {
  return useMemo(() => {
    if (run.final) {
      return {
        markdown: run.final.report,
        claims: Object.fromEntries(run.final.claims.map((c) => [c.id, c])) as Record<string, ClaimPublic>,
        sources: Object.fromEntries(run.final.sources.map((s) => [s.id, s])) as Record<number, SourcePublic>,
      };
    }
    const claimMap = new Map(Object.entries(run.claims));
    const numbers = new Map(orderCitedSources(run.reportRaw, claimMap).map((id, i) => [id, i + 1]));
    return {
      markdown: renderCitations(trimPartialMarker(run.reportRaw), claimMap, (id) => numbers.get(id)),
      claims: run.claims,
      sources: run.sources,
    };
  }, [run.final, run.reportRaw, run.claims, run.sources]);
}

export function Report({ run }: { run: Run }) {
  const { markdown, claims, sources } = useReportView(run);

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        if (href?.startsWith("#claim-")) {
          const claim = claims[href.slice(7)];
          return <ClaimCitation claim={claim} source={claim ? sources[claim.sourceId] : undefined} label={children} />;
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      td: ({ children, node: _node, ...props }) => {
        const text = textOf(children).trim().toLowerCase();
        if (text === "high" || text === "medium" || text === "low") {
          return (
            <td {...props}>
              <ConfidenceBadge level={text as Confidence} />
            </td>
          );
        }
        return <td {...props}>{children}</td>;
      },
      strong: ({ children }) => {
        const match = /^overall risk:\s*(low|medium|high)\b/i.exec(textOf(children).trim());
        if (match) return <RiskPill level={match[1].toLowerCase() as "low" | "medium" | "high"}>{children}</RiskPill>;
        return <strong>{children}</strong>;
      },
      table: ({ children }) => (
        <div className="not-prose my-5 overflow-x-auto rounded-2xl border border-line">
          <table className="w-full border-collapse text-sm [&_td]:border-t [&_td]:border-line [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top [&_th]:bg-surface-2/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase">
            {children}
          </table>
        </div>
      ),
    }),
    [claims, sources],
  );

  return (
    <article className="prose prose-report max-w-none prose-headings:tracking-tight prose-h2:mt-8 prose-h2:mb-3 prose-h2:text-xl prose-p:leading-relaxed prose-li:my-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
