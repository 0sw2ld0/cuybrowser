import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "screenshot",
  description: "Captura la pestaña activa, la página completa o un elemento.",
  params: z.strictObject({
    ref: z.string().optional().describe("Captura solo este elemento."),
    full_page: z.boolean().default(false).describe("Captura toda la página."),
  }),
  risk: "read",
  cli: { returnsImage: true },
  handler: async ({ session }, { ref, full_page }) => {
    if (ref !== undefined && full_page) {
      throw new CuyError("INVALID_PARAMS", "Usa ref o full_page, no ambos.");
    }
    const tab = session.activeTab();
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (ref !== undefined) {
      const element = await resolveElement(tab, ref);
      try {
        clip = await element.box();
      } finally {
        await element.dispose();
      }
    }
    const buffer = await tab.page.screenshot({
      type: "png",
      fullPage: full_page,
      ...(clip ? { clip } : {}),
    });
    return { image: { mime_type: "image/png", base64: buffer.toString("base64") } };
  },
});
