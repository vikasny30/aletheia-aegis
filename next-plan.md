# Aletheia Aegis: Technical Version Roadmap (v0.4.0 – v1.0.0)

This roadmap outlines the architectural evolution of **Aletheia Aegis** from a standalone sub-millisecond MCP output guard into a ubiquitous, framework-agnostic runtime enforcement standard for autonomous agent pipelines.

---

## Current Baseline (v0.3.0)
- **Engine**: Sub-millisecond (<0.8ms) AST and regex pattern-matching engine running locally with zero LLM in the hot path (~4,800 evals/sec).
- **Enforcement**: Fail-closed detection for leaked secrets (AWS, OpenAI, DB URIs, private keys), tool parameter forgery, prompt-injection echoes, and life-safety triggers.
- **Ecosystem**: Published on npm (`aletheia-aegis@0.3.0`) and the official Model Context Protocol (MCP) registry (`io.github.vikasny30/aletheia-aegis`).
- **Validation**: 120+ adversarial test cases with bundled red-team evaluation harness.

---

## Release Phases

### Phase 1: v0.4.0 — Streaming Inspection & Framework Adapters
**Target Focus**: Drop-in developer ergonomics across popular agent frameworks and real-time streaming tokens.

- [ ] **Streaming Token / Chunk Interceptor**:
  - Implement a sliding-window chunk evaluator (`AegisStreamFilter`) that inspects streaming LLM tokens in flight.
  - Fail-closed immediately upon secret prefix detection (e.g. `AKIA`, `sk-`, `ghp_`) without waiting for full completion.
  - Abort upstream token generation early, saving downstream API compute and reducing time-to-block.
- [ ] **First-Party Framework Adapters**:
  - **Vercel AI SDK Middleware**: Middleware hook for `onFinish` and `transformStream` in `@ai-sdk/openai` / `@ai-sdk/anthropic`.
  - **LangChain / LangGraph Interceptor**: Custom `BaseCallbackHandler` and tool execution middleware for `on_tool_end` and `on_llm_end`.
  - **LlamaIndex Output Transform**: Node post-processor for query engines and tool agents.
- [ ] **Configurable Custom Policy File (`.aegisrc.json`)**:
  - Allow platform teams to add organization-specific regexes (custom internal tokens, domain masks, proprietary API keys).
  - Configurable sensitivity thresholds per signature (`STRICT`, `BALANCED`, `PERMISSIVE`).

---

### Phase 2: v0.5.0 — Deep Structural Analysis & Package Hallucination Defense
**Target Focus**: Intercepting supply-chain attacks and multi-turn state drift in tool arguments.

- [ ] **Package & Dependency Hallucination Detector**:
  - Detect fabricated npm/pip package names in generated code blocks and tool arguments to protect against typosquatting/slopsquatting supply chain attacks.
  - Fast offline Trie lookup of the top 50,000 legitimate package names with Levenshtein-distance fuzzy matching.
- [ ] **Tool Parameter Schema Enforcement**:
  - For MCP clients, intercept outgoing tool calls and validate arguments against the target tool’s declared `inputSchema` using pure Zod/JSON-Schema validation.
  - Block parameter injection and parameter pollution before downstream MCP tools receive requests.
- [ ] **Multi-Turn Context State Tracking**:
  - Track session state across multiple agent steps: flag when an agent attempts to pass an unredacted variable from step $N-1$ into a network tool call in step $N$.

---

### Phase 3: v0.6.0 — OpenTelemetry (OTel) & Production Observability
**Target Focus**: Enterprise runtime visibility, compliance metrics, and SIEM integration.

- [ ] **OpenTelemetry Native Spans**:
  - Emit lightweight OTel spans for every evaluation (`aegis.eval`, duration, verdict `ALLOW` | `BLOCK` | `WARN`, matched signature).
  - Out-of-the-box compatibility with Datadog, Prometheus, Langfuse, Arize Phoenix, and Opik.
- [ ] **Structured Audit Log Pipeline**:
  - Configurable JSONL / syslog egress for security operations center (SOC) audit compliance.
  - Zero raw credential logging: automatically mask matched token entropy before recording telemetry.
- [ ] **Dynamic Ruleset Hot-Reloading**:
  - Support reloading `.aegisrc.json` rules at runtime without restarting the daemon or dropping persistent MCP stdio sessions.

---

### Phase 4: v1.0.0 — Specification Freeze & Enterprise Stability
**Target Focus**: Formal API stability, long-term support (LTS), and benchmark publication.

- [ ] **API Stability Guarantee**:
  - Formal semantic versioning freeze for `@modelcontextprotocol/sdk` integration and TypeScript runtime interfaces.
- [ ] **Zero-Dependency Core Library**:
  - Decouple the detector engine into `@aletheia/aegis-core` (pure JS/TS runtime, 0 external npm dependencies) and `@aletheia/aegis-mcp` (MCP server layer).
- [ ] **Academic & Industry Whitepaper**:
  - Publish the reproducible benchmark whitepaper: *“Deterministic Runtime Output Enforcement: Eliminating the 300ms Guardrail Tax in Autonomous Agents.”*
  - Comprehensive empirical comparison against LLM-as-a-judge approaches (latency, cost, false positive rate).
