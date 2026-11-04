import { z } from "zod";
import { defineTool } from "../core/registry.js";
import { UNTRUSTED_NOTE } from "../core/security/untrusted.js";

export default defineTool({
  name: "network_requests",
  description: `Lista las peticiones de red recientes. Una petición cuenta como fallida si no terminó o si su estado es 400 o superior. ${UNTRUSTED_NOTE}`,
  params: z.strictObject({
    since: z.number().int().nonnegative().optional().describe("Solo eventos posteriores a este seq."),
    url_contains: z.string().optional().describe("Fragmento que debe contener la URL."),
    failed_only: z.boolean().default(false).describe("Incluye solo peticiones fallidas."),
  }),
  risk: "read",
  handler: async ({ session }, { since, url_contains, failed_only }) => ({
    requests: session.events.list("network", since).filter((event) => {
      if (failed_only && !event.data.failed) return false;
      return url_contains === undefined || String(event.data.url).includes(url_contains);
    }),
    last_seq: session.events.lastSeq,
  }),
});
