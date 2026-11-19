/**
 * Aletheia Aegis: reference lookup for S1 (opt-in).
 *
 * Neither pattern matching nor a model judge can reliably tell a real paper
 * from a plausible invented one. This module extracts reference-like lines
 * from a reply and looks each up in Crossref, the public registry of scholarly
 * works. It is used only when AEGIS_VERIFY_CITATIONS=crossref and only on
 * replies already flagged under S1, so reference text leaves the machine only
 * when the operator has asked for it.
 *
 * Reading the result: "found" means Crossref has a work whose first author and
 * year match the reference and whose title overlaps it. "not_found" means no
 * such record, which is strong evidence of fabrication but not proof (some
 * real work isn't in Crossref). A network failure yields "unverifiable", never
 * "not_found".
 */

import { redactSecrets } from "./detectors.js";

export type LookupStatus = "found" | "not_found" | "unverifiable";
export interface ReferenceLookup {
  reference: string;
  status: LookupStatus;
  match?: { title: string; firstAuthor: string; year?: number; doi?: string };
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const YEAR_RE = /\b(19[5-9]\d|20[0-3]\d)\b/;
const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "their", "study", "effects", "effect", "randomized", "controlled", "trial", "review", "journal", "systematic", "analysis"]);

/** How much of a reply the reference extractor reads. Text past this point is
 *  never looked up, so the Crossref check can't clear a longer reply. */
export const REFERENCE_SCAN_CHARS = 20_000;

/** Reference-like chunks: numbered or bulleted entries (or paragraphs) that
 *  name an author-like surname and a year. At most `max` are returned. */
export function extractReferences(text: string, max = 6): string[] {
  // Bound the work: some patterns below are quadratic on long runs of letters
  // or blank lines, so cap the input, collapse whitespace runs, and skip
  // chunks far longer than any reference before testing them.
  text = text.slice(0, REFERENCE_SCAN_CHARS).replace(/[ \t]{8,}/g, " ").replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n\n");
  // Split on numbered entries ("1." "2)" "**1.**" "### 2.") or blank lines, but
  // not on bullets: bullets under an entry usually carry its title and journal.
  const chunks = text
    .split(/\n\s*(?=(?:[*#>\s]*\(?\d{1,2}[.)]\s|#{1,4}\s|\|))|\n{2,}(?=\s*(?:[*#]*\s*)?(?:\d{1,2}[.)]|[A-Z]))/)
    .map((c) => c.replace(/[*_`#>|]/g, " ").replace(/\s+/g, " ").trim())
    .filter((c) => c.length > 25 && c.length < 3000 && YEAR_RE.test(c));
  const refs = chunks
    .filter((c) => !/^[\s|:-]+$/.test(c))
    .filter((c) => /\bet al\b|[A-Z][a-zA-Z'\-]+,\s*(?:[A-Z]\.|[A-Z][a-z]+)|[A-Z][a-zA-Z'\-]+ [A-Z](?:\.?[A-Z])*\.?[,;]|\b[A-Z]\.(?: ?[A-Z]\.)* [A-Z][a-zA-Z'\-]+|Authors?\s*:/.test(c));
  return refs.slice(0, max).map((c) => c.slice(0, 700));
}

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").match(/[a-z0-9]{4,}/g) ?? []).filter((t) => !STOP.has(t)));
}

/** Does a Crossref record plausibly correspond to the reference text? */
export function matches(reference: string, item: any): boolean {
  const ref = reference.toLowerCase().normalize("NFKD");
  const family = String(item?.author?.[0]?.family ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z\-' ]/g, "");
  if (!family || !ref.includes(family)) return false;
  const year = item?.issued?.["date-parts"]?.[0]?.[0] ?? item?.published?.["date-parts"]?.[0]?.[0];
  const refYear = Number(reference.match(YEAR_RE)?.[0]);
  if (year && refYear && Math.abs(year - refYear) > 1) return false;
  const refTokens = tokens(reference);
  const overlap = (s: string) => {
    const t = tokens(s);
    if (t.size === 0) return 0;
    let hit = 0;
    for (const x of t) if (refTokens.has(x)) hit++;
    return hit / t.size;
  };
  // Title overlap, or (when the reply gives no title) the journal name: first
  // author + year + journal is still a specific, checkable claim.
  return overlap(String(item?.title?.[0] ?? "")) >= 0.5 || (Boolean(year && refYear) && overlap(String(item?.["container-title"]?.[0] ?? "")) >= 0.75);
}

/** The searchable part of an entry: drop a heading before "Authors:", field
 *  labels, and summaries, which only add noise to the search. */
export function queryText(reference: string): string {
  return reference
    .replace(/^.*?(?=Authors?\s*:)/i, "")
    .replace(/\b(Summary|Key Finding|Findings?|Relevance|Note|Brief Context|What it found)\s*:.*$/i, "")
    .replace(/\b(Authors?|Journal|Year|Title|Publication Year|Study Title|Study)\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

/** Total time for all lookups in one check: references left when it runs out are "unverifiable". */
export const LOOKUP_BUDGET_MS = 20_000;

export async function lookupReferences(text: string, options: { fetchImpl?: FetchLike; timeoutMs?: number; budgetMs?: number } = {}): Promise<ReferenceLookup[]> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const refs = extractReferences(text);
  const deadline = Date.now() + (options.budgetMs ?? LOOKUP_BUDGET_MS);
  // Sequential with a short pause: Crossref rate-limits bursts from one client.
  const out: ReferenceLookup[] = [];
  for (const reference of refs) {
    const left = deadline - Date.now();
    if (left < 1000) { out.push({ reference, status: "unverifiable" }); continue; }
    out.push(await one(reference, Math.min(options.timeoutMs ?? 12000, left)));
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
  async function one(reference: string, timeoutMs: number): Promise<ReferenceLookup> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Query with the head of the entry (names, year, title); match against all of it.
      const url = "https://api.crossref.org/works?" + new URLSearchParams({ "query.bibliographic": redactSecrets(queryText(reference)), rows: "5", select: "title,author,issued,published,DOI,container-title" });
      let res = await fetchImpl(url, { headers: { "user-agent": "aletheia-aegis (citation check)" }, signal: ctrl.signal });
      // Crossref answers bursts with 429: back off and retry twice.
      for (let attempt = 1; res.status === 429 && attempt <= 2; attempt++) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        res = await fetchImpl(url, { headers: { "user-agent": "aletheia-aegis (citation check)" }, signal: ctrl.signal });
      }
      if (!res.ok) return { reference: reference.slice(0, 300), status: "unverifiable" };
      const items: any[] = (await res.json())?.message?.items ?? [];
      const m = items.find((it) => matches(reference, it));
      if (!m) return { reference, status: "not_found" };
      return { reference, status: "found", match: { title: String(m.title?.[0] ?? ""), firstAuthor: String(m.author?.[0]?.family ?? ""), year: m.issued?.["date-parts"]?.[0]?.[0], doi: m.DOI } };
    } catch {
      return { reference, status: "unverifiable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
