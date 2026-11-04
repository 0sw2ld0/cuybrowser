import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "confirm",
  description:
    "Pide a la persona usuaria que apruebe una acción retenida, espera su respuesta y, si la aprueba, la ejecuta y devuelve su resultado. No aprueba nada por sí misma.",
  params: z.strictObject({
    confirmation_id: z.string().describe("Id recibido en CONFIRMATION_REQUIRED."),
  }),
  risk: "action",
  concurrent: true,
  cli: { positional: ["confirmation_id"] },
  handler: ({ confirm }, { confirmation_id }) => confirm(confirmation_id),
});
