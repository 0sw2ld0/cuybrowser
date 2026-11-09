import { z } from "zod";
import { DEFAULT_CDP_URL, validateCdpUrl } from "../core/driver/attach.js";
import { BROWSER_IDS } from "../core/driver/browsers.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { policyPath } from "../core/security/policy.js";

export default defineTool({
  name: "start",
  description:
    "Abre un navegador con un perfil aislado de CuyBrowser: Google Chrome o, si no está, el primero que haya de Microsoft Edge, Brave, Chromium, Arc y el Chromium que descarga install-browser. Con mode attach, se conecta a un Chrome ya abierto con --remote-debugging-port si la política lo permite.",
  params: z.strictObject({
    mode: z
      .enum(["launch", "attach"])
      .default("launch")
      .describe("launch abre un navegador propio; attach se conecta a un Chrome ya abierto en este equipo."),
    profile: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "Usa solo letras, números, guiones y guiones bajos.")
      .default("default")
      .describe("Nombre del perfil aislado, solo con launch."),
    cdp_url: z
      .string()
      .optional()
      .describe(`URL de depuración de Chrome, solo con attach. Por defecto ${DEFAULT_CDP_URL}.`),
    browser: z
      .string()
      .optional()
      .describe(
        `Navegador que se abre, solo con launch: ${BROWSER_IDS.join(", ")} o la ruta absoluta del ejecutable. Sin indicarlo, se usa CUYBROWSER_BROWSER o el primero instalado.`,
      ),
    headless: z.boolean().default(false).describe("Ejecuta el navegador sin ventana, solo con launch."),
  }),
  risk: "action",
  cli: { aliases: { cdp_url: "cdp" } },
  handler: async ({ session, warnings, policy }, { mode, profile, cdp_url, browser, headless }) => {
    if (mode === "launch" && cdp_url !== undefined) {
      throw new CuyError("INVALID_PARAMS", "cdp_url solo se usa con mode attach.");
    }
    if (mode === "attach" && browser !== undefined) {
      throw new CuyError("INVALID_PARAMS", "browser solo se usa con mode launch: en attach el Chrome ya está abierto.");
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
        : { mode, profile, headless, ...(browser === undefined ? {} : { browser }) },
      warnings,
    );
    if (!started) warnings.push("El navegador ya estaba iniciado; se conservó su configuración.");
    return session.status();
  },
});
