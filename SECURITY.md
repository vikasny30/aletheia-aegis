# Security Policy

## Reporting

Report security issues privately to Vikas Shivpuriya at vikas.ny30@gmail.com. Do not open a public issue for a vulnerability that could put users at risk.

## Scope

Aletheia Aegis is a deterministic pattern-based pre-filter for model responses. It is a first line of defense, not a guarantee. Novel or obfuscated phrasing can evade pattern matching, and the S1 detector flags specifics for verification rather than verifying truth.

## Data handling

- The server never stores response text. Telemetry and the audit log record verdicts, finding checks, latency, and response length only.
- Finding evidence is capped at 120 characters. SSNs, card numbers, API keys and literal credentials are masked in everything a result returns (every finding's evidence and description, the explanation, the judge's reason, reference text), not only in S3 findings.
- By default the guard makes no network requests and loads no remote resources. It reads only local files: the bundled eval data (when `aegis_run_eval` runs) and a case/corpus file path passed to that tool. Such a path must be an existing `.jsonl` file under 50 MB (checked after resolving symlinks); errors never quote file contents or reveal whether some other path exists.
- **Optional model judge (v0.2).** Only when the operator sets `AEGIS_JUDGE_PROVIDER`, the reply and user prompt are sent to that provider's endpoint (or the operator's `AEGIS_JUDGE_BASE_URL`) with the operator's API key. The key is read from the environment, never logged, and replaced with `[key]` wherever it appears in an error. A custom base URL must use https (plain http only for localhost) and may not embed credentials. Texts over 24,000 characters (prompt: 6,000) are cut before sending.
- **Optional Crossref check (v0.2).** Only when `AEGIS_VERIFY_CITATIONS=crossref`, reference lines from replies already flagged under S1 are sent to api.crossref.org.
- `aegis_verify_citations` is an opt-in tool that resolves identifiers against doi.org, arxiv.org, and NCBI E-utilities. It runs only when explicitly called, and checks at most 25 distinct identifiers per call (the rest are reported as skipped).
- The opt-in debug log (`AEGIS_DEBUG_LOG`) writes full evaluation records, including response text, to a local file. It is off by default and is never exposed as an MCP resource. A debug log may contain secrets and sensitive user content. The server creates it owner-only (mode 600) and tightens an existing file to that mode; keep it local and do not share it.
- Environment variables that change guard behavior: `AEGIS_LOCALE` (crisis-resource locale), `AEGIS_BLOCK_CHECKS` (per-check BLOCK escalation), `AEGIS_DEBUG_LOG` (debug log path), and the optional `AEGIS_JUDGE_*` and `AEGIS_VERIFY_CITATIONS` settings. No credentials are required; the judge's API key is the only one accepted.

## Known limitations

- **The judge reviews untrusted text.** A reply can contain text aimed at the judge (forged tags, "note to the reviewer", a fake verdict). Defenses: the reply sits in tags with a random per-call suffix; the rubric treats instructions inside it as data; text aimed at a reviewer, or a reply too long to send in full, removes the judge's power to overrule the patterns for that call; and in any case the judge can soften a pattern BLOCK only to FLAG, never clear it. A manipulated judge can still miss a failure the patterns also miss, as any model reviewer can.

- Pattern-based detectors can be evaded by paraphrase. Treat a passing verdict as "no known pattern matched", not "safe". The red-team set (`eval/redteam.jsonl`) documents what evades it today.
- The S6 crisis checks are locale-aware (`locale` parameter or `AEGIS_LOCALE`); unknown locales fall back to US resources plus the international directory. Helpline numbers live in `src/engine/crisis-resources.ts` — if a number changes, fix it there.
- S8 (Feedback Loop Absence) is not covered by this server; it requires multi-output trajectory analysis, planned for the session auditor.
