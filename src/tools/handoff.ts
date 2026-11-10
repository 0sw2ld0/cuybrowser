import { z } from "zod";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE } from "../core/security/untrusted.js";

export default defineTool({
  name: "handoff",
  description: `Cede la pestaña activa a la persona para un login, 2FA, captcha u otra intervención manual. Trae su ventana al frente y espera Continuar o Cancelar en un diálogo del sistema durante un máximo de dos minutos. Solo con ventana; bloquea las acciones del agente mientras espera. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    reason: z.string().trim().min(1).max(2000).describe("Qué debe hacer la persona en la pestaña."),
  }),
  risk: "action",
  cli: { positional: ["reason"] },
  handler: async ({ session, requestHandoff }, { reason }) => {
    const tab = session.activeTab();
    const abort = session.beginHandoff();
    let stopped = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      stopped = () => reject(new CuyError("CONFIRMATION_DENIED", "El relevo se canceló o terminó su plazo."));
      abort.signal.addEventListener("abort", stopped, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), 120_000);
    timer.unref();
    try {
      await Promise.race([tab.page.bringToFront(), cancelled]);
      const origin = new URL(tab.page.url()).origin;
      const decision = await Promise.race([requestHandoff({
        description: `Sitio: ${origin}\nTarea: ${reason}`,
        seconds: 120,
        signal: abort.signal,
      }), cancelled]);
      if (decision === "unavailable") {
        throw new CuyError("APPROVAL_UNAVAILABLE", "No se pudo mostrar el diálogo del sistema para el relevo.");
      }
      if (decision !== "approved" || abort.signal.aborted) {
        throw new CuyError("CONFIRMATION_DENIED", "La persona canceló el relevo, se cerró la pestaña o terminó el plazo.");
      }
      const title = tab.dialog ? "" : await Promise.race([tab.page.title(), cancelled]);
      return { tab: tab.id, url: tab.page.url(), title, note: UNTRUSTED_NOTE };
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", stopped);
      session.finishHandoff(abort);
    }
  },
});
