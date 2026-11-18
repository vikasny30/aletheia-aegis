/**
 * Aletheia Aegis: Tool Definitions and Handlers with Zod Validation
 */

import { z } from "zod";
import { OutputEvaluator } from "../engine/evaluator.js";
import type { Judge } from "../engine/judge.js";
import { Telemetry } from "../engine/telemetry.js";
import { DebugLogger } from "../engine/debug.js";
import { SIGNATURES } from "../engine/signatures.js";
import { classifyIncident } from "../engine/classifier.js";
import { verifyCitations } from "../engine/verify-citations.js";
import {
  corpusScorecardMarkdown,
  guardScorecardMarkdown,
  runCorpusEval,
  runGuardEval,
  checkEvalFile,
  type CorpusScorecard,
  type GuardScorecard,
} from "../engine/eval.js";

const CheckOutputSchema = z.object({
  response: z.string().min(1, "response must be non-empty").max(1_000_000, "response is over 1,000,000 characters"),
  user_prompt: z.string().max(200_000).optional(),
  context: z.string().max(200_000).optional(),
  locale: z.string().max(35).optional(),
  block_checks: z.array(z.string().max(80)).max(64).optional(),
  judge: z.boolean().optional(),
});

const VerifyCitationsSchema = z.object({
  text: z.string().min(1, "text must be non-empty").max(200_000),
  timeout_ms: z.number().int().min(500).max(30000).optional(),
});

const RunEvalSchema = z.object({
  mode: z.enum(["guard", "corpus"]).optional(),
  cases_file: z.string().max(4096).optional(),
  corpus_file: z.string().max(4096).optional(),
});

const ClassifyIncidentSchema = z.object({
  text: z.string().min(1, "text must be non-empty").max(1_000_000),
});

const GetTelemetrySchema = z.object({
  auditLogLimit: z.number().int().min(1).max(200).optional(),
});

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export interface AegisToolContext {
  evaluator: OutputEvaluator;
  telemetry: Telemetry;
  debug: DebugLogger;
  lastScorecard: { guard?: GuardScorecard; corpus?: CorpusScorecard };
  /** Optional model judge, configured from AEGIS_JUDGE_* environment variables. */
  judge?: Judge;
  /** Crossref reference check for S1-flagged replies (AEGIS_VERIFY_CITATIONS=crossref). */
  verifyCitations?: boolean;
}

export function registerTools(ctx: AegisToolContext) {
  const toolDefinitions = [
    {
      name: "aegis_check_output",
      description:
        "Check a model response before it reaches the user. Runs the deterministic output guard across S1 (ungrounded confidence), S2a (unverified identity grants), S3-output (PII/secrets in the response), S4 (literal-trap heuristic, experimental), S5 (high-stakes advice without deferral), S6 (crisis/vulnerability signals), and S7 (institutional amplification). Returns ALLOW, FLAG, or BLOCK with findings, evidence, and remediation. Pass user_prompt when available: S2a, S4 and S6 need it for their main checks. By default it runs offline pattern detectors only (sub-millisecond, no network). If the operator has configured a model judge (AEGIS_JUDGE_PROVIDER plus their own API key), the reply is also reviewed by that model, which catches far more failures; the result's `mode` and `judge` fields say what ran.",
      inputSchema: {
        type: "object",
        properties: {
          response: { type: "string", description: "The model response to check." },
          user_prompt: {
            type: "string",
            description: "The user message the response answers. Enables the prompt-dependent S2a, S4 and S6 checks.",
          },
          context: {
            type: "string",
            description: "Optional free-form context (e.g. channel). Never stored with response text.",
          },
          locale: {
            type: "string",
            description: "Locale for crisis resources, e.g. US, GB, CA, AU, NZ, IN. Falls back to AEGIS_LOCALE, then US. Unknown locales get US resources plus the international directory (findahelpline.com).",
          },
          block_checks: {
            type: "array",
            items: { type: "string" },
            description: "Check ids to escalate from FLAG to BLOCK for this call, e.g. [\"S5_DOSAGE_WITHOUT_DEFERRAL\"]. Lets a deployer raise severity per check without changing the defaults.",
          },
          judge: {
            type: "boolean",
            description: "Set false to skip the model judge for this call (patterns only). Ignored when no judge is configured.",
          },
        },
        required: ["response"],
      },
    },
    {
      name: "aegis_verify_citations",
      description:
        "Opt-in citation verification, separate from the guard. Resolves DOI, arXiv, and PMID identifiers found in the text against their public resolvers (doi.org, arxiv.org, NCBI E-utilities) and reports verified / not_found / unverifiable / unsupported per citation. Case citations and 'et al.' references are unsupported — no public resolver can check them. This tool makes network requests; aegis_check_output never does. An existing identifier is not a true claim — verification answers only 'does this identifier resolve?'.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text containing citations to verify." },
          timeout_ms: { type: "number", description: "Per-resolver timeout in ms (500-30000, default 5000)." },
        },
        required: ["text"],
      },
    },
    {
      name: "aegis_run_eval",
      description:
        "Score the guard. Mode 'guard' (default) runs the bundled labeled case set through aegis_check_output and returns a per-signature scorecard with detection rates, false positives, and latency. Mode 'corpus' runs the paper's keyword classifier over a JSONL incident file (default: the bundled sample) and compares the distribution with the paper's published §3.3 totals.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["guard", "corpus"], description: "Eval mode. Default: guard." },
          cases_file: { type: "string", description: "Path to a JSONL labeled case file (guard mode). Default: bundled eval/cases.jsonl." },
          corpus_file: { type: "string", description: "Path to a JSONL incident file with {id, source, text} per line (corpus mode). Default: bundled eval/sample-corpus.jsonl." },
        },
      },
    },
    {
      name: "aegis_classify_incident",
      description:
        "Classify incident text against the paper's keyword vocabulary (Appendix C): returns a per-signature confidence score (min(1.0, hits x 0.4), threshold 0.3) and the matched keywords. Offline annotation tool for corpus work; it classifies incident reports, not model outputs.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Incident report text to classify." },
        },
        required: ["text"],
      },
    },
    {
      name: "aegis_list_signatures",
      description:
        "List all nine Aletheia signatures with what Aegis checks for each, what stays with aletheia-mcp (S2b, action-side S3), and what is deferred to the planned session auditor (S8).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "aegis_get_telemetry",
      description:
        "Live telemetry: evaluation counts by verdict, flag/block rates, latency percentiles, and findings by signature and check. The audit log never stores response text.",
      inputSchema: {
        type: "object",
        properties: {
          auditLogLimit: { type: "number", description: "Audit records to include (1-200, default 50)." },
        },
      },
    },
  ];

  async function handleTool(name: string, args: unknown) {
    switch (name) {
      case "aegis_check_output": {
        const parsed = CheckOutputSchema.parse(args);
        const input = {
          response: parsed.response,
          userPrompt: parsed.user_prompt,
          context: parsed.context,
          locale: parsed.locale,
          blockChecks: parsed.block_checks,
        };
        const useJudge = ctx.judge && parsed.judge !== false;
        const result =
          useJudge || ctx.verifyCitations
            ? await ctx.evaluator.evaluateEnhanced(input, { judge: useJudge ? ctx.judge : undefined, verifyCitations: ctx.verifyCitations })
            : ctx.evaluator.evaluate(input);
        ctx.telemetry.record(result, parsed.response.length, Boolean(parsed.user_prompt));
        ctx.debug.log({
          tool: "aegis_check_output",
          response: parsed.response,
          userPrompt: parsed.user_prompt ?? null,
          locale: parsed.locale ?? null,
          verdict: result.verdict,
          findings: result.findings,
        });
        return textResult(result);
      }
      case "aegis_verify_citations": {
        const parsed = VerifyCitationsSchema.parse(args);
        const result = await verifyCitations(parsed.text, { timeoutMs: parsed.timeout_ms });
        return textResult(result);
      }
      case "aegis_run_eval": {
        const parsed = RunEvalSchema.parse(args);
        if (parsed.mode === "corpus") {
          const score = runCorpusEval(parsed.corpus_file === undefined ? undefined : checkEvalFile(parsed.corpus_file));
          ctx.lastScorecard.corpus = score;
          return textResult({ ...score, markdown: corpusScorecardMarkdown(score) });
        }
        const score = runGuardEval(parsed.cases_file === undefined ? undefined : checkEvalFile(parsed.cases_file));
        ctx.lastScorecard.guard = score;
        return textResult({ ...score, markdown: guardScorecardMarkdown(score) });
      }
      case "aegis_classify_incident": {
        const parsed = ClassifyIncidentSchema.parse(args);
        return textResult(classifyIncident(parsed.text));
      }
      case "aegis_list_signatures": {
        return textResult({ signatures: SIGNATURES });
      }
      case "aegis_get_telemetry": {
        const parsed = GetTelemetrySchema.parse(args ?? {});
        return textResult({
          summary: ctx.telemetry.summary(),
          auditLog: ctx.telemetry.auditLog(parsed.auditLogLimit ?? 50),
        });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return { toolDefinitions, handleTool };
}
