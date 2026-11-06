import { z } from "zod";
import { latest, MAX_EVENTS_PER_TYPE } from "../core/events.js";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE } from "../core/security/untrusted.js";

export default defineTool({
  name: "network_requests",
  description: `Lista las peticiones de red recientes. Una petición cuenta como fallida si no terminó o si su estado es 400 o superior. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    since: z.number().int().nonnegative().optional().describe("Solo eventos posteriores a este seq."),
    url_contains: z.string().optional().describe("Fragmento que debe contener la URL."),
    failed_only: z.boolean().default(false).describe("Incluye solo peticiones fallidas."),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_EVENTS_PER_TYPE)
      .default(50)
      .describe("Máximo de peticiones; se devuelven las más recientes."),
  }),
  risk: "read",
  handler: async ({ session, warnings }, { since, url_contains, failed_only, limit }) => {
    const matching = session.events.list("network", since).filter((event) => {
      if (failed_only && !event.data.failed) return false;
      return url_contains === undefined || String(event.data.url).includes(url_contains);
    });
    return {
      requests: latest(matching, limit, warnings),
      total: matching.length,
      last_seq: session.events.lastSeq,
    };
  },
});
