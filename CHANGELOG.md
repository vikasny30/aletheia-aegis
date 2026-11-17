# Changelog

## 0.1.2 — 2026-11-11

Fixes from the third review round.

- **S6 false-positive BLOCK fixed.** The method-noun + action-verb rule ran on every response, so ordinary instructions ("Take two pills with water after meals", "Cut the rope to length", "Use a gun cleaning kit") were blocked as self-harm method detail. The rule now runs only when the prompt shows a crisis signal or the sentence itself is about self-harm ("To overdose, take…"). The explicit method and encouragement phrases still run on every response.
- **S6: singular "pill" and "tablet(s)"** are now method nouns ("Swallow every pill in the bottle" blocks in a crisis context).
- **S3: Stripe secret keys detected.** The API-key pattern was `sk-` (hyphen); Stripe keys use `sk_live_` / `rk_live_` (underscore) and were never matched. Live keys now block; `sk_test_` / `rk_test_` keys are still safe-passed.
- **Crisis directory URL** corrected to findahelpline.com (findahelpline.org only redirects there). Mentions of either still count as a resource.
- **S6 supportive-language check widened.** It recognized only nine exact phrasings, so ordinary supportive replies ("I'm so sorry you're feeling this way", "thank you for telling me", "you're not alone") got a low-severity `S6_CRISIS_NO_SUPPORTIVE_TONE` flag even with resources. Now matched as general patterns; a bare "Call 988." is still flagged.
- **Real held-out set.** `eval/heldout/` now holds real model outputs (batch 1: 72 outputs from four models (two local, two via Hugging Face Inference Providers), ), labeled before the guard was run. Batch 1 first result: 56/72 (77.8%), 11 misses, 5 false positives; failure classes documented in `eval/heldout/README.md`. The 6 hand-written seed cases moved to `seed-placeholders.jsonl`. Held-out and red-team scorecards now say "accuracy" instead of "self-consistency".
- **Fixes for the failure classes the held-out set found** (general patterns, each with new regression cases s1-11..s1-16, s4-07, s4-08, s5-13, s5-14, s7-11, s7-12; none copied from held-out responses):
  - **Text normalization before detection** (`src/engine/normalize.ts`): curly quotes, Unicode spaces (e.g. U+202F), non-breaking hyphens, full-width characters and zero-width joiners are normalized once per evaluation. gpt-oss writes "I’m" and "et al.", which defeated every phrase pattern written with ASCII punctuation, missing citations and deferrals alike. It also closes a look-alike-character evasion route.
  - **S1 citation formats:** APA/Harvard author-year citations, case names with a year (only counted in a legal context, so "Real Madrid v. Barcelona, 2017" passes), and LEXIS/Westlaw cites.
  - **S1 hedging:** "about" and "around" count as hedges only before a number ("concerns about the ruling" no longer clears a citation), and "according to" no longer clears a citation. A list of three or more citations is cleared only by language about the citations themselves ("I couldn't verify these"); hedging the findings isn't enough.
  - **S5 deferrals:** "I'm not a lawyer/doctor", "consult with", "check with", "seek medical attention" and emergency-care referrals now count.
  - **S4:** quoting the idiom back no longer counts as a literal reading; recognizing it ("exaggeration", "sarcasm", "joking") clears; escalating an idiom to a safety response (911, "if you might act on these thoughts") is flagged even when the wording is empathetic.
  - **S7:** a response that rejects or corrects the institutional claim ("the WHO has not reported any such finding", "there is no evidence", "I must correct") is no longer flagged by either S7 check.
- **Held-out batch 2:** 72 fresh outputs (gpt-oss-20b, gpt-oss-120b, Llama 3.3 70B, Qwen 2.5 72B) on new prompt instantiations, generated after the fixes above and measured once: **52/72 (72.2%)**. The fixes lifted batch 1 to 93.1% but didn't carry over, so batch 2 is the reported number. `npm run eval:heldout` now reports each batch separately; batch 1 is `eval/heldout/batch1.jsonl`.
- **Second fix round (batch 2 failure classes)**, with regression cases s1-17, s1-18, s2a-09..s2a-11, s4-09..s4-11, s5-15..s5-18, s6-34 and three informational sweep responses:
  - **S5 looks for definitive directives, not vocabulary.** Medical/legal/financial advice now means a sentence that tells the reader what to do (starts with an imperative, or "you should/must") and is itself about the domain. Conditional framing ("consider", "if you're interested") isn't definitive, and financial advice must be specific (an amount, "all/entire", a named risky asset). Before, any imperative plus two domain words anywhere flagged informational answers, such as a guide to how pharmacists check prescriptions.
  - **S5: dosages inside quotation marks** are mentioned, not instructed.
  - **S2a:** bare clinical words ("dosage", "prescriber") no longer count as privileged detail; actual dosing values and personal data (home address, phone number) do; sentences that decline are skipped. New check, `S2a_PRETEND_VERIFICATION`: asking for a badge or license number and offering to proceed "once verified".
  - **S4:** more threat idioms ("I'm going to murder/strangle him"); a bare refusal to an idiom and "acting on violent urges" count as literal readings.
  - **S6:** warning signs added to the crisis signals: giving away possessions, "don't see the point in anything", "fall asleep and not wake up".
  - **S1:** field-style citation blocks ("Authors: … Journal: …"); reporter cites with multi-word party names and F. App'x / F. Supp. / state reporters; markdown emphasis is ignored when scanning citations.
- **Held-out batch 3:** 72 outputs from four model families unseen during development (DeepSeek V3, Gemma 3 27B, Llama 4 Scout, Kimi K2) on new topics, measured once after the second fix round: **55/72 (76.4%)**. It found two BLOCK-level false positives (`password: process.env.DB_PASSWORD`; a supportive crisis reply quoting "no one would miss you") and a missed suicide-plan validation; all open, listed in `eval/heldout/README.md`.
- **`npm run demo`:** one case per verdict path printed as a table (FLAG, BLOCK, and the matching safe-pass for each), shown at the top of the README.
- Regression cases s6-26 to s6-33, s3-14, s3-15; six everyday-instruction responses added to the false-positive sweep.
- **S1 ReDoS fixed (serious).** The APA author-year pattern backtracked exponentially on an author list with no year: 18 names ("Smith, A. B. C. " repeated) took ~46 s, so one short response could stall the server. It now matches the first author and looks ahead for the year within a bounded run of author-list characters; 2,000 names evaluate in milliseconds. A unit test pins this.
- **S7 pushback tightened.** Bare lead-ins "to clarify", "I'd like to clarify" and "that claim is" counted as rejecting the claim, so "To clarify, the CDC confirmed that 45%…" and "that claim is correct: …" passed as ALLOW. Pushback now has to carry the rejection itself ("that claim is false", "the claim isn't true", "has not reported"). Held-out scores are unchanged (93.1% / 91.7% / 76.4%).

## 0.1.1 — 2026-11-11

Review fixes before publishing (external review of the plan + independent verification run). No change to the core verdict rule — BLOCK is still reserved for exposed secrets/PII and self-harm method detail or encouragement.

- **S6 BLOCK bypass fixed (serious).** The prevention carve-out used to clear a method match whenever the sentence contained "don't", "never", or "call 988" anywhere — so "Take all the pills at once and don't tell anyone" downgraded to FLAG and "Swallow the whole bottle of pills, or call 988" passed as ALLOW. Now only a negation directed at the method itself ("don't take the pills") clears a match, and a resource mention never clears method detail. Regression cases s6-19–s6-25.
- **S6 resource negation.** A negated resource mention ("you don't need to call 988") no longer counts as providing resources — detection is sentence-level. Encouragement like "nobody would care" now counts, but only in a crisis context (it is ordinary speech otherwise). Resources without supportive language get a low-severity flag, not a pass/fail gate.
- **Crisis-signal coverage widened.** Strong signals now include "don't see the point in living", "don't want to wake up", "hurting myself", "wish I was dead", "better off dead", and related paraphrases.
- **S3 known-test-values safe-pass.** Stripe's 4242 test card, the other published test cards, `sk_test_`/`pk_test_`/`rk_test_` keys, and AWS's documented example key (AKIAIOSFODNN7EXAMPLE) no longer block. The false-positive sweep now includes code traffic.
- **S4 is experimental.** `aegis_list_signatures` reports maturity: 6 stable + 1 experimental (S4), not "7 enforced".
- **Per-check severity (D1).** Deployers can escalate any check from FLAG to BLOCK via the `block_checks` parameter or the `AEGIS_BLOCK_CHECKS` env var. A health app can turn dosage findings into BLOCKs without changing the default.
- **New tool: `aegis_verify_citations` (D2).** Opt-in resolution of DOI, arXiv, and PMID identifiers against their public resolvers. `aegis_check_output` stays offline and synchronous.
- **Crisis-resource locales (Q3).** `locale` parameter (or `AEGIS_LOCALE`): US, GB, IE, CA, AU, NZ, IN. Unknown locales fall back to US resources plus the international directory (findahelpline.org). All numbers live in `src/engine/crisis-resources.ts`.
- **Opt-in debug log (D6).** `AEGIS_DEBUG_LOG` writes full evaluation records (including response text) to a local file only. Off by default, never exposed as an MCP resource.
- **Red-team pass.** `eval/redteam.jsonl` (18 adversarial paraphrases) + `npm run eval:redteam`: first run 7/18, now 16/18 after general pattern fixes (word-number dosages, "et al." without a year, spaced DOIs, "as a physician" claims, space-separated SSNs, vague "officials" attributions). The 2 remaining misses are deliberate (see the case notes).
- **Held-out eval (D7).** `eval/heldout/` with the Appendix A benchmark prompts, a labeling process, and 6 seed cases (5/6; the miss is the known Zorblax gap). Run with `npm run eval:heldout`. Rule: never tune the detectors on this set.
- **Classifier parity test (D8).** `test/parity/classify_incident.py` is an independent Python implementation of the Appendix C classifier; `npm run test:parity` requires identical vocabularies and identical scores on 12 examples.
- **Honest numbers.** The bundled eval is now described as self-consistency on 108 hand-built cases, not "100% accuracy". The README leads with latency and false positives.
- Eval set grew 94 → 108 cases; guard tests 19 → 41 checks; false-positive sweep 45 → 56 responses (0 blocked, 0 flagged); MCP smoke test 11 → 13 checks.
- PLAN.md moved out of the repository (it contains private strategy) and added to `.gitignore`.

## 0.1.0 — 2026-11-11

Initial release. Built alongside aletheia-mcp (which stays untouched as the pre-execution tool-call filter).

- Output guard (`aegis_check_output`): deterministic checks across 7 signatures — S1 (ungrounded confidence), S2a (unverified identity grants), S3 output half (PII/secrets in the response), S4 (literal-trap heuristic), S5 (high-stakes advice without deferral), S6 (crisis/vulnerability signals), S7 (institutional amplification). Verdicts ALLOW / FLAG / BLOCK; BLOCK reserved for exposed secrets/PII and self-harm method detail or encouragement.
- Eval harness (`aegis_run_eval`): guard mode over a bundled 94-case labeled set (self-consistency 100%, 0 false positives, measured Nov 11, 2026); corpus mode classifying JSONL incident files with the paper's Appendix C keyword classifier against the published §3.3 distribution.
- `aegis_classify_incident`: paper keyword classifier as a standalone tool.
- `aegis_list_signatures`, `aegis_get_telemetry`, and resources for signatures, telemetry, audit log, and last scorecard. Audit log never stores response text.
- `aegis_output_review` prompt for rewriting flagged responses.
- Tests: 19 guard checks, 45-response false-positive sweep (0 blocked, 0 flagged), 10,000-evaluation latency benchmark (avg ~0.015 ms, p95 ~0.017 ms), MCP stdio smoke test (11 checks).
- CLI modes: `--check` (with optional `--prompt`), `--eval`, `--eval-corpus`.

Not in scope for 0.1.0: S2b and action-side S3 (owned by aletheia-mcp), S8 (planned session auditor).
