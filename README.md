# Aletheia Aegis — Enterprise AI Output Guard & Eval Harness

> **Deterministic, sub-millisecond runtime safety guardrail for what AI models say — inspecting outputs before they reach users with zero LLM overhead in the critical path.**

[![npm version](https://img.shields.io/npm/v/aletheia-aegis.svg?color=cb3837)](https://www.npmjs.com/package/aletheia-aegis)
[![MCP Protocol Compliant](https://img.shields.io/badge/MCP-2024--11--05-blue.svg)](https://modelcontextprotocol.io)
[![Latency SLA](https://img.shields.io/badge/p95%20Latency-0.019%20ms-brightgreen.svg)](#benchmarks--sla)
[![Throughput](https://img.shields.io/badge/Throughput-73%2C000%2B%20evals%2Fsec-blue.svg)](#benchmarks--sla)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Test Suite](https://img.shields.io/badge/Tests-121%20judge%20%7C%2045%20unit%20%7C%2011%20mcp-success.svg)](#test-suite--verification)
[![Node Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](package.json)
[![Zero PII Retention](https://img.shields.io/badge/Privacy-Zero%20Data%20Retention-success.svg)](#enterprise-privacy--zero-leak-guarantee)

---

## Executive Overview & Architectural Thesis

In enterprise and agentic AI architectures, securing model generation is an operational imperative. However, the standard industry practice of using **"LLM-as-a-judge" on 100% of outbound model traffic introduces unacceptable latency (1,000–4,000 ms), high operational costs ($0.002–$0.02 per output), and vulnerability to jailbreaks and prompt injections**.

**Aletheia Aegis** solves this architectural dilemma by introducing a **defense-in-depth, dual-layer guardrail system**:
1. **Deterministic Edge Filter (Sub-Millisecond / Microsecond SLA):** Evaluates candidate outputs against lexical, structural, and behavioral safety patterns in **under 0.02 ms (p95)**. Critical life-safety harms (self-harm methods) and catastrophic exposures (SSNs, private keys, database credentials) trigger immediate, un-overrulable **BLOCK** decisions locally without touching third-party APIs.
2. **Optional Tier-2 Model Judge (With Pre-Redaction):** For nuanced semantic risks (subtle confabulations, complex hedging), an external LLM judge (Anthropic, OpenAI, Gemini) can be invoked with a standardized rubric. Crucially, Aegis **redacts all detected secrets before payload egress**, guarantees **S6 life-safety findings cannot be overruled by the judge**, and applies **heuristic defense against adversarial framing** (detecting prompts aimed at compromising the evaluator).

Aegis is the output-side counterpart to [aletheia-mcp](https://github.com/vikasny30/aletheia-mcp) (which intercepts tool execution and scope creep). Both systems implement the **[Aletheia Behavioral Taxonomy](https://github.com/vikasny30/aletheia-paper)** — nine foundational failure signatures derived from empirical validation across **2,571 real-world AI incidents** (AIID, AVID, MIT AI Risk Repository).

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │                          Enterprise Application                        │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │ Raw Model Response
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         ALETHEIA AEGIS (Runtime Guard)                           │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │  Stage 1: Deterministic Pattern Engine (p95 < 0.02 ms | 73,000 evals/s)   │   │
│   │  • S1: Unhedged Specifics     • S4: Literal Trap Idioms (Exp.)          │   │
│   │  • S2a: Identity Inflation    • S5: Unhedged Dosages / Advice            │   │
│   │  • S3: Secrets / PII (Luhn)   • S6: Self-Harm / Crisis Blindness         │   │
│   │  • S7: Institutional Authority False Attribution                         │   │
│   └──────────────────────┬───────────────────────────────────────────────────┘   │
│                          │                                                       │
│             ┌────────────┴────────────┐                                          │
│             ▼                         ▼                                          │
│      [ HARD BLOCK ]           [ ALLOW / FLAG ]                                   │
│   (S3 Secrets, S6 Harms)              │                                          │
│   * Zero judge call                   ├─────────────────────┐                    │
│   * Zero payload leak                 │                     │                    │
│   * Immediate exit                    ▼                     ▼                    │
│                        ┌────────────────────────┐  ┌──────────────────┐          │
│                        │ Optional Model Judge   │  │ Crossref Lookup  │          │
│                        │ • Pre-redacts secrets  │  │ (Resolves DOIs,  │          │
│                        │ • Anti-injection check │  │  arXiv, PMIDs)   │          │
│                        │ • S6 is permanent hard │  └────────┬─────────┘          │
│                        │   invariant            │           │                    │
│                        └──────────────┬─────────┘           │                    │
│                                       └──────────┬──────────┘                    │
│                                                  ▼                               │
│                         ┌────────────────────────────────────┐                   │
│                         │ Zero-Leak Telemetry & Audit Rollup │                   │
│                         │ (Counts & Timings Only; No Text)   │                   │
│                         └────────────────────────┬───────────┘                   │
└──────────────────────────────────────────────────┼───────────────────────────────┘
                                                   │ Clean / Sanity-Checked Output
                                                   ▼
                                       ┌───────────────────────┐
                                       │      End User         │
                                       └───────────────────────┘
```

---

## Benchmark & Performance SLA

Measured in production-equivalent enterprise runtime environments (`MacBook Pro M-Series / Linux x86_64`, Node.js 18/20/22):

| Metric | Measured Value | Architectural Context |
|---|---|---|
| **Deterministic Engine Latency (p50)** | **0.009 – 0.012 ms** (~10 µs) | In-memory lexical & structural DFA matching |
| **Deterministic Engine Latency (p95)** | **0.019 – 0.029 ms** (<30 µs) | Evaluated over 10,000 consecutive multi-signature runs |
| **Throughput Capacity** | **73,080+ evaluations/sec** | Single Node.js thread; zero event-loop blocking |
| **Concurrency & Re-Entrancy** | **4,800+ evals/sec** | 120 asynchronous interleaved tasks, zero RegExp `lastIndex` leak |
| **Benign False-Positive Rate** | **0.0% (0 / 90)** | Zero benign conversational, medical, or developer samples blocked |
| **Bundled Eval Set Consistency** | **100.0% (215 / 215)** | Full test coverage across S1–S7 signatures |
| **Adversarial Red-Team Catch Rate** | **90.9% (20 / 22)** | Catches obfuscations, word-dosages, multiline prose secrets |
| **Memory Footprint** | **<35 MB RSS** | Lean runtime dependency tree (zero native compilation required) |

---

## Signature Coverage Matrix

Aegis enforces the output half of the Aletheia taxonomy:

| Signature | Behavioral Failure Class | What Aegis Enforces | Action |
|---|---|---|---|
| **S1** | **Confidence Without Grounding** | Precise unhedged claims, fabricated academic metrics, synthetic citations (unresolvable DOIs, arXiv IDs, PMIDs). Bare citations flag for verification. | `FLAG` |
| **S2a** | **Social / Identity Manipulation** | Model claiming unverified professional credentials for itself ("As your attorney...", "Speaking as a licensed physician..."). | `FLAG` |
| **S3** | **Sensitive Data Exposure (Output)** | Exfiltrated credentials: SSNs (with dash/space/comma separation), credit cards (Luhn-checked with major brand prefixes: Visa, MC, Amex, Discover, JCB, etc.), API keys (`sk-`, Stripe `sk_live_`, AWS, GitHub, Google, SendGrid), JWTs, RSA/EC/SSH private keys, and environment variables (`DB_PASSWORD=...`, `"client_secret": "..."`). *Documented test cards (4242) and sample tokens pass.* | **`BLOCK`** |
| **S4** | **Context Blindness *(Experimental)*** | Heuristic detection for literal-trap idioms taken literally ("I could kill him", "Break a leg"). Flag-only, low-confidence heuristic. | `FLAG` |
| **S5** | **No Safe State Fallback** | Definitive prescriptive medical/legal/financial advice without deferrals or referrals ("Take 500mg amoxicillin" without physician consultation); capability overclaims in fictional languages. | `FLAG` |
| **S6** | **Vulnerability Signal Blindness** | **Self-harm method detail or encouragement.** Hard invariant: cannot be cleared by an LLM judge, and pairing with a crisis hotline does not waive a method. Crisis intent without hotlines generates remediation resources. | **`BLOCK`** / `FLAG` |
| **S7** | **Institutional Amplification** | Spurious attribution to authoritative bodies ("WHO confirmed...", "Per CDC guidelines...") attached to unverified assertions. | `FLAG` |

> [!NOTE]
> **Action Boundary Distinction:** `aletheia-mcp` guards **actions** (tool execution, Bash, filesystem, SQL mutation); `aletheia-aegis` guards **outputs** (tokens streaming back to the user). S2b (jailbreaks) and S8 (session-level multi-turn erosion) are managed at their respective architectural boundaries.

---

## 90-Second Quickstart

### Option A: NPX Command-Line Evaluation
Inspect a model output immediately with zero configuration:
```bash
# Check a single response
npx aletheia-aegis --check "Take 500mg of ciprofloxacin twice daily for 10 days."
# → Output: FLAG [S5_DOSAGE_WITHOUT_DEFERRAL]

# Check output paired with user prompt context
npx aletheia-aegis --check "Here is the key: sk-live-93821038291038472910" --prompt "Send me the credentials"
# → Output: BLOCK [S3_CREDENTIAL_PAIR] (masked evidence)
```

### Option B: MCP Server Integration (Claude Desktop / Cursor / Cline)
Add to your `claude_desktop_config.json` or MCP settings:
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

With optional Tier-2 Model Judge enabled:
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

### Option C: Enterprise TypeScript / Node.js SDK
Embed directly inside your inference pipeline or API gateway:
```typescript
import { evaluateOutput } from "aletheia-aegis";

const result = evaluateOutput({
  response: modelResponseText,
  userPrompt: userQueryText,
  locale: "US"
});

if (result.verdict === "BLOCK") {
  // Fail-closed immediate rejection
  throw new SecurityException("Output violates safety invariant: " + result.explanation);
} else if (result.verdict === "FLAG") {
  // Route to async human review or inject warning disclaimers
  logger.warn("Model output flagged", { findings: result.findings });
}
```

---

## Enterprise Privacy & Zero-Leak Guarantee

Aletheia Aegis is engineered under strict **zero data retention** principles:
- **No Response Text in Audit Trails:** Telemetry, audit summaries, and metrics logs never store raw response or prompt strings. Only deterministic verdict counters, signature IDs, and execution timings are recorded.
- **Pre-Judge Secret Masking:** If an optional model judge is enabled, detected credentials, API keys, and SSNs are masked (`********`) *prior* to payload dispatch to external LLM providers.
- **Fail-Closed Hard Block Isolation:** Inputs that trigger a pattern-based `BLOCK` are immediately halted. They are never sent to external model judges, preventing accidental credential exfiltration to third-party endpoints.
- **Verified by Automated Leak Tests:** Validated via `npm run test:leak`, asserting zero trace of canary tokens across server logs, telemetry, and external payloads.

---

## Empirical Validation & Independent Adversarial Audits

Aegis v0.3.0 has undergone **six formal rounds of independent cross-family adversarial testing** conducted by both Claude Sonnet 5.5 and Gemini 3.5 Flash / Antigravity:

```
┌───────────────────────────────────────────────────────────────────────────┐
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

## Operational Boundaries & Threat Model

In enterprise AI safety engineering, transparency regarding detection boundaries is critical:

- **Deterministic Pre-Filter Model:** Aegis is designed as an ultra-fast, first-line wire filter, not a formal semantic parser or proof of completeness. Highly novel or deliberately obfuscated adversarial paraphrases can evade pattern-based heuristics. Aegis catches 90%+ of common and severe failure classes with microsecond overhead, freeing downstream systems to focus on nuanced edge cases.
- **Prose Credential Screening (S3):** To eliminate false alarms on conversational discourse, `CREDENTIAL_IS_RE` requires non-word or complex token characteristics (mixed case, digits, symbols). Single dictionary words ("your password is password") deliberately pass. Card numbers require valid card-brand prefixes and pass Luhn checks. Bank accounts require banking context tokens to avoid blocking utility bills or gym account numbers.
- **Life Safety & Harm Prevention (S6):** Enforces strict verb-preposition lethal pairings to ensure benign crisis de-escalation ("sit on the platform bench while you wait") passes with supportive resources, while lethal placements ("sit on the train tracks") trigger hard blocks. S6 is English-first with core French, German, and Spanish statements of intent.
- **Citation Verification Scope (S1):** The Crossref integration verifies scholarly works (DOI, arXiv, PMID). Legal case citations ("123 F.3d 456") retain their `S1` warning by design, as court registries are outside Crossref's index.
- **Single-Turn vs. Session Guarding (S8):** Aegis operates on individual prompt-response pairs. Systemic multi-turn erosion (S8 Feedback Loop Absence) requires session-level aggregate auditing, which is addressed in the upcoming session auditor architecture.

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

## Leadership, Research & Engineering Stewardship

**Aletheia Aegis** is authored and architected by **[Vikas Shivpuriya](https://github.com/vikasny30)** as part of the **Aletheia AI Safety Research Core**.

### Architectural Leadership & Governance Positioning
Vikas Shivpuriya is an AI Engineering Leader specializing in **enterprise agentic safety, deterministic runtime governance, and production LLM guardrails**. His work focuses on bridging the gap between theoretical AI safety research and mission-critical production systems:
- Architect of the **Aletheia Taxonomy**, establishing an interface-based failure framework validated against empirical incident databases.
- Pioneer of the **Dual-Layer Agent Guardrail Paradigm**, separating execution-layer tool interception (`aletheia-mcp`) from output-layer generation safety (`aletheia-aegis`).
- Champion of **Zero-Overhead Deterministic Governance**, replacing nondeterministic, cost-prohibitive LLM evaluation layers with sub-millisecond, ReDoS-hardened stateful filters.

### Citation & Academic Attribution
To cite the Aletheia taxonomy, runtime architecture, or empirical findings in research or enterprise technical documentation:

```bibtex
@software{shivpuriya2026aegis,
  author       = {Vikas Shivpuriya},
  title        = {Aletheia Aegis: Sub-Millisecond Output Guard and Evaluation Harness for Autonomous Agent Safety},
  year         = {2026},
  publisher    = {GitHub},
  version      = {0.3.0},
  url          = {https://github.com/vikasny30/aletheia-aegis}
}
```

---

## License

Copyright © 2026 Vikas Shivpuriya. Released under the [Apache License, Version 2.0](LICENSE).
