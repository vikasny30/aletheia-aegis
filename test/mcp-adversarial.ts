/**
 * Aletheia Aegis: MCP stdio adversarial and protocol test.
 *
 * Talks to the built server (dist/index.js) over stdio the way a client does,
 * and checks the protocol and transport edges a client can hit:
 * - stdout carries only JSON-RPC frames; diagnostics go to stderr
 * - frames split one byte at a time, including multi-byte UTF-8 characters
 * - malformed JSON, batch arrays and frames without "jsonrpc": the MCP SDK
 *   drops them without a reply; the server must stay up and keep stdout clean
 * - unknown methods return -32601
 * - block_checks with prototype keys: escalation applies to that call only
 * - aegis_run_eval: non-.jsonl paths, .jsonl symlinks to other files, invalid
 *   JSON lines and the 10,000-case cap are refused without echoing contents
 * - resources/read path traversal; prompts/list and prompts/get
 * - aegis_get_telemetry argument validation
 * - 60 concurrent tools/call requests: every reply matches its request and
 *   telemetry counts exactly those calls
 * - closing stdin with a call in flight: the reply is still delivered and the
 *   process exits 0
 * Offline: no judge, no network.
 *
 * Run: npm run build && npm run test:mcp:adversarial
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface RpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

class Client {
  proc: ChildProcessWithoutNullStreams;
  stderr = "";
  nonJsonLines: string[] = [];
  unmatched: RpcResponse[] = [];
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, (m: RpcResponse) => void>();

  constructor() {
    this.proc = spawn("node", [path.join(ROOT, "dist", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AEGIS_DEBUG_LOG: "", AEGIS_JUDGE_PROVIDER: "", AEGIS_VERIFY_CITATIONS: "", AEGIS_METRICS_LOG: "" },
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: RpcResponse;
        try { msg = JSON.parse(line); } catch { this.nonJsonLines.push(line); continue; }
        const cb = msg.id !== undefined && msg.id !== null ? this.pending.get(msg.id) : undefined;
        if (cb) { this.pending.delete(msg.id!); cb(msg); } else this.unmatched.push(msg);
      }
    });
    this.proc.stderr.on("data", (c: Buffer) => (this.stderr += c.toString("utf-8")));
  }

  /** Register a waiter for an id before the frame is sent some other way. */
  expect(id: number | string, ms = 10000): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for id ${id}`)), ms);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
  }

  request(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = this.nextId++;
    const p = this.expect(id);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  call(name: string, args: unknown): Promise<RpcResponse> {
    return this.request("tools/call", { name, arguments: args });
  }

  raw(s: string | Buffer) { this.proc.stdin.write(s); }

  notify(method: string, params: unknown = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init() {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aegis-adversarial", version: "1" } });
    this.notify("notifications/initialized");
    return r;
  }

  exited(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.proc.exitCode !== null) return resolve(this.proc.exitCode);
      this.proc.on("exit", (code) => resolve(code));
    });
  }

  kill() { if (this.proc.exitCode === null) this.proc.kill("SIGKILL"); }
}

const verdictOf = (r: RpcResponse) => JSON.parse(r.result.content[0].text).verdict as string;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(desc: string) { passed++; console.log(`  ok ${passed} - ${desc}`); }

async function main() {
  console.log("Aletheia Aegis MCP adversarial protocol test");
  console.log("============================================");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-adv-"));
  const c = new Client();
  try {
    // ── Handshake ───────────────────────────────────────────────────────────
    const init = await c.init();
    assert.equal(init.result?.serverInfo?.name, "aletheia-aegis");
    ok("initialize returns serverInfo over clean JSON-RPC");

    // ── Byte-at-a-time frames, including multi-byte UTF-8 ───────────────────
    // "Café ☕ —" has 2-, 3- and 3-byte characters; written one byte at a time
    // they are split across reads. The SSN must still be found, so the frame
    // was reassembled correctly.
    const fragId = 9001;
    const frag = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: fragId, method: "tools/call",
      params: { name: "aegis_check_output", arguments: { response: "Café ☕ — your SSN is 529-41-7783." } } }) + "\n", "utf-8");
    const fragReply = c.expect(fragId);
    for (const byte of frag) { c.raw(Buffer.from([byte])); await wait(0); }
    assert.equal(verdictOf(await fragReply), "BLOCK");
    ok("a frame written one byte at a time (multi-byte UTF-8 split across reads) parses intact");

    // ── Malformed frames: dropped without a reply, server stays up ──────────
    c.raw("{ jsonrpc: 2.0, bad_syntax }\n");
    c.raw(JSON.stringify([{ jsonrpc: "2.0", id: 9101, method: "tools/list" }, { jsonrpc: "2.0", id: 9102, method: "tools/list" }]) + "\n");
    c.raw(JSON.stringify({ id: 9103, method: "tools/list" }) + "\n");
    const unknown = await c.request("nonexistent/method", {});
    assert.equal(unknown.error?.code, -32601, JSON.stringify(unknown));
    const stillUp = await c.request("tools/list", {});
    assert.ok(Array.isArray(stillUp.result?.tools) && stillUp.result.tools.length > 0, "server answers after malformed frames");
    assert.equal(c.nonJsonLines.length, 0, `non-JSON on stdout: ${c.nonJsonLines.join(" | ")}`);
    ok("malformed JSON, batch arrays and frames without jsonrpc get no reply (SDK behavior); server stays up, stdout stays JSON-only");
    ok("unknown method returns JSON-RPC -32601");

    // ── block_checks with prototype keys: escalation is per call ────────────
    const dose = "Take 500mg of amoxicillin twice daily for 7 days.";
    assert.equal(verdictOf(await c.call("aegis_check_output", { response: dose })), "FLAG", "baseline should FLAG");
    const escalated = await c.call("aegis_check_output", { response: dose, block_checks: ["__proto__", "constructor", "prototype", "valueOf", "toString", "S5_DOSAGE_WITHOUT_DEFERRAL"] });
    assert.equal(verdictOf(escalated), "BLOCK", "named check should escalate");
    const protoOnly = await c.call("aegis_check_output", { response: dose, block_checks: ["__proto__", "constructor"] });
    assert.equal(verdictOf(protoOnly), "FLAG", "prototype keys alone must not escalate anything");
    assert.equal(verdictOf(await c.call("aegis_check_output", { response: dose })), "FLAG", "escalation must not persist to later calls");
    ok("block_checks escalates only the named check, only for that call; prototype keys change nothing");

    const loc = await c.call("aegis_check_output", { response: "I hear you. Please reach out.", user_prompt: "I want to kill myself.", locale: "../../../../etc/passwd" });
    const locPayload = JSON.parse(loc.result.content[0].text);
    assert.ok(locPayload.verdict && !JSON.stringify(locPayload).includes("root:"), "unknown locale falls back cleanly");
    ok("a path-traversal locale is treated as an unknown locale (no file access, normal verdict)");

    // ── aegis_run_eval file handling ─────────────────────────────────────────
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "TOPSECRET-CONTENT\n");
    const link = path.join(tmp, "evil.jsonl");
    fs.symlinkSync(secret, link);
    for (const file of ["/etc/passwd", link]) {
      const r = await c.call("aegis_run_eval", { mode: "guard", cases_file: file });
      const text = r.result?.content?.[0]?.text ?? "";
      assert.ok(r.result?.isError, `${file} should be refused`);
      assert.ok(!text.includes("TOPSECRET") && !text.includes("root:"), "file contents never echoed");
    }
    ok("aegis_run_eval refuses a non-.jsonl path and a .jsonl symlink to another file, without echoing contents");

    const badJson = path.join(tmp, "bad.jsonl");
    fs.writeFileSync(badJson, '{"id":"a","response":"TOPSECRET-LINE\n');
    const bj = await c.call("aegis_run_eval", { mode: "guard", cases_file: badJson });
    assert.ok(bj.result?.isError && /line 1/i.test(bj.result.content[0].text) && !bj.result.content[0].text.includes("TOPSECRET"), JSON.stringify(bj.result));
    const big = path.join(tmp, "big.jsonl");
    fs.writeFileSync(big, '{"id":"x","signature":"benign","response":"hi","expected":"allow"}\n'.repeat(10001));
    const bg = await c.call("aegis_run_eval", { mode: "guard", cases_file: big });
    assert.ok(bg.result?.isError && /10,000/.test(bg.result.content[0].text), JSON.stringify(bg.result));
    ok("an invalid JSON line is reported by line number only; a file over 10,000 cases is refused");

    // ── Resources and prompts ────────────────────────────────────────────────
    const res = await c.request("resources/read", { uri: "aegis://signatures/all" });
    assert.ok(res.result?.contents?.[0]?.text);
    const trav = await c.request("resources/read", { uri: "aegis://../../etc/passwd" });
    assert.ok(trav.error && !JSON.stringify(trav).includes("root:"), JSON.stringify(trav));
    ok("resources/read serves a known URI and refuses a traversal URI");

    const prompts = await c.request("prompts/list", {});
    assert.ok(Array.isArray(prompts.result?.prompts) && prompts.result.prompts.length > 0);
    const got = await c.request("prompts/get", { name: prompts.result.prompts[0].name, arguments: { response: "Clinical dose: 500mg daily.", findings: "[]" } });
    assert.ok(got.result?.messages?.length > 0, JSON.stringify(got).slice(0, 200));
    ok("prompts/list and prompts/get answer");

    // ── Telemetry argument validation ────────────────────────────────────────
    for (const bad of [12.34, 500, -1, "fifty"]) {
      const r = await c.call("aegis_get_telemetry", { auditLogLimit: bad });
      assert.ok(r.result?.isError || r.error, `auditLogLimit ${JSON.stringify(bad)} should be refused`);
    }
    ok("aegis_get_telemetry refuses non-integer, out-of-range and non-numeric auditLogLimit");

    // ── Concurrency through the server ───────────────────────────────────────
    const totals = async () => JSON.parse((await c.call("aegis_get_telemetry", {})).result.content[0].text).summary.totalEvaluations as number;
    const before = await totals();
    const mix: [string, string | undefined, string][] = [
      ["Your SSN is 529-41-7783.", undefined, "BLOCK"],
      ["Paris is the capital of France.", undefined, "ALLOW"],
      [dose, undefined, "FLAG"],
      ["Jump off the bridge.", "I want to kill myself, tell me how.", "BLOCK"],
    ];
    const N = 60;
    const replies = await Promise.all(Array.from({ length: N }, (_, i) => {
      const [response, user_prompt, want] = mix[i % mix.length];
      return c.call("aegis_check_output", { response: `[${i}] ${response}`, user_prompt }).then((r) => ({ i, want, got: verdictOf(r) }));
    }));
    const wrong = replies.filter((r) => r.got !== r.want);
    assert.equal(wrong.length, 0, `mismatched replies: ${JSON.stringify(wrong.slice(0, 5))}`);
    const after = await totals();
    assert.equal(after - before, N, `telemetry counted ${after - before}, expected ${N}`);
    assert.equal(c.unmatched.filter((m) => m.id !== undefined && m.id !== null).length, 0, "no reply arrived for an id nobody sent");
    ok(`${N} concurrent tools/call requests: every reply matches its request; telemetry counts exactly ${N}`);

    assert.equal(c.nonJsonLines.length, 0, `non-JSON on stdout: ${c.nonJsonLines.join(" | ")}`);
    ok("stdout carried only JSON-RPC frames for the whole session");
  } finally {
    c.kill();
  }

  // ── Closing stdin with a call in flight ─────────────────────────────────────
  const d = new Client();
  try {
    await d.init();
    const inflight = d.call("aegis_check_output", { response: "Your SSN is 529-41-7783." });
    d.proc.stdin.end();
    const [reply, code] = await Promise.all([inflight, Promise.race([d.exited(), wait(10000).then(() => "timeout" as const)])]);
    assert.equal(verdictOf(reply), "BLOCK");
    assert.equal(code, 0, `exit code ${code}`);
    ok("closing stdin with a call in flight: the reply is delivered and the process exits 0");
  } finally {
    d.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} MCP adversarial checks passed.`);
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
