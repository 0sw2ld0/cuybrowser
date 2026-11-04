import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "hover",
  description: "Coloca el puntero sobre un elemento.",
  params: z.strictObject({ ref: z.string().describe("Ref del elemento.") }),
  risk: "action",
  cli: { positional: ["ref"] },
  handler: async ({ session }, { ref }) => {
    const tab = session.activeTab();
    const element = await resolveElement(tab, ref);
    try {
      const { x, y } = await element.clickablePoint();
      await tab.page.mouse.move(x, y);
      return { ref };
    } finally {
      await element.dispose();
    }
  },
});
