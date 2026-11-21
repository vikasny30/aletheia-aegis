# AGY Test Plan 6: MCP Server Protocol, Transport, and Integration Hardening

A comprehensive adversarial test plan for Aletheia Aegis operating as a **Model Context Protocol (MCP)** stdio server. This suite tests the system at the MCP protocol and transport layers, stress-testing JSON-RPC 2.0 framing, tool parameter fuzzing, filesystem sandbox boundaries, asynchronous re-entrancy / regex race conditions, and outbound resolver resilience.

---

## 1. Baseline Verification

All standard regression suites must pass before commencing MCP stress tests:

| Command | Expected |
|---|---|
| `npm test` | 45 passed |
| `npm run test:judge` | 109+ passed |
| `npm run test:mcp` | 13 passed |
| `npm run test:leak` | zero hits |
| `npm run test:parity`, `npm run test:fp` | pass; 0 blocked, 0 flagged |
| `npm run eval` | 215 cases, 100% |
| `npm run eval:redteam` | 22 cases, 86.4% |
| `npm run eval:heldout:judge` | 0 API calls; balanced: batch10 20/20, batch11 26/31 |
| `npm run benchmark` | p95 sub-millisecond |

---

## 2. MCP Protocol & Stdio Transport Hardening

Because Aegis connects to IDEs and clients (Claude Desktop, Zed, Cursor, VS Code) over `stdio`, framing violations crash or stall the host client.

1. **Stdout Cleanliness Invariant (Zero Non-Protocol Output):**
   - In MCP stdio transport, `stdout` belongs strictly and exclusively to JSON-RPC 2.0 frames.
   - Any log message, debug trace, warning, or unhandled rejection written to `stdout` corrupts client JSON-RPC parsers.
   - **Attack:** Run every tool, resource, and prompt with debug enabled, invalid arguments, and edge cases. Verify that **100% of diagnostic output, server banners, and error traces write exclusively to `stderr`**, and `stdout` contains only well-formed JSON-RPC.
2. **Buffer Chunking & Fragmented Stdio Streams:**
   - Stream valid JSON-RPC requests to the server's `stdin` in adversarial chunks:
     - 1 byte per chunk with microsecond pauses.
     - Multi-byte UTF-8 sequences split across read buffers (e.g. splitting emoji or non-ASCII characters).
     - Multiple newline-delimited requests packed into a single chunk.
   - Verify the server reassembles frames without dropping requests or desynchronizing.
3. **Malformed JSON-RPC & Fuzzing:**
   - Send malformed JSON (`{"jsonrpc": "2.0", "method": ...`), missing `jsonrpc` version, missing request `id`, non-existent methods (`tools/unknown`), and batch requests (`[{...}, {...}]`).
   - Verify the server returns standard JSON-RPC 2.0 error objects (`-32700 Parse error`, `-32600 Invalid Request`, `-32601 Method not found`) and never throws an uncaught exception.
4. **Lifecycle & Pipe Closures:**
   - Close `stdin` abruptly while tool executions are pending.
   - Verify the server process exits cleanly with exit code `0` and leaves no orphaned asynchronous timers or child workers.

---

## 3. Tool Boundary Fuzzing & Injection

Target every exposed tool via `tools/call`:

1. **`aegis_check_output` Boundary Testing:**
   - **Response Size & Adversarial Unicode:** Test 1,000,000-character inputs containing RTL overrides (`\u202E`), zero-width spaces (`\u200B`), non-printable ASCII, and unpaired surrogate characters.
   - **Prototype Pollution via `block_checks`:** Send arrays containing prototype properties: `["__proto__", "constructor", "prototype", "valueOf"]`. Verify that `OutputEvaluator` sets do not pollute Object prototypes.
   - **Locale Path Traversal:** Pass `locale: "../../../../etc/passwd"`, `locale: "US\0GB"`, and unregistered locales (`locale: "qaa-Qaaa-QM"`). Verify clean fallback to US resources without filesystem errors.
   - **Context Parameter Flooding:** Pass 200,000 characters of arbitrary context. Verify no memory leaks and zero secret exposure in telemetry.
2. **`aegis_classify_incident`:**
   - Send 1,000,000 characters of repeated punctuation, whitespace, and Unicode text. Verify linear execution time and bounded hit scoring.
3. **`aegis_get_telemetry`:**
   - Fuzz `auditLogLimit` with `0`, `-1`, `NaN`, `1000000`, `"fifty"`. Verify strict Zod validation rejects bad types with standard MCP error objects.

---

## 4. Filesystem Boundaries & Eval Sandbox (`aegis_run_eval`)

`aegis_run_eval` accepts user-supplied paths (`cases_file` and `corpus_file`).

1. **Path Traversal & Symlink Escape:**
   - Attempt to pass paths outside the repo:
     - `/etc/passwd` (should fail `.jsonl` extension check).
     - A `.jsonl` symlink pointing to `/etc/shadow`, `.env`, or `~/.ssh/id_rsa`.
     - `eval/../../../../var/log/system.log`.
     - Internal sensitive `.jsonl` files (e.g. `cases_file: "metrics.jsonl"`).
   - Verify `checkEvalFile()` strictly enforces that the real path exists, is a regular file, is under 50 MB, and ends in `.jsonl`.
2. **Malformed JSONL & Allocation Bomb:**
   - Pass `.jsonl` files containing:
     - Lines with invalid JSON (verify error message does not quote file contents).
     - Single lines exceeding 10 MB.
     - Files with more than 10,000 lines (verify `MAX_CASES` bound halts execution cleanly).

---

## 5. Asynchronous Re-entrancy & Shared Regex State

In production, multiple tools or client sessions invoke Aegis concurrently over the Node.js event loop.

1. **Shared Precompiled RegExp `lastIndex` Race Conditions:**
   - Multiple detectors reuse module-level precompiled regexes with the `/g` and `/gi` flags (`API_KEY_RES`, `BANK_ACCOUNT_LABELED_RE`, `SSN_RE`, `IBAN_RE`, `CREDENTIAL_PAIR_RE`).
   - `evaluateEnhanced()` is **asynchronous** (awaits Crossref and Judge network calls).
   - If Request A pauses on an `await`, Request B enters `evaluate()`.
   - **Attack:** Fire 100 concurrent asynchronous tool calls with interleaved credential, PII, and crisis inputs.
   - Verify that concurrent evaluations do NOT experience `lastIndex` state corruption, race conditions, or dropped detections.
2. **In-Memory Telemetry Ring Buffer Thread-Safety:**
   - Concurrently flood `telemetry.record()` and `aegis_get_telemetry` to verify `records.shift()` and `pushCapped()` maintain integrity under asynchronous load.

---

## 6. Outbound Citation Verification Resilience (`aegis_verify_citations`)

1. **SSRF & Resolver Redirection:**
   - Submit text containing crafted DOIs that redirect to:
     - `http://127.0.0.1:8080/`
     - `http://169.254.169.254/latest/meta-data/`
     - `http://10.0.0.1/`
   - Verify that `redirect: "manual"` strictly rejects following redirects across all resolvers (`doi.org`, `arxiv.org`, NCBI).
2. **Rate Limit Backoff & Global Budget:**
   - Simulate 429 rate limit responses and socket timeouts using a local HTTP stub.
   - Verify `LOOKUP_BUDGET_MS` (20,000 ms) strictly bounds total execution time, marking remaining items `"unverifiable"` without hanging the MCP server.

---

## 7. Resources & Prompts Spec Conformance

1. **MCP Resources (`resources/list` & `resources/read`):**
   - Read all registered URIs:
     - `aegis://signatures/all`
     - `aegis://telemetry/summary`
     - `aegis://eval/last-scorecard`
   - Test invalid & traversal URIs:
     - `aegis://../../etc/passwd`
     - `aegis://telemetry/unknown`
     - `file:///etc/passwd`
   - Verify `ReadResourceRequestSchema` throws clean MCP errors without crashing the server.
2. **MCP Prompts (`prompts/list` & `prompts/get`):**
   - Enumerate all prompt templates.
   - Call `prompts/get` with missing and adversarial arguments.

---

## Test Deliverables

1. Automated Test Runner: `test/mcp-adversarial.ts`
2. Concurrent Stress Runner: `test/re-entrancy-stress.ts`
3. Results Report: `AGY_RESULTS_6.md`
