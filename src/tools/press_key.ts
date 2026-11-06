import { z } from "zod";
import { watchNavigation } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { focusedSensitiveKind, keyGate } from "../core/security/classify.js";
import { SENSITIVE_HINT, writesIntoField } from "../core/security/sensitive.js";

export default defineTool({
  name: "press_key",
  description:
    "Pulsa una tecla o combinación en la pestaña activa, por ejemplo Enter o Control+A. Con el foco en un campo sensible solo admite teclas que no escriben, como Tab, Escape o las flechas.",
  params: z.strictObject({ key: z.string().describe("Tecla o combinación.") }),
  risk: "action",
  cli: { positional: ["key"] },
  gate: ({ session }, { key }) => keyGate(session.activeTab(), key),
  handler: async ({ session, warnings, policy }, { key }) => {
    const tab = session.activeTab();
    // Sin esto, pulsar las teclas una a una escribiría lo que type bloquea.
    if (policy.sensitive_fields.block_typing && writesIntoField(key)) {
      const kind = await focusedSensitiveKind(tab);
      if (kind) {
        throw new CuyError(
          "SENSITIVE_FIELD",
          `La tecla ${key} está bloqueada: el foco está en un campo sensible (${kind}).`,
          SENSITIVE_HINT,
        );
      }
    }
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
