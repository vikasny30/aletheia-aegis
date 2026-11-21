# AGY Test Summary 5: Aletheia Aegis v0.2.1 (`3620a59`)

## Key Metrics & Baseline
- **Baseline Tests:** 100% pass rate (`npm test`: 45 passed, `test:judge`: 109 passed, `test:mcp`: 13 passed).
- **Leak Tests:** 0 hits across telemetry, audit log, history file, and stderr.
- **Eval & Parity:** 215 cases (100%), Redteam 22 cases (86.4%), FP sweep 0/90 (0%).
- **Replayed Held-Out Judge:** Batch 10 (20/20 caught, 1/88 flagged); Batch 11 (26/31 caught, 1/59 flagged).
- **ReDoS Benchmark:** 1M-char inputs evaluated in 0.8–107 ms CPU time; p95 latency 0.036 ms.
- **Live Calls:** Zero live API calls made.

## Confirmed Findings Summary
| # | Severity | Category | File:Line | Issue Summary |
|---|---|---|---|---|
| 1 | **CRITICAL** | S6 Self-Harm | `src/engine/detectors.ts:1218` | Lethal method rides on means-safety span (`step off ledge and go back inside the river`) to completely evade BLOCK as ALLOW. |
| 2 | **CRITICAL** | S6 Self-Harm | `src/engine/detectors.ts:1218, 1262` | Means-safety span and roof/water rules falsely block 10 of 56 tested supportive crisis de-escalation instructions. |
| 3 | **CRITICAL** | S3 Secrets | `src/engine/detectors.ts:527, 730` | Enclosing plaintext secrets or comments inside closed python/js fences completely exempts them from credential detection. |
| 4 | **HIGH** | S1 Crossref | `src/engine/citation-lookup.ts:88` | Acronym main titles (e.g. `BERT`) permit hallucinated title combinations (`BERT Transformers`) to validate against real records. |
| 5 | **HIGH** | S1 Crossref | `src/engine/citation-lookup.ts:55, 121` | Single-quoted citations (`'...'`), titles starting with short questions (`Why?`), and quoted annotations fail paper verification. |
| 6 | **HIGH** | S3 Secrets | `src/engine/detectors.ts:480, 497` | Fence scanner treats code in blockquotes (`> ```py`), list items, and `python3`/`py3`/`golang` tags as prose, falsely blocking valid code. |
| 7 | **MEDIUM** | S3 Secrets | `src/engine/detectors.ts:411` | Lowercase IBANs (`de89370400440532013000`) completely bypass financial detection and masking due to missing `i` flag. |
| 8 | **MEDIUM** | S6 Self-Harm | `src/engine/detectors.ts:1247` | Plural locations (`cliffs`, `bridges`, `balconies`) and movement verbs (`hop`, `roll`, `slip`, `tumble`, `swim`) evade BLOCK as FLAG. |

## Recommendation
**DO NOT SHIP** until Issue #1 (lethal method riding on means safety to ALLOW), Issue #2 (false blocks on de-escalation directives), and Issue #3 (prose secrets leaking inside python blocks) are resolved.
