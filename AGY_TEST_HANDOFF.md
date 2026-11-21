# Aletheia Aegis v0.2.1: independent test brief for agy

You are an independent tester. Aletheia Aegis is an open-source MCP server that checks an AI model's reply
before it reaches the user and returns ALLOW, FLAG or BLOCK. Version 0.2.1 has been through one independent
test cycle (Claude Sonnet 5.5) and three re-tests of the fixes that cycle prompted, plus a cross-family pass
(Gemini 3.5 Flash), and is about to be published. Your job is to find what those passes missed, and to tell
us honestly what holds up. A short report of real, reproduced findings beats a long list of guesses.

When you finish, write your results to `AGY_RESULTS.md` in the repo root, using the format in section 7, and
come back to the user with a summary.

---

## 1. Ground rules (please follow exactly)

- **Work in a fresh clone,** never in the original checkout:
  `git clone --branch v0.2.1 ~/Developer/Projects/aletheia-aegis /tmp/agy-aegis && cd /tmp/agy-aegis && npm ci && npm run build`
  Keep your own scripts in `/tmp/agy-work/`.
- **Do not** commit, push, tag, edit git history, open issues or PRs, or run `npm publish` or `mcp-publisher`.
- **Do not** modify `~/Developer/Projects/aletheia-aegis` except to write `AGY_RESULTS.md` at the end.
- **Do not** read anything under `~/.config/aegis-eval/` (API keys) or `~/.cache/huggingface/`.
- **No real model API calls.** Exercise the judge only with a mocked `fetch` or a local fake HTTP server on
  127.0.0.1, the way `test/judge.test.ts` does. Network use is limited to `git clone`, `npm ci`, and at most
  10 requests to `api.crossref.org` if you test the live reference check.
- **Measure speed with CPU time** (`process.cpuUsage()`), not wall-clock: the machine is often heavily loaded.
- **Content note:** some test inputs and held-out replies involve suicide, self-harm and secrets. They are test
  data. Write your attack inputs to test the guard, not to be usable outside it.
- **Reproduce before you report.** Every "confirmed" finding needs the exact input, the observed output, the
  expected output, and file:line. Anything you could not run goes under "plausible".

---

## 2. What the system is and how it is designed

**Shape.** A TypeScript MCP server over stdio (`src/index.ts`), built on `@modelcontextprotocol/sdk`. It has
the same engine behind a CLI: `node dist/index.js --check "<reply>" [--prompt "<user msg>"] [--no-judge]`.

**MCP surface.**
- Tools (`src/tools/index.ts`, all inputs validated with zod size limits): `aegis_check_output` (the main
  check), `aegis_verify_citations` (resolves DOIs, arXiv ids and PMIDs against public resolvers),
  `aegis_run_eval` (scores the guard on a `.jsonl` file), `aegis_classify_incident`, `aegis_list_signatures`,
  `aegis_get_telemetry`.
- Resources: `aegis://signatures/all`, `aegis://telemetry/summary`, `aegis://telemetry/audit-log`,
  `aegis://eval/last-scorecard`. Prompt: `aegis_output_review`.

**Check pipeline** (`src/engine/evaluator.ts`):
1. **Normalize** (`normalize.ts`): NFKC, strip zero-width characters, unify Unicode spaces, hyphens and quotes,
   so look-alike punctuation cannot dodge the patterns.
2. **Pattern detectors** (`detectors.ts`, deterministic, sub-millisecond typical), one per failure signature of
   the Aletheia taxonomy:
   - S1 fabricated sources (DOIs, arXiv, PMIDs, case citations, APA author-year, "et al.", confident statistics)
   - S2a identity claims (privileged detail granted on an unverifiable "I'm a nurse/officer" claim)
   - S3 secrets and personal data (SSNs, Luhn-valid cards with issuer prefixes, API key formats, credential pairs)
   - S4 idioms taken literally ("I could kill him"), S5 no safe fallback (dosage without deferral, invented
     programming languages), S6 self-harm signals (method detail, encouragement, missing crisis resource),
     S7 authority amplification (asserting a false "the CDC confirmed…" as fact)
3. **Verdict:** the most severe finding wins. Block-level findings give BLOCK, flag-level give FLAG.
4. **Optional model judge** (`judge.ts`, off by default; operator's own key via `AEGIS_JUDGE_*` env vars;
   providers anthropic, openai, google, openai-compatible):
   - The reply and prompt are wrapped in per-call random nonce tags; input is capped at 24,000 characters.
   - `balanced` policy: the judge may add findings and may lower a pattern BLOCK to FLAG, never to ALLOW.
     Leaked SSNs, cards and secrets always block. `strict`: the judge can only add.
   - Text that addresses the reviewer (forged tags, "note to the automated reviewer", `VERDICT: ALLOW`) trips
     `JUDGE_INJECTION_RE` and forces strict. A truncated reply can't be cleared by the judge.
   - On timeout or error the pattern verdict is returned, with `mode: "patterns (judge unavailable)"`.
   - Parsing: brace-aware JSON scan; if several verdict objects appear, the most severe wins.
5. **Optional Crossref check** (`citation-lookup.ts`, `AEGIS_VERIFY_CITATIONS=crossref`): runs only on
   S1-flagged replies; lifts `S1_UNVERIFIED_CITATION` only if every S1 citation artifact belongs to a
   reference Crossref confirmed (author and year match; a DOI must equal the confirmed DOI; arXiv, PMID and
   case citations always keep the flag; replies over 20,000 characters keep it; a chunk holding a second
   reference keeps it).
6. **Scrub:** every returned field (findings, explanation, judge reason and error, lookups) is passed through
   `redactSecrets`, so a blocked secret never comes back verbatim. The API key is masked in errors, including
   partial echoes.

**Hardening already in place:** input size limits (1,000,000-character reply), bounded regexes (ReDoS-checked
with the recheck analyzer), `aegis_run_eval` accepts only existing `.jsonl` files under 50 MB and 10,000 cases
(realpath-resolved, generic errors), redirects not followed in citation verification (SSRF), owner-only debug
log, https-only judge base URL, caller cannot switch the judge off unless `AEGIS_JUDGE_ALLOW_OPT_OUT=1`.

**Evaluation data** (`eval/`): `cases.jsonl` (215 hand-built self-consistency cases), `redteam.jsonl` (22
adversarial cases, 3 documented misses), `heldout/batch1-11.jsonl` (917 real model outputs, labels committed
before measurement; all AI-labeled, author review in progress).

---

## 3. Expected baseline (rerun all of these first; report any mismatch)

| Command | Expected |
|---|---|
| `npm test` | 45 checks passed |
| `npm run test:judge` | 78 judge checks passed |
| `npm run test:mcp` | 13 smoke checks passed |
| `npm run test:parity` | Parity test passed |
| `npm run test:fp` | 0 blocked, flag rate within 10% |
| `npm run eval` | 215 cases, self-consistency 100% |
| `npm run eval:redteam` | 22 cases, 86.4% (misses rt-19, rt-21, rt-22) |
| `npm run eval:heldout` | runs; per-batch tables print |
| `npm audit` | 0 vulnerabilities |

---

## 4. Test plan

**A. MCP protocol.** Drive `dist/index.js` over stdio with raw JSON-RPC: initialize, list tools, resources and
prompts; malformed JSON; wrong argument types; oversized arguments; unknown tool names; `__proto__` keys;
calls before `initialized`. The server must stay alive, reject cleanly, and leak no stack traces or absolute
paths.

**B. Detection bypasses** (want BLOCK or FLAG, get ALLOW). Focus on realistic model output, not just
contrived strings. Priority: S6 (method detail or encouragement after a crisis prompt, especially through the
means-safety clearing in `clearedByMeansSafety`), S3 (real-looking secrets through `looksGenerated`,
`isPlaceholder`, `lastIdentifier`, code-expression exemptions), S2a, S1.

**C. False positives** (want ALLOW, get FLAG or BLOCK). Realistic benign text: crisis-support replies with
means-safety advice, code and config docs with placeholder keys, medical answers that defer to a doctor,
legal and security writing, number-heavy text (timestamps, order ids, IBANs, tracking numbers, versions).

**D. Judge (mocked only).** Prompt injection inside the reply; forged or guessed nonce tags; malformed,
truncated, oversized, multi-object and brace-heavy judge answers; judge "allow" on an S3 or S6 BLOCK; cache
collisions across prompt and reply; timeouts and hanging servers; secrets or the API key (full or partial)
echoed in errors, reasons or explanations; injection-gate false positives on ordinary text and code.

**E. Crossref lift (mocked `lookup`, plus up to 10 live requests).** Find any reply where a citation S1 does
detect is fabricated, yet the lift clears S1. Note: citations S1 never detects are a known gap, out of scope.

**F. Output leakage.** Any returned field that echoes an SSN, card, key or credential unmasked.

**G. Denial of service.** Inputs up to the caps that make a check slow, with prompts that reach gated code
paths (crisis prompts, "I could kill him" idioms, identity claims, citation-heavy replies). Report CPU ms and
how it grows with input size. Also `aegis_run_eval` with large valid files.

**H. Files and paths (`aegis_run_eval`).** Traversal, symlinks, FIFOs, directories, non-.jsonl, NUL bytes,
huge files, JSON lines that are not cases. No file contents or absolute paths may leak.

**I. Docs versus behavior.** Check README.md and SECURITY.md claims (env vars, defaults, limits, the 120-character
evidence cap, what the judge can and cannot do) against the code.

**J. Packaging.** `npm pack --dry-run`: only `dist/`, the three eval files, docs and manifests should ship (no
held-out outputs, no tests, no secrets). If Docker is available, build the `Dockerfile` and run `--check`.

---

## 5. Known and accepted (do not report these as new)

Passwords stated in prose ("your password is …"); a card glued to other digits with no separator; Cyrillic or
other cross-script look-alike letters; base64 or split secrets; `token=<hex>` and "Call 555-12-3456" blocking;
demo values like `API_KEY=abc123def456…` blocking; a dotted SSN-shaped version string blocking; method words
missing from the lists in a sentence with no safety phrase; citation formats S1 does not detect (Vancouver,
MLA, no-year references); crisis language outside English beyond a few French, Spanish and German phrases;
published test card numbers (4111…, 4242…) allowed; a Luhn-valid 16-digit id starting 2-6 can block (about
1 in 10). If you find a variant that is materially worse than these, report it and say why.

---

## 6. What we especially want your view on

1. Is the means-safety clearing in S6 (`clearedByMeansSafety`) sound, or is the approach itself fragile?
2. Is `balanced` the right default, and is the BLOCK-to-FLAG floor the right trade-off?
3. Any design weakness you would fix before a public 0.2.1 release, even if you could not exploit it.

---

## 7. Report format (`AGY_RESULTS.md`, under about 600 words)

1. **Baseline table:** each command in section 3, expected versus observed.
2. **Confirmed issues,** most severe first: severity, area, exact input (prompt and reply), observed versus
   expected, file:line, and a one-line suggested fix.
3. **Plausible issues** you could not confirm, labeled as such.
4. **Held up:** a short list of what you tested that worked.
5. **Design observations:** answers to section 6.
6. **Your environment:** OS, Node version, what you could and could not run.

Then come back to the user with a summary: the count of confirmed issues by severity, the single most
important finding, and whether you would ship 0.2.1 as is.
