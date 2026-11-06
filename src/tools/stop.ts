import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "stop",
  description: "Cierra Chrome; el perfil y sus sesiones se conservan. En modo attach solo se desconecta y Chrome sigue abierto.",
  params: z.strictObject({}),
  risk: "action",
  handler: async ({ session }) => {
    await session.stop();
    return { running: false };
  },
});
