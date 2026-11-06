import { z } from "zod";
import { latest, MAX_EVENTS_PER_TYPE } from "../core/events.js";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE, wrapPageContent } from "../core/security/untrusted.js";

export default defineTool({
  name: "console_messages",
  description: `Lista los mensajes recientes de la consola de la página, incluidos los errores de JavaScript no capturados, que llevan uncaught=true. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    since: z.number().int().nonnegative().optional().describe("Solo eventos posteriores a este seq."),
    level: z.enum(["log", "info", "warning", "error", "debug"]).optional().describe("Filtra por nivel."),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_EVENTS_PER_TYPE)
      .default(50)
      .describe("Máximo de mensajes; se devuelven los más recientes."),
  }),
  risk: "read",
  handler: async ({ session, warnings }, { since, level, limit }) => {
    const matching = session.events
      .list("console", since)
      .filter((event) => level === undefined || event.data.level === level);
    return {
      messages: latest(matching, limit, warnings).map((event) => ({
        ...event,
        data: { ...event.data, text: wrapPageContent(String(event.data.text)) },
      })),
      total: matching.length,
      last_seq: session.events.lastSeq,
    };
  },
});
