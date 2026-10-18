export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Canonical form used to dedupe sources: no fragment, no trailing slash, no tracking params. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.replace(/^http:\/\//, "https://").replace("://www.", "://");
  } catch {
    return url.trim();
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
