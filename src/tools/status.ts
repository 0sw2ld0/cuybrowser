import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "status",
  description: "Muestra el modo, el perfil, las pestañas y la pestaña activa.",
  params: z.strictObject({}),
  risk: "read",
  handler: ({ session }) => session.status(),
});
