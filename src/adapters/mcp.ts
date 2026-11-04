import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResponse } from "../core/errors.js";
import type { AnyTool } from "../core/registry.js";
import { toolInputSchema } from "../core/schema.js";
import { VERSION } from "../core/version.js";
import { approvalInfo, callTool, resolveApproval } from "../ipc/client.js";

function warningsText(warnings: string[]): string {
  return warnings.map((warning) => `Aviso: ${warning}`).join("\n");
}

/** El texto va sin envolver en JSON: los saltos de línea escapados gastarían tokens en cada snapshot. */
function toMcpResult(response: ToolResponse) {
  if (!response.ok) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(response) }] };
  }
  const data = response.data as { image?: { mime_type: string; base64: string }; text?: unknown };
  const notes = warningsText(response.warnings);
  if (data.image) {
    return {
      content: [
        { type: "image" as const, data: data.image.base64, mimeType: data.image.mime_type },
        ...(notes ? [{ type: "text" as const, text: notes }] : []),
      ],
    };
  }
  if (typeof data.text === "string") {
    return { content: [{ type: "text" as const, text: notes ? `${data.text}\n\n${notes}` : data.text }] };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
}

export async function runMcp(tools: readonly AnyTool[], prefix: string): Promise<void> {
  const server = new Server({ name: "cuybrowser", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: `${prefix}${tool.name}`,
      description: tool.description,
      inputSchema: toolInputSchema(tool),
    })),
  }));

  /** Con approval: elicitation, el cliente MCP pregunta a la persona antes de llamar a confirm. */
  const elicitIfConfigured = async (confirmationId: string): Promise<void> => {
    const info = await approvalInfo(confirmationId);
    if (info.mode !== "elicitation" || !info.description || info.decided) return;
    if (!server.getClientCapabilities()?.elicitation) return;
    const answer = await server.elicitInput({
      message: `CuyBrowser pide permiso para esta acción:\n\n${info.description}`,
      requestedSchema: { type: "object", properties: {} },
    });
    await resolveApproval(confirmationId, answer.action === "accept", "elicitation");
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: params } = request.params;
    const tool = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (tool !== "confirm") return toMcpResult(await callTool(tool, params ?? {}));

    // La espera puede durar minutos: el progreso evita que el cliente corte la llamada.
    const progressToken = request.params._meta?.progressToken;
    let progress = 0;
    const heartbeat =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: ++progress, message: "Esperando la aprobación humana" },
            });
          }, 10_000);
    try {
      const id = (params as { confirmation_id?: unknown } | undefined)?.confirmation_id;
      if (typeof id === "string") await elicitIfConfigured(id);
      return toMcpResult(await callTool(tool, params ?? {}));
    } finally {
      clearInterval(heartbeat);
    }
  });

  process.stdin.once("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}
