/**
 * Aletheia Aegis: per-run eval report.
 *
 * Every eval runner (npm run eval / eval:redteam / eval:heldout) writes one
 * reproducible, content-free report next to its console output: what ran
 * (git commit, Aegis and Node versions, a sha256 of each cases file) and
 * what came out (scorecards, latency, missed and wrongly flagged case ids).
 * Case ids and labels only: no response text, prompt text or evidence.
 *
 * Files: eval/reports/<runner>-<timestamp>.{json,md} plus <runner>-latest.*
 * (git-ignored). AEGIS_EVAL_REPORT_DIR overrides the directory; --no-report
 * skips writing.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardScorecard } from "../src/engine/eval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ScoreSummary {
  name: string;
  casesFile: string;
  casesSha256: string | null;
  note?: string;
  totalCases: number;
  /** Labeled failures (expected flag or block). "Caught" follows
   *  eval/heldout/README.md: the guard said FLAG or BLOCK. A block-labeled
   *  output that only got FLAG is caught but listed in underBlockedIds. */
  failures: { total: number; caught: number; missedIds: string[]; underBlockedIds: string[] };
  /** Labeled good outputs (expected allow) and how many it wrongly flagged or blocked. */
  goodOutputs: { total: number; wronglyFlagged: number; wronglyFlaggedIds: string[] };
  accuracyPercent: number;
  verdicts: { allow: number; flag: number; block: number };
  perSignature: Array<{ signature: string; total: number; caught: number; missedIds: string[] }>;
  latencyMs: { avg: number; p95: number; max: number };
}

export interface EvalReport {
  runner: string;
  generatedAt: string;
  mode: string;
  reproduce: { command: string; gitCommit: string | null; gitDirty: boolean | null; aegisVersion: string; node: string; platform: string };
  scorecards: ScoreSummary[];
  note: string;
}

function sha256(file: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}
function git(args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
}

export function summarize(name: string, score: GuardScorecard, absFile: string, note?: string): ScoreSummary {
  const failures = score.results.filter((r) => r.expected !== "allow");
  const good = score.results.filter((r) => r.expected === "allow");
  const verdicts = { allow: 0, flag: 0, block: 0 };
  for (const r of score.results) verdicts[r.got.toLowerCase() as keyof typeof verdicts]++;
  return {
    name,
    casesFile: path.relative(ROOT, absFile),
    casesSha256: sha256(absFile),
    ...(note ? { note } : {}),
    totalCases: score.totalCases,
    failures: {
      total: failures.length,
      caught: failures.filter((r) => r.got !== "ALLOW").length,
      missedIds: failures.filter((r) => r.got === "ALLOW").map((r) => r.id),
      underBlockedIds: failures.filter((r) => r.expected === "block" && r.got === "FLAG").map((r) => r.id),
    },
    goodOutputs: { total: good.length, wronglyFlagged: good.filter((r) => !r.correct).length, wronglyFlaggedIds: good.filter((r) => !r.correct).map((r) => r.id) },
    accuracyPercent: score.overallAccuracy,
    verdicts,
    perSignature: score.perSignature.map((s) => ({ signature: s.signature, total: s.total, caught: s.caught, missedIds: s.missedIds })),
    latencyMs: { avg: score.latency.avgMs, p95: score.latency.p95Ms, max: score.latency.maxMs },
  };
}

function markdown(r: EvalReport): string {
  const out = [
    `# Aegis eval report: ${r.runner}`,
    "",
    `- Generated: ${r.generatedAt}`,
    `- Mode: ${r.mode}`,
    `- Reproduce: \`${r.reproduce.command}\` at commit \`${r.reproduce.gitCommit ?? "unknown"}\`${r.reproduce.gitDirty ? " (with uncommitted changes)" : ""}; Aegis ${r.reproduce.aegisVersion}, Node ${r.reproduce.node}, ${r.reproduce.platform}`,
    "",
    "| Set | Cases | Failures caught (FLAG or BLOCK) | Good outputs wrongly flagged | Exact-verdict accuracy | p95 latency |",
    "|---|---|---|---|---|---|",
    ...r.scorecards.map((s) => `| ${s.name} | ${s.totalCases} | ${s.failures.caught}/${s.failures.total} | ${s.goodOutputs.wronglyFlagged}/${s.goodOutputs.total} | ${s.accuracyPercent}% | ${s.latencyMs.p95} ms |`),
  ];
  // No pooled row: batches that drove detector fixes overstate performance,
  // so held-out sets are reported one by one (see test/run-heldout.ts).
  out.push("");
  for (const s of r.scorecards) {
    const missed = s.failures.missedIds, wrong = s.goodOutputs.wronglyFlaggedIds, under = s.failures.underBlockedIds;
    if (!missed.length && !wrong.length && !under.length) continue;
    out.push(`- **${s.name}**: missed ${missed.length ? missed.join(", ") : "none"}; wrongly flagged ${wrong.length ? wrong.join(", ") : "none"}${under.length ? `; caught but FLAG where the label says block: ${under.join(", ")}` : ""}`);
  }
  out.push("", "\"Caught\" follows eval/heldout/README.md: FLAG or BLOCK on an output labeled flag or block. Exact-verdict accuracy additionally requires BLOCK where the label says block (the bundled eval's rule).");
  out.push("", `Cases files are pinned by sha256 in the JSON report. Latency here is from one cold run (JIT warm-up included); \`npm run benchmark\` is the latency number. ${r.note}`, "");
  return out.join("\n");
}

export function writeEvalReport(runner: string, command: string, scorecards: ScoreSummary[], mode = "patterns (deterministic detectors; no judge, no Crossref)"): string | null {
  if (process.argv.includes("--no-report")) return null;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const status = git(["status", "--porcelain"]);
  const report: EvalReport = {
    runner,
    generatedAt: new Date().toISOString(),
    mode,
    reproduce: { command, gitCommit: git(["rev-parse", "--short", "HEAD"]), gitDirty: status === null ? null : status.length > 0, aegisVersion: pkg.version, node: process.version, platform: `${process.platform}-${process.arch}` },
    scorecards,
    note: "Case ids and labels only; no response text. Catch and false-positive rates are measured against hand labels; see eval/heldout/README.md for how batches were labeled.",
  };
  const dir = process.env.AEGIS_EVAL_REPORT_DIR || path.join(ROOT, "eval", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const json = JSON.stringify(report, null, 2) + "\n", md = markdown(report);
  for (const [name, body] of [[`${runner}-${stamp}.json`, json], [`${runner}-${stamp}.md`, md], [`${runner}-latest.json`, json], [`${runner}-latest.md`, md]]) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  const shown = path.relative(process.cwd(), path.join(dir, `${runner}-${stamp}.md`));
  console.log(`\nReport: ${shown} (and .json; ${runner}-latest.* updated)`);
  return path.join(dir, `${runner}-${stamp}.json`);
}
