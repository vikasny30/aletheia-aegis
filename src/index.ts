#!/usr/bin/env node
/**
 * Aletheia Aegis: Entrypoint
 *
 * Model Context Protocol (MCP) server providing deterministic, sub-millisecond
 * output-side safety checks for model responses, plus a bundled eval harness.
 * Companion to aletheia-mcp, which guards tool calls before execution; Aegis
 * guards what the model says before it reaches the user.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { OutputEvaluator } from "./engine/evaluator.js";
import { Telemetry } from "./engine/telemetry.js";
import { DebugLogger } from "./engine/debug.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import {
  corpusScorecardMarkdown,
  guardScorecardMarkdown,
  runCorpusEval,
  runGuardEval,
} from "./engine/eval.js";

const VERSION = "0.1.2";

const HELP = `
Aletheia Aegis v${VERSION}
Deterministic output-side guard for model responses + eval harness

Usage:
  npx aletheia-aegis                          Start MCP server on stdio
  npx aletheia-aegis --check "<response>"     Check one response, print the verdict JSON, exit
  npx aletheia-aegis --check "<response>" --prompt "<user prompt>"
                                              Check with prompt-dependent S2a/S4/S6 checks enabled
  npx aletheia-aegis --check "<response>" --locale GB --block-checks S5_DOSAGE_WITHOUT_DEFERRAL
                                              Check with a locale and per-check BLOCK escalation
  npx aletheia-aegis --eval                   Run the bundled guard eval, print the scorecard
  npx aletheia-aegis --eval-corpus [file]     Classify a JSONL incident file (default: bundled sample)
  npx aletheia-aegis --version, -v            Show version
  npx aletheia-aegis --help, -h               Show this help

Environment:
  AEGIS_LOCALE        Default locale for crisis resources (default: US)
  AEGIS_BLOCK_CHECKS  Comma-separated check ids to escalate FLAG -> BLOCK
  AEGIS_DEBUG_LOG     Path to a local debug log file (off unless set; contains
                      response text — keep the file local and do not share it)

Tools (over MCP): aegis_check_output, aegis_verify_citations, aegis_run_eval,
aegis_classify_incident, aegis_list_signatures, aegis_get_telemetry.
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`aletheia-aegis v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const checkIdx = args.indexOf("--check");
  if (checkIdx !== -1) {
    const response = args[checkIdx + 1];
    if (!response) {
      console.error("Usage: aletheia-aegis --check \"<response>\" [--prompt \"<user prompt>\"]");
      process.exit(1);
    }
    const promptIdx = args.indexOf("--prompt");
    const userPrompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined;
    const localeIdx = args.indexOf("--locale");
    const locale = localeIdx !== -1 ? args[localeIdx + 1] : undefined;
    const blockIdx = args.indexOf("--block-checks");
    const blockChecks =
      blockIdx !== -1 && args[blockIdx + 1]
        ? args[blockIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const evaluator = new OutputEvaluator();
    const result = evaluator.evaluate({ response, userPrompt, locale, blockChecks });
    new DebugLogger().log({
      tool: "cli --check",
      response,
      userPrompt: userPrompt ?? null,
      locale: locale ?? null,
      verdict: result.verdict,
      findings: result.findings,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (args.includes("--eval")) {
    console.log(guardScorecardMarkdown(runGuardEval()));
    process.exit(0);
  }

  const corpusIdx = args.indexOf("--eval-corpus");
  if (corpusIdx !== -1) {
    const file = args[corpusIdx + 1];
    console.log(corpusScorecardMarkdown(runCorpusEval(file)));
    process.exit(0);
  }

  // MCP server on stdio
  const evaluator = new OutputEvaluator();
  const telemetry = new Telemetry();
  const debug = new DebugLogger();
  const ctx = { evaluator, telemetry, debug, lastScorecard: {} as { guard?: never; corpus?: never } };
  const { toolDefinitions, handleTool } = registerTools(ctx);
  const { resourceDefinitions, readResource } = registerResources(ctx);
  const { promptDefinitions, getPrompt } = registerPrompts();

  const server = new Server(
    { name: "aletheia-aegis", version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resourceDefinitions,
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: promptDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleTool(request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: (error as Error).message }),
          },
        ],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return readResource(request.params.uri);
    } catch (error) {
      throw new Error(`Failed to read resource ${request.params.uri}: ${(error as Error).message}`);
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return getPrompt(request.params.name, (request.params.arguments ?? {}) as Record<string, string>);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Aletheia Aegis] v${VERSION} running on stdio`);
}

main().catch((error: unknown) => {
  console.error(`[Aletheia Aegis] Fatal: ${(error as Error).message}`);
  process.exit(1);
});
