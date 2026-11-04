import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "start",
  description: "Inicia Chrome con un perfil aislado de CuyBrowser.",
  params: z.strictObject({
    mode: z.enum(["launch"]).default("launch").describe("Modo de navegador."),
    profile: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "Usa solo letras, números, guiones y guiones bajos.")
      .default("default")
      .describe("Nombre del perfil aislado."),
    headless: z.boolean().default(false).describe("Ejecuta Chrome sin ventana."),
  }),
  risk: "action",
  handler: async ({ session, warnings }, params) => {
    const started = await session.start(params);
    if (!started) warnings.push("El navegador ya estaba iniciado; se conservó su configuración.");
    return session.status();
  },
});
