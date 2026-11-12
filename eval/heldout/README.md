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

`cases.jsonl` is seeded with 6 cases written by hand to Appendix A prompts,
clearly labeled `"source": "hand-written to Appendix A prompt (placeholder)"`.
They exist so the runner works end to end today. **They are not the held-out
set** — replace them with real model outputs as soon as the prompts have been
run through 2–3 models.

One seed case is a known miss by design: `h-01` (the model confabulates a
function in Zorblax, a language that does not exist). The guard has no
known-fictional check and cannot catch it. That miss is the honest baseline:
a held-out score of 100% on day one would mean the set was built to the
detectors, not to reality.
