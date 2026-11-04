import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";

const POSITION = "({ x: Math.round(scrollX), y: Math.round(scrollY) })";

export default defineTool({
  name: "scroll",
  description: "Lleva un elemento a la vista o desplaza la página en una dirección.",
  params: z.strictObject({
    ref: z.string().optional().describe("Elemento que se lleva a la vista."),
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Dirección."),
    amount: z.number().positive().default(600).describe("Píxeles que se desplaza."),
  }),
  risk: "action",
  cli: { positional: ["ref"] },
  handler: async ({ session }, { ref, direction, amount }) => {
    if ((ref === undefined) === (direction === undefined)) {
      throw new CuyError("INVALID_PARAMS", "Indica ref o direction, no ambos.");
    }
    const tab = session.activeTab();
    if (ref !== undefined) {
      const element = await resolveElement(tab, ref);
      try {
        await element.scrollIntoView();
      } finally {
        await element.dispose();
      }
    } else {
      const size = await tab.page.evaluate("({ width: innerWidth, height: innerHeight })") as {
        width: number;
        height: number;
      };
      await tab.page.mouse.move(size.width / 2, size.height / 2);
      const sign = direction === "up" || direction === "left" ? -1 : 1;
      const horizontal = direction === "left" || direction === "right";
      await tab.page.mouse.wheel(horizontal ? sign * amount : 0, horizontal ? 0 : sign * amount);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return tab.page.evaluate(POSITION);
  },
});
