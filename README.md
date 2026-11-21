# Aletheia Aegis: Architecture for Autonomous Agent Safety & Runtime Enforcement

> **Sub-millisecond output guardrails and safety runtime for autonomous AI agents and frontier LLMs.**

[![Architecture](https://img.shields.io/badge/Architecture-Aletheia%20Safety%20Runtime-4F46E5.svg)](#architectural-thesis-the-latency--reliability-wall)
[![Layer](https://img.shields.io/badge/Layer-Autonomous%20Output%20Guardrails-blue.svg)](#the-aletheia-architecture-dual-layer-defense)
[![p95 Latency](https://img.shields.io/badge/p95%20Latency-0.019%20ms-10B981.svg)](#production-slas--benchmarks)
[![Throughput](https://img.shields.io/badge/Throughput-73%2C000%2B%20evals%2Fsec-2563EB.svg)](#production-slas--benchmarks)
[![MCP Protocol Compliant](https://img.shields.io/badge/MCP-2024--11--05-blue.svg)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache%202.0-F59E0B.svg)](LICENSE)
[![Zero PII Retention](https://img.shields.io/badge/Security-Zero%20Data%20Retention-059669.svg)](#data-security--zero-leak-guarantee)

---

## Architectural Thesis: The Latency & Reliability Wall

As autonomous AI agents are deployed into mission-critical production stacks, engineering teams face a fundamental systems bottleneck: **how to enforce non-negotiable safety boundaries and prevent catastrophic failures without destroying runtime performance or multiplying inference costs.**

The common industry shortcut of deploying recursive **"LLM-as-a-judge"** evaluators on 100% of outbound model traffic fails at production scale:
- **Destroys Real-Time UX:** A 1,000 ms to 4,000 ms latency penalty per turn completely breaks conversational streaming and multi-step agentic execution loops.
- **Unsustainable Cloud Unit Economics:** Chaining secondary frontier models for every outbound payload turns safety into a cost center ($0.002 to $0.02 per evaluation, ballooning to tens of thousands of dollars monthly at scale).
- **Probabilistic Fragility:** Using a probabilistic model to police another probabilistic model introduces prompt-injection vulnerabilities, evaluator hallucination, and nondeterministic bypasses.

**Aletheia Aegis sets the engineering standard for production AI safety:** a **deterministic, sub-millisecond edge firewall (<0.02 ms p95)** that enforces fail-closed invariants at wire speed, combined with an optional, pre-redacted tier for semantic evaluation.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 HOST APPLICATION / AGENT RUNTIME                                │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                │ Raw Model Response Stream
                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          ALETHEIA AEGIS: RUNTIME SAFETY PLATFORM                                │
│                                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  STAGE 1: Deterministic DFA & Structural Engine (Sub-Millisecond Wire-Speed Gate)          │  │
│  │  • Latency: p95 < 0.02 ms | Throughput: 73,080+ evals/sec | Linear-time ReDoS Immune      │  │
│  │  • S1: Epistemic Grounding             • S4: Literal Trap Context Blindness (Exp.)        │  │
│  │  • S2a: Identity & Credential Fraud    • S5: Prescriptive Medical / Legal Directives      │  │
│  │  • S3: PII & Credential Exfiltration   • S6: Life-Safety & Vulnerability Blindness        │  │
│  │  • S7: Institutional Authority False Attribution                                          │  │
│  └────────────────────────────────────────────┬──────────────────────────────────────────────┘  │
│                                               │                                                 │
│                      ┌────────────────────────┴────────────────────────┐                        │
│                      ▼                                                 ▼                        │
│            [ HARD BLOCK DECISION ]                           [ ALLOW / WARNING FLAG ]           │
│         (S3 Credentials, S6 Harm)                                      │                        │
│         • Immediate Fail-Closed Termination                            ├─────────────────────┐  │
│         • Zero Upstream Judge Dispatch                                 │                     │  │
│         • Zero Data Exfiltration Risk                                  ▼                     ▼  │
│                                                     ┌─────────────────────┐  ┌───────────────┐  │
│                                                     │ Optional Stage 2    │  │ Crossref      │  │
│                                                     │ Semantic Judge      │  │ Registry      │  │
│                                                     │ • Pre-redaction     │  │ (Resolves DOI │  │
│                                                     │ • Anti-injection    │  │  arXiv, PMID) │  │
│                                                     │ • S6 is permanent   │  └───────┬───────┘  │
│                                                     │   hard invariant    │          │          │
│                                                     └──────────┬──────────┘          │          │
│                                                                └──────────┬──────────┘          │
│                                                                           ▼                     │
│                                                     ┌────────────────────────────────────────┐  │
│                                                     │ Enterprise Zero-Leak Audit Telemetry   │  │
│                                                     │ (Metadata & Timing Counts Only)        │  │
│                                                     └─────────────────────┬──────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                            │ Governed Response
                                                                            ▼
                                                              ┌───────────────────────────┐
                                                              │   Authenticated End User  │
                                                              └───────────────────────────┘
```

Aegis enforces a clean separation of concerns:
1. **Deterministic Edge Engine (Wire-Speed Pre-Filter):** Evaluates outputs in **0.019 ms (p95)** on CPU. Irreversible failures—credential leaks (API keys, private keys, database credentials) and life-safety violations (self-harm methods)—trigger an immediate **HARD BLOCK**. Upstream judge models are skipped entirely, saving cost and eliminating payload exfiltration.
2. **Optional Stage 2 Semantic Judge (Cryptographically Pre-Redacted):** For subjective or complex epistemic checks, an external model judge (Anthropic, OpenAI, Gemini) can be called under strict rubrics. Aegis enforces defense-in-depth: **all detected secrets are masked before payload dispatch**, **life-safety findings can never be overruled**, and **heuristic defenses catch reviewer-targeted prompt injections**.

---

## The Aletheia Architecture: Dual-Layer Defense

The Aletheia framework standardizes nine core failure signatures across the modern agentic interaction lifecycle, empirically validated against **2,571 real-world incident records** (AI Incident Database, AVID, MIT AI Risk Repository):

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                           THE ALETHEIA BEHAVIORAL TAXONOMY MATRIX                             │
├───────────┬──────────────────────────────────────┬──────────────────────┬─────────────────────┤
│ Signature │ Category & Risk Surface              │ Runtime Enforcer     │ Enforcement Policy  │
├───────────┼──────────────────────────────────────┼──────────────────────┼─────────────────────┤
│ **S1**    │ Confidence Without Grounding         │ **Aletheia Aegis**   │ `FLAG` (Audit trail)│
│ **S2a**   │ Social / Identity Manipulation       │ **Aletheia Aegis**   │ `FLAG` (Disclaimers)│
│ **S2b**   │ Adversarial Jailbreak & Injection    │ **Aletheia MCP**     │ `BLOCK` (Pre-exec)  │
│ **S3**    │ Action Scope Creep & Data Leakage    │ **Dual-Layer**       │ `BLOCK` (Hard gate) │
│ **S4**    │ Context Blindness & Idiom Traps      │ **Aletheia Aegis**   │ `FLAG` (Heuristic)  │
│ **S5**    │ Unsafe Prescriptive Fallback         │ **Aletheia Aegis**   │ `FLAG` / `BLOCK`    │
│ **S6**    │ Vulnerability Signal Blindness       │ **Aletheia Aegis**   │ `BLOCK` (Invariant) │
│ **S7**    │ Institutional Credibility Spoofing   │ **Aletheia Aegis**   │ `FLAG` (Attribution)│
│ **S8**    │ Feedback Loop & Session Erosion      │ *Session Auditor*    │ *Multi-turn Audit*  │
└───────────┴──────────────────────────────────────┴──────────────────────┴─────────────────────┘
```

### Decoupling Actions from Outputs
To prevent single-point-of-failure vulnerabilities, the Aletheia architecture splits **S3** by operational layer:
- **Action Plane ([aletheia-mcp](https://github.com/vikasny30/aletheia-mcp)):** Guards tool execution (Bash commands, filesystem mutations, database writes, SSRF network calls) *before* execution occurs.
- **Output Plane ([aletheia-aegis](https://github.com/vikasny30/aletheia-aegis)):** Guards generated token streams (SSNs, API keys, credentials, private keys, Luhn-valid cards) *before* presentation to users.

---

## Production SLAs & Benchmarks

Benchmarked in production server environments (`Linux x86_64` and `Apple Silicon`, Node.js 18/20/22):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              PRODUCTION RUNTIME SLA PROFILE                            │
├────────────────────────────────────────┬─────────────────────┬─────────────────────────┤
│ Evaluation Metric                      │ Measured Performance│ Systems Benchmark       │
├────────────────────────────────────────┼─────────────────────┼─────────────────────────┤
│ **p50 Latency (Deterministic Filter)** │ **0.009 – 0.012 ms**│ ~10 microseconds        │
│ **p95 Latency (Deterministic Filter)** │ **0.019 – 0.029 ms**│ Sub-30 microseconds     │
│ **Peak Throughput Capacity**           │ **73,080+ evals/sec**│ Single core, unbatched  │
│ **Concurrent Re-Entrancy Throughput**  │ **4,815+ evals/sec**│ 120 async tasks/event-loop│
│ **Benign False-Positive Rate**         │ **0.0% (0 / 90)**   │ Zero false alarms       │
│ **Evaluated Test Corpus Consistency**  │ **100% (215 / 215)**│ Zero regression         │
│ **Held-Out Corpus Catch Rate**         │ **90.2% (Balanced)**│ Batches 10–11 replayed  │
│ **System Memory Footprint**            │ **<35 MB RSS**      │ Zero native C++ compile │
└────────────────────────────────────────┴─────────────────────┴─────────────────────────┘
```

---

## Signature Enforcement Matrix

Aegis enforces rigorous behavioral guardrails across output failure signatures:

| Signature | Failure Mode | Enforced Rule & Remediation | Action |
|---|---|---|---|
| **S1** | **Confidence Without Grounding** | Catches unhedged specific statistical claims, fabricated citations, unverified DOIs/arXiv/PMIDs. Enables automated scholarly verification via public Crossref registries. | `FLAG` |
| **S2a** | **Social / Identity Manipulation** | Detects unauthorized claims of professional licensure ("As your board-certified oncologist...", "Speaking as your legal counsel..."). | `FLAG` |
| **S3** | **Sensitive Data Exposure (Output)** | Exfiltrated credentials: SSNs (with dash/space/comma separation), credit cards (Luhn-checked with major brand prefixes: Visa, MC, Amex, Discover, JCB, etc.), API keys (`sk-`, Stripe `sk_live_`, AWS, GitHub, Google, SendGrid), JWTs, RSA/EC/SSH private keys, and environment variables (`DB_PASSWORD=...`, `"client_secret": "..."`). *Documented test cards (4242) and sample tokens pass.* | **`BLOCK`** |
| **S4** | **Context Blindness *(Experimental)*** | Pragmatic understanding heuristic: flags literal interpretations of common colloquial idioms ("I could kill him", "Break a leg"). | `FLAG` |
| **S5** | **No Safe State Fallback** | Intercepts prescriptive medical dosages, unhedged pharmaceutical directives, and capability confabulations in fictional languages. | `FLAG` |
| **S6** | **Vulnerability Signal Blindness** | **Self-harm method detail or encouragement.** Permanent hard invariant: cannot be overruled by an LLM judge, and pairing with a crisis hotline does not waive a method. Crisis intent without hotlines generates remediation resources. | **`BLOCK`** / `FLAG` |
| **S7** | **Institutional Amplification** | Flags unverified attribution to authoritative international bodies ("According to official WHO directives...") to prevent disinformation laundering. | `FLAG` |

---

## Data Security & Zero-Leak Guarantee

Aletheia Aegis is engineered under strict **zero data retention** principles:
- **No Response Text in Audit Trails:** Telemetry, audit summaries, and metrics logs never store raw response or prompt strings. Only deterministic verdict counters, signature IDs, and execution timings are recorded.
- **Pre-Judge Secret Masking:** If an optional model judge is enabled, detected credentials, API keys, and SSNs are masked (`********`) *prior* to payload dispatch to external LLM providers.
- **Fail-Closed Hard Block Isolation:** Inputs that trigger a pattern-based `BLOCK` are immediately halted. They are never sent to external model judges, preventing accidental credential exfiltration to third-party endpoints.
- **Verified by Automated Leak Tests:** Validated via `npm run test:leak`, asserting zero trace of canary tokens across server logs, telemetry, and external payloads.

---

## Deployment & Integration

### 1. Fast CLI Verification
Evaluate arbitrary model payloads immediately via `npx`:
```bash
# Verify output against prescriptive medical directives (S5)
npx aletheia-aegis --check "Take 500mg of ciprofloxacin twice daily for 10 days."
# → Returns: FLAG [S5_DOSAGE_WITHOUT_DEFERRAL] (0.024 ms)

# Verify credential leak prevention (S3)
npx aletheia-aegis --check "Database connection: postgres://admin:secretKey987654@db.prod:5432/main"
# → Returns: BLOCK [S3_CREDENTIAL_PAIR] (masked evidence)
```

### 2. Standard MCP Server (Claude Desktop, Cursor, Cline, OpenRouter)
Add to your MCP configuration (`claude_desktop_config.json`):
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

Configuring with an optional Tier-2 Semantic Judge:
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

### 3. Programmatic TypeScript / Node.js SDK
Embed directly inside inference gateways, proxy routers, or API middleware:
```typescript
import { evaluateOutput } from "aletheia-aegis";

const assessment = evaluateOutput({
  response: generatedTokens,
  userPrompt: userQuery,
  locale: "US"
});

if (assessment.verdict === "BLOCK") {
  // Fail-closed gate: reject immediately
  metrics.increment("safety.hard_block", { signature: assessment.findings[0].signature });
  throw new SecurityPolicyException("Generation blocked: " + assessment.explanation);
}

if (assessment.verdict === "FLAG") {
  // Append disclaimers or route to async audit queue
  auditPipeline.logEvent({ findings: assessment.findings, latencyMs: assessment.latencyMs });
}
```

---

## Independent Adversarial Audit & Empirical Validation

Aegis v0.3.0 has undergone **six formal rounds of independent cross-family adversarial testing** conducted by both Claude Sonnet 5.5 and Gemini 3.5 Flash / Antigravity:

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                    Summary of Adversarial Test Cycles                     │
├─────────┬───────────────────┬─────────────────────────────────────────────┤
│ Round   │ Primary Focus     │ Key Hardening Delivered                     │
├─────────┼───────────────────┼─────────────────────────────────────────────┤
│ Round 1 │ Baseline Sweep    │ ReDoS elimination, bounded whitespace       │
│ Round 2 │ Life Safety & S3  │ False-block elimination on supportive care   │
│ Round 3 │ Prepositions & S3 │ Lethal preposition pairing, .env hardening  │
│ Round 4 │ Code Fences & S6  │ CommonMark line scanner, IBAN ISO 13616     │
│ Round 5 │ Boundary Integrity│ Means-safety span separation, Crossref fix  │
│ Round 6 │ MCP & Concurrency │ 1-byte chunk stream framing, re-entrancy    │
└─────────┴───────────────────┴─────────────────────────────────────────────┘
```

- **Held-Out Model Output Evaluation:** Tested against 575 real model outputs across 30+ open and frontier models (Claude Opus/Sonnet, GPT-5/6, Gemini 3.1/3.5, Muse Spark/Wonder). Replay batches 10 and 11 achieve **90.2% catch rate on balanced policy with 1.4% false alarms**, reproducible offline without external API costs via `npm run eval:heldout:judge`.
- **Peer-Reviewed Incident Taxonomy:** Every signature maps directly to published empirical distributions derived from the AI Incident Database (AIID) and AVID.

---

## Operational Boundaries & Threat Model

In production AI safety engineering, transparency regarding detection boundaries is critical:

- **Deterministic Pre-Filter Model:** Aegis is designed as an ultra-fast, first-line wire filter, not a formal semantic parser or proof of completeness. Highly novel or deliberately obfuscated adversarial paraphrases can evade pattern-based heuristics. Aegis catches 90%+ of common and severe failure classes with microsecond overhead, freeing downstream systems to focus on nuanced edge cases.
- **Prose Credential Screening (S3):** To eliminate false alarms on conversational discourse, `CREDENTIAL_IS_RE` requires non-word or complex token characteristics (mixed case, digits, symbols). Single dictionary words ("your password is password") deliberately pass. Card numbers require valid card-brand prefixes and pass Luhn checks. Bank accounts require banking context tokens to avoid blocking utility bills or gym account numbers.
- **Life Safety & Harm Prevention (S6):** Enforces strict verb-preposition lethal pairings to ensure benign crisis de-escalation ("sit on the platform bench while you wait") passes with supportive resources, while lethal placements ("sit on the train tracks") trigger hard blocks. S6 is English-first with core French, German, and Spanish statements of intent.
- **Citation Verification Scope (S1):** The Crossref integration verifies scholarly works (DOI, arXiv, PMID). Legal case citations ("123 F.3d 456") retain their `S1` warning by design, as court registries are outside Crossref's index.
- **Single-Turn vs. Session Guarding (S8):** Aegis operates on individual prompt-response pairs. Systemic multi-turn erosion (S8 Feedback Loop Absence) requires session-level aggregate auditing, which is addressed in the upcoming session auditor architecture.

---

## MCP Tool Reference

Aletheia Aegis exposes 6 standard MCP tools, 4 resources, and 1 prompt template:

### Tools

| Tool Name | Parameters | Description |
|---|---|---|
| `aegis_check_output` | `response` (str), `user_prompt` (str?), `locale` (str?), `block_checks` (str[]?), `judge` (bool?) | Core inspection engine. Returns verdict (`ALLOW`, `FLAG`, `BLOCK`), findings, risk score, and microsecond latency. Deterministic and offline by default. |
| `aegis_verify_citations` | `response` (str) | Resolves DOIs, arXiv IDs, and PMIDs against official public registries. Reports verification status per reference without modifying verdicts. |
| `aegis_run_eval` | `mode` ("guard" \| "corpus"), `casesPath` (str?) | Executes local safety eval harness against 215 labeled cases or classifies an incident JSONL file. |
| `aegis_classify_incident` | `text` (str) | Categorizes unstructured incident reports against the Aletheia taxonomy using the paper's keyword classifier. |
| `aegis_list_signatures` | *none* | Returns comprehensive metadata, maturity levels (`stable` vs `experimental`), and operational mandates across all 9 signatures. |
| `aegis_get_telemetry` | `auditLogLimit` (int?) | Returns live operational telemetry: stage latencies (p50/p95), judge usage, token counts, cost basis, and override statistics. |

### Resources & Prompts
- **`aegis://signatures/all`**: Machine-readable specification of all Aletheia signatures.
- **`aegis://telemetry/summary`**: Aggregated performance and verdict counters.
- **`aegis://telemetry/audit-log`**: Ring buffer of recent inspection events (redacted metadata only).
- **`aegis://eval/last-scorecard`**: Scorecard from the latest evaluation run.
- **Prompt `aegis_output_review`**: Workflow prompt guiding AI models to autonomously remediate flagged outputs into safe, compliant responses.

---

## Configuration & Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AEGIS_BLOCK_CHECKS` | Comma-separated list of check IDs to elevate from `FLAG` to `BLOCK` | `""` |
| `AEGIS_LOCALE` | Regional crisis lifeline localization (`US`, `GB`, `IE`, `CA`, `AU`, `NZ`, `IN`) | `US` |
| `AEGIS_METRICS_LOG` | Path to append-only JSONL operational metrics history file | Unset (off) |
| `AEGIS_JUDGE_PROVIDER` | Optional Tier-2 judge (`anthropic`, `openai`, `google`, `openai-compatible`) | Unset (off) |
| `AEGIS_JUDGE_API_KEY` | API key for the chosen judge provider | Unset |
| `AEGIS_JUDGE_MODEL` | Model identifier for evaluation | Provider default |
| `AEGIS_JUDGE_POLICY` | Evaluation policy (`balanced` protects S6/S3; `strict` joins all flags) | `balanced` |
| `AEGIS_VERIFY_CITATIONS` | Set to `crossref` to enable automated scholarly reference lookups | Unset (off) |
| `AEGIS_DEBUG_LOG` | Path to local debug file (captures payload text for offline debugging) | Unset (off) |

---

## Test Suite & Verification

The repository contains an exhaustive automated test suite executable offline:

```bash
npm install
npm run build              # Compile TypeScript (tsc)
npm test                   # Core unit checks + eval assertions (45 checks)
npm run test:judge         # Model judge, security, and ReDoS tests (121 checks)
npm run test:mcp           # MCP stdio smoke test (13 checks)
npm run test:mcp:adversarial # MCP stdio protocol fuzzing & sandboxing (11 checks)
npm run test:stress        # Concurrency & event-loop re-entrancy stress (120 tasks)
npm run test:leak          # Zero-leak PII/secret exfiltration verification
npm run test:fp            # False-positive sweep on benign discourse (90 cases)
npm run eval               # Full 215-case benchmark evaluation (100% pass)
npm run eval:redteam       # Adversarial paraphrase test suite (90.9% catch)
npm run eval:heldout:judge # Offline replay of held-out batches 10–11
npm run benchmark          # 10,000-iteration microsecond latency benchmark
```

---

## Author & Citation

Aletheia Aegis is authored and architected by **[Vikas Shivpuriya](https://github.com/vikasny30)** as part of the **Aletheia AI Safety Research Core**.

To cite the Aletheia taxonomy, runtime architecture, or empirical findings in research or technical documentation:

```bibtex
@software{shivpuriya2026aegis,
  author       = {Vikas Shivpuriya},
  title        = {Aletheia Aegis: Architecture for Autonomous Agent Safety and Runtime Enforcement},
  year         = {2026},
  publisher    = {GitHub},
  version      = {0.3.0},
  url          = {https://github.com/vikasny30/aletheia-aegis}
}
```

---

## License

Copyright © 2026 Vikas Shivpuriya. Released under the [Apache License, Version 2.0](LICENSE).
