import { CuyError } from "./errors.js";
import { assertUrlAllowed, type Policy } from "./security/policy.js";
import type { Tab } from "./session.js";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle";

/** Limita los esquemas: javascript: saltaría el control de evaluate y file: expondría archivos locales. */
export function validateUrl(url: string, policy: Policy): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CuyError("INVALID_PARAMS", `URL no válida: ${url}`, "Incluye el esquema, por ejemplo https://.");
  }
  const allowed = parsed.protocol === "http:" || parsed.protocol === "https:" || url === "about:blank";
  if (!allowed) {
    throw new CuyError("INVALID_PARAMS", `Esquema no permitido: ${parsed.protocol}`, "Usa http:// o https://.");
  }
  assertUrlAllowed(policy, url);
}

function blockedNavigation(url: string, target: string): CuyError {
  return new CuyError("BLOCKED_BY_POLICY", `La política bloqueó la navegación iniciada en ${url} hacia ${target}.`);
}

/** Una navegación que la página empezó antes, por ejemplo al enviar un formulario, puede llegar tarde y pisar esta. */
async function gotoOnceMore(tab: Tab, url: string, waitUntil: WaitUntil, warnings: string[]) {
  try {
    return await tab.page.goto(url, { waitUntil, timeout: 30_000 });
  } catch (err) {
    if (!(err instanceof Error) || !/interrupted by another navigation/i.test(err.message)) throw err;
    warnings.push("Una navegación que la página ya había empezado interrumpió la carga; se repitió.");
    return tab.page.goto(url, { waitUntil, timeout: 30_000 });
  }
}

export async function navigateTab(tab: Tab, url: string, waitUntil: WaitUntil, policy: Policy, warnings: string[] = []) {
  validateUrl(url, policy);
  await tab.cancelledNavigation;
  tab.blockedUrl = null;
  try {
    const response = await gotoOnceMore(tab, url, waitUntil, warnings);
    await tab.cancelledNavigation;
    if (tab.blockedUrl) throw blockedNavigation(url, tab.blockedUrl);
    return {
      url: tab.page.url(),
      title: await tab.page.title(),
      status: response?.status() ?? null,
    };
  } catch (err) {
    if (err instanceof CuyError) throw err;
    await tab.cancelledNavigation;
    if (tab.blockedUrl) throw blockedNavigation(url, tab.blockedUrl);
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CuyError("TIMEOUT", `La navegación a ${url} superó los 30 segundos.`);
    }
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new CuyError("NAVIGATION_FAILED", `No se pudo abrir ${url}: ${message}`);
  }
}
