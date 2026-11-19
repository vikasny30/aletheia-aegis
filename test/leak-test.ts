/**
 * Aletheia Aegis: content-leak test for telemetry and measurement.
 *
 * Spawns the built server (dist/index.js) with the JSONL metrics history on
 * and a local stub judge (openai-compatible on 127.0.0.1) whose reason echoes
 * the reply's email back. Sends replies holding a fake SSN, an API key and an
 * email through aegis_check_output, then searches every place measurement
 * writes for those values: aegis_get_telemetry (summary + audit log), the
 * JSONL history file and the server's stderr. Pass bar: zero hits.
 * Also asserts the BLOCKed replies (SSN, key) never reached the judge.
 *
 * Run: npm run build && npm run test:leak
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SSN = "529-41-7783";
const KEY = "sk-proj-9fK2mQ7xLp4Rt8vW1zYb3nC6";
const EMAIL = "jane.doe.leaktest@example.org";
// Whole values plus fragments a partial leak would still show.
const NEEDLES = [SSN, "529417783", "7783", KEY, "9fK2mQ7xLp4R", EMAIL, "jane.doe.leaktest", "leaktest@"];

const judgeBodies: string[] = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    judgeBodies.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ label: "flag", signatures: ["S1"], reason: `Unverified claim; also mentions ${EMAIL}.` }) } }],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    }));
  });
});
await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
const port = (stub.address() as { port: number }).port;

const dir = mkdtempSync(path.join(tmpdir(), "aegis-leak-"));
const history = path.join(dir, "history.jsonl");
const proc = spawn("node", [path.join(ROOT, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    AEGIS_METRICS_LOG: history,
    AEGIS_JUDGE_PROVIDER: "openai-compatible",
    AEGIS_JUDGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    AEGIS_JUDGE_API_KEY: "stub-key",
    AEGIS_JUDGE_MODEL: "stub-model",
    AEGIS_JUDGE_PRICE_INPUT_PER_MTOK: "0.25",
    AEGIS_JUDGE_PRICE_OUTPUT_PER_MTOK: "2",
    AEGIS_DEBUG_LOG: "",
  },
});
let stderr = "";
proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
let buffer = "";
const pending = new Map<number, (m: any) => void>();
proc.stdout.on("data", (c: Buffer) => {
  buffer += c.toString();
  let i: number;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
let nextId = 1;
function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name: string, args: unknown) => JSON.parse((await request("tools/call", { name, arguments: args })).content[0].text);

let failed = 0;
function expect(cond: boolean, msg: string) {
  if (cond) console.log(`  ok - ${msg}`);
  else { failed++; console.error(`  FAIL - ${msg}`); }
}
const hits = (where: string) => NEEDLES.filter((n) => where.includes(n));

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "leak-test", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  const ssn = await call("aegis_check_output", { response: `Your SSN on file is ${SSN}.`, user_prompt: `My email is ${EMAIL}; what is my SSN?` });
  const key = await call("aegis_check_output", { response: `Sure, here's the config: OPENAI_API_KEY=${KEY}` });
  const mail = await call("aegis_check_output", { response: `Write to ${EMAIL}. Chen et al. (2020), Sleep Medicine, showed a 34.7% drop in melatonin.`, user_prompt: `Ask ${EMAIL} about it` });
  expect(ssn.verdict === "BLOCK" && key.verdict === "BLOCK", `SSN and key replies BLOCK (${ssn.verdict}, ${key.verdict})`);
  expect(mail.mode === "patterns+judge", `email reply went to the judge (${mail.mode})`);

  const tel = await call("aegis_get_telemetry", { auditLogLimit: 50 });
  const m = tel.summary.measurement;
  expect(m.judge.skippedHardBlock === 2 && m.judge.calls === 1, `measurement counted 2 hard-block skips and 1 judge call (${m.judge.skippedHardBlock}, ${m.judge.calls})`);
  expect(m.judge.tokens.input === 900 && m.judge.estimatedCostUsd !== null, "tokens and cost estimate recorded");

  const telHits = hits(JSON.stringify(tel));
  expect(telHits.length === 0, `aegis_get_telemetry (summary + audit log) has no leaked values${telHits.length ? `: ${telHits.join(", ")}` : ""}`);
  const lines = existsSync(history) ? readFileSync(history, "utf8") : "";
  expect(lines.trim().split("\n").length === 3, "JSONL history has one line per check");
  const fileHits = hits(lines);
  expect(fileHits.length === 0, `JSONL history has no leaked values${fileHits.length ? `: ${fileHits.join(", ")}` : ""}`);
  expect(!lines.includes(dir) && !JSON.stringify(tel).includes(dir), "history path is not echoed");
  const errHits = hits(stderr);
  expect(errHits.length === 0, `server stderr has no leaked values${errHits.length ? `: ${errHits.join(", ")}` : ""}`);
  const sent = judgeBodies.join("\n");
  expect(judgeBodies.length === 1 && !sent.includes(SSN) && !sent.includes(KEY), `BLOCKed replies never reached the judge (${judgeBodies.length} request(s))`);
} finally {
  proc.kill();
  stub.close();
}

console.log(failed ? `\n${failed} leak check(s) failed.` : "\nLeak test passed: zero hits.");
process.exit(failed ? 1 : 0);
