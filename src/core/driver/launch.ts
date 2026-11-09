import { mkdirSync } from "node:fs";
import type { BrowserContext } from "playwright-core";
import { CuyError } from "../errors.js";
import { profileDir } from "../paths.js";
import { loadPlaywright, realSystem, resolveBrowsers, type BrowserCandidate } from "./browsers.js";
import type { BrowserDriver, StartOptions } from "./types.js";

/** Primera línea del error de Playwright, que trae después un registro largo. */
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}

/**
 * Abre un navegador del motor de Chrome con un perfil aislado de CuyBrowser; nunca usa el perfil personal.
 * Sin navegador elegido, prueba los instalados en orden hasta que uno abre.
 */
export class LaunchDriver implements BrowserDriver {
  readonly mode = "launch" as const;
  readonly profile: string;
  readonly endpoint = null;
  browser: BrowserCandidate | null = null;
  private context: BrowserContext | null = null;

  constructor(
    private readonly options: StartOptions,
    private readonly warnings: string[] = [],
  ) {
    this.profile = options.profile;
  }

  async start(): Promise<BrowserContext> {
    const { chromium } = await loadPlaywright();
    const candidates = resolveBrowsers(this.options.browser, await realSystem());
    const failures: string[] = [];
    for (const browser of candidates) {
      const dir = profileDir(this.options.profile, browser.profileKey);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        this.context = await chromium.launchPersistentContext(dir, {
          executablePath: browser.executablePath,
          headless: this.options.headless,
          viewport: null,
          // Sin esto Playwright añade --no-sandbox y Chrome muestra un aviso de
          // marca no admitida; además deja el renderizador sin aislamiento.
          chromiumSandbox: true,
          // Core las retiene en cuarentena hasta que una persona las aprueba.
          acceptDownloads: true,
        });
      } catch (err) {
        failures.push(`${browser.name}: ${firstLine(err)}`);
        continue;
      }
      this.browser = browser;
      if (failures.length > 0) {
        this.warnings.push(`No se pudo abrir ${failures.join("; ")}. Se usó ${browser.name}.`);
      }
      return this.context;
    }
    const only = candidates.length === 1 ? candidates[0]! : null;
    throw new CuyError(
      "NO_BROWSER",
      only ? `No se pudo abrir ${failures[0]}` : `No se pudo abrir ningún navegador. ${failures.join("; ")}`,
      "Comprueba que el navegador funciona y que el perfil no está en uso por otra ventana de CuyBrowser.",
    );
  }

  async stop(): Promise<void> {
    const context = this.context;
    this.context = null;
    await context?.close();
  }
}
