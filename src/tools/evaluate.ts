import { z } from "zod";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { pageHost, quotePageText } from "../core/security/classify.js";
import { policyPath } from "../core/security/policy.js";
import { UNTRUSTED_NOTE } from "../core/security/untrusted.js";

export default defineTool({
  name: "evaluate",
  description: `Ejecuta una expresión JavaScript en la página. Está deshabilitada por defecto. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({ expression: z.string().describe("Expresión JavaScript.") }),
  risk: "sensitive",
  cli: { positional: ["expression"] },
  gate: async ({ session, policy }, { expression }) => {
    if (!policy.evaluate.enabled) {
      throw new CuyError("BLOCKED_BY_POLICY", "evaluate está deshabilitada.", `Una persona puede habilitarla en ${policyPath()}.`);
    }
    return {
      kinds: ["evaluate"],
      description: `Ejecutar JavaScript en ${pageHost(session.activeTab())}: ${quotePageText(expression)}.`,
    };
  },
  handler: async ({ session }, { expression }) => {
    const value = await session.activeTab().page.evaluate(expression);
    return { value: value === undefined ? null : value };
  },
});
