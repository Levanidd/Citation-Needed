import type { ClaimPublic, SourcePublic } from "@worker/types.ts";
import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { favicon } from "../lib/format.ts";
import { ConfidenceBadge } from "./ConfidenceBadge.tsx";

const VERDICT_LABEL = { supported: "✅ Supported", contested: "⚠️ Contested", unverified: "❌ Unverified" } as const;
const CARD_WIDTH = 360;

interface Props {
  claim?: ClaimPublic;
  source?: SourcePublic;
  label: ReactNode;
}

/** Superscript [n] that opens the source scrolled to the quote; hover shows the verbatim quote. */
export function ClaimCitation({ claim, source, label }: Props) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  if (!claim) return <sup className="text-subtle">[{label}]</sup>;

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - CARD_WIDTH / 2), window.innerWidth - CARD_WIDTH - 8);
    const above = r.bottom > window.innerHeight * 0.6;
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
  };
  const hide = () => setPos(null);
  const domain = source?.domain ?? new URL(claim.citationUrl).hostname.replace(/^www\./, "");

  return (
    <>
      <sup className="ml-0.5 whitespace-nowrap">
        <a
          ref={ref}
          href={claim.citationUrl}
          target="_blank"
          rel="noreferrer"
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          className="font-semibold text-accent no-underline hover:underline"
          aria-label={`Source ${String(label)}: ${source?.title ?? domain}`}
        >
          [{label}]
        </a>
        {claim.confidence && <ConfidenceBadge level={claim.confidence} compact />}
      </sup>
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 rounded-2xl border border-line-strong bg-surface p-4 text-sm shadow-2xl animate-step-in"
            style={{
              left: pos.left,
              top: pos.top,
              width: CARD_WIDTH,
              transform: pos.above ? "translateY(-100%)" : undefined,
            }}
          >
            <div className="flex items-center gap-2">
              <img src={favicon(domain)} alt="" className="size-4 rounded" />
              <span className="truncate font-semibold text-fg">{source?.title ?? domain}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted">{domain}</div>
            <blockquote className="mt-3 border-l-2 border-accent pl-3 text-[13px] leading-relaxed text-fg italic">
              “{claim.quote}”
            </blockquote>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className={claim.quoteVerified ? "font-medium text-pos" : "font-medium text-neg"}>
                {claim.quoteVerified ? "✓ Quote verified on page" : "✗ Quote not verified"}
              </span>
              {claim.verdict && <span className="text-muted">{VERDICT_LABEL[claim.verdict]}</span>}
              {claim.confidence && <ConfidenceBadge level={claim.confidence} />}
            </div>
            {claim.note && <p className="mt-2 text-xs text-muted">Fact-check: {claim.note}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
