# AGY Test Suite Manifest: Aletheia Aegis Independent Adversarial Testing

This manifest documents all adversarial test plans, empirical test results, summaries, architectural security reports, and automated test runners created during the independent adversarial test cycles (Rounds 1–6) for Aletheia Aegis v0.2.1.

---

## 1. Directory of Test Documents & Artifacts

### Round 1: Baseline & Initial Adversarial Sweep
- **`AGY_TEST_HANDOFF.md`**: Foundational test directives and operating rules for the independent adversarial tester.
- **`AGY_TEST_PLAN.md`**: Initial comprehensive attack plan (S1–S7 detectors, judge stubs, leak verification, slow-regex checks).
- **`AGY_RESULTS.md`**: Round 1 test report documenting the baseline, confirmed issues, and evasions.

### Round 2: Focused Re-Testing of Fixes
- **`AGY_RESULTS_2.md`**: Adversarial re-testing of round 1 fixes; discovered S6 counseling word blocks ("rest your head") and S3 prose credential leakage.
- **`AGY_SUMMARY_2.md`**: Executive summary of round 2 findings.

### Round 3: High-Priority S6 & S3 Deep Dive
- **`AGY_TEST_PLAN_3.md`**: Test plan attacking S6 movement verbs, S3 code context indexing, and Crossref title matching.
- **`AGY_RESULTS_3.md`**: Confirmed critical false blocks on supportive transit ("walk across the bridge to the hospital") and Crossref container overlap inversion.
- **`AGY_SUMMARY_3.md`**: Executive summary of round 3 findings.

### Round 4: Verification of 3d0889e
- **`AGY_TEST_PLAN_4.md`**: Focused attack on Round 3 fixes.
- **`AGY_RESULTS_4.md`**: Confirmed 28/42 false blocks on crisis de-escalation, 4-backtick code fence block bug, and Crossref subtitle subset bypass.
- **`AGY_SUMMARY_4.md`**: Executive summary of round 4 findings.

### Round 5: Verification of 3620a59
- **`AGY_TEST_PLAN_5.md`**: Attack on redesigned S6 verb-preposition pairings, means-safety spans, CommonMark fence scanner, and IBAN.
- **`AGY_RESULTS_5.md`**: Discovered critical means-safety riding exploit ("step off the ledge and go back inside the river" -> ALLOW) and code block plaintext credential exemptions.
- **`AGY_SUMMARY_5.md`**: Executive summary of round 5 findings.

### Architectural & Security Audit
- **`AGY_STRUCTURAL_SECURITY_REPORT.md`** (alias **`AGY_SECURITY_REPORT.md`**): Comprehensive deep dive into the 5 foundational architecture liabilities:
  1. Life-safety de-escalation via regex string-splicing (`clearedByMeansSafety`).
  2. Model judge trust boundary and trivial prompt injection evasion (`JUDGE_INJECTION_RE`).
  3. Cleartext transmission of non-blocked PII/credentials to external LLM providers.
  4. Blanket block-level credential exemptions inside code fences.
  5. Acronym and interrogative token-arithmetic inversion in Crossref matching.

### Round 6: MCP Server Protocol, Stdio Transport, & Integration Hardening
- **`AGY_TEST_PLAN_6.md`**: Master test plan for MCP server layer testing: stdio JSON-RPC 2.0 framing, 1-byte stream chunking, tool parameter fuzzing, filesystem sandboxing, and async re-entrancy.
- **`AGY_RESULTS_6.md`**: Round 6 test results and performance benchmarks on commit `ef3c6b7`.
- **`AGY_SUMMARY_6.md`**: Executive summary of Round 6 findings and protocol invariants.
- **`test/mcp-adversarial.ts`**: Standalone automated test runner executing stdio framing stress, fragmented chunking, prototype pollution sanitization, prompt retrieval, and clean EOF termination.
- **`test/re-entrancy-stress.ts`**: Asynchronous re-entrancy and concurrency test runner executing 120 interleaved tasks across the Node.js event loop to verify shared precompiled RegExp state (`lastIndex`).
- **`test/round6-repro.ts`**: Standalone reproduction runner for all 4 confirmed issues in Round 6.

---

## 2. Git Inclusion Instructions (For Claude / Maintainer)

To commit and push all test plans, test runs, results, reports, and scripts into the repository:

1. **Remove the exclude patterns from `.git/info/exclude`:**
   Open `.git/info/exclude` and remove or comment out the lines listing:
   ```text
   # Remove or comment out these lines:
   handoff.md
   AGY_TEST_HANDOFF.md
   AGY_RESULTS.md
   AGY_TEST_PLAN.md
   AGY_RESULTS_2.md
   AGY_SUMMARY_2.md
   AGY_TEST_PLAN_3.md
   AGY_RESULTS_3.md
   AGY_SUMMARY_3.md
   AGY_TEST_PLAN_4.md
   AGY_RESULTS_4.md
   AGY_SUMMARY_4.md
   AGY_TEST_PLAN_5.md
   AGY_RESULTS_5.md
   AGY_SUMMARY_5.md
   AGY_RESULTS_6.md
   AGY_SUMMARY_6.md
   ```

2. **Stage and commit all AGY artifacts and test scripts:**
   ```bash
   git add AGY_* test/mcp-adversarial.ts test/re-entrancy-stress.ts test/round6-repro.ts
   git commit -m "docs: add independent adversarial test plans, results, security reports, and MCP test suites (Rounds 1-6)"
   git push
   ```

3. **Optionally add npm script shortcuts to `package.json`:**
   ```json
   "scripts": {
     "test:mcp:adversarial": "npm run build && tsx test/mcp-adversarial.ts",
     "test:stress": "tsx test/re-entrancy-stress.ts",
     "test:round6:repro": "tsx test/round6-repro.ts"
   }
   ```
