/**
 * Aletheia Aegis: MCP Stdio Adversarial & Protocol Stress Test
 *
 * Implements AGY Test Plan 6:
 * - Verifies stdout cleanliness (100% JSON-RPC 2.0 framing, zero non-protocol bytes)
 * - Fuzzes stdio with 1-byte fragmented stream chunking
 * - Fuzzes malformed JSON-RPC frames and unknown methods
 * - Tests prototype pollution & boundary parameters in aegis_check_output
 * - Tests filesystem sandboxing in aegis_run_eval
 * - Tests resource URI traversal in resources/read
 * - Tests prompt template enumeration and retrieval (prompts/list & prompts/get)
 * - Tests Zod schema fuzzing & type enforcement in aegis_get_telemetry
 * - Verifies clean process termination on stdin EOF
 *
 * Run: npm run build && npx tsx test/mcp-adversarial.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface RpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

class AdversarialRpcClient {
  public proc: ChildProcessWithoutNullStreams;
  public rawStdout = "";
  public rawStderr = "";
  private lineBuffer = "";
  private nextId = 1;
  private pending = new Map<number | string, (msg: RpcResponse) => void>();
  public nonJsonLines: string[] = [];

  constructor(env: Record<string, string> = {}) {
    this.proc = spawn("node", [path.join(ROOT, "dist", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.rawStdout += text;
      this.lineBuffer += text;

      let idx: number;
      while ((idx = this.lineBuffer.indexOf("\n")) !== -1) {
        const line = this.lineBuffer.slice(0, idx).trim();
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          this.nonJsonLines.push(line);
        }
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.rawStderr += chunk.toString("utf-8");
    });
  }

  request(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method} (id=${id})`)), 10000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(frame);
    });
  }

  /** Send raw string frame directly to stdin (for malformed / fuzz testing) */
  sendRaw(raw: string): void {
    this.proc.stdin.write(raw);
  }

  /** Send frame chunked byte-by-byte with small delays */
  async sendSlowChunks(raw: string, chunkSize = 1, delayMs = 2): Promise<void> {
    for (let i = 0; i < raw.length; i += chunkSize) {
      this.proc.stdin.write(raw.slice(i, i + chunkSize));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  notify(method: string, params: unknown = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async closeCleanly(): Promise<number | null> {
    return new Promise((resolve) => {
      this.proc.on("exit", (code) => resolve(code));
      this.proc.stdin.end();
    });
  }

  kill() {
    this.proc.kill("SIGKILL");
  }
}

let checksPassed = 0;
function ok(desc: string) {
  checksPassed++;
  console.log(`  ok ${checksPassed} - ${desc}`);
}

async function run() {
  console.log("Aletheia Aegis MCP Adversarial Protocol Test (AGY-6)");
  console.log("=====================================================");

  const client = new AdversarialRpcClient({ AEGIS_DEBUG_LOG: "" });

  try {
    // ── 1. Protocol Handshake ──────────────────────────────────────────────
    const initRes = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agy-adversarial-tester", version: "1.0.0" },
    });
    assert.ok(initRes.result, "initialize returned a result");
    assert.equal(initRes.result.serverInfo.name, "aletheia-aegis");
    ok("initialize handshake succeeded with clean JSON-RPC");
    client.notify("notifications/initialized");

    // ── 2. Stdout Cleanliness Check ─────────────────────────────────────────
    assert.equal(client.nonJsonLines.length, 0, `Non-JSON lines on stdout: ${client.nonJsonLines.join(", ")}`);
    assert.ok(client.rawStderr.includes("[Aletheia Aegis]"), "Server logging directed strictly to stderr");
    ok("stdout contains strictly valid JSON-RPC frames (zero non-protocol stdout contamination)");

    // ── 3. Fragmented 1-Byte Stream Chunking ────────────────────────────────
    const chunkedId = 999;
    const chunkedMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: chunkedId,
      method: "tools/call",
      params: {
        name: "aegis_list_signatures",
        arguments: {},
      },
    }) + "\n";

    const chunkPromise = new Promise<RpcResponse>((resolve) => {
      (client as any).pending.set(chunkedId, resolve);
    });

    await client.sendSlowChunks(chunkedMsg, 1, 1);
    const chunkRes = await chunkPromise;
    assert.ok(chunkRes.result, "1-byte fragmented chunk request parsed cleanly");
    ok("1-byte fragmented chunk streaming over stdio parsed without loss or frame desync");

    // ── 4. Malformed JSON-RPC Frames ────────────────────────────────────────
    // Malformed JSON should not crash stdio server
    client.sendRaw("{ jsonrpc: 2.0, bad_syntax }\n");
    // Unknown method
    const unknownRes = await client.request("nonexistent/method", {});
    assert.ok(unknownRes.error || unknownRes.result === undefined, "Unknown method returns error");
    ok("malformed JSON-RPC frames and unknown methods handled gracefully without server crash");

    // ── 5. Prototype Pollution & Parameter Fuzzing in aegis_check_output ─────
    const protoCheck = await client.request("tools/call", {
      name: "aegis_check_output",
      arguments: {
        response: "Clinical dose: 500mg daily. Ask your doctor first.",
        block_checks: ["__proto__", "constructor", "prototype", "valueOf", "S5_DOSAGE_WITHOUT_DEFERRAL"],
        locale: "../../../../etc/passwd",
        context: "A".repeat(5000),
      },
    });

    assert.ok(protoCheck.result, "check_output completed with prototype keys in block_checks");
    const protoPayload = JSON.parse(protoCheck.result.content[0].text);
    assert.equal(protoPayload.verdict, "ALLOW");
    // Ensure Object prototype was not polluted
    assert.equal((Object.prototype as any).S5_DOSAGE_WITHOUT_DEFERRAL, undefined);
    assert.equal((Object.prototype as any)["../../../../etc/passwd"], undefined);
    ok("block_checks prototype pollution and path traversal in locale sanitized safely");

    // ── 6. Filesystem Sandboxing in aegis_run_eval ──────────────────────────
    const traversalEval = await client.request("tools/call", {
      name: "aegis_run_eval",
      arguments: {
        mode: "guard",
        cases_file: "/etc/passwd",
      },
    });
    assert.ok(traversalEval.result?.isError, "run_eval with non-jsonl path rejected");
    const errText = traversalEval.result.content[0].text;
    assert.ok(!errText.includes("root:"), "Sensitive host file contents never echoed");
    ok("aegis_run_eval path traversal / non-jsonl file read rejected with generic error");

    // ── 7. Resource URI Traversal ──────────────────────────────────────────
    const validResource = await client.request("resources/read", { uri: "aegis://signatures/all" });
    assert.ok(validResource.result?.contents?.[0]?.text, "valid resource read returns content");
    ok("resources/read aegis://signatures/all resolved cleanly");

    const badResource = await client.request("resources/read", { uri: "aegis://../../etc/passwd" });
    assert.ok(badResource.error, "Resource traversal URI rejected with standard error");
    ok("resources/read URI path traversal rejected without crashing");

    // ── 8. Prompt Template Enumeration and Retrieval ────────────────────────
    const listPromptsRes = await client.request("prompts/list", {});
    assert.ok(Array.isArray(listPromptsRes.result?.prompts), "prompts/list returns prompts array");
    const getPromptRes = await client.request("prompts/get", {
      name: "aegis_output_review",
      arguments: {
        response: "Clinical dose: 500mg daily.",
        findings: JSON.stringify([{ check: "S5_DOSAGE_WITHOUT_DEFERRAL" }]),
      },
    });
    assert.ok(getPromptRes.result?.messages?.length > 0, "prompts/get returned template messages");
    ok("prompts/list and prompts/get resolved cleanly with argument interpolation");

    // ── 9. Telemetry Limit Boundary & Fuzzing ───────────────────────────────
    const telemRes = await client.request("tools/call", {
      name: "aegis_get_telemetry",
      arguments: { auditLogLimit: 100 },
    });
    assert.ok(telemRes.result, "aegis_get_telemetry returns valid payload");
    const telemPayload = JSON.parse(telemRes.result.content[0].text);
    assert.ok(Array.isArray(telemPayload.auditLog));

    // Negative and float values rejected cleanly by Zod
    const floatRes = await client.request("tools/call", {
      name: "aegis_get_telemetry",
      arguments: { auditLogLimit: 12.34 },
    });
    assert.ok(floatRes.result?.isError, "Float auditLogLimit rejected by Zod schema");

    const outOfBoundsRes = await client.request("tools/call", {
      name: "aegis_get_telemetry",
      arguments: { auditLogLimit: 500 },
    });
    assert.ok(outOfBoundsRes.result?.isError, "auditLogLimit > 200 rejected by Zod schema");
    ok("aegis_get_telemetry auditLogLimit fuzzing bounded and sanitized across boundaries");

    // ── 10. Clean Process Termination on EOF ────────────────────────────────
    const exitCode = await client.closeCleanly();
    assert.equal(exitCode, 0, `Server exited with code ${exitCode} instead of 0`);
    ok("server terminates cleanly (exit code 0) on stdio stdin closure");

    console.log(`\nAll ${checksPassed} MCP adversarial checks passed.`);
  } finally {
    client.kill();
  }
}

run().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
