/**
 * Aletheia Aegis: text normalization before detection.
 *
 * Every detector is written against plain ASCII punctuation: `i'?m`, `don'?t`,
 * `et al\.`, `peer-reviewed`. Real model output often isn't plain ASCII.
 * gpt-oss, for example, writes "I’m" (U+2019), "et al." with a narrow no-break
 * space (U+202F) and "peer‑reviewed" with a non-breaking hyphen (U+2011). Without
 * normalization, deferrals like "I’m not a lawyer" go unrecognized (a false
 * positive) and citation markers like "et al." are missed (a miss). The same
 * gap lets anyone evade a pattern with look-alike characters or zero-width
 * joiners.
 *
 * Normalization runs once per evaluation, on the response and the prompt,
 * before any detector sees them. It is length-agnostic: evidence snippets come
 * from the normalized text.
 */

const ZERO_WIDTH_RE = /[​-‍⁠﻿­]/g;
const SPACE_RE = /[   -   　]/g;
const HYPHEN_RE = /[‐‑‒–—―−﹘﹣－]/g;
const SINGLE_QUOTE_RE = /[‘’‚‛′ʼ＇]/g;
const DOUBLE_QUOTE_RE = /[“”„‟″＂]/g;

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC") // full-width letters/digits → ASCII, ligatures split
    .replace(ZERO_WIDTH_RE, "")
    .replace(SPACE_RE, " ")
    .replace(HYPHEN_RE, "-")
    .replace(SINGLE_QUOTE_RE, "'")
    .replace(DOUBLE_QUOTE_RE, '"');
}
