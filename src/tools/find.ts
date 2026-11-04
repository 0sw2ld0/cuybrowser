import { z } from "zod";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE } from "../core/security/untrusted.js";
import { findInPage } from "../core/snapshot/index.js";

export default defineTool({
  name: "find",
  description: `Busca elementos por texto en nombre o valor, sin distinguir mayúsculas ni acentos, y devuelve sus refs. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    query: z.string().min(1).describe("Texto que se busca."),
    role: z.string().optional().describe("Limita la búsqueda a un rol, por ejemplo button."),
    limit: z.number().int().positive().max(100).default(10).describe("Número máximo de resultados."),
  }),
  risk: "read",
  cli: { positional: ["query"] },
  handler: ({ session, warnings }, params) => findInPage(session.activeTab(), params, warnings),
});
