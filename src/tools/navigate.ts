import { z } from "zod";
import { navigateTab } from "../core/navigation.js";
import { defineTool } from "../core/registry.js";

export default defineTool({
  name: "navigate",
  description: "Navega a una URL http o https en la pestaña activa.",
  params: z.strictObject({
    url: z.string().describe("URL de destino."),
    wait_until: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("load")
      .describe("Momento en que se da por terminada la carga."),
  }),
  risk: "action",
  cli: { positional: ["url"] },
  handler: ({ session, policy, warnings }, { url, wait_until }) =>
    navigateTab(session.activeTab(), url, wait_until, policy, warnings),
});
