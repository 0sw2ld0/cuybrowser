import { z } from "zod";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE } from "../core/security/untrusted.js";
import { DEFAULT_MAX_TOKENS, takeSnapshot } from "../core/snapshot/index.js";

export default defineTool({
  name: "snapshot",
  description: `Devuelve el árbol de accesibilidad de la pestaña activa en texto compacto, con refs para las acciones e iframes incluidos. Los textos largos se recortan: léelos con get_text. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    mode: z
      .enum(["full", "diff"])
      .default("full")
      .describe("diff devuelve solo lo añadido (+), eliminado (-) y modificado (~) desde el snapshot anterior."),
    scope_ref: z.string().optional().describe("Limita el snapshot a esta ref."),
    interactive_only: z.boolean().default(false).describe("Incluye solo elementos interactivos."),
    max_tokens: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_TOKENS)
      .describe("Límite aproximado de tokens de la respuesta."),
  }),
  risk: "read",
  cli: {
    aliases: { scope_ref: "scope" },
    shortcuts: { diff: { param: "mode", value: "diff", description: "Equivale a --mode diff." } },
  },
  handler: ({ session, warnings }, params) => takeSnapshot(session.activeTab(), params, warnings),
});
