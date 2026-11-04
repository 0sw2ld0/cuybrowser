import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { defineTool } from "../core/registry.js";
import { collectInjectionWarnings, UNTRUSTED_NOTE, wrapPageContent } from "../core/security/untrusted.js";

export default defineTool({
  name: "get_text",
  description: `Devuelve el texto visible de la página o de una sección. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    scope_ref: z.string().optional().describe("Limita la lectura a esta ref."),
    max_chars: z.number().int().positive().default(20_000).describe("Número máximo de caracteres."),
  }),
  risk: "read",
  cli: { aliases: { scope_ref: "scope" } },
  handler: async ({ session, warnings }, { scope_ref, max_chars }) => {
    const tab = session.activeTab();
    let full: string;
    if (scope_ref !== undefined) {
      const element = await resolveElement(tab, scope_ref);
      try {
        full = (await element.call<string | null>("function(){return this.innerText??this.textContent}")) ?? "";
      } finally {
        await element.dispose();
      }
    } else {
      full = (await tab.page.evaluate("document.body?.innerText ?? ''")) as string;
    }
    const truncated = full.length > max_chars;
    if (truncated) warnings.push(`Texto recortado a ${max_chars} de ${full.length} caracteres.`);
    await collectInjectionWarnings(tab.page, full, warnings);
    return { text: wrapPageContent(full.slice(0, max_chars)), truncated };
  },
});
