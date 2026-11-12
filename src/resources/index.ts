/**
 * Aletheia Aegis: MCP Resources
 */

import { SIGNATURES } from "../engine/signatures.js";
import type { AegisToolContext } from "../tools/index.js";
import { corpusScorecardMarkdown, guardScorecardMarkdown } from "../engine/eval.js";

export function registerResources(ctx: AegisToolContext) {
  const resourceDefinitions = [
    {
      uri: "aegis://signatures/all",
      name: "Aletheia signature coverage",
      description: "All nine Aletheia signatures with what Aegis checks, what stays with aletheia-mcp, and what is deferred.",
      mimeType: "application/json",
    },
    {
      uri: "aegis://telemetry/summary",
      name: "Telemetry summary",
      description: "Live evaluation counts, verdict rates, latency percentiles, findings by signature.",
      mimeType: "application/json",
    },
    {
      uri: "aegis://telemetry/audit-log",
      name: "Audit log",
      description: "Recent evaluations (verdicts, finding checks, latency). Response text is never stored.",
      mimeType: "application/json",
    },
    {
      uri: "aegis://eval/last-scorecard",
      name: "Last eval scorecard",
      description: "Markdown scorecard from the most recent aegis_run_eval call in this session.",
      mimeType: "text/markdown",
    },
  ];

  function readResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    switch (uri) {
      case "aegis://signatures/all":
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({ signatures: SIGNATURES }, null, 2),
            },
          ],
        };
      case "aegis://telemetry/summary":
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(ctx.telemetry.summary(), null, 2),
            },
          ],
        };
      case "aegis://telemetry/audit-log":
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({ auditLog: ctx.telemetry.auditLog(50) }, null, 2),
            },
          ],
        };
      case "aegis://eval/last-scorecard": {
        const guard = ctx.lastScorecard.guard
          ? guardScorecardMarkdown(ctx.lastScorecard.guard)
          : null;
        const corpus = ctx.lastScorecard.corpus
          ? corpusScorecardMarkdown(ctx.lastScorecard.corpus)
          : null;
        const text =
          [guard, corpus].filter(Boolean).join("\n\n---\n\n") ||
          "No eval has run in this session yet. Call aegis_run_eval first.";
        return { contents: [{ uri, mimeType: "text/markdown", text }] };
      }
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  }

  return { resourceDefinitions, readResource };
}
