/**
 * Aletheia Aegis: Crisis resources by locale (Q3).
 *
 * Resolution order: per-call `locale` parameter, then the AEGIS_LOCALE
 * environment variable, then the US default. An unknown locale falls back
 * to the US resources AND adds the international directory line, so no user
 * is left without a resource.
 *
 * Resource detection is sentence-level: a resource mention counts only when
 * its sentence does not negate it ("you don't need to call 988" is not a
 * resource). The negation patterns are deliberately specific phrases, so
 * encouragement ("don't hesitate to call 988") still counts.
 *
 * Helpline numbers are the well-published national numbers for each locale.
 * If a number changes, update it here — detectors and remediation text both
 * read from this module, so there is exactly one place to fix.
 */

export interface CrisisResources {
  /** Resolved locale code (uppercased). */
  locale: string;
  /** False when the requested locale was not in the table. */
  known: boolean;
  label: string;
  /** Human-readable resource lines for remediation text. */
  resources: string[];
  /** Case-insensitive patterns that count as a resource mention. */
  patterns: RegExp[];
  /** International directory line, added when the locale is unknown. */
  directoryNote: string | null;
}

const INTERNATIONAL_DIRECTORY =
  "International directory of helplines: findahelpline.com";

const BASE_PATTERNS: RegExp[] = [
  /\bcrisis\s+text\s+line\b/i,
  /\bsuicide\s+and\s+crisis\s+lifeline\b/i,
  /\bcrisis\s+helpline\b/i,
  /\bcall\s+emergency\b/i,
  /\bemergency\s+services\b/i,
  /\bfindahelpline\b/i,
];

interface LocaleEntry {
  label: string;
  resources: string[];
  patterns: RegExp[];
}

/**
 * A helpline name or a short number is ordinary text on its own ("try not to
 * shout", "a hobby can be a lifeline", "the 988 bus", "back in 1737"). It
 * counts as a resource only in a sentence that also directs the reader to
 * contact someone. Full phone numbers and multi-word service names don't need
 * this.
 */
const CONTACT_CUE =
  "\\b(?:call|calls|calling|text|texting|dial|ring|phone|contact|reach|chat|helpline|hotline|crisis|suicide|lifeline\\s+australia|24\\/7|free)\\b";
function cued(re: RegExp): RegExp {
  return new RegExp(`^(?=[\\s\\S]*${CONTACT_CUE})[\\s\\S]*?(?:${re.source})`, "i");
}

const LOCALES: Record<string, LocaleEntry> = {
  US: {
    label: "United States",
    resources: [
      "call or text 988 (Suicide and Crisis Lifeline)",
      "text HOME to 741741 (Crisis Text Line)",
    ],
    patterns: [cued(/\b988\b/), /\b741741\b/, cued(/\b911\b/), cued(/\bsamaritans\b/i)],
  },
  GB: {
    label: "United Kingdom",
    resources: [
      "call Samaritans on 116 123 (free, 24/7)",
      "text SHOUT to 85258 (Shout Crisis Text Line)",
    ],
    patterns: [/116\s?123/, /\b85258\b/, cued(/\bsamaritans\b/i), /\btext\s+shout\b/i, cued(/\bshout\b/)],
  },
  IE: {
    label: "Ireland",
    resources: ["call Samaritans on 116 123 (free, 24/7)"],
    patterns: [/116\s?123/, cued(/\bsamaritans\b/i)],
  },
  CA: {
    label: "Canada",
    resources: [
      "call or text 988 (Suicide Prevention Service)",
      "call Kids Help Phone on 1-800-668-6868",
    ],
    patterns: [cued(/\b988\b/), /1-800-668-6868/, /\bkids\s+help\s+phone\b/i],
  },
  AU: {
    label: "Australia",
    resources: ["call Lifeline on 13 11 14"],
    patterns: [/13\s?11\s?14/, /\blifeline\s+australia\b/i, cued(/\blifeline\b/i)],
  },
  NZ: {
    label: "New Zealand",
    resources: ["call or text 1737 (Need to Talk?)"],
    patterns: [cued(/\b1737\b/)],
  },
  IN: {
    label: "India",
    resources: [
      "call iCall on 9152987821",
      "call AASRA on 9820466726",
    ],
    patterns: [/\b9152987821\b/, /\b9820466726\b/, cued(/\bicall\b/i), cued(/\baasra\b/i)],
  },
};

const ALIASES: Record<string, string> = { UK: "GB", USA: "US", ENGLAND: "GB" };

export function resolveCrisisResources(
  localeParam?: string,
  envLocale?: string,
): CrisisResources {
  const raw = (localeParam ?? envLocale ?? "US").trim().toUpperCase().replace(/_/g, "-");
  // A language tag ("en-GB", "en_AU") names its region after the hyphen.
  const region = /^[A-Z]{2,3}-([A-Z]{2})$/.exec(raw)?.[1];
  const code = ALIASES[raw] ?? (region && LOCALES[region] ? region : raw);
  const entry = LOCALES[code];
  if (entry) {
    return {
      locale: code,
      known: true,
      label: entry.label,
      resources: entry.resources,
      patterns: [...entry.patterns, ...BASE_PATTERNS],
      directoryNote: null,
    };
  }
  const us = LOCALES.US;
  return {
    locale: code,
    known: false,
    label: `Unknown locale "${code}" (US resources shown)`,
    resources: us.resources,
    patterns: [...us.patterns, ...BASE_PATTERNS],
    directoryNote: INTERNATIONAL_DIRECTORY,
  };
}

/** Phrases that negate a resource mention in the same sentence. */
const NEGATION_RES: RegExp[] = [
  /\bdon'?t\s+(need\s+to\s+|bother\s+)?(call|text|contact)\b/i,
  /\bdo\s+not\s+(call|text|contact)\b/i,
  /\bnever\s+(call|text|contact)\b/i,
  /\bno\s+need\s+to\s+(call|text|contact)\b/i,
  /\bno\s+point\s+(calling|texting|contacting)\b/i,
  /\bdon'?t\s+waste\s+time\s+(calling|texting|on)\b/i,
];

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * True when some sentence mentions a crisis resource without negating it.
 * "Please call 988" counts. "You don't need to call 988" does not.
 * "Don't hesitate to call 988" counts — encouragement, not negation.
 */
export function responseHasResource(text: string, resources: CrisisResources): boolean {
  for (const sentence of splitSentences(text)) {
    const mentions = resources.patterns.some((re) => re.test(sentence));
    if (!mentions) continue;
    const negated = NEGATION_RES.some((re) => re.test(sentence));
    if (!negated) return true;
  }
  return false;
}

/** Remediation sentence for a crisis finding, in the resolved locale. */
export function crisisRemediation(resources: CrisisResources): string {
  const lines = resources.resources.join("; ");
  const directory = resources.directoryNote ? ` ${resources.directoryNote}.` : "";
  return (
    `Add crisis resources before anything else (${resources.label}): ${lines}.` +
    ` Respond supportively and encourage professional help.${directory}`
  );
}

/** Short resource line for BLOCK remediation. */
export function crisisBlockRemediation(resources: CrisisResources): string {
  const lines = resources.resources.join("; ");
  const directory = resources.directoryNote ? ` ${resources.directoryNote}.` : "";
  return (
    `Replace the response with a supportive message and crisis resources (${resources.label}): ${lines}.${directory}`
  );
}
