/**
 * Aletheia Aegis: MCP Prompts
 */

export function registerPrompts() {
  const promptDefinitions = [
    {
      name: "aegis_output_review",
      description:
        "Review a flagged model response: given the Aegis findings, rewrite the response so it passes the guard — verify or drop ungrounded specifics, add deferrals where advice is high-stakes, and add crisis resources where a vulnerability signal is present.",
      arguments: [
        { name: "response", description: "The flagged model response.", required: true },
        { name: "findings", description: "The Aegis findings JSON for the response.", required: true },
      ],
    },
  ];

  function getPrompt(
    name: string,
    args: Record<string, string>,
  ): { description: string; messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } {
    if (name !== "aegis_output_review") throw new Error(`Unknown prompt: ${name}`);
    return {
      description: "Rewrite a flagged response so it passes the Aegis output guard.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "A deterministic output guard (Aletheia Aegis) flagged the model response below.",
              "Rewrite the response so it passes the guard, following the findings:",
              "",
              "Findings:",
              args.findings ?? "(none supplied)",
              "",
              "Original response:",
              args.response ?? "(none supplied)",
              "",
              "Rules for the rewrite:",
              "- Verify or remove every ungrounded citation, statistic, or institutional claim; never invent a source.",
              "- For high-stakes advice (medical, legal, financial), add a clear deferral to a qualified professional.",
              "- If a crisis or vulnerability signal is present, lead with support and crisis resources (US: call or text 988, or text HOME to 741741).",
              "- Remove any exposed secret or personal data entirely; never reproduce it.",
              "- Keep the helpful substance of the original answer. Do not add new specific claims you cannot support.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  return { promptDefinitions, getPrompt };
}
