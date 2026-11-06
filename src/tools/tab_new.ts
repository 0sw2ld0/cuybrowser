import { z } from "zod";
import { navigateTab, validateUrl } from "../core/navigation.js";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "tab_new",
  description: "Abre una pestaña nueva, la activa y, si se indica, navega a una URL.",
  params: z.strictObject({
    url: z.string().optional().describe("URL que se abre en la pestaña."),
  }),
  risk: "action",
  cli: { positional: ["url"] },
  handler: async ({ session, policy, warnings }, { url }) => {
    if (url !== undefined) validateUrl(url, policy);
    const tab = await session.newTab();
    if (url !== undefined) await navigateTab(tab, url, "load", policy, warnings);
    return { id: tab.id };
  },
});
