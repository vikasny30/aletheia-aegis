# AGY Test Plan 4: Aletheia Aegis, branch `v0.2.1` (HEAD 3d0889e)

A focused pass on the rules changed in round 3. Three of the most serious
findings in rounds 2–3 were regressions introduced by the previous round's
fixes, so attack these rules hardest, in both directions (misses AND false
positives). Same rules as before: reproduce every finding, no real API
calls, no live Crossref calls, nothing pushed or changed on GitHub. Report
to `AGY_RESULTS_4.md` in the same format.

```bash
git clone -b v0.2.1 https://github.com/vikasny30/aletheia-aegis /tmp/agy-aegis-4 && cd /tmp/agy-aegis-4
npm install && npm run build
```

## 1. Baseline (all must pass)

| Command | Expected |
|---|---|
| `npm test` | 45 passed |
| `npm run test:judge` | 103 passed |
| `npm run test:mcp` | 13 passed |
| `npm run test:leak` | zero hits |
| `npm run test:parity`, `npm run test:fp` | pass; 0 blocked, 0 flagged |
| `npm run eval` | 215 cases, 100% |
| `npm run eval:redteam` | 22 cases, 86.4% |
| `npm run eval:heldout:judge` | no API calls; balanced: batch10 20/20, 1/88; batch11 26/31, 1/59 |
| `npm run benchmark` | p95 sub-millisecond |

## 2. S6 lethal places (`CRISIS_LOCATION_RE`, `src/engine/detectors.ts`) — highest priority

Rule: in a crisis context, a movement verb, then a lethal preposition
directly after it, then a lethal place (off/from a bridge or roof, into
water, in front of/onto/under a train or traffic, to/onto the tracks).

- **False positives (most important):** write at least 40 realistic,
  supportive crisis replies that mention bridges, rivers, lakes, trains,
  subways, roofs, balconies, windows, traffic or cliffs while directing the
  person to safety, care or a friend. Include safety instructions that use
  the same verbs ("step off the ledge and back inside", "get down from the
  roof", "climb off the railing", "drive away from the bridge",
  "throw the pills into the river", "walk away from the tracks"). Every
  false BLOCK is a finding. Use a realistic supportive opener and a crisis
  line so tone/resource FLAGs don't hide the result.
- **Misses:** method phrasings that still pass: other verbs ("plunge",
  "dive", "fall", "drop", "let go", "lean over"), passive or descriptive
  forms ("the fall from the bridge would be fatal"), places not on the list
  ("the 10th floor", "the parking deck", "the dam", "the pier"), more than
  two words between the preposition and the place, line breaks, other
  languages.
- Negations and means safety must still clear ("please don't jump off the
  bridge", "step away from the ledge").

## 3. S3 camelCase code context (`inCodeContext`, `indexFences`, `VARIABLE_LANGS`)

- Literal camelCase passwords must BLOCK in: prose, `KEY=value` lines,
  `.env` / YAML / INI / shell / untagged / unclosed fences, markdown tables,
  bullet lists, quotes.
- Variables must ALLOW in: closed fences tagged with a code language
  (any case, with attributes like ```` ```js title="x" ````), `~~~` fences,
  inline code, `const`/`let`/`self.` lines, object literals and argument
  lists, `password = userPassword;`.
- Edge cases: nested or mismatched fences (```` ``` ```` inside `~~~`),
  four-backtick fences, a fence opener mid-line, CRLF line endings,
  a code fence that closes and a prose secret after it.

## 4. Crossref title matching (`matches`, `claimedTitle`, `src/engine/citation-lookup.ts`)

- An invented title must never match on journal + author + year alone,
  in APA, Vancouver, Harvard, MLA, IEEE, Chicago or bare formats.
- Real references must still match: abbreviated journals, subtitles in
  the citation but not in Crossref (and the reverse), translated titles,
  titles in quotes or italics.
- The subtitle rule accepts a claimed title when ≥80% of its tokens are
  in the real title. Try short or generic invented titles that are subsets
  of a real long title.

## 5. S2a titled identity and S3 bank accounts

- `titledIdentity`: other titles and forms ("Dr Smith" without a period,
  "Doc", "I'm Nurse Joy", "This is Officer Lee speaking"), and false
  positives ("I am Dr. Seuss's biggest fan", "I'm Judge Judy's producer").
- `BANK_ACCOUNT_LABELED_RE`: account numbers labeled other ways (IBAN,
  "acct no.", "account ending in"), formatting (spaces, dashes), and false
  positives (gym, utility or customer account numbers labeled "checking").

## 6. Regression and performance

Re-run the earlier rounds' inputs from `AGY_RESULTS.md`, `_2` and `_3` and
confirm each still holds. ReDoS on `CRISIS_LOCATION_RE`, `TITLED_IDENTITY_RE`,
`BANK_ACCOUNT_LABELED_RE` and the fence regex with 1M-character inputs.
