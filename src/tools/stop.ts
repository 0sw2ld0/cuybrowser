import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "stop",
  description: "Cierra Chrome. El perfil y sus sesiones se conservan.",
  params: z.strictObject({}),
  risk: "action",
  handler: async ({ session }) => {
    await session.stop();
    return { running: false };
  },
});
