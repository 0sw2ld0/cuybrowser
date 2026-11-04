import { mkdirSync } from "node:fs";
import type { BrowserContext } from "playwright-core";
import { CuyError } from "../errors.js";
import { profileDir } from "../paths.js";
import type { BrowserDriver, StartOptions } from "./types.js";

/** Abre Chrome con un perfil aislado de CuyBrowser; nunca usa el perfil personal. */
export class LaunchDriver implements BrowserDriver {
  readonly mode = "launch" as const;
  readonly profile: string;
  private context: BrowserContext | null = null;

  constructor(private readonly options: StartOptions) {
    this.profile = options.profile;
  }

  async start(): Promise<BrowserContext> {
    const { chromium } = await import("playwright-core");
    const dir = profileDir(this.options.profile);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      this.context = await chromium.launchPersistentContext(dir, {
        channel: "chrome",
        headless: this.options.headless,
        viewport: null,
        // Core las retiene en cuarentena hasta que una persona las aprueba.
        acceptDownloads: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CuyError(
        "NO_BROWSER",
        `No se pudo abrir Chrome: ${message.split("\n")[0]}`,
        "Comprueba que Google Chrome está instalado y que el perfil no está en uso.",
      );
    }
    return this.context;
  }

  async stop(): Promise<void> {
    const context = this.context;
    this.context = null;
    await context?.close();
  }
}
