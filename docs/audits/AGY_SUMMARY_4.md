# AGY Test Summary 4: Aletheia Aegis v0.2.1 (`3d0889e`)

## Key Metrics & Baseline
- **Baseline Tests:** 100% pass rate (`npm test`: 45 passed, `test:judge`: 103 passed, `test:mcp`: 13 passed).
- **Leak Tests:** 0 hits across telemetry, audit log, history file, and stderr.
- **Eval & Parity:** 215 cases (100%), Redteam 22 cases (86.4%), FP sweep 0/90 (0%).
- **Replayed Held-Out Judge:** Batch 10 (20/20 caught, 1/88 flagged); Batch 11 (26/31 caught, 1/59 flagged).
- **ReDoS Benchmark:** 1M-char inputs evaluated in 0.6–70 ms CPU time; p95 latency 0.036 ms.
- **Live Calls:** Zero live API calls made.

## Confirmed Findings Summary
| # | Severity | Category | File:Line | Issue Summary |
|---|---|---|---|---|
| 1 | **CRITICAL** | S6 Self-Harm | `src/engine/detectors.ts:1191` | `CRISIS_LOCATION_RE` falsely blocks supportive crisis de-escalation (28/42 tested blocked). |
| 2 | **CRITICAL** | S6 Self-Harm | `src/engine/detectors.ts:1189` | Lethal methods using unlisted verbs (`plunge`, `dive`, `drop`, `fall`), 3-word modifiers, or places (`pier`, `deck`, `dam`) bypass BLOCK as FLAG (25/30 tested missed). |
| 3 | **HIGH** | S1 Crossref | `src/engine/citation-lookup.ts:87` | Inverted subtitle token subset match (`claimed / claimedTokens.size`) allows hallucinated paper titles to validate against real subtitles. |
| 4 | **HIGH** | S1 Crossref | `src/engine/citation-lookup.ts:110` | Real MLA, IEEE, and Chicago citations fail title extraction and are falsely flagged when Crossref records subtitles. |
| 5 | **HIGH** | S3 Secrets | `src/engine/detectors.ts:466` | Four-backtick code fences (` ````python `) fail language capture and falsely block valid code variables. |
| 6 | **HIGH** | S3 Secrets | `src/engine/detectors.ts:466` | Mismatched fence delimiters (`~~~` closed by ```` ``` ````) treat literal passwords as code and allow them. |
| 7 | **MEDIUM** | S2a Identity | `src/engine/detectors.ts:229` | Possessives and fans/companions (`Dr. Seuss's biggest fan`, `Judge Judy's producer`) falsely flag benign medical answers. |
| 8 | **MEDIUM** | S3 Secrets | `src/engine/detectors.ts:403` | Labeled bank accounts miss IBANs, "account ending in", bare "acct no.", and wire/ACH labels. |

## Recommendation
**DO NOT SHIP** until Issue #1 (`CRISIS_LOCATION_RE` blocking supportive de-escalation) and Issue #3 (Crossref subtitle subset bypass) are addressed. Issue #1 is life-critical because it suppresses real emergency de-escalation instructions to users in crisis.
