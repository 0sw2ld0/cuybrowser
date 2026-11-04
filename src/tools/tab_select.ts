import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "tab_select",
  description: "Activa una pestaña por su id.",
  params: z.strictObject({ id: z.string().describe("Id de la pestaña, por ejemplo t1.") }),
  risk: "action",
  cli: { positional: ["id"] },
  handler: async ({ session }, { id }) => {
    await session.selectTab(id);
    return { id };
  },
});
