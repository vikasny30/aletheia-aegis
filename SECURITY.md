# Security Policy

## Reporting

Report security issues privately to Vikas Shivpuriya at vikas.ny30@gmail.com. Do not open a public issue for a vulnerability that could put users at risk.

## Scope

Aletheia Aegis is a deterministic pattern-based pre-filter for model responses. It is a first line of defense, not a guarantee. Novel or obfuscated phrasing can evade pattern matching, and the S1 detector flags specifics for verification rather than verifying truth.

## Data handling

- The server never stores response text. Telemetry and the audit log record verdicts, finding checks, latency, and response length only.
- Finding evidence is capped at 120 characters. Secrets and PII detected by the S3 checks are masked in evidence and never reproduced raw.
- The guard makes no network requests and loads no remote resources. It reads only local files: the bundled eval data (when `aegis_run_eval` runs) and any case/corpus file path the operator explicitly passes.
- The one exception is `aegis_verify_citations`, an opt-in tool that resolves identifiers against doi.org, arxiv.org, and NCBI E-utilities. It runs only when explicitly called.
- The opt-in debug log (`AEGIS_DEBUG_LOG`) writes full evaluation records, including response text, to a local file. It is off by default and is never exposed as an MCP resource. A debug log may contain secrets and sensitive user content: keep the file local, restrict its permissions, and do not share it.
- Environment variables that change guard behavior: `AEGIS_LOCALE` (crisis-resource locale), `AEGIS_BLOCK_CHECKS` (per-check BLOCK escalation), `AEGIS_DEBUG_LOG` (debug log path). No credentials are required or accepted.

## Known limitations

- Pattern-based detectors can be evaded by paraphrase. Treat a passing verdict as "no known pattern matched", not "safe". The red-team set (`eval/redteam.jsonl`) documents what evades it today.
- The S6 crisis checks are locale-aware (`locale` parameter or `AEGIS_LOCALE`); unknown locales fall back to US resources plus the international directory. Helpline numbers live in `src/engine/crisis-resources.ts` — if a number changes, fix it there.
- S8 (Feedback Loop Absence) is not covered by this server; it requires multi-output trajectory analysis, planned for the session auditor.
