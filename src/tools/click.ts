import { z } from "zod";
import { resolveElement, watchNavigation } from "../core/element.js";
import { defineTool } from "../core/registry.js";
import { clickGate } from "../core/security/classify.js";

export default defineTool({
  name: "click",
  description: "Hace clic en un elemento identificado por su ref del último snapshot.",
  params: z.strictObject({
    ref: z.string().describe("Ref del elemento, por ejemplo e12."),
    button: z.enum(["left", "right", "middle"]).default("left").describe("Botón del ratón."),
    double: z.boolean().default(false).describe("Hace doble clic."),
  }),
  risk: "action",
  cli: { positional: ["ref"] },
  gate: ({ session }, { ref }) => clickGate(session.activeTab(), ref),
  handler: async ({ session, warnings }, { ref, button, double }) => {
    const tab = session.activeTab();
    const element = await resolveElement(tab, ref);
    try {
      const { x, y } = await element.clickablePoint();
      return await watchNavigation(tab, () => session.tabIds(), warnings, async () => {
        if (double) await tab.page.mouse.dblclick(x, y, { button });
        else await tab.page.mouse.click(x, y, { button });
      });
    } finally {
      await element.dispose();
    }
  },
});
