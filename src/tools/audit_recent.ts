import { z } from "zod";
import { defineTool } from "../core/registry.js";
import { AUDIT_NOTE } from "../core/security/audit-recent.js";

export default defineTool({
  name: "audit_recent",
  description: `Lee la auditoría reciente del daemon y perfil actuales, con metadatos saneados y sin parámetros ni texto de la página. ${AUDIT_NOTE}`,
  params: z.strictObject({
    limit: z.number().int().min(1).max(100).default(50).describe("Máximo de entradas; inicialmente devuelve las más recientes."),
    cursor: z.string().min(1).max(1024).optional().describe("Cursor opaco de la respuesta anterior para consultar las entradas posteriores."),
  }),
  risk: "read",
  handler: async ({ auditRecent }, params) => auditRecent(params),
});
