import { z } from "zod";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE, wrapPageContent } from "../core/security/untrusted.js";

export default defineTool({
  name: "console_messages",
  description: `Lista los mensajes recientes de la consola de la página. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    since: z.number().int().nonnegative().optional().describe("Solo eventos posteriores a este seq."),
    level: z.enum(["log", "info", "warning", "error", "debug"]).optional().describe("Filtra por nivel."),
  }),
  risk: "read",
  handler: async ({ session }, { since, level }) => ({
    messages: session.events
      .list("console", since)
      .filter((event) => level === undefined || event.data.level === level)
      .map((event) => ({ ...event, data: { ...event.data, text: wrapPageContent(String(event.data.text)) } })),
    last_seq: session.events.lastSeq,
  }),
});
