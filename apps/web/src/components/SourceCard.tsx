import type { SourcePublic } from "@worker/types.ts";
import { favicon } from "../lib/format.ts";

export function SourceCard({ source }: { source: SourcePublic }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="group flex items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2.5 transition hover:border-line-strong"
    >
      <span className="w-6 shrink-0 text-center font-mono text-xs font-semibold text-muted">{source.id}</span>
      <img src={favicon(source.domain)} alt="" className="size-5 shrink-0 rounded" loading="lazy" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg group-hover:text-accent">{source.title}</span>
        <span className="block truncate text-xs text-muted">{source.domain}</span>
      </span>
    </a>
  );
}
