import { z } from "zod";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "tabs_list",
  description: "Lista las pestañas abiertas.",
  params: z.strictObject({}),
  risk: "read",
  cli: {
    format: (data: { tabs: { id: string; title: string; url: string; active: boolean }[] }) =>
      data.tabs
        .map((tab) => `${tab.active ? "*" : " "} ${tab.id}  ${tab.url}  ${JSON.stringify(tab.title)}`)
        .join("\n"),
  },
  handler: async ({ session }) => ({ tabs: await session.listTabs() }),
});
