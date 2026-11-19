/**
 * Aletheia Aegis: judge verdicts for held-out runs, replayed from disk.
 *
 * Held-out judge numbers must be reproducible without calling a provider
 * again: the judge's answer for each case is committed in
 * eval/heldout/second-labeler/<batch>-judge-verdicts-<model>.jsonl
 * ({id, label, signatures, reason, latencyMs}). ReplayJudge answers from those
 * files, so current pattern code, policies and the hard-block rule are scored
 * against the judge's recorded answers at zero API cost. With `live`, a case
 * with no recorded answer goes to the real provider once and is appended.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { Judge, type JudgeConfig, type JudgeVerdict } from "../src/engine/judge.js";
import { normalizeText } from "../src/engine/normalize.js";
import type { EvalCase } from "../src/engine/eval.js";
import type { GuardedSignature } from "../src/engine/types.js";

export interface RecordedVerdict { id: string; label: "allow" | "flag" | "block"; signatures: string[]; reason: string; latencyMs?: number }

const key = (response: string, prompt?: string) =>
  createHash("sha256").update(JSON.stringify([prompt === undefined ? null : normalizeText(prompt), normalizeText(response)])).digest("hex");

export function readVerdicts(file: string): Map<string, RecordedVerdict> {
  const out = new Map<string, RecordedVerdict>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const v = JSON.parse(line) as RecordedVerdict;
    out.set(v.id, v);
  }
  return out;
}

export class ReplayJudge extends Judge {
  private readonly byText = new Map<string, { id: string; v?: RecordedVerdict }>();
  liveCalls = 0;
  replayed = 0;

  constructor(
    config: JudgeConfig,
    cases: EvalCase[],
    private readonly recorded: Map<string, RecordedVerdict>,
    private readonly opts: { live?: boolean; appendTo?: string; throttleMs?: number; maxLiveCalls?: number } = {},
    fetchImpl?: ConstructorParameters<typeof Judge>[1],
  ) {
    super(config, fetchImpl);
    for (const c of cases) this.byText.set(key(c.response, c.prompt), { id: c.id, v: recorded.get(c.id) });
  }

  /** Cases that would need a live call (no recorded verdict). */
  missing(): string[] {
    return [...this.byText.values()].filter((e) => !e.v).map((e) => e.id);
  }

  override async review(response: string, userPrompt?: string): Promise<JudgeVerdict> {
    const entry = this.byText.get(key(response, userPrompt));
    if (!entry) throw new Error("reply is not a held-out case");
    if (entry.v) {
      this.replayed++;
      const sigs = entry.v.signatures.filter((s): s is GuardedSignature => /^S(?:[1-7]|2a)$/.test(s));
      return { label: entry.v.label, signatures: sigs, reason: entry.v.reason, model: this.config.model, provider: this.config.provider, latencyMs: entry.v.latencyMs ?? 0, cached: true };
    }
    if (!this.opts.live) throw new Error(`no recorded judge verdict for ${entry.id} (run with --live --yes to fetch it)`);
    if (this.liveCalls >= (this.opts.maxLiveCalls ?? 250)) throw new Error("live-call cap reached");
    if (this.liveCalls > 0) await new Promise((r) => setTimeout(r, this.opts.throttleMs ?? 2500));
    this.liveCalls++;
    const v = await super.review(response, userPrompt);
    const rec: RecordedVerdict = { id: entry.id, label: v.label, signatures: v.signatures, reason: v.reason, latencyMs: v.latencyMs };
    entry.v = rec;
    this.recorded.set(entry.id, rec);
    if (this.opts.appendTo) fs.appendFileSync(this.opts.appendTo, JSON.stringify(rec) + "\n", { flag: "a" });
    return v;
  }
}
