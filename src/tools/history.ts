import { z } from "zod";
import { defineTool } from "../core/registry.js";

const OPTIONS = { waitUntil: "load", timeout: 30_000 } as const;

export const back = defineTool({
  name: "back",
  description: "Vuelve a la página anterior del historial.",
  params: z.strictObject({}),
  risk: "action",
  handler: async ({ session, warnings }) => {
    const { page } = session.activeTab();
    if (!(await page.goBack(OPTIONS))) warnings.push("No hay página anterior en el historial.");
    return { url: page.url(), title: await page.title() };
  },
});

export const forward = defineTool({
  name: "forward",
  description: "Avanza a la página siguiente del historial.",
  params: z.strictObject({}),
  risk: "action",
  handler: async ({ session, warnings }) => {
    const { page } = session.activeTab();
    if (!(await page.goForward(OPTIONS))) warnings.push("No hay página siguiente en el historial.");
    return { url: page.url(), title: await page.title() };
  },
});

export const reload = defineTool({
  name: "reload",
  description: "Recarga la pestaña activa.",
  params: z.strictObject({}),
  risk: "action",
  handler: async ({ session }) => {
    const { page } = session.activeTab();
    await page.reload(OPTIONS);
    return { url: page.url(), title: await page.title() };
  },
});
