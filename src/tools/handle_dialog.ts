import { z } from "zod";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { pageHost, PURCHASE_TEXT, quotePageText } from "../core/security/classify.js";

export default defineTool({
  name: "handle_dialog",
  description: "Acepta o rechaza el diálogo abierto en la pestaña activa.",
  params: z.strictObject({
    accept: z.boolean().describe("true para aceptar, false para rechazar."),
    prompt_text: z.string().optional().describe("Texto para un diálogo de tipo prompt."),
  }),
  risk: "action",
  auditRedact: ["prompt_text"],
  gate: async ({ session }, { accept }) => {
    const tab = session.activeTab();
    const message = tab.dialog?.message();
    if (!accept || !message || !PURCHASE_TEXT.test(message)) return null;
    return {
      kinds: ["purchases"],
      description: `Aceptar un diálogo que parece una compra en ${pageHost(tab)}: ${quotePageText(message)}.`,
    };
  },
  handler: async ({ session }, { accept, prompt_text }) => {
    const tab = session.activeTab();
    const { dialog } = tab;
    if (!dialog) throw new CuyError("INVALID_PARAMS", "No hay ningún diálogo abierto en la pestaña activa.");
    tab.dialog = null;
    if (accept) await dialog.accept(prompt_text);
    else await dialog.dismiss();
    return { accepted: accept };
  },
});
