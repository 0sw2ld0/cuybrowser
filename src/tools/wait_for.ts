import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "wait_for",
  description: "Espera a que aparezca un texto o un elemento, a que la URL cambie o a un estado de carga.",
  params: z.strictObject({
    text: z.string().optional().describe("Texto visible que debe aparecer."),
    ref: z.string().optional().describe("Elemento que debe estar visible."),
    url_contains: z.string().optional().describe("Fragmento que debe contener la URL."),
    load: z.enum(["load", "domcontentloaded", "networkidle"]).optional().describe("Estado de carga."),
    timeout_ms: z.number().int().positive().max(60_000).default(10_000).describe("Tiempo máximo de espera."),
  }),
  risk: "read",
  handler: async ({ session }, { text, ref, url_contains, load, timeout_ms }) => {
    const conditions = [text, ref, url_contains, load].filter((value) => value !== undefined);
    if (conditions.length !== 1) {
      throw new CuyError("INVALID_PARAMS", "Indica exactamente una condición: text, ref, url_contains o load.");
    }
    const tab = session.activeTab();
    const { page } = tab;
    const timeout = timeout_ms;
    try {
      if (text !== undefined) {
        await page.getByText(text).first().waitFor({ state: "visible", timeout });
      } else if (url_contains !== undefined) {
        await page.waitForURL((url) => url.href.includes(url_contains), { timeout, waitUntil: "commit" });
      } else if (load !== undefined) {
        await page.waitForLoadState(load, { timeout });
      } else {
        const deadline = Date.now() + timeout;
        for (;;) {
          const element = await resolveElement(tab, ref!);
          try {
            await element.box();
            break;
          } catch (err) {
            if (!(err instanceof CuyError) || err.code !== "NOT_INTERACTABLE") throw err;
            if (Date.now() >= deadline) {
              throw new CuyError("TIMEOUT", `${ref} no se hizo visible en ${timeout} ms.`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          } finally {
            await element.dispose();
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CuyError("TIMEOUT", `La condición no se cumplió en ${timeout} ms.`);
      }
      throw err;
    }
    return { url: page.url() };
  },
});
