import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "tab_close",
  description: "Cierra una pestaña; sin id, cierra la activa.",
  params: z.strictObject({ id: z.string().optional().describe("Id de la pestaña.") }),
  risk: "action",
  cli: { positional: ["id"] },
  handler: async ({ session }, { id }) => {
    await session.closeTab(id);
    return { tabs: await session.listTabs() };
  },
});
