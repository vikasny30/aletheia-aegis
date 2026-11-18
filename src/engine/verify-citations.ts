/**
 * Aletheia Aegis: Citation verification (D2).
 *
 * A SEPARATE, opt-in tool — not part of check_output. The guard stays offline
 * and synchronous; that promise is the product. This tool makes network
 * requests to public resolvers (doi.org, arxiv.org, NCBI E-utilities) and is
 * only ever called when the operator explicitly invokes aegis_verify_citations.
 *
 * What it can and cannot do:
 *  - DOI: resolved against doi.org. 200 = the DOI exists; 404 = it does not.
 *  - arXiv id: resolved against arxiv.org/abs. Same reading.
 *  - PMID: resolved against NCBI E-utilities esummary. A returned record =
 *    the PMID exists; an empty result = it does not.
 *  - Case citations and "et al." references: UNSUPPORTED — there is no public
 *    resolver to check them against, so the tool says so instead of guessing.
 *
 * An existing DOI is not a true claim — verification answers "does this
 * identifier resolve?", never "is the surrounding claim correct?". A network
 * failure or timeout yields "unverifiable", never a false negative.
 *
 * The fetch implementation is injectable so tests can stub it; production
 * uses the global fetch with a 5-second default timeout.
 */

export type CitationType = "doi" | "arxiv" | "pmid" | "case" | "et-al";
export type CitationStatus = "verified" | "not_found" | "unverifiable" | "unsupported";

export interface CitationResult {
  type: CitationType;
  value: string;
  status: CitationStatus;
  detail: string;
}

export interface VerifyResult {
  citations: CitationResult[];
  summary: { total: number; verified: number; notFound: number; unverifiable: number; unsupported: number; /** identifiers past the per-call cap, not checked */ skipped?: number };
}

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/g;
const ARXIV_RE = /arxiv:\s?(\d{4}\.\d{4,5})(v\d+)?/gi;
const PMID_RE = /PMID:?\s?(\d{7,8})/gi;
const CASE_CITE_RE = /\b[A-Z][A-Za-z]+ v\. [A-Z][A-Za-z]+,?\s+\d{1,4}\s+(U\.S\.|F\.\d*d|S\. Ct\.)/g;
const ET_AL_RE = /\bet al\.\s*\(\d{4}\)/g;

function cleanDoi(raw: string): string {
  return raw.replace(/[).,;:]+$/, "");
}

export function extractCitations(text: string): Array<{ type: CitationType; value: string }> {
  const out: Array<{ type: CitationType; value: string }> = [];
  for (const re of [DOI_RE, ARXIV_RE, PMID_RE, CASE_CITE_RE, ET_AL_RE]) re.lastIndex = 0;
  for (const m of text.matchAll(DOI_RE)) out.push({ type: "doi", value: cleanDoi(m[0]) });
  for (const m of text.matchAll(ARXIV_RE)) out.push({ type: "arxiv", value: m[1] });
  for (const m of text.matchAll(PMID_RE)) out.push({ type: "pmid", value: m[1] });
  for (const m of text.matchAll(CASE_CITE_RE)) out.push({ type: "case", value: m[0] });
  for (const m of text.matchAll(ET_AL_RE)) out.push({ type: "et-al", value: m[0] });
  return out;
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<{ status: number; text: () => Promise<string> }>;

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; text: () => Promise<string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow redirects: doi.org redirects to whatever URL a DOI's
    // registrant chose, which could be an address on the operator's network.
    // A redirect from the resolver already means the identifier exists.
    return await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOne(
  citation: { type: CitationType; value: string },
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<CitationResult> {
  const { type, value } = citation;
  try {
    if (type === "doi") {
      const res = await fetchWithTimeout(fetchImpl, `https://doi.org/${encodeURIComponent(value)}`, timeoutMs);
      if (res.status === 200 || (res.status >= 300 && res.status < 400)) return { type, value, status: "verified", detail: "DOI resolves at doi.org." };
      if (res.status === 404) return { type, value, status: "not_found", detail: "DOI does not resolve at doi.org." };
      return { type, value, status: "unverifiable", detail: `doi.org returned HTTP ${res.status}.` };
    }
    if (type === "arxiv") {
      const res = await fetchWithTimeout(fetchImpl, `https://arxiv.org/abs/${value}`, timeoutMs);
      if (res.status === 200 || (res.status >= 300 && res.status < 400)) return { type, value, status: "verified", detail: "arXiv id resolves at arxiv.org." };
      if (res.status === 404) return { type, value, status: "not_found", detail: "arXiv id does not resolve at arxiv.org." };
      return { type, value, status: "unverifiable", detail: `arxiv.org returned HTTP ${res.status}.` };
    }
    if (type === "pmid") {
      const res = await fetchWithTimeout(
        fetchImpl,
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${value}&retmode=json`,
        timeoutMs,
      );
      if (res.status !== 200) {
        return { type, value, status: "unverifiable", detail: `NCBI E-utilities returned HTTP ${res.status}.` };
      }
      const body = JSON.parse(await res.text()) as { result?: { uids?: string[] } };
      if (body.result?.uids?.includes(value)) {
        return { type, value, status: "verified", detail: "PMID has a PubMed record." };
      }
      return { type, value, status: "not_found", detail: "PMID has no PubMed record." };
    }
    return {
      type,
      value,
      status: "unsupported",
      detail: "No public resolver can check this citation type; verify it by hand.",
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "could not be reached";
    return { type, value, status: "unverifiable", detail: `Resolver ${reason}; no conclusion drawn.` };
  }
}

/** Most identifiers checked per call. */
export const MAX_LOOKUPS = 25;

export async function verifyCitations(
  text: string,
  options: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<VerifyResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const timeoutMs = options.timeoutMs ?? 5000;
  // Each identifier is one outbound request, made one after another: dedupe
  // and cap them, so a pasted bibliography (or a hostile text) can't turn one
  // call into thousands of requests or a call that runs for hours.
  const seen = new Set<string>();
  const all = extractCitations(text).filter((c) => !seen.has(`${c.type}:${c.value.toLowerCase()}`) && seen.add(`${c.type}:${c.value.toLowerCase()}`));
  const citations = all.slice(0, MAX_LOOKUPS);
  const results: CitationResult[] = [];
  for (const citation of citations) {
    results.push(await verifyOne(citation, fetchImpl, timeoutMs));
  }
  return {
    citations: results,
    summary: {
      total: results.length,
      verified: results.filter((r) => r.status === "verified").length,
      notFound: results.filter((r) => r.status === "not_found").length,
      unverifiable: results.filter((r) => r.status === "unverifiable").length,
      unsupported: results.filter((r) => r.status === "unsupported").length,
      ...(all.length > citations.length ? { skipped: all.length - citations.length } : {}),
    },
  };
}
