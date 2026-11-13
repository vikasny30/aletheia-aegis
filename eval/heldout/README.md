# Held-out eval set (D7)

The bundled eval set (`eval/cases.jsonl`) is hand-built to the detectors'
documented behavior. It proves the guard does what it says — it cannot prove
the guard catches real failures. **This directory is the number that means
something.**

## How it works

1. Take the prompts in `prompts.md` (the paper's Appendix A benchmark
   prompts, plus a few output-guard-specific ones).
2. Run each prompt through 2–3 different models.
3. Paste each model's response into `cases.jsonl` as one JSON object per
   line, with the label you judged by hand (`allow` / `flag` / `block`),
   the prompt, and a `source` field naming the model, e.g.
   `"source": "model output (Claude Sonnet 4.5), hand-labeled"`.
4. Run `npm run eval:heldout` and read the scorecard.

## The one rule

**Never tune the detectors on this set.** The moment a detector is changed to
catch a held-out case, the set stops measuring anything. Held-out misses go
to the red-team list for principled fixes (a new general pattern, not a
case-specific hack) — or stay recorded as known gaps.

## Current contents

`cases.jsonl`: **72 real model outputs**, generated November 12, 2026: the 18 prompts
below (15 output-guard prompts from Appendix A, instantiated with concrete values, plus
3 benign controls) run through four models:

| Model | Where it ran |
|---|---|
| Llama 3.2 3B | local, Ollama |
| Qwen 2.5 7B | local, Ollama |
| gpt-oss-20b | Hugging Face Inference Providers (Groq) |
| Llama 3.3 70B | Hugging Face Inference Providers |

Labels: 16 should be caught (15 flag, 1 block), 56 should pass. Every response was
labeled against the signature definitions **before** the guard was run on it. Labels
marked "Borderline" in `note` are judgment calls. The labels were written by a reviewer
and are pending the author's review, as each case's `source` field says.

**First run (v0.1.2): 56/72 (77.8%), 11 misses, 5 false positives.** The failure classes:

| Class | Cases | What happened |
|---|---|---|
| S1: APA-style citations with no DOI or "et al." | 3 misses | The S1 detector keys on DOI/arXiv/PMID/"et al."; real models cite as "Chang, A. M., ... (2016). Title. Journal, 12(11)" |
| S1: invented case holdings | 3 misses | "Henderson v. Pacific Rail Logistics" with no reporter citation, or with LEXIS/WL cites, isn't recognized |
| S1: precise statistic | 1 miss | "about 9.3 %" (space before %, "about"). Arguably hedged |
| S5: Zorblax confabulation | 3 misses | Known gap: no known-fictional check |
| S4: crisis-style reply to an idiom | 1 miss | The S4 check doesn't recognize a 911/crisis response to "I could kill him" |
| S4: quoting the idiom | 2 false positives | `S4_LITERAL_TRAP` fires when the response quotes "I could kill him", even while calling it an exaggeration |
| S5: deferral not recognized | 2 false positives | "I'm not a lawyer" and "consult with a physician" phrasing not counted as deferral |
| S7: premise rejected | 1 false positive | `S7_PREMISE_AMPLIFIED` fires on "the WHO has not reported any such findings", the correct response |

`seed-placeholders.jsonl`: the 6 hand-written seed cases that preceded this set. Kept
for reference; they are not part of the held-out number.

To regenerate: run the prompts in `prompts.md` through new models, label before
running the guard, and append to `cases.jsonl`. After detector fixes, measure on a
**new** batch: this one has now been seen.
