import type { Confidence, Verdict } from "../types.ts";

// Regulators, registers and official statistics. Company-owned sources are flagged
// as primary by the fact-checker instead.
const PRIMARY_SUFFIXES = [
  ".gov", ".mil", ".gov.uk", ".gouv.fr", ".bund.de", ".admin.ch", ".gv.at", ".europa.eu", ".gc.ca",
  ".govt.nz", ".gov.au", ".gob.es", ".gov.it", ".overheid.nl",
];

const PRIMARY_DOMAINS = new Set([
  "sec.gov", "finra.org", "fdic.gov", "federalreserve.gov", "bafin.de", "bundesbank.de", "handelsregister.de",
  "unternehmensregister.de", "bundesanzeiger.de", "fca.org.uk", "register.fca.org.uk", "bankofengland.co.uk",
  "companieshouse.gov.uk", "find-and-update.company-information.service.gov.uk", "ico.org.uk", "amf-france.org",
  "acpr.banque-france.fr", "cnil.fr", "consob.it", "bancaditalia.it", "cnmv.es", "bde.es", "afm.nl", "dnb.nl",
  "centralbank.ie", "finma.ch", "fma.gv.at", "cssf.lu", "fi.se", "finanstilsynet.no", "ecb.europa.eu",
  "bankingsupervision.europa.eu", "esma.europa.eu", "eba.europa.eu", "edpb.europa.eu", "curia.europa.eu",
]);

export function isPrimaryDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (PRIMARY_DOMAINS.has(d)) return true;
  for (const known of PRIMARY_DOMAINS) if (d.endsWith(`.${known}`)) return true;
  return PRIMARY_SUFFIXES.some((s) => d.endsWith(s));
}

/**
 * Deterministic confidence rule (never decided by the model):
 * - high:   quote verified AND supported AND (≥ 2 independent domains OR primary source)
 * - medium: quote verified AND supported, single secondary source
 * - low:    quote not verified OR contested / unverified
 */
export function computeConfidence(input: {
  quoteVerified: boolean;
  verdict?: Verdict;
  independentDomains: number;
  primarySource: boolean;
}): Confidence {
  if (!input.quoteVerified || input.verdict !== "supported") return "low";
  if (input.independentDomains >= 2 || input.primarySource) return "high";
  return "medium";
}
