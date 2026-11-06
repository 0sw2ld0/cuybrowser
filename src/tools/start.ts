import { z } from "zod";
import { DEFAULT_CDP_URL, validateCdpUrl } from "../core/driver/attach.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { policyPath } from "../core/security/policy.js";

export default defineTool({
  name: "start",
  description:
    "Inicia Chrome con un perfil aislado de CuyBrowser o, con mode attach, se conecta a un Chrome ya abierto con --remote-debugging-port si la política lo permite.",
  params: z.strictObject({
    mode: z
      .enum(["launch", "attach"])
      .default("launch")
      .describe("launch abre un Chrome propio; attach se conecta a uno ya abierto en este equipo."),
    profile: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "Usa solo letras, números, guiones y guiones bajos.")
      .default("default")
      .describe("Nombre del perfil aislado, solo con launch."),
    cdp_url: z
      .string()
      .optional()
      .describe(`URL de depuración de Chrome, solo con attach. Por defecto ${DEFAULT_CDP_URL}.`),
    headless: z.boolean().default(false).describe("Ejecuta Chrome sin ventana, solo con launch."),
  }),
  risk: "action",
  cli: { aliases: { cdp_url: "cdp" } },
  handler: async ({ session, warnings, policy }, { mode, profile, cdp_url, headless }) => {
    if (mode === "launch" && cdp_url !== undefined) {
      throw new CuyError("INVALID_PARAMS", "cdp_url solo se usa con mode attach.");
    }
    if (mode === "attach" && !policy.attach.enabled) {
      throw new CuyError(
        "BLOCKED_BY_POLICY",
        "El modo attach está deshabilitado: daría acceso a todas las pestañas y sesiones de ese Chrome.",
        `Una persona puede habilitarlo en ${policyPath()}.`,
      );
    }
    const started = await session.start(
      mode === "attach"
        ? { mode, profile, headless, cdp_url: validateCdpUrl(cdp_url ?? DEFAULT_CDP_URL) }
        : { mode, profile, headless },
    );
    if (!started) warnings.push("El navegador ya estaba iniciado; se conservó su configuración.");
    return session.status();
  },
});
