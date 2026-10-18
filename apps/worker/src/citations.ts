// Claim-marker handling shared by the Worker (final report) and the web app (live stream).
// The writer emits markers like [c:c3] or [c:c3, c:c7]; they become Markdown links
// `[n](#claim-c3)` where n is the source number in order of first appearance.

import type { Claim } from "./types.ts";

const MARKER_RE = /\[c:([^\]\n]{1,80})\]/g;

function markerIds(inner: string): string[] {
  return inner
    .split(/[,;\s]+/)
    .map((s) => s.trim().replace(/^c:/i, ""))
    .filter(Boolean);
}

/** Source IDs in order of first citation in the text. */
export function orderCitedSources(text: string, claims: Map<string, Pick<Claim, "sourceId">>): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(MARKER_RE)) {
    for (const id of markerIds(m[1])) {
      const claim = claims.get(id);
      if (claim && !seen.has(claim.sourceId)) {
        seen.add(claim.sourceId);
        order.push(claim.sourceId);
      }
    }
  }
  return order;
}

/** Replace claim markers with citation links; unknown IDs are dropped. */
export function renderCitations(
  text: string,
  claims: Map<string, Pick<Claim, "sourceId">>,
  numberOf: (sourceId: number) => number | undefined,
): string {
  return text.replace(MARKER_RE, (_, inner: string) =>
    markerIds(inner)
      .map((id) => {
        const claim = claims.get(id);
        const n = claim ? numberOf(claim.sourceId) : undefined;
        return n === undefined ? "" : `[${n}](#claim-${id})`;
      })
      .join(""),
  );
}

/** Hide a marker that is still being streamed, e.g. a trailing "[c:c1". */
export function trimPartialMarker(text: string): string {
  return text.replace(/\[(c(:[^\]\n]*)?)?$/, "");
}

/** Convert rendered citation links back to plain [n] for Markdown export. */
export function plainCitations(markdown: string): string {
  return markdown.replace(/\[(\d+)\]\(#claim-[^)]+\)/g, "[$1]");
}
