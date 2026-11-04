import { z } from "zod";
import { watchNavigation } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { keyGate } from "../core/security/classify.js";

export default defineTool({
  name: "press_key",
  description: "Pulsa una tecla o combinación en la pestaña activa, por ejemplo Enter o Control+A.",
  params: z.strictObject({ key: z.string().describe("Tecla o combinación.") }),
  risk: "action",
  cli: { positional: ["key"] },
  gate: ({ session }, { key }) => keyGate(session.activeTab(), key),
  handler: async ({ session, warnings }, { key }) => {
    const tab = session.activeTab();
    return watchNavigation(tab, () => session.tabIds(), warnings, async () => {
      try {
        await tab.page.keyboard.press(key);
      } catch (err) {
        if (err instanceof Error && /unknown key/i.test(err.message)) {
          throw new CuyError("INVALID_PARAMS", `Tecla desconocida: ${key}`);
        }
        throw err;
      }
    });
  },
});
