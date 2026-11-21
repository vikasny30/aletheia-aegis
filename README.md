# Aletheia Aegis: Inference-Time Output Enforcement for Autonomous Agents

> A deterministic, sub-millisecond inference-time guard for model outputs. Fail-closed on irreversible harm with zero extra model inference on the fast path, and an optional semantic judge only for cases patterns cannot settle.

[![Architecture](https://img.shields.io/badge/Architecture-Aletheia%20Safety%20Runtime-blue)]()
[![Layer](https://img.shields.io/badge/Layer-Output%20Enforcement-green)]()
[![p95 Latency](https://img.shields.io/badge/p95-0.019--0.029%20ms-orange)]()
[![Throughput](https://img.shields.io/badge/Throughput-73k%2B%20evals%2Fsec-purple)]()
[![License](https://img.shields.io/badge/License-Apache%202.0-lightgrey)]()

Aegis is the output plane of the Aletheia safety framework. It inspects generated text before it reaches a user, blocks credential leaks and life-safety failures outright, and flags everything else for audit or disclaimer. It runs offline by default, on CPU, with no response text retained.

Ships as an MCP server, TypeScript SDK, and CLI. Version 0.3.0. Apache 2.0. TypeScript, Node.js 18/20/22.

---

## Why Aegis exists

Built for platform, security, and AI infrastructure teams deploying tool-using agents into regulated or high-throughput production environments.

Production agents need safety that does not break the product. The common approach, running a second LLM as judge on 100 percent of outbound traffic, fails on three counts at scale:

1. **Latency.** A 1,000 to 4,000 ms penalty per turn breaks streaming and multi-step agentic loops.
2. **Cost.** A secondary frontier model on every payload turns safety into a cost center, roughly $0.002 to $0.02 per evaluation, tens of thousands of dollars monthly at scale.
3. **Reliability.** A probabilistic model policing another probabilistic model inherits prompt injection, evaluator hallucination, and nondeterministic bypasses.

Even smaller dedicated guardrail models (such as Llama Guard or classifier checkpoints) still add GPU infrastructure, tens of milliseconds of inference overhead, and probabilistic variance to every response.

Aegis takes the opposite starting point: enforce the non-negotiable invariants at inference time deterministically on CPU, with zero extra model inference on the fast path, and reserve model judgment for the small set of cases where semantics actually matter.

That is the core design bet. Deterministic first, semantic second, fail-closed throughout.

---

## Principles

1. **Deterministic first.** Pattern and structural checks run on every output. No network call, no model call, no variance.
2. **Fail-closed on irreversible harm.** Credential exfiltration and life-safety violations block immediately. They are never sent to an external judge and cannot be overruled by one.
3. **Semantic judgment is optional and pre-redacted.** When enabled, a judge sees only masked payloads, under strict rubrics, with injection defenses on the review path itself.
4. **Zero retention by default.** Telemetry stores verdict counts, signature IDs, and timings only. No prompt or response text in logs.
5. **Honest boundaries.** Aegis is a fast first-line filter, not a proof of completeness. Its limits are documented below, not buried.

---

## Architecture

```mermaid
flowchart TB
    subgraph Host["Host application / Agent runtime"]
        A[Raw model response stream]
    end

    subgraph Aegis["Aletheia Aegis: Inference-Time Safety Platform"]
        direction TB
        B["Stage 1: Deterministic engine<br/>DFA and structural checks, p95 0.019-0.029 ms<br/>S1 Grounding, S2a Identity, S3 PII/Credentials,<br/>S4 Context, S5 Medical/Legal, S6 Life-safety, S7 Attribution"]
        B --> C{ verdict? }
        C -- "BLOCK: S3 credentials, S6 harm" --> D["Hard block<br/>Immediate fail-closed termination<br/>No judge dispatch, no exfiltration risk"]
        C -- "ALLOW / FLAG" --> E["Optional Stage 2: Semantic judge<br/>Pre-redacted, anti-injection<br/>S6 can never be overruled"]
        E --> F["Citation check<br/>Crossref: DOI, arXiv, PMID"]
        F --> G["Audit telemetry<br/>Metadata and timing counts only"]
    end

    A --> B
    D --> H[Blocked: no output delivered]
    G --> I[Governed response to user]
```

### How the two stages work

**Stage 1: Deterministic edge engine.** Every output is evaluated on CPU in 0.019 to 0.029 ms at p95. Irreversible failures trigger an immediate hard block. The upstream judge is skipped entirely, which saves cost and removes the exfiltration path.

**Stage 2: Optional semantic judge.** For subjective or complex epistemic checks, an external judge (Anthropic, OpenAI, Gemini) can be called under strict rubrics. Detected secrets are masked before dispatch, life-safety findings can never be overruled, and heuristic defenses catch reviewer-targeted prompt injections.

---

## Where Aegis fits: the Aletheia dual layer

Aletheia standardizes nine failure signatures across the agentic lifecycle, grounded in 2,571 real-world incident records from the AI Incident Database, AVID, and the MIT AI Risk Repository. Aegis covers the output plane. Its companion, aletheia-mcp, covers the action plane.

| Signature | Failure | Enforced by | Action |
|---|---|---|---|
| S1 | Confidence without grounding | Aegis | Flag |
| S2a | Social / identity manipulation | Aegis | Flag |
| S2b | Adversarial jailbreak and injection | aletheia-mcp | Block (pre-execution) |
| S3 | Scope creep and data leakage | Dual layer | Block (hard gate) |
| S4 | Context blindness and idiom traps | Aegis | Flag (heuristic, experimental) |
| S5 | Unsafe prescriptive fallback | Aegis | Flag / Block |
| S6 | Vulnerability signal blindness | Aegis | Block (invariant) |
| S7 | Institutional credibility spoofing | Aegis | Flag |
| S8 | Feedback loop and session erosion | Session auditor (planned) | Multi-turn audit |

S3 is split by plane by design, so no single layer is a single point of failure:

- **Action plane (aletheia-mcp):** guards tool execution (shell commands, filesystem mutations, database writes, SSRF calls) before execution.
- **Output plane (Aegis):** guards generated token streams (SSNs, API keys, credentials, private keys, Luhn-valid cards) before presentation.

---

## What it enforces

| Signature | What it catches | Verdict |
|---|---|---|
| S1 | Unhedged specific statistical claims, fabricated citations, unverified DOIs, arXiv IDs, PMIDs. Scholarly verification via Crossref. | Flag |
| S2a | Unauthorized claims of professional licensure, for example "As your board-certified oncologist" or "Speaking as your legal counsel." | Flag |
| S3 | Exfiltrated credentials: SSNs, Luhn-checked cards (Visa, Mastercard, Amex, Discover, JCB), API keys (Stripe, AWS, GitHub, Google, SendGrid), JWTs, RSA/EC/SSH private keys, environment variables. Documented test cards (4242) and sample tokens pass. | Block |
| S4 | Literal readings of common idioms ("I could kill him", "Break a leg"). Experimental heuristic. | Flag |
| S5 | Prescriptive medical dosages, unhedged pharmaceutical directives, capability confabulations. | Flag |
| S6 | Self-harm method detail or encouragement. Permanent hard invariant: pairing with a crisis hotline does not waive a method. Crisis intent without a hotline generates remediation resources. | Block / Flag |
| S7 | Unverified attribution to authoritative bodies ("According to official WHO directives") to prevent disinformation laundering. | Flag |

---

## Performance and evaluation

Benchmarked on Linux x86_64 and Apple Silicon, Node.js 18/20/22, single core unless noted.

| Metric | Result |
|---|---|
| p50 latency, deterministic filter | 0.009 to 0.012 ms |
| p95 latency, deterministic filter | 0.019 to 0.029 ms |
| Peak throughput | 73,080+ evals/sec, single core, unbatched |
| Concurrent throughput | 4,815+ evals/sec, 120 async tasks |
| Memory footprint | Under 35 MB RSS, no native compile |
| Benign false positives | 0 of 90 |
| Bundled eval corpus | 215 of 215 pass, zero regression |
| Held-out catch rate, batches 10-11, balanced policy | 90.2 percent, with 1.4 percent false alarms |

Held-out evaluation used 575 real model outputs across 30+ open and frontier models. Batches 10-11 replay offline with no external API cost:

```
npm run eval:heldout:judge
```

Labels were committed before measurement. The 90.2 percent figure is the balanced-policy result with the semantic judge enabled; patterns alone catch less, which is why the two-stage design exists. See `eval/` for the labeled cases and replay instructions.

### Adversarial testing

Six rounds of cross-family adversarial testing, conducted with Claude Sonnet 5.5 and Gemini 3.5 Flash, covering ReDoS elimination, life-safety false blocks, preposition pairing, code-fence handling, boundary integrity, and MCP concurrency. Each round is documented in [docs/audits/](docs/audits/); the test suite reproduces the checks offline.

A note on method: model-assisted red-teaming is useful for finding bypasses, it is not independent validation. The held-out numbers above are the empirical claim. The adversarial rounds are the hardening process behind them.

---

## Security: zero retention

- **No response text in audit trails.** Telemetry and metrics store verdict counters, signature IDs, and timings only.
- **Pre-judge secret masking.** If a judge is enabled, detected credentials, API keys, and SSNs are masked before dispatch to any external provider.
- **Fail-closed isolation.** Pattern-based blocks halt immediately and are never sent to external judges.
- **Verified by leak tests.** `npm run test:leak` asserts zero trace of canary tokens across logs, telemetry, and outbound payloads.

---

## Quick start

### 1. CLI

```bash
# Prescriptive medical directive (S5)
npx aletheia-aegis --check "Take 500mg of ciprofloxacin twice daily for 10 days."
# FLAG [S5_DOSAGE_WITHOUT_DEFERRAL]

# Credential leak (S3)
npx aletheia-aegis --check "Database connection: postgres://admin:secretKey987654@db.prod:5432/main"
# BLOCK [S3_CREDENTIAL_PAIR] (masked evidence)
```

### 2. MCP server (Claude Desktop, Cursor, Cline, OpenRouter)

```json
{
  "mcpServers": {
    "aletheia-aegis": {
      "command": "npx",
      "args": ["-y", "aletheia-aegis"]
    }
  }
}
```

With an optional Tier-2 judge:

```json
{
  "mcpServers": {
    "aletheia-aegis": {
      "command": "npx",
      "args": ["-y", "aletheia-aegis"],
      "env": {
        "AEGIS_JUDGE_PROVIDER": "anthropic",
        "AEGIS_JUDGE_API_KEY": "sk-ant-...",
        "AEGIS_JUDGE_POLICY": "balanced",
        "AEGIS_VERIFY_CITATIONS": "crossref"
      }
    }
  }
}
```

### 3. TypeScript SDK

Embed inside inference gateways, proxy routers, or API middleware:

```typescript
import { evaluateOutput } from "aletheia-aegis";

const assessment = evaluateOutput({
  response: generatedTokens,
  userPrompt: userQuery,
  locale: "US"
});

if (assessment.verdict === "BLOCK") {
  metrics.increment("safety.hard_block", { signature: assessment.findings[0].signature });
  throw new SecurityPolicyException("Generation blocked: " + assessment.explanation);
}

if (assessment.verdict === "FLAG") {
  auditPipeline.logEvent({ findings: assessment.findings, latencyMs: assessment.latencyMs });
}
```

---

## MCP tools

Six tools, four resources, one prompt template.

| Tool | Purpose |
|---|---|
| `aegis_check_output` | Core inspection. Returns verdict (ALLOW, FLAG, BLOCK), findings, risk score, latency. Deterministic and offline by default. |
| `aegis_verify_citations` | Resolves DOIs, arXiv IDs, PMIDs against public registries. Reports status without changing verdicts. |
| `aegis_run_eval` | Runs the local eval harness against 215 labeled cases, or classifies an incident JSONL file. |
| `aegis_classify_incident` | Categorizes incident reports against the Aletheia taxonomy. |
| `aegis_list_signatures` | Metadata, maturity, and mandates for all nine signatures. |
| `aegis_get_telemetry` | Stage latencies, judge usage, token counts, cost basis, override stats. |

Resources: `aegis://signatures/all`, `aegis://telemetry/summary`, `aegis://telemetry/audit-log`, `aegis://eval/last-scorecard`. Prompt: `aegis_output_review`, which guides a model to remediate flagged outputs.

---

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `AEGIS_BLOCK_CHECKS` | Check IDs to elevate from FLAG to BLOCK | Unset |
| `AEGIS_LOCALE` | Crisis lifeline localization (US, GB, IE, CA, AU, NZ, IN) | US |
| `AEGIS_METRICS_LOG` | Path to append-only JSONL metrics file | Off |
| `AEGIS_JUDGE_PROVIDER` | Tier-2 judge (anthropic, openai, google, openai-compatible) | Off |
| `AEGIS_JUDGE_API_KEY` | API key for the judge provider | Unset |
| `AEGIS_JUDGE_MODEL` | Judge model identifier | Provider default |
| `AEGIS_JUDGE_POLICY` | balanced (protects S6/S3) or strict (joins all flags) | balanced |
| `AEGIS_VERIFY_CITATIONS` | Set to `crossref` to enable scholarly lookups | Off |
| `AEGIS_DEBUG_LOG` | Local debug file (captures payload text, offline use only) | Off |

---

## Boundaries and threat model

Transparency on limits is part of the design:

- **Deterministic pre-filter, not a semantic parser.** Novel or deliberately obfuscated paraphrases can evade pattern heuristics. Aegis catches the common and severe classes at microsecond cost, so downstream systems can focus on edge cases.
- **Prose credential screening (S3).** To avoid false alarms on ordinary conversation, credential checks require non-word or complex token characteristics. Single dictionary words ("your password is password") deliberately pass. Cards require valid brand prefixes and Luhn checks. Bank accounts require banking context, so utility bills and gym numbers are not blocked.
- **Life safety (S6).** Strict verb-preposition pairing keeps benign de-escalation ("sit on the platform bench while you wait") passing with supportive resources, while lethal placements ("sit on the train tracks") block. English-first, with core French, German, and Spanish intent statements.
- **Citation scope (S1).** Crossref verifies scholarly works (DOI, arXiv, PMID). Legal case citations retain their S1 warning by design; court registries are outside Crossref.
- **Single-turn scope (S8).** Aegis operates on individual prompt-response pairs. Multi-turn erosion requires session-level auditing, which is the planned session auditor (see [ROADMAP.md](ROADMAP.md)).

---

## Status and roadmap

**Current: v0.3.0.** Public release. Deterministic engine, optional judge, Crossref verification, MCP server, and SDK are stable. S4 remains experimental.

**Next** (full technical plan in [ROADMAP.md](ROADMAP.md)):

- Streaming token/chunk inspection and framework adapters (v0.4.0)
- Session auditor for S8 multi-turn erosion
- Expanded non-English coverage for S6
- Broader held-out eval sets, with sampling methodology documented in repo

---

## Contributing

Contributions, new evaluation cases, and issue reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, offline test commands, and pull request guidelines. Please include a redacted reproduction case for any bypass report—never a live credential. For sensitive disclosures, see [SECURITY.md](SECURITY.md).

---

## Tests

Everything runs offline:

```bash
npm install
npm run build              # Compile TypeScript (tsc)
npm test                   # Core unit checks + eval assertions (45 checks)
npm run test:judge         # Model judge, security, ReDoS tests (121 checks)
npm run test:mcp           # MCP stdio smoke test (13 checks)
npm run test:mcp:adversarial # MCP stdio protocol fuzzing and sandboxing (11 checks)
npm run test:stress        # Concurrency and re-entrancy stress (120 tasks)
npm run test:leak          # Zero-leak PII/secret verification
npm run test:fp            # False-positive sweep on benign discourse (90 cases)
npm run eval               # Full 215-case benchmark (100 percent pass)
npm run eval:redteam       # Adversarial paraphrase suite (90.9 percent catch)
npm run eval:heldout:judge # Offline replay of held-out batches 10-11
npm run benchmark          # 10,000-iteration latency benchmark
```

---

## Author and citation

Aletheia Aegis is authored by Vikas Shivpuriya as part of the Aletheia AI Safety Research Core.

```bibtex
@software{shivpuriya2026aegis,
  author       = {Vikas Shivpuriya},
  title        = {Aletheia Aegis: Inference-Time Output Enforcement for Autonomous Agents},
  year         = {2026},
  publisher    = {GitHub},
  version      = {0.3.0},
  url          = {https://github.com/vikasny30/aletheia-aegis}
}
```

---

## License

Copyright 2026 Vikas Shivpuriya. Released under the Apache License, Version 2.0.
